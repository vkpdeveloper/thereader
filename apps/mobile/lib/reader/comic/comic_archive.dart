import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart' show ZLibDecoder;
import 'package:flutter/foundation.dart' show compute;

import '../../data/comic/comic_pages.dart';
import '../../data/storage/book_store.dart';

class ComicFormatException implements Exception {
  ComicFormatException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// One file in the CBZ's central directory.
class ComicEntry {
  const ComicEntry({
    required this.name,
    required this.method,
    required this.compressedSize,
    required this.size,
    required this.headerOffset,
  });

  /// Normalized entry name (`\` → `/`, no leading slash).
  final String name;
  final int method;
  final int compressedSize;
  final int size;
  final int headerOffset;
}

/// Random access to a CBZ through [BookFile.readRange] only: the central
/// directory is read from the tail, then each page by its own range. That is
/// what lets a comic open while its download is still running.
class ComicArchive {
  ComicArchive._(this._file, this.pages, this._entries);

  BookFile _file;

  /// Page entry names in reading order (docs/comics.md).
  final List<String> pages;
  final Map<String, ComicEntry> _entries;

  /// Native files share one RandomAccessFile; overlapping reads would race.
  Future<void> _lock = Future<void>.value();

  BookFile get file => _file;
  ComicEntry entry(int page) => _entries[pages[page]]!;

  /// Entries above this inflate in a background isolate.
  static const inflateInIsolateAbove = 256 * 1024;

  static const _eocdSig = 0x06054b50;
  static const _zip64LocatorSig = 0x07064b50;
  static const _zip64EocdSig = 0x06064b50;
  static const _centralSig = 0x02014b50;
  static const _localSig = 0x04034b50;

  static Future<ComicArchive> open(BookFile file) async {
    final length = file.length;
    if (length < 22) throw ComicFormatException('This file is not a comic archive.');
    // EOCD (22 bytes) plus the longest possible comment.
    final tailStart = length - (22 + 0xffff) < 0 ? 0 : length - (22 + 0xffff);
    final tail = await file.readRange(tailStart, length);
    final data = ByteData.sublistView(tail);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (data.getUint32(i, Endian.little) == _eocdSig) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw ComicFormatException('This file is not a comic archive.');
    var count = data.getUint16(eocd + 10, Endian.little);
    var cdSize = data.getUint32(eocd + 12, Endian.little);
    var cdOffset = data.getUint32(eocd + 16, Endian.little);
    if (count == 0xffff || cdSize == 0xffffffff || cdOffset == 0xffffffff) {
      final locator = eocd - 20;
      if (locator >= 0 && data.getUint32(locator, Endian.little) == _zip64LocatorSig) {
        final at = data.getUint64(locator + 8, Endian.little);
        final z = ByteData.sublistView(await file.readRange(at, at + 56));
        if (z.getUint32(0, Endian.little) != _zip64EocdSig) {
          throw ComicFormatException('The comic archive directory is damaged.');
        }
        count = z.getUint64(32, Endian.little);
        cdSize = z.getUint64(40, Endian.little);
        cdOffset = z.getUint64(48, Endian.little);
      }
    }
    if (cdOffset + cdSize > length) {
      throw ComicFormatException('The comic archive directory is damaged.');
    }
    // Small archives already have their directory inside the tail read.
    final directory = cdOffset >= tailStart
        ? Uint8List.sublistView(tail, cdOffset - tailStart, cdOffset - tailStart + cdSize)
        : await file.readRange(cdOffset, cdOffset + cdSize);
    final entries = _parseDirectory(directory, count);
    final pages = orderPages(entries.keys);
    if (pages.isEmpty) throw ComicFormatException('This comic has no pages.');
    return ComicArchive._(file, pages, entries);
  }

  static Map<String, ComicEntry> _parseDirectory(Uint8List bytes, int count) {
    final data = ByteData.sublistView(bytes);
    final entries = <String, ComicEntry>{};
    var at = 0;
    for (var i = 0; i < count; i++) {
      if (at + 46 > bytes.length || data.getUint32(at, Endian.little) != _centralSig) {
        throw ComicFormatException('The comic archive directory is damaged.');
      }
      final flags = data.getUint16(at + 8, Endian.little);
      final method = data.getUint16(at + 10, Endian.little);
      var compressed = data.getUint32(at + 20, Endian.little);
      var size = data.getUint32(at + 24, Endian.little);
      final nameLength = data.getUint16(at + 28, Endian.little);
      final extraLength = data.getUint16(at + 30, Endian.little);
      final commentLength = data.getUint16(at + 32, Endian.little);
      var offset = data.getUint32(at + 42, Endian.little);
      final nameStart = at + 46;
      final extraStart = nameStart + nameLength;
      final next = extraStart + extraLength + commentLength;
      if (next > bytes.length) {
        throw ComicFormatException('The comic archive directory is damaged.');
      }
      if (flags & 1 != 0) throw ComicFormatException('This comic is encrypted.');
      // ZIP64 extra field: the values that overflowed, in this order.
      var e = extraStart;
      while (e + 4 <= extraStart + extraLength) {
        final id = data.getUint16(e, Endian.little);
        final len = data.getUint16(e + 2, Endian.little);
        if (id == 0x0001) {
          var f = e + 4;
          if (size == 0xffffffff && f + 8 <= e + 4 + len) {
            size = data.getUint64(f, Endian.little);
            f += 8;
          }
          if (compressed == 0xffffffff && f + 8 <= e + 4 + len) {
            compressed = data.getUint64(f, Endian.little);
            f += 8;
          }
          if (offset == 0xffffffff && f + 8 <= e + 4 + len) {
            offset = data.getUint64(f, Endian.little);
          }
        }
        e += 4 + len;
      }
      final name = normalizeEntryName(
        utf8.decode(Uint8List.sublistView(bytes, nameStart, extraStart), allowMalformed: true),
      );
      if (name.isNotEmpty && !name.endsWith('/')) {
        entries.putIfAbsent(
          name,
          () => ComicEntry(
            name: name,
            method: method,
            compressedSize: compressed,
            size: size,
            headerOffset: offset,
          ),
        );
      }
      at = next;
    }
    return entries;
  }

  /// The decoded bytes of page [page]. Throws on a failed range read so the
  /// caller can retry that page alone.
  Future<Uint8List> readPage(int page) => readEntry(entry(page));

  Future<Uint8List> readEntry(ComicEntry e) async {
    if (e.method != 0 && e.method != 8) {
      throw ComicFormatException('This page uses an unsupported compression.');
    }
    final raw = await _locked(() => _readData(e));
    if (e.method == 0) return raw;
    if (raw.length > inflateInIsolateAbove) {
      return compute(_inflate, raw);
    }
    return _inflate(raw);
  }

  /// Local header and data in one range when the header is the usual size, so
  /// a streamed page costs a single request.
  Future<Uint8List> _readData(ComicEntry e) async {
    final length = _file.length;
    final start = e.headerOffset;
    var end = start + 30 + e.name.length * 4 + 64 + e.compressedSize;
    if (end > length) end = length;
    var chunk = await _file.readRange(start, end);
    final data = ByteData.sublistView(chunk);
    if (chunk.length < 30 || data.getUint32(0, Endian.little) != _localSig) {
      throw ComicFormatException('The comic archive is damaged.');
    }
    final dataStart =
        30 + data.getUint16(26, Endian.little) + data.getUint16(28, Endian.little);
    final dataEnd = dataStart + e.compressedSize;
    if (start + dataEnd > length) throw ComicFormatException('The comic archive is damaged.');
    if (dataEnd > chunk.length) {
      final rest = await _file.readRange(start + chunk.length, start + dataEnd);
      chunk = (Uint8List(chunk.length + rest.length)
        ..setRange(0, chunk.length, chunk)
        ..setRange(chunk.length, chunk.length + rest.length, rest));
    }
    return Uint8List.sublistView(chunk, dataStart, dataEnd);
  }

  Future<T> _locked<T>(Future<T> Function() run) {
    final result = _lock.then((_) => run());
    _lock = result.then((_) {}, onError: (_) {});
    return result;
  }

  /// Switches to another copy of the same bytes, e.g. the verified local file
  /// once a background download finishes. Reads already queued use the new one.
  Future<void> replaceFile(BookFile file) async {
    final old = _file;
    await _locked(() async => _file = file);
    await old.close();
  }

  Future<void> close() => _locked(() => _file.close());
}

Uint8List _inflate(Uint8List raw) => ZLibDecoder().decodeBytes(raw, raw: true);
