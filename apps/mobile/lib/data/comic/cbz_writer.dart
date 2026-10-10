/// Archive sniffing and the deterministic CBR → CBZ repack of docs/comics.md
/// ("Stored format: CBZ"). Pure Dart: entry bytes arrive as streams, output
/// leaves through a callback, so a comic of hundreds of MB never sits in
/// memory and the same code reproduces the contract's reference vector.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart' show getCrc32;
import 'package:crypto/crypto.dart';

import 'comic_pages.dart';

/// Comics are refused above this size (the API limit).
const maxComicBytes = 1024 * 1024 * 1024;

/// The API refuses comics with more entries than this.
const maxComicEntries = 10000;

enum ComicArchiveKind { zip, rar, sevenZip, tar, pdf, unknown }

/// What the first bytes of a file say it is. Magic bytes decide, not the
/// extension: a `.cbr` that is a ZIP is a CBZ and vice versa.
ComicArchiveKind sniffComicArchive(List<int> head) {
  bool startsWith(List<int> magic, [int at = 0]) {
    if (head.length < at + magic.length) return false;
    for (var i = 0; i < magic.length; i++) {
      if (head[at + i] != magic[i]) return false;
    }
    return true;
  }

  if (startsWith(const [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(const [0x50, 0x4b, 0x05, 0x06])) {
    return ComicArchiveKind.zip;
  }
  // RAR 1.5–4.x `Rar!\x1a\x07\x00`, RAR 5 `Rar!\x1a\x07\x01\x00`.
  if (startsWith(const [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) ||
      startsWith(const [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])) {
    return ComicArchiveKind.rar;
  }
  if (startsWith(const [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return ComicArchiveKind.sevenZip;
  }
  if (startsWith(const [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return ComicArchiveKind.pdf;
  }
  if (startsWith(ascii.encode('ustar'), 257)) return ComicArchiveKind.tar;
  return ComicArchiveKind.unknown;
}

/// The user-facing refusal for an archive that is not a CBZ or CBR.
String unsupportedComicMessage(ComicArchiveKind kind) => switch (kind) {
  ComicArchiveKind.sevenZip =>
    'CB7 (7-Zip) comics are not supported. Convert it to CBZ or CBR.',
  ComicArchiveKind.tar =>
    'CBT (tar) comics are not supported. Convert it to CBZ or CBR.',
  ComicArchiveKind.pdf =>
    'This comic is a PDF. Only CBZ and CBR comics are supported.',
  _ => 'This file is not a CBZ or CBR comic.',
};

/// One entry of a repacked CBZ: its archive name and a way to (re)read its
/// bytes. The writer reads each source twice: once for the CRC-32 that the
/// local header must carry (no data descriptors), once to copy it.
class CbzSource {
  const CbzSource({required this.name, required this.size, required this.open});
  final String name;
  final int size;
  final Stream<List<int>> Function() open;
}

class CbzResult {
  const CbzResult({
    required this.size,
    required this.sha256,
    required this.pages,
    this.comicInfo,
  });
  final int size;
  final String sha256;

  /// Page names in reading order, as stored.
  final List<String> pages;
  final String? comicInfo;
}

/// Entry names a repack keeps, in stored order: the pages, then one
/// `ComicInfo.xml`. [names] must already be normalized file names.
({List<String> pages, String? comicInfo}) repackLayout(
  Iterable<String> names,
) => (pages: orderPages(names), comicInfo: pickComicInfo(names));

/// Writes [sources] (normalized names) as the contract's deterministic CBZ:
/// stored entries, fixed time/date/attributes, UTF-8 names, no extras, no
/// ZIP64. Throws [FormatException] for comics without pages or over a limit.
Future<CbzResult> writeDeterministicCbz(
  List<CbzSource> sources,
  Future<void> Function(List<int> bytes) write, {
  int maxBytes = maxComicBytes,
}) async {
  final byName = <String, CbzSource>{};
  for (final source in sources) {
    if (byName.containsKey(source.name)) {
      throw const FormatException('The comic contains duplicate file names.');
    }
    byName[source.name] = source;
  }
  final layout = repackLayout(byName.keys);
  if (layout.pages.isEmpty) {
    throw const FormatException('This comic has no page images.');
  }
  final order = [...layout.pages, ?layout.comicInfo];
  if (order.length > maxComicEntries) {
    throw const FormatException('This comic has more than 10,000 pages.');
  }

  final digest = _DigestSink();
  final hash = sha256.startChunkedConversion(digest);
  var offset = 0;
  Future<void> emit(List<int> bytes) async {
    offset += bytes.length;
    if (offset > maxBytes) {
      throw const FormatException('Comics are limited to 1 GiB.');
    }
    hash.add(bytes);
    await write(bytes);
  }

  final central = BytesBuilder(copy: false);
  for (final name in order) {
    final source = byName[name]!;
    final nameBytes = utf8.encode(name);
    if (nameBytes.length > 0xffff) {
      throw const FormatException('A comic page has an overlong name.');
    }
    var crc = 0;
    var counted = 0;
    await for (final chunk in source.open()) {
      crc = getCrc32(chunk, crc);
      counted += chunk.length;
    }
    if (counted != source.size) {
      throw const FormatException('A comic page changed while converting.');
    }
    if (offset + 30 + nameBytes.length + source.size > maxBytes) {
      throw const FormatException('Comics are limited to 1 GiB.');
    }
    final headerOffset = offset;
    await emit(_localHeader(crc, source.size, nameBytes));
    var copied = 0;
    var copyCrc = 0;
    await for (final chunk in source.open()) {
      copied += chunk.length;
      copyCrc = getCrc32(chunk, copyCrc);
      await emit(chunk);
    }
    if (copied != source.size || copyCrc != crc) {
      throw const FormatException('A comic page changed while converting.');
    }
    central.add(_centralHeader(crc, source.size, nameBytes, headerOffset));
  }
  final directory = central.takeBytes();
  final directoryOffset = offset;
  await emit(directory);
  await emit(_endOfDirectory(order.length, directory.length, directoryOffset));
  hash.close();
  return CbzResult(
    size: offset,
    sha256: digest.value!.toString(),
    pages: layout.pages,
    comicInfo: layout.comicInfo,
  );
}

const _versionNeeded = 10;
const _versionMadeBy = 10;
const _utf8Flag = 0x0800;
const _dosTime = 0x0000;
const _dosDate = 0x0021;

Uint8List _localHeader(int crc, int size, List<int> name) {
  final data = ByteData(30 + name.length)
    ..setUint32(0, 0x04034b50, Endian.little)
    ..setUint16(4, _versionNeeded, Endian.little)
    ..setUint16(6, _utf8Flag, Endian.little)
    ..setUint16(8, 0, Endian.little)
    ..setUint16(10, _dosTime, Endian.little)
    ..setUint16(12, _dosDate, Endian.little)
    ..setUint32(14, crc, Endian.little)
    ..setUint32(18, size, Endian.little)
    ..setUint32(22, size, Endian.little)
    ..setUint16(26, name.length, Endian.little)
    ..setUint16(28, 0, Endian.little);
  final bytes = data.buffer.asUint8List();
  bytes.setRange(30, 30 + name.length, name);
  return bytes;
}

Uint8List _centralHeader(int crc, int size, List<int> name, int offset) {
  final data = ByteData(46 + name.length)
    ..setUint32(0, 0x02014b50, Endian.little)
    ..setUint16(4, _versionMadeBy, Endian.little)
    ..setUint16(6, _versionNeeded, Endian.little)
    ..setUint16(8, _utf8Flag, Endian.little)
    ..setUint16(10, 0, Endian.little)
    ..setUint16(12, _dosTime, Endian.little)
    ..setUint16(14, _dosDate, Endian.little)
    ..setUint32(16, crc, Endian.little)
    ..setUint32(20, size, Endian.little)
    ..setUint32(24, size, Endian.little)
    ..setUint16(28, name.length, Endian.little)
    // Extra, comment, disk number, internal and external attributes: 0.
    ..setUint32(42, offset, Endian.little);
  final bytes = data.buffer.asUint8List();
  bytes.setRange(46, 46 + name.length, name);
  return bytes;
}

Uint8List _endOfDirectory(int entries, int size, int offset) {
  final data = ByteData(22)
    ..setUint32(0, 0x06054b50, Endian.little)
    ..setUint16(8, entries, Endian.little)
    ..setUint16(10, entries, Endian.little)
    ..setUint32(12, size, Endian.little)
    ..setUint32(16, offset, Endian.little);
  return data.buffer.asUint8List();
}

class _DigestSink implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}
