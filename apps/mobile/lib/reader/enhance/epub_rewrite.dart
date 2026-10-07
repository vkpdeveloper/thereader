import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart' show getCrc32;
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:path/path.dart' as p;
import 'package:xml/xml.dart';

/// Folder, next to the package document, that holds the enhancer bundle in a
/// derived copy. Nothing in a publisher's EPUB is expected to use it.
const enhancerFolder = '__thereader';

/// Writes [target]: a copy of the EPUB at [source] in which every XHTML/HTML
/// manifest document links the enhancer bundle ([bundle] maps file names to
/// bytes, e.g. `enhance.js`, `enhance.css`), the bundle files sit in
/// [enhancerFolder] beside the OPF, and the OPF manifest lists them.
///
/// Every original entry keeps its name, so hrefs, locators and highlights
/// address the same resources. Untouched entries (images, fonts, styles) are
/// copied as raw compressed bytes, so a 30 MB, 7,000-image book costs one
/// sequential copy, not a recompression. Only the documents and the OPF are
/// inflated, edited and deflated again.
///
/// Synchronous: run it off the UI isolate. Throws [FormatException] on
/// anything it does not understand (ZIP64, encryption, no package document);
/// callers fall back to the original file.
RewriteStats rewriteEpubWithEnhancer({
  required String source,
  required String target,
  required Map<String, Uint8List> bundle,
}) {
  final watch = Stopwatch()..start();
  final input = File(source).openSync();
  RandomAccessFile? output;
  try {
    final zip = _CentralDirectory.read(input);
    final byName = {for (final e in zip.entries) e.name: e};

    final container = byName['META-INF/container.xml'];
    if (container == null) throw const FormatException('No container.xml');
    final opfPath = _rootfile(_text(_inflate(input, container)));
    final opfEntry = byName[opfPath];
    if (opfEntry == null) throw FormatException('No package document $opfPath');
    final opfDir = p.posix.dirname(opfPath) == '.'
        ? ''
        : p.posix.dirname(opfPath);
    String inOpfDir(String name) => opfDir.isEmpty ? name : '$opfDir/$name';

    final opfText = _text(_inflate(input, opfEntry));
    final documents = _manifestDocuments(
      opfText,
      opfDir,
    ).where(byName.containsKey).toSet();

    final assetNames = bundle.keys.toList()..sort();
    final assetPaths = {
      for (final n in assetNames) n: inOpfDir('$enhancerFolder/$n'),
    };
    final cssLinks = [
      for (final n in assetNames)
        if (n.endsWith('.css')) assetPaths[n]!,
    ];
    final scripts = [
      for (final n in assetNames)
        if (n.endsWith('.js')) assetPaths[n]!,
    ];

    final replaced = <String, Uint8List>{};
    replaced[opfPath] = Uint8List.fromList(
      latin1.encode(
        _addManifestItems(latin1.decode(_inflate(input, opfEntry)), [
          for (final n in assetNames)
            (href: '$enhancerFolder/$n', type: _mediaType(n)),
        ]),
      ),
    );
    var injected = 0;
    for (final doc in documents) {
      final entry = byName[doc]!;
      if (!entry.canInflate) continue;
      final dir = p.posix.dirname(doc);
      String rel(String asset) =>
          p.posix.relative(asset, from: dir == '.' ? '' : dir);
      final bytes = _inflate(input, entry);
      final edited = injectEnhancer(
        bytes,
        stylesheets: cssLinks.map(rel).toList(),
        scripts: scripts.map(rel).toList(),
      );
      if (edited != null) {
        replaced[doc] = edited;
        injected++;
      }
    }

    final part = File('$target.part');
    output = part.openSync(mode: FileMode.write);
    final writer = _ZipWriter(output);
    // Original order (mimetype first), minus any bundle left by an earlier
    // derivation of an already derived file.
    final bundlePrefix = inOpfDir('$enhancerFolder/');
    for (final entry in zip.entriesByOffset) {
      if (entry.name.startsWith(bundlePrefix)) continue;
      final edited = replaced[entry.name];
      if (edited == null) {
        writer.copyRaw(input, entry, zip.endOf(entry));
      } else {
        writer.addEdited(entry, edited);
      }
    }
    for (final n in assetNames) {
      writer.addNew(assetPaths[n]!, bundle[n]!, compress: !_isFont(n));
    }
    writer.finish();
    output.closeSync();
    output = null;
    part.renameSync(target);
    return RewriteStats(
      entries: zip.entries.length,
      documents: injected,
      milliseconds: watch.elapsedMilliseconds,
    );
  } finally {
    output?.closeSync();
    input.closeSync();
  }
}

class RewriteStats {
  const RewriteStats({
    required this.entries,
    required this.documents,
    required this.milliseconds,
  });
  final int entries;
  final int documents;
  final int milliseconds;

  @override
  String toString() =>
      '$documents documents enhanced, $entries entries, ${milliseconds}ms';
}

/// Adds the bundle's `<link>`s and `<script>`s at the end of the document
/// head, after the publisher's own styles. Works on bytes through latin1, a
/// lossless 1:1 mapping, so any ASCII-compatible encoding survives untouched.
/// Returns null when the document has no recognisable head or is already
/// linked.
@visibleForTesting
Uint8List? injectEnhancer(
  Uint8List bytes, {
  required List<String> stylesheets,
  required List<String> scripts,
}) {
  final text = latin1.decode(bytes);
  if (text.contains('$enhancerFolder/')) return null;
  final tags = [
    for (final href in stylesheets)
      '<link rel="stylesheet" type="text/css" href="${_attr(href)}"/>',
    for (final src in scripts)
      '<script type="text/javascript" src="${_attr(src)}"></script>',
  ].join();
  final close = RegExp(r'</head\s*>', caseSensitive: false).firstMatch(text);
  String? out;
  if (close != null) {
    out = text.replaceRange(close.start, close.start, tags);
  } else {
    final empty = RegExp(
      r'<head(\s[^>]*)?/>',
      caseSensitive: false,
    ).firstMatch(text);
    if (empty != null) {
      out = text.replaceRange(
        empty.start,
        empty.end,
        '<head${empty.group(1) ?? ''}>$tags</head>',
      );
    } else {
      final body = RegExp(r'<body[\s>]', caseSensitive: false).firstMatch(text);
      if (body != null &&
          !RegExp(r'<head[\s>]', caseSensitive: false).hasMatch(text)) {
        out = text.replaceRange(body.start, body.start, '<head>$tags</head>');
      }
    }
  }
  return out == null ? null : Uint8List.fromList(latin1.encode(out));
}

String _attr(String s) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

String _addManifestItems(String opf, List<({String href, String type})> items) {
  final close = RegExp(
    r'</((?:[A-Za-z_][\w.-]*:)?)manifest\s*>',
  ).firstMatch(opf);
  if (close == null) {
    throw const FormatException('No manifest in package document');
  }
  final prefix = close.group(1)!;
  final tags = [
    for (final (i, item) in items.indexed)
      '<${prefix}item id="thereader-enhance-$i" href="${_attr(item.href)}" media-type="${item.type}"/>',
  ].join();
  return opf.replaceRange(close.start, close.start, tags);
}

String _rootfile(String containerXml) {
  final doc = XmlDocument.parse(containerXml);
  for (final el in doc.descendantElements) {
    if (el.localName == 'rootfile') {
      final path = el.getAttribute('full-path');
      final type = el.getAttribute('media-type');
      if (path != null &&
          (type == null || type == 'application/oebps-package+xml')) {
        return path;
      }
    }
  }
  throw const FormatException('container.xml names no package document');
}

/// Zip paths of the manifest's XHTML/HTML documents.
Iterable<String> _manifestDocuments(String opf, String opfDir) sync* {
  final doc = XmlDocument.parse(opf);
  for (final el in doc.descendantElements) {
    if (el.localName != 'item') continue;
    final type = el.getAttribute('media-type') ?? '';
    final href = el.getAttribute('href');
    if (href == null) continue;
    if (type != 'application/xhtml+xml' && type != 'text/html') continue;
    final path = Uri.decodeFull(href.split('#').first);
    yield p.posix.normalize(opfDir.isEmpty ? path : '$opfDir/$path');
  }
}

String _text(Uint8List bytes) {
  try {
    return utf8.decode(bytes);
  } on FormatException {
    return latin1.decode(bytes);
  }
}

String _mediaType(String name) => switch (p.extension(name).toLowerCase()) {
  '.js' => 'application/javascript',
  '.css' => 'text/css',
  '.woff2' => 'font/woff2',
  '.woff' => 'font/woff',
  '.otf' => 'font/otf',
  '.ttf' => 'font/ttf',
  _ => 'application/octet-stream',
};

bool _isFont(String name) => const {
  '.woff2',
  '.woff',
  '.otf',
  '.ttf',
}.contains(p.extension(name).toLowerCase());

Uint8List _inflate(RandomAccessFile input, _Entry entry) {
  if (!entry.canInflate) {
    throw FormatException('Unsupported entry ${entry.name}');
  }
  input.setPositionSync(entry.localOffset);
  final header = input.readSync(30);
  if (header.length < 30 || _u32(header, 0) != 0x04034b50) {
    throw FormatException('Bad local header for ${entry.name}');
  }
  final dataStart =
      entry.localOffset + 30 + _u16(header, 26) + _u16(header, 28);
  input.setPositionSync(dataStart);
  final raw = input.readSync(entry.compressedSize);
  if (entry.method == 0) return raw;
  return Uint8List.fromList(ZLibDecoder(raw: true).convert(raw));
}

int _u16(List<int> b, int o) => b[o] | (b[o + 1] << 8);
int _u32(List<int> b, int o) =>
    b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

class _Entry {
  _Entry(this.central, this.name);

  /// The complete central directory record, reused for unchanged entries.
  final Uint8List central;
  final String name;

  int get flags => _u16(central, 8);
  int get method => _u16(central, 10);
  int get compressedSize => _u32(central, 20);
  int get localOffset => _u32(central, 42);

  bool get encrypted => flags & 1 != 0;
  bool get canInflate => !encrypted && (method == 0 || method == 8);
}

class _CentralDirectory {
  _CentralDirectory(this.entries, this.offset);

  final List<_Entry> entries;
  final int offset;
  late final List<_Entry> entriesByOffset = [...entries]
    ..sort((a, b) => a.localOffset.compareTo(b.localOffset));
  late final Map<_Entry, int> _ends = {
    for (final (i, e) in entriesByOffset.indexed)
      e: i + 1 < entriesByOffset.length
          ? entriesByOffset[i + 1].localOffset
          : offset,
  };

  /// Where [entry]'s local record (header, data, data descriptor) ends.
  int endOf(_Entry entry) => _ends[entry]!;

  static _CentralDirectory read(RandomAccessFile f) {
    final length = f.lengthSync();
    final tailSize = length < 65557 ? length : 65557;
    f.setPositionSync(length - tailSize);
    final tail = f.readSync(tailSize);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (_u32(tail, i) == 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw const FormatException('Not a ZIP archive');
    final count = _u16(tail, eocd + 10);
    final size = _u32(tail, eocd + 12);
    final offset = _u32(tail, eocd + 16);
    if (count == 0xffff || size == 0xffffffff || offset == 0xffffffff) {
      throw const FormatException('ZIP64 archives are not rewritten');
    }
    f.setPositionSync(offset);
    final cd = f.readSync(size);
    final entries = <_Entry>[];
    var pos = 0;
    for (var i = 0; i < count; i++) {
      if (pos + 46 > cd.length || _u32(cd, pos) != 0x02014b50) {
        throw const FormatException('Corrupt central directory');
      }
      final nameLen = _u16(cd, pos + 28);
      final recordLen = 46 + nameLen + _u16(cd, pos + 30) + _u16(cd, pos + 32);
      final record = Uint8List.sublistView(cd, pos, pos + recordLen);
      final nameBytes = Uint8List.sublistView(record, 46, 46 + nameLen);
      final name = _u16(record, 8) & 0x800 != 0
          ? utf8.decode(nameBytes, allowMalformed: true)
          : latin1.decode(nameBytes);
      entries.add(_Entry(Uint8List.fromList(record), name));
      pos += recordLen;
    }
    return _CentralDirectory(entries, offset);
  }
}

class _ZipWriter {
  _ZipWriter(this.out);

  final RandomAccessFile out;
  final _central = BytesBuilder(copy: false);
  var _offset = 0;
  var _count = 0;

  void _write(List<int> bytes) {
    out.writeFromSync(bytes);
    _offset += bytes.length;
  }

  void _addCentral(Uint8List record, int localOffset) {
    _setU32(record, 42, localOffset);
    _central.add(record);
    _count++;
  }

  /// Copies the whole local record byte for byte; only its offset changes.
  void copyRaw(RandomAccessFile input, _Entry entry, int end) {
    final start = _offset;
    input.setPositionSync(entry.localOffset);
    var left = end - entry.localOffset;
    while (left > 0) {
      final chunk = input.readSync(left < 1 << 20 ? left : 1 << 20);
      if (chunk.isEmpty) throw const FormatException('Truncated archive');
      _write(chunk);
      left -= chunk.length;
    }
    _addCentral(Uint8List.fromList(entry.central), start);
  }

  /// Writes [data] as a deflated replacement of [entry], keeping its name,
  /// timestamps and central-directory extras.
  void addEdited(_Entry entry, Uint8List data) {
    final record = Uint8List.fromList(entry.central);
    final name = Uint8List.sublistView(record, 46, 46 + _u16(record, 28));
    final flags = (_u16(record, 8) & 0x800); // keep only the UTF-8 name flag
    final (method, payload) = _compress(data, true);
    final crc = getCrc32(data);
    final start = _offset;
    _write(
      _localHeader(
        flags: flags,
        method: method,
        time: _u16(record, 12),
        date: _u16(record, 14),
        crc: crc,
        compressed: payload.length,
        size: data.length,
        name: name,
      ),
    );
    _write(payload);
    _setU16(record, 6, 20);
    _setU16(record, 8, flags);
    _setU16(record, 10, method);
    _setU32(record, 16, crc);
    _setU32(record, 20, payload.length);
    _setU32(record, 24, data.length);
    _addCentral(record, start);
  }

  void addNew(String path, Uint8List data, {required bool compress}) {
    final name = utf8.encode(path);
    final (method, payload) = _compress(data, compress);
    final crc = getCrc32(data);
    final (time, date) = _dosNow();
    final start = _offset;
    _write(
      _localHeader(
        flags: 0x800,
        method: method,
        time: time,
        date: date,
        crc: crc,
        compressed: payload.length,
        size: data.length,
        name: name,
      ),
    );
    _write(payload);
    final record = Uint8List(46 + name.length);
    _setU32(record, 0, 0x02014b50);
    _setU16(record, 4, 20);
    _setU16(record, 6, 20);
    _setU16(record, 8, 0x800);
    _setU16(record, 10, method);
    _setU16(record, 12, time);
    _setU16(record, 14, date);
    _setU32(record, 16, crc);
    _setU32(record, 20, payload.length);
    _setU32(record, 24, data.length);
    _setU16(record, 28, name.length);
    record.setRange(46, 46 + name.length, name);
    _addCentral(record, start);
  }

  void finish() {
    final cd = _central.takeBytes();
    final cdOffset = _offset;
    _write(cd);
    final eocd = Uint8List(22);
    _setU32(eocd, 0, 0x06054b50);
    _setU16(eocd, 8, _count);
    _setU16(eocd, 10, _count);
    _setU32(eocd, 12, cd.length);
    _setU32(eocd, 16, cdOffset);
    _write(eocd);
  }

  static (int, Uint8List) _compress(Uint8List data, bool compress) {
    if (!compress) return (0, data);
    final deflated = Uint8List.fromList(
      ZLibEncoder(raw: true, level: 6).convert(data),
    );
    return deflated.length < data.length ? (8, deflated) : (0, data);
  }

  static Uint8List _localHeader({
    required int flags,
    required int method,
    required int time,
    required int date,
    required int crc,
    required int compressed,
    required int size,
    required List<int> name,
  }) {
    final h = Uint8List(30 + name.length);
    _setU32(h, 0, 0x04034b50);
    _setU16(h, 4, 20);
    _setU16(h, 6, flags);
    _setU16(h, 8, method);
    _setU16(h, 10, time);
    _setU16(h, 12, date);
    _setU32(h, 14, crc);
    _setU32(h, 18, compressed);
    _setU32(h, 22, size);
    _setU16(h, 26, name.length);
    h.setRange(30, 30 + name.length, name);
    return h;
  }

  static (int, int) _dosNow() {
    final t = DateTime.now();
    return (
      (t.hour << 11) | (t.minute << 5) | (t.second ~/ 2),
      ((t.year - 1980) << 9) | (t.month << 5) | t.day,
    );
  }

  static void _setU16(Uint8List b, int o, int v) {
    b[o] = v & 0xff;
    b[o + 1] = (v >> 8) & 0xff;
  }

  static void _setU32(Uint8List b, int o, int v) {
    b[o] = v & 0xff;
    b[o + 1] = (v >> 8) & 0xff;
    b[o + 2] = (v >> 16) & 0xff;
    b[o + 3] = (v >> 24) & 0xff;
  }
}
