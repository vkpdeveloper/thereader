import 'dart:convert';
import 'dart:typed_data';

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;
import 'package:kindle_unpack/kindle_unpack.dart';

/// Rebuilds a MOBI as an EPUB publication so every subsequent read uses the
/// app's existing Readium EPUB navigator. Kindle URLs must become ordinary
/// relative EPUB links before the navigator can load styles, images or TOC.
Uint8List convertMobi(Uint8List source) {
  final book = KindleBook.fromBytes(source);
  final flowPaths = <int, String>{};
  final css = <EpubAsset>[];
  final extraImages = <ExtractedImage>[];

  for (final flow in book.flows?.flows ?? <FlowSection>[]) {
    if (flow.kind == FlowKind.css) {
      final name = 'style${(css.length + 1).toString().padLeft(4, '0')}.css';
      flowPaths[flow.index] = 'Styles/$name';
      css.add(EpubAsset(name: name, bytes: flow.bytes));
    } else if (flow.kind == FlowKind.svg) {
      final image = ExtractedImage(
        blockIndex: 10000 + flow.index,
        recordIndex: -1,
        format: ImageFormat.svg,
        data: flow.bytes,
      );
      flowPaths[flow.index] = 'Images/${image.name}';
      extraImages.add(image);
    }
  }

  final fragments = <FragmentEntry>[];
  if (book.flows != null) {
    try {
      fragments.addAll(FragmentTable.parse(book.pdb, book.mobi).entries);
    } on HeaderException {
      // The unpacker already falls back to a single part for books without
      // usable fragment indices. Resource URLs still resolve in that part.
    }
  }

  final partTexts = <int, String>{};
  for (final part in book.parts) {
    partTexts[part.fileNumber] = utf8.decode(part.bytes, allowMalformed: true);
  }
  final targets = <int, String>{};
  for (var fid = 0; fid < fragments.length; fid++) {
    final fragment = fragments[fid];
    var text = partTexts[fragment.fileNumber];
    if (text == null) continue;
    final aid = RegExp(
      r'''@aid=['"]([^'"]+)['"]''',
    ).firstMatch(fragment.idText)?.group(1);
    if (aid == null) continue;
    final element = RegExp(
      '(<[A-Za-z][^>]*\\baid=["\\\']${RegExp.escape(aid)}["\\\'][^>]*)(>)',
    ).firstMatch(text);
    if (element == null) continue;
    var anchor = RegExp(
      r'''\bid=['"]([^'"]+)['"]''',
    ).firstMatch(element.group(1)!)?.group(1);
    if (anchor == null) {
      anchor = 'mobi-aid-$aid';
      text = text.replaceRange(
        element.end - 1,
        element.end - 1,
        ' id="$anchor"',
      );
      partTexts[fragment.fileNumber] = text;
    }
    targets[fid] =
        'part${fragment.fileNumber.toString().padLeft(4, '0')}.xhtml#$anchor';
  }

  String rewrite(String text, String directory) {
    text = text.replaceAllMapped(
      RegExp(r'''kindle:flow:([0-9]+)\?mime=[^\s"'<>]+'''),
      (match) {
        final index = int.parse(match.group(1)!);
        final path = flowPaths[index];
        if (path == null) {
          throw FormatException('The MOBI references missing flow $index.');
        }
        return '../$path';
      },
    );
    text = text.replaceAllMapped(
      RegExp(r'''kindle:embed:([0-9A-V]+)(?:\?mime=[^\s"'<>]+)?'''),
      (match) {
        final index = int.parse(match.group(1)!, radix: 32) - 1;
        final image = book.images.all
            .where((item) => item.blockIndex == index)
            .firstOrNull;
        if (image == null) {
          throw FormatException(
            'The MOBI references missing image ${index + 1}.',
          );
        }
        return '../Images/${image.name}';
      },
    );
    text = text.replaceAllMapped(
      RegExp(r'kindle:pos:fid:([0-9A-V]+):off:[0-9A-V]+'),
      (match) {
        final fid = int.parse(match.group(1)!, radix: 32);
        final target = targets[fid];
        if (target == null) {
          throw FormatException('The MOBI references missing chapter $fid.');
        }
        return target;
      },
    );
    final cover = book.images.cover;
    if (cover != null && directory == 'Text') {
      text = text.replaceAllMapped(
        RegExp(
          r'''(<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["'])[^"']+(["'])''',
        ),
        (match) => '${match.group(1)}../Images/${cover.name}${match.group(2)}',
      );
      text = text.replaceAllMapped(
        RegExp(
          r'''(<link\b[^>]*\bhref=["'])[^"']+(["'][^>]*\brel=["']icon["'])''',
        ),
        (match) => '${match.group(1)}../Images/${cover.name}${match.group(2)}',
      );
    }
    if (text.contains('kindle:')) {
      throw const FormatException(
        'The MOBI contains an unsupported internal link.',
      );
    }
    return text;
  }

  final fixedCss = <EpubAsset>[
    for (final asset in css)
      EpubAsset(
        name: asset.name,
        bytes: utf8.encode(rewrite(utf8.decode(asset.bytes), 'Styles')),
      ),
  ];
  final fixedImages = <ExtractedImage>[
    ...book.images.all,
    for (final image in extraImages)
      ExtractedImage(
        blockIndex: image.blockIndex,
        recordIndex: image.recordIndex,
        format: image.format,
        data: utf8.encode(rewrite(utf8.decode(image.data), 'Images')),
      ),
  ];
  final parts = <XhtmlPart>[
    for (final part in book.parts)
      XhtmlPart(
        fileNumber: part.fileNumber,
        bytes: utf8.encode(
          book.format == KindleFormat.mobi7Only
              ? _legacyXhtml(
                  part.bytes,
                  book.mobi.textEncoding,
                  book.images.all,
                )
              : rewrite(partTexts[part.fileNumber]!, 'Text'),
        ),
      ),
  ];
  final fontAssets = <EpubAsset>[
    for (var i = 0; i < book.fonts.length; i++)
      EpubAsset(
        name:
            'font${i.toString().padLeft(4, '0')}.${book.fonts[i].format.extension}',
        bytes: book.fonts[i].payload,
      ),
  ];
  final cover = book.images.cover;
  final epub = EpubBuilder.build(
    metadata: EpubMetadata(
      identifier: book.exth?.asin ?? 'urn:kindle:${book.mobi.uniqueId}',
      title: book.title,
      language: book.exth?.language ?? 'und',
      creators: book.exth?.authors ?? const [],
      publisher: book.exth?.publisher,
      description: book.exth?.description,
      coverImageId: cover == null ? null : 'img${cover.blockIndex}',
    ),
    parts: parts,
    images: fixedImages,
    css: fixedCss,
    fonts: fontAssets,
  );
  _normalizeZipTimestamps(epub);
  return epub;
}

String _legacyXhtml(
  Uint8List sourceBytes,
  int textEncoding,
  List<ExtractedImage> images,
) {
  final byRecord = {for (final image in images) image.blockIndex + 1: image};
  final positions = <int>{};
  for (final match in RegExp(
    r'''\bfilepos=["']?(\d+)''',
  ).allMatches(latin1.decode(sourceBytes))) {
    positions.add(int.parse(match.group(1)!));
  }
  // Mobi-7 filepos values address the original byte stream. Anchors are
  // inserted at the next tag boundary, then carried through HTML repair.
  // Reparse after insertion so invalid publisher HTML becomes valid XHTML.
  if (positions.isNotEmpty) {
    final ordered = positions.toList()..sort((a, b) => b.compareTo(a));
    var patched = sourceBytes;
    for (final position in ordered) {
      if (position >= patched.length) continue;
      var at = position;
      while (at < patched.length && patched[at] != 0x3c) {
        at++;
      }
      if (at < patched.length) {
        patched = Uint8List.fromList([
          ...patched.sublist(0, at),
          ...utf8.encode('<span id="mobi-pos-$position"></span>'),
          ...patched.sublist(at),
        ]);
      }
    }
    sourceBytes = patched;
  }
  var source = textEncoding == 1252
      ? _decodeWindows1252(sourceBytes)
      : utf8.decode(sourceBytes, allowMalformed: true);
  source = source.replaceAll(RegExp(r'</br\s*>', caseSensitive: false), '');
  final repaired = html.parse(source);
  for (final element in repaired.querySelectorAll('[filepos]')) {
    final position = element.attributes.remove('filepos');
    if (position != null && int.tryParse(position) != null) {
      element.attributes['href'] = '#mobi-pos-${int.parse(position)}';
    }
  }
  for (final element in repaired.querySelectorAll('[recindex]')) {
    final index = int.tryParse(element.attributes.remove('recindex') ?? '');
    final image = byRecord[index];
    if (image == null) {
      throw const FormatException('The MOBI references a missing image.');
    }
    element.attributes['src'] = '../Images/${image.name}';
  }
  final output = StringBuffer('<?xml version="1.0" encoding="UTF-8"?>\n');
  _writeXhtml(repaired.documentElement!, output);
  return output.toString();
}

String _decodeWindows1252(Uint8List bytes) {
  const extended = <int>[
    0x20ac,
    0x81,
    0x201a,
    0x192,
    0x201e,
    0x2026,
    0x2020,
    0x2021,
    0x2c6,
    0x2030,
    0x160,
    0x2039,
    0x152,
    0x8d,
    0x17d,
    0x8f,
    0x90,
    0x2018,
    0x2019,
    0x201c,
    0x201d,
    0x2022,
    0x2013,
    0x2014,
    0x2dc,
    0x2122,
    0x161,
    0x203a,
    0x153,
    0x9d,
    0x17e,
    0x178,
  ];
  return String.fromCharCodes([
    for (final byte in bytes)
      byte >= 0x80 && byte <= 0x9f ? extended[byte - 0x80] : byte,
  ]);
}

const _voidTags = {
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
};

void _writeXhtml(dom.Node node, StringBuffer out) {
  if (node is dom.Text) {
    out.write(_escapeXml(node.text));
  } else if (node is dom.Element) {
    final tag = node.localName?.toLowerCase() ?? 'span';
    if (tag == 'mbp:pagebreak') {
      out.write('<hr style="break-before: page"/>');
      for (final child in node.nodes) {
        _writeXhtml(child, out);
      }
      return;
    }
    out.write('<$tag');
    if (tag == 'html') out.write(' xmlns="http://www.w3.org/1999/xhtml"');
    for (final entry in node.attributes.entries) {
      if (entry.key == 'xmlns' && tag == 'html') continue;
      out.write(' ${entry.key}="${_escapeXml(entry.value)}"');
    }
    if (_voidTags.contains(tag)) {
      out.write('/>');
    } else {
      out.write('>');
      for (final child in node.nodes) {
        _writeXhtml(child, out);
      }
      out.write('</$tag>');
    }
  }
}

String _escapeXml(String value) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

void _normalizeZipTimestamps(Uint8List bytes) {
  final view = ByteData.sublistView(bytes);
  var offset = 0;
  while (offset + 4 <= bytes.length) {
    final signature = view.getUint32(offset, Endian.little);
    if (signature == 0x04034b50) {
      if (offset + 30 > bytes.length) {
        throw const FormatException('Invalid converted EPUB.');
      }
      view.setUint16(offset + 10, 0, Endian.little);
      view.setUint16(offset + 12, 33, Endian.little);
      offset +=
          30 +
          view.getUint16(offset + 26, Endian.little) +
          view.getUint16(offset + 28, Endian.little) +
          view.getUint32(offset + 18, Endian.little);
    } else if (signature == 0x02014b50) {
      if (offset + 46 > bytes.length) {
        throw const FormatException('Invalid converted EPUB.');
      }
      view.setUint16(offset + 12, 0, Endian.little);
      view.setUint16(offset + 14, 33, Endian.little);
      offset +=
          46 +
          view.getUint16(offset + 28, Endian.little) +
          view.getUint16(offset + 30, Endian.little) +
          view.getUint16(offset + 32, Endian.little);
    } else if (signature == 0x06054b50) {
      return;
    } else {
      throw const FormatException('Invalid converted EPUB.');
    }
    if (offset > bytes.length) {
      throw const FormatException('Invalid converted EPUB.');
    }
  }
  throw const FormatException('Invalid converted EPUB.');
}
