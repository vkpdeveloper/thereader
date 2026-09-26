import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;
import 'package:kindle_unpack/kindle_unpack.dart' hide CompressionType;

/// Rebuilds a MOBI as an EPUB publication so every subsequent read uses the
/// app's existing Readium EPUB navigator. Kindle URLs must become ordinary
/// relative EPUB links before the navigator can load styles, images or TOC.
///
/// The converter is deliberately "intelligent" about chapter labels: instead
/// of emitting generic "Part 1, Part 2..." entries, it reads the actual
/// headings inside each XHTML part and uses those for the EPUB 3 nav doc and
/// NCX. Sub-sections are nested so the table of contents matches the book's
/// real structure.
Uint8List convertMobi(Uint8List source) {
  final book = KindleBook.fromBytes(source);
  final flowPaths = <int, String>{};
  final resourcePaths = <int, String>{
    for (final image in book.images.all)
      image.blockIndex: 'Images/${image.name}',
  };
  final css = <EpubAsset>[];
  final extraImages = <ExtractedImage>[];
  final fontAssets = <EpubAsset>[];
  final firstResource = book.mobi.firstImageIndex;
  if (firstResource != MobiHeader.unset && firstResource > 0) {
    for (var i = firstResource; i < book.pdb.records.length; i++) {
      final bytes = book.pdb.records[i].data;
      if (bytes.length < 4 ||
          bytes[0] != 0x46 ||
          bytes[1] != 0x4f ||
          bytes[2] != 0x4e ||
          bytes[3] != 0x54) {
        continue;
      }
      try {
        final font = FontResource.parse(bytes);
        final name =
            'font${fontAssets.length.toString().padLeft(4, '0')}.${font.format.extension}';
        resourcePaths[i - firstResource] = 'Fonts/$name';
        fontAssets.add(
          EpubAsset(
            name: name,
            bytes: font.payload,
            mediaType: switch (font.format) {
              FontFormat.ttf || FontFormat.ttc => 'font/ttf',
              FontFormat.otf => 'font/otf',
              FontFormat.unknown => 'application/octet-stream',
            },
          ),
        );
      } on HeaderException {
        // A damaged font is treated like any other missing referenced asset.
      }
    }
  }

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
        final path = resourcePaths[index];
        if (path == null) {
          throw FormatException(
            'The MOBI references missing resource ${index + 1}.',
          );
        }
        return '../$path';
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
  final List<_EpubPart> parts;
  if (book.format == KindleFormat.mobi7Only) {
    parts = _splitMobi7Parts(
      book.parts.single.bytes,
      book.mobi.textEncoding,
      book.images.all,
    );
  } else {
    parts = [
      for (final part in book.parts)
        _finalizeKf8Part(
          fileNumber: part.fileNumber,
          text: rewrite(partTexts[part.fileNumber]!, 'Text'),
        ),
    ];
  }
  final cover = book.images.cover;
  final epub = _ThereaderEpubBuilder.build(
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

/// One finalized EPUB text part, including the real heading-derived label.
class _EpubPart {
  const _EpubPart({
    required this.fileNumber,
    required this.bytes,
    required this.title,
    this.headings = const [],
  });

  final int fileNumber;
  final Uint8List bytes;

  /// Human-readable label for this part (chapter/section title).
  final String title;

  /// All headings found inside this part, used for nested navigation.
  final List<_Heading> headings;

  String get filename => 'part${fileNumber.toString().padLeft(4, '0')}.xhtml';
}

class _Heading {
  const _Heading({
    required this.level,
    required this.text,
    required this.anchor,
  });

  final int level;
  final String text;
  final String anchor;
}

_EpubPart _finalizeKf8Part({
  required int fileNumber,
  required String text,
}) {
  final document = html.parse(text);
  final headings = _collectHeadings(document, fileNumber);
  final title = _selectTitle(headings, fallbackNumber: fileNumber);
  final xhtml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      '${_writeNodeToString(document.documentElement!)}';
  return _EpubPart(
    fileNumber: fileNumber,
    bytes: utf8.encode(xhtml),
    title: title,
    headings: headings,
  );
}

List<_Heading> _collectHeadings(dom.Document document, int fileNumber) =>
    _collectHeadingsFromBody(document.body!, fileNumber);

List<_Heading> _collectHeadingsFromBody(dom.Element body, int fileNumber) {
  final headings = <_Heading>[];
  final children = body.children;
  var inHeadings = false;
  for (var i = 0; i < children.length; i++) {
    final child = children[i];
    final heading = _extractHeading(child, fileNumber, i);
    if (heading != null) {
      headings.add(heading);
      inHeadings = true;
      continue;
    }
    if (inHeadings && !_isIgnorableForHeadings(child)) {
      break;
    }
  }
  _combineNumberHeadings(headings);
  return headings;
}

_Heading? _extractHeading(dom.Element element, int fileNumber, int index) {
  final tag = element.localName?.toLowerCase() ?? '';
  if (_isIgnorableForHeadings(element)) return null;
  if (!_isHeadingLike(element)) return null;
  final text = _cleanHeading(element.text);
  if (text.isEmpty) return null;
  var anchor = element.attributes['id'];
  if (anchor == null || anchor.isEmpty) {
    anchor = 'mobi-hd-$fileNumber-$index';
    element.attributes['id'] = anchor;
  }
  final level = int.tryParse(tag.substring(1)) ?? 1;
  return _Heading(level: level, text: text, anchor: anchor);
}

bool _isIgnorableForHeadings(dom.Element element) {
  final tag = element.localName?.toLowerCase() ?? '';
  if (const {'br', 'hr', 'script', 'style'}.contains(tag)) return true;
  if (tag == 'span' && _cleanHeading(element.text).isEmpty) return true;
  return false;
}

bool _isHeadingLike(dom.Element element) {
  final tag = element.localName?.toLowerCase() ?? '';
  if (RegExp(r'^h[1-6]$').hasMatch(tag)) return true;

  final text = _cleanHeading(element.text);
  if (text.isEmpty || text.length > 120) return false;

  // Attribution lines such as "—NDT" are not chapter titles.
  if (RegExp(r'^[—\-–]').hasMatch(text) && text.length <= 8) return false;

  // All-caps short titles like PREFACE, CONTENTS, ACKNOWLEDGMENTS.
  if (text.toUpperCase() == text && text.length >= 2 && text.length <= 30) {
    return true;
  }

  // Chapter / section numbers, with or without the word "Chapter".
  if (_isNumberHeading(text) || _isChapterHeading(text)) return true;

  // Visually emphasized, short introductory text.
  final fontSize = _firstFontSize(element);
  final hasLargeFont = fontSize != null && fontSize >= 4;
  final hasBold = element.querySelector('b, strong') != null;
  final isCentered = element.attributes['align']?.toLowerCase() == 'center';
  if ((hasLargeFont || hasBold) && (isCentered || text.length <= 40)) {
    return true;
  }

  return false;
}

int? _firstFontSize(dom.Element element) {
  for (final font in element.querySelectorAll('font[size]')) {
    final size = int.tryParse(font.attributes['size'] ?? '');
    if (size != null) return size;
  }
  final own = int.tryParse(element.attributes['size'] ?? '');
  return own;
}

final _numberHeadingPattern = RegExp(r'^\s*\d+[.:\-]?\s*$');
final _chapterHeadingPattern = RegExp(
  r'^\s*(Chapter|CHAPTER|Ch\.?|Section|SECTION)?\s*\d+[.:\-]?\s*$',
);

bool _isNumberHeading(String text) => _numberHeadingPattern.hasMatch(text);
bool _isChapterHeading(String text) => _chapterHeadingPattern.hasMatch(text);

void _combineNumberHeadings(List<_Heading> headings) {
  for (var i = 0; i < headings.length - 1; i++) {
    final current = headings[i];
    final next = headings[i + 1];
    if (_isNumberHeading(current.text) || _isChapterHeading(current.text)) {
      if (!_isNumberHeading(next.text)) {
        headings[i] = _Heading(
          level: current.level,
          text: '${current.text.trim()} ${next.text.trim()}',
          anchor: current.anchor,
        );
        headings.removeAt(i + 1);
        i--;
      }
    }
  }
}

String _cleanHeading(String value) {
  var text = value.replaceAll('\u00a0', ' ').trim();
  text = text.replaceAll(RegExp(r'\s+'), ' ');
  if (text.length > 200) {
    text = text.substring(0, 200).trim();
  }
  return text;
}

String _selectTitle(
  List<_Heading> headings, {
  required int fallbackNumber,
}) {
  if (headings.isNotEmpty) {
    return headings.first.text;
  }
  return 'Section ${fallbackNumber + 1}';
}

List<_EpubPart> _splitMobi7Parts(
  Uint8List sourceBytes,
  int textEncoding,
  List<ExtractedImage> images, {
  int firstFileNumber = 0,
}) {
  final byRecord = {for (final image in images) image.blockIndex + 1: image};
  final positions = <int>{};
  for (final match in RegExp(
    r'''\bfilepos=["']?(\d+)''',
  ).allMatches(latin1.decode(sourceBytes))) {
    positions.add(int.parse(match.group(1)!));
  }
  // Mobi-7 filepos values address the original byte stream. Anchors are
  // inserted at the next tag boundary in one pass, then carried through HTML
  // repair so invalid publisher HTML becomes valid XHTML.
  if (positions.isNotEmpty) {
    final ordered = positions.toList()..sort();
    final patched = BytesBuilder(copy: false);
    var lastOffset = 0;
    for (final position in ordered) {
      if (position >= sourceBytes.length) continue;
      var at = position > lastOffset ? position : lastOffset;
      while (at < sourceBytes.length && sourceBytes[at] != 0x3c) {
        at++;
      }
      if (at < sourceBytes.length) {
        patched.add(Uint8List.sublistView(sourceBytes, lastOffset, at));
        patched.add(utf8.encode('<span id="mobi-pos-$position"></span>'));
        lastOffset = at;
      }
    }
    patched.add(Uint8List.sublistView(sourceBytes, lastOffset));
    sourceBytes = patched.takeBytes();
  }
  var source = textEncoding == 1252
      ? _decodeWindows1252(sourceBytes)
      : utf8.decode(sourceBytes, allowMalformed: true);
  source = source.replaceAll(RegExp(r'</br\s*>', caseSensitive: false), '');
  // The HTML parser treats <mbp:pagebreak> as a non-void element and nests
  // all subsequent content inside it. Convert it to a self-describing <hr>
  // marker before parsing so chapters become sibling body children.
  source = source.replaceAll(
    RegExp(r'<mbp:pagebreak\s*/?>', caseSensitive: false),
    '<hr class="mbp-pagebreak"/>',
  );
  source = source.replaceAll(
    RegExp(r'</mbp:pagebreak\s*>', caseSensitive: false),
    '',
  );
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

  final body = repaired.body!;
  final groups = <List<dom.Node>>[[]];
  for (final node in body.nodes.toList()) {
    if (node is dom.Element &&
        node.localName?.toLowerCase() == 'hr' &&
        node.attributes['class'] == 'mbp-pagebreak') {
      groups.add([]);
    } else {
      groups.last.add(node);
    }
  }
  groups.removeWhere((group) => group.isEmpty);

  final head = repaired.head;
  final headString = head == null ? '' : _writeNodeToString(head);
  final bodyAttributes = <String, String>{
    for (final entry in body.attributes.entries)
      entry.key.toString(): entry.value,
  };

  final titles = <String>[];
  final headingsList = <List<_Heading>>[];
  final partStrings = <String>[];
  for (var i = 0; i < groups.length; i++) {
    final group = groups[i];
    final bodyElement = dom.Element.tag('body');
    for (final entry in bodyAttributes.entries) {
      bodyElement.attributes[entry.key] = entry.value;
    }
    for (final node in group) {
      bodyElement.append(node.clone(true));
    }
    final fileNumber = firstFileNumber + i;
    final headings = _collectHeadingsFromBody(bodyElement, fileNumber);
    final title = _selectTitle(headings, fallbackNumber: fileNumber);
    titles.add(title);
    headingsList.add(headings);
    final bodyString = _writeNodeToString(bodyElement);
    partStrings.add(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      '<html xmlns="http://www.w3.org/1999/xhtml" '
      'xmlns:xlink="http://www.w3.org/1999/xlink">\n'
      '$headString\n'
      '$bodyString\n'
      '</html>\n',
    );
  }

  final positionToPart = <int, int>{};
  final idPattern = RegExp(r'id="mobi-pos-(\d+)"');
  for (var i = 0; i < partStrings.length; i++) {
    for (final match in idPattern.allMatches(partStrings[i])) {
      positionToPart[int.parse(match.group(1)!)] = i;
    }
  }
  for (var i = 0; i < partStrings.length; i++) {
    partStrings[i] = partStrings[i].replaceAllMapped(
      RegExp(r'href="#mobi-pos-(\d+)"'),
      (match) {
        final pos = int.parse(match.group(1)!);
        final target = positionToPart[pos];
        if (target == null) return match.group(0)!;
        return 'href="part${target.toString().padLeft(4, '0')}.xhtml#mobi-pos-$pos"';
      },
    );
  }

  return [
    for (var i = 0; i < partStrings.length; i++)
      _EpubPart(
        fileNumber: firstFileNumber + i,
        bytes: utf8.encode(partStrings[i]),
        title: titles[i],
        headings: headingsList[i],
      ),
  ];
}

class _ThereaderEpubBuilder {
  static Uint8List build({
    required EpubMetadata metadata,
    required List<_EpubPart> parts,
    List<ExtractedImage> images = const [],
    List<EpubAsset> css = const [],
    List<EpubAsset> fonts = const [],
  }) {
    final archive = Archive();

    final mimetype = ArchiveFile(
      'mimetype',
      _epubMimetype.length,
      Uint8List.fromList(_epubMimetype.codeUnits),
    )..compression = CompressionType.none;
    archive.addFile(mimetype);

    _addUtf8(archive, 'META-INF/container.xml', _containerXml);
    _addUtf8(archive, 'OEBPS/content.opf', _buildOpf(metadata, parts, images, css, fonts));
    _addUtf8(archive, 'OEBPS/nav.xhtml', _buildNav(metadata, parts));
    _addUtf8(archive, 'OEBPS/toc.ncx', _buildNcx(metadata, parts));

    for (final part in parts) {
      archive.addFile(
        ArchiveFile('OEBPS/Text/${part.filename}', part.bytes.length, part.bytes),
      );
    }
    for (final img in images) {
      archive.addFile(
        ArchiveFile('OEBPS/Images/${img.name}', img.data.length, img.data),
      );
    }
    for (var i = 0; i < css.length; i++) {
      archive.addFile(
        ArchiveFile(
          'OEBPS/Styles/${css[i].name}',
          css[i].bytes.length,
          css[i].bytes,
        ),
      );
    }
    for (var i = 0; i < fonts.length; i++) {
      archive.addFile(
        ArchiveFile(
          'OEBPS/Fonts/${fonts[i].name}',
          fonts[i].bytes.length,
          fonts[i].bytes,
        ),
      );
    }

    return ZipEncoder().encodeBytes(archive);
  }

  static void _addUtf8(Archive archive, String path, String content) {
    final bytes = utf8.encode(content);
    archive.addFile(ArchiveFile(path, bytes.length, bytes));
  }

  static String _buildOpf(
    EpubMetadata m,
    List<_EpubPart> parts,
    List<ExtractedImage> images,
    List<EpubAsset> css,
    List<EpubAsset> fonts,
  ) {
    String esc(String s) => _escapeXml(s);
    final manifest = StringBuffer();
    final spine = StringBuffer();

    for (final p in parts) {
      final id = 'p${p.fileNumber}';
      manifest.writeln(
          '    <item id="$id" href="Text/${p.filename}" media-type="application/xhtml+xml"/>');
      spine.writeln('    <itemref idref="$id"/>');
    }
    for (final img in images) {
      final id = 'img${img.blockIndex}';
      manifest.writeln(
          '    <item id="$id" href="Images/${img.name}" media-type="${_imageMime(img.format)}"/>');
    }
    for (var i = 0; i < css.length; i++) {
      manifest.writeln(
          '    <item id="css$i" href="Styles/${css[i].name}" media-type="text/css"/>');
    }
    for (var i = 0; i < fonts.length; i++) {
      final mime = fonts[i].mediaType ?? 'application/octet-stream';
      manifest.writeln(
          '    <item id="font$i" href="Fonts/${fonts[i].name}" media-type="$mime"/>');
    }
    manifest.writeln(
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    manifest.writeln(
        '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

    final coverMeta = m.coverImageId != null
        ? '    <meta name="cover" content="${esc(m.coverImageId!)}"/>\n'
        : '';

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="bookid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        '    <dc:identifier id="bookid">${esc(m.identifier)}</dc:identifier>\n'
        '    <dc:title>${esc(m.title)}</dc:title>\n'
        '    <dc:language>${esc(m.language)}</dc:language>\n'
        '${m.creators.map((c) => '    <dc:creator>${esc(c)}</dc:creator>\n').join()}'
        '${m.publisher == null ? '' : '    <dc:publisher>${esc(m.publisher!)}</dc:publisher>\n'}'
        '${m.description == null ? '' : '    <dc:description>${esc(m.description!)}</dc:description>\n'}'
        '$coverMeta'
        '  </metadata>\n'
        '  <manifest>\n'
        '$manifest'
        '  </manifest>\n'
        '  <spine toc="ncx">\n'
        '$spine'
        '  </spine>\n'
        '</package>\n';
  }

  static String _buildNav(EpubMetadata m, List<_EpubPart> parts) {
    String esc(String s) => _escapeXml(s);
    final roots = _buildNavTree(parts);
    final items = StringBuffer();
    void render(List<_NavNode> nodes, int depth) {
      if (nodes.isEmpty) return;
      items.writeln('${'  ' * depth}<ol>');
      for (final node in nodes) {
        items.writeln('${'  ' * (depth + 1)}<li>');
        items.writeln(
            '${'  ' * (depth + 2)}<a href="${esc(node.src)}">${esc(node.label)}</a>');
        if (node.children.isNotEmpty) {
          render(node.children, depth + 2);
        }
        items.writeln('${'  ' * (depth + 1)}</li>');
      }
      items.writeln('${'  ' * depth}</ol>');
    }
    render(roots, 3);

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(m.language)}">\n'
        '  <head>\n'
        '    <meta charset="utf-8"/>\n'
        '    <title>${esc(m.title)}</title>\n'
        '  </head>\n'
        '  <body>\n'
        '    <nav epub:type="toc" id="toc">\n'
        '      <h1>${esc(m.title)}</h1>\n'
        '$items'
        '    </nav>\n'
        '  </body>\n'
        '</html>\n';
  }

  static String _buildNcx(EpubMetadata m, List<_EpubPart> parts) {
    String esc(String s) => _escapeXml(s);
    final entries = <_TocEntry>[];
    for (final part in parts) {
      if (part.headings.isEmpty) {
        entries.add(_TocEntry(
          level: 1,
          label: part.title,
          src: 'Text/${part.filename}',
        ));
      } else {
        for (final heading in part.headings) {
          entries.add(_TocEntry(
            level: heading.level,
            label: heading.text,
            src: 'Text/${part.filename}#${heading.anchor}',
          ));
        }
      }
    }

    final navPoints = StringBuffer();
    final open = <int>[];
    var order = 0;
    for (final entry in entries) {
      while (open.isNotEmpty && open.last >= entry.level) {
        final indent = '  ' * (open.length + 1);
        navPoints.writeln('$indent</navPoint>');
        open.removeLast();
      }
      order++;
      final indent = '  ' * (open.length + 2);
      final labelIndent = '  ' * (open.length + 3);
      navPoints.writeln(
          '$indent<navPoint id="navPoint-$order" playOrder="$order">');
      navPoints.writeln(
          '$labelIndent<navLabel><text>${esc(entry.label)}</text></navLabel>');
      navPoints.writeln(
          '$labelIndent<content src="${esc(entry.src)}"/>');
      open.add(entry.level);
    }
    while (open.isNotEmpty) {
      final indent = '  ' * (open.length + 1);
      navPoints.writeln('$indent</navPoint>');
      open.removeLast();
    }

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        '  <head>\n'
        '    <meta name="dtb:uid" content="${esc(m.identifier)}"/>\n'
        '  </head>\n'
        '  <docTitle><text>${esc(m.title)}</text></docTitle>\n'
        '  <navMap>\n'
        '$navPoints'
        '  </navMap>\n'
        '</ncx>\n';
  }

  static String _imageMime(ImageFormat fmt) {
    switch (fmt) {
      case ImageFormat.jpeg:
        return 'image/jpeg';
      case ImageFormat.png:
        return 'image/png';
      case ImageFormat.gif:
        return 'image/gif';
      case ImageFormat.bmp:
        return 'image/bmp';
      case ImageFormat.svg:
        return 'image/svg+xml';
    }
  }

  static String _escapeXml(String s) => s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
}

class _NavNode {
  _NavNode(this.label, this.src, this.level);

  final String label;
  final String src;
  final int level;
  final List<_NavNode> children = [];
}

List<_NavNode> _buildNavTree(List<_EpubPart> parts) {
  final roots = <_NavNode>[];
  final stack = <_NavNode>[];
  for (final part in parts) {
    if (part.headings.isEmpty) {
      final node = _NavNode(part.title, 'Text/${part.filename}', 1);
      roots.add(node);
      stack
        ..clear()
        ..add(node);
      continue;
    }
    for (final heading in part.headings) {
      final node = _NavNode(
        heading.text,
        'Text/${part.filename}#${heading.anchor}',
        heading.level,
      );
      while (stack.isNotEmpty && stack.last.level >= heading.level) {
        stack.removeLast();
      }
      if (stack.isEmpty) {
        roots.add(node);
      } else {
        stack.last.children.add(node);
      }
      stack.add(node);
    }
  }
  return roots;
}

class _TocEntry {
  const _TocEntry({required this.level, required this.label, required this.src});

  final int level;
  final String label;
  final String src;
}

String _writeNodeToString(dom.Node node) {
  final buffer = StringBuffer();
  _writeXhtml(node, buffer);
  return buffer.toString();
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
    var tag = node.localName?.toLowerCase() ?? 'span';
    if (tag == 'mbp:pagebreak') {
      out.write('<hr style="break-before: page"/>');
      for (final child in node.nodes) {
        _writeXhtml(child, out);
      }
      return;
    }
    if (!_xmlName.hasMatch(tag)) tag = 'span';
    out.write('<$tag');
    if (tag == 'html') {
      out.write(' xmlns="http://www.w3.org/1999/xhtml"');
      out.write(' xmlns:xlink="http://www.w3.org/1999/xlink"');
    }
    for (final entry in node.attributes.entries) {
      final name = entry.key.toString();
      if (tag == 'html' && (name == 'xmlns' || name == 'xmlns:xlink')) {
        continue;
      }
      if (!_xmlName.hasMatch(name) &&
          name != 'xml:lang' &&
          name != 'xlink:href' &&
          !name.startsWith('xmlns:')) {
        continue;
      }
      if (name.startsWith('xmlns:') && !_xmlName.hasMatch(name.substring(6))) {
        continue;
      }
      out.write(' $name="${_escapeXml(entry.value)}"');
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

final _xmlName = RegExp(r'^[A-Za-z_][A-Za-z0-9_.-]*$');

String _escapeXml(String value) => value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const _epubMimetype = 'application/epub+zip';

const _containerXml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">\n'
    '  <rootfiles>\n'
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
    '  </rootfiles>\n'
    '</container>\n';

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
