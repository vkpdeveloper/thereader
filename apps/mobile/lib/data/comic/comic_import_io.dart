/// Comic imports on native platforms (docs/comics.md): a CBZ is validated and
/// stored as picked; a CBR is extracted by the native RAR library into a
/// fresh directory and repacked into the contract's deterministic CBZ, so two
/// devices importing the same CBR upload the same bytes.
library;

import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:archive/archive.dart' show getCrc32;
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:rar/rar.dart';

import '../covers/cover_validation.dart';
import 'cbz_writer.dart';
import 'comic_info.dart';
import 'comic_pages.dart';

/// Extracts regular file i of a RAR archive to `<destination>/i` and returns
/// the archive names in that order (see `package:rar`). Injected by tests.
typedef RarExtractor =
    Future<List<String>> Function(
      String archive,
      String destination, {
      required int maxBytes,
    });

/// What the first bytes of [path] say it is.
Future<ComicArchiveKind> sniffComicFile(String path) async {
  final file = await File(path).open();
  try {
    return sniffComicArchive(await file.read(512));
  } finally {
    await file.close();
  }
}

/// A CBZ ready for [inspectComic]: [sourcePath] itself when it is a ZIP, else
/// a repacked `comic.cbz` inside [workDir] (which the caller owns and
/// removes). Refuses CB7, CBT, PDF and encrypted archives with clear messages.
Future<String> prepareComic(
  String sourcePath,
  Directory workDir, {
  RarExtractor extract = extractRar,
}) async {
  final kind = await sniffComicFile(sourcePath);
  if (kind == ComicArchiveKind.zip) return sourcePath;
  if (kind != ComicArchiveKind.rar) {
    throw FormatException(unsupportedComicMessage(kind));
  }
  final pages = await Directory(p.join(workDir.path, 'pages')).create();
  try {
    final List<String> names;
    try {
      names = await extract(sourcePath, pages.path, maxBytes: maxComicBytes);
    } on RarException catch (e) {
      throw FormatException(switch (e.failure) {
        RarFailure.encrypted => 'Password-protected comics are not supported.',
        RarFailure.tooLarge => 'Comics are limited to 1 GiB.',
        RarFailure.unsupported => 'CBR comics cannot be opened on this device.',
        RarFailure.damaged => 'This CBR is damaged and cannot be read.',
      });
    }
    final output = p.join(workDir.path, 'comic.cbz');
    await Isolate.run(() => _repack(pages.path, names, output));
    return output;
  } finally {
    // Extracted pages can be as large as the comic: free them before the
    // repacked copy is hashed and stored.
    await pages.delete(recursive: true);
  }
}

Future<CbzResult> _repack(String dir, List<String> names, String output) async {
  final sources = <String, CbzSource>{};
  for (var i = 0; i < names.length; i++) {
    final name = normalizeEntryName(names[i]);
    // Traversal names are never pages; dropping them also keeps a stray
    // `../ComicInfo.xml` out of the archive the API validates.
    if (name.contains('\x00') || name.split('/').contains('..')) continue;
    final file = File(p.join(dir, '$i'));
    final source = CbzSource(
      name: name,
      size: file.lengthSync(),
      open: file.openRead,
    );
    // Later duplicates (RAR updates append) replace earlier ones.
    sources[name] = source;
  }
  final layout = repackLayout(sources.keys);
  final kept = [
    for (final name in [...layout.pages, ?layout.comicInfo]) sources[name]!,
  ];
  final out = await File(output).open(mode: FileMode.writeOnly);
  try {
    final result = await writeDeterministicCbz(kept, out.writeFrom);
    await out.flush();
    return result;
  } finally {
    await out.close();
  }
}

/// Validates a CBZ the way the API's completion check does (so an import
/// never fails later with 422 INVALID_COMIC) and returns `Book.fromJson`
/// fields: `sha256`, `fileSize`, `format`, ComicInfo metadata with a
/// [fileName] fallback, and `coverBytes` (page 1) when it is a usable cover.
Future<Map<String, dynamic>> inspectComic(String path, String fileName) =>
    Isolate.run(() => _inspect(path, fileName));

const _maxDirectoryBytes = 4 * 1024 * 1024;
const _maxComicInfoBytes = 1024 * 1024;
const _maxCoverBytes = 4 * 1024 * 1024;

class _Entry {
  _Entry(this.method, this.crc, this.compressed, this.size, this.offset);
  final int method;
  final int crc;
  final int compressed;
  final int size;
  final int offset;
}

Future<Map<String, dynamic>> _inspect(String path, String fileName) async {
  const damaged = FormatException('This comic is damaged or not a CBZ.');
  final file = File(path);
  final size = await file.length();
  if (size < 22) throw damaged;
  if (size > maxComicBytes) {
    throw const FormatException('Comics are limited to 1 GiB.');
  }
  final digest = await sha256.bind(file.openRead()).first;
  final raf = await file.open();
  try {
    Future<Uint8List> read(int start, int length) async {
      await raf.setPosition(start);
      final bytes = await raf.read(length);
      if (bytes.length != length) throw damaged;
      return bytes;
    }

    final head = ByteData.sublistView(await read(0, 4));
    if (head.getUint32(0, Endian.little) != 0x04034b50) throw damaged;
    final tailStart = size > 65557 ? size - 65557 : 0;
    final tail = ByteData.sublistView(await read(tailStart, size - tailStart));
    var eocd = -1;
    for (var i = tail.lengthInBytes - 22; i >= 0; i--) {
      if (tail.getUint32(i, Endian.little) == 0x06054b50 &&
          i + 22 + tail.getUint16(i + 20, Endian.little) ==
              tail.lengthInBytes) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw damaged;
    final count = tail.getUint16(eocd + 10, Endian.little);
    final dirSize = tail.getUint32(eocd + 12, Endian.little);
    final dirOffset = tail.getUint32(eocd + 16, Endian.little);
    if (count > maxComicEntries && count != 0xffff) {
      throw const FormatException('Comics are limited to 10,000 files.');
    }
    if (count == 0 ||
        count == 0xffff ||
        dirOffset == 0xffffffff ||
        tail.getUint16(eocd + 4, Endian.little) != 0 ||
        tail.getUint16(eocd + 6, Endian.little) != 0 ||
        tail.getUint16(eocd + 8, Endian.little) != count ||
        dirSize > _maxDirectoryBytes ||
        dirOffset + dirSize > size) {
      throw const FormatException('This CBZ uses an unsupported ZIP layout.');
    }
    final directory = ByteData.sublistView(await read(dirOffset, dirSize));
    final names = const Utf8Decoder();
    final entries = <String, _Entry>{};
    var at = 0;
    for (var i = 0; i < count; i++) {
      if (at + 46 > dirSize ||
          directory.getUint32(at, Endian.little) != 0x02014b50) {
        throw damaged;
      }
      final flags = directory.getUint16(at + 8, Endian.little);
      final method = directory.getUint16(at + 10, Endian.little);
      final compressed = directory.getUint32(at + 20, Endian.little);
      final uncompressed = directory.getUint32(at + 24, Endian.little);
      final nameLength = directory.getUint16(at + 28, Endian.little);
      final end =
          at +
          46 +
          nameLength +
          directory.getUint16(at + 30, Endian.little) +
          directory.getUint16(at + 32, Endian.little);
      final offset = directory.getUint32(at + 42, Endian.little);
      if (end > dirSize) throw damaged;
      if ((flags & 1) != 0) {
        throw const FormatException(
          'Password-protected comics are not supported.',
        );
      }
      if (compressed == 0xffffffff ||
          uncompressed == 0xffffffff ||
          offset == 0xffffffff) {
        throw const FormatException('This CBZ uses an unsupported ZIP layout.');
      }
      if (method != 0 && method != 8) {
        throw const FormatException(
          'This CBZ uses an unsupported compression method.',
        );
      }
      final String raw;
      try {
        raw = names.convert(
          Uint8List.sublistView(directory, at + 46, at + 46 + nameLength),
        );
      } on FormatException {
        throw const FormatException(
          'This comic contains unreadable file names.',
        );
      }
      final name = normalizeEntryName(raw);
      if (raw.length > 1024 ||
          name.isEmpty ||
          raw.contains('\x00') ||
          name.split('/').contains('..')) {
        throw const FormatException('This comic contains unsafe file names.');
      }
      if (entries.containsKey(name)) {
        throw const FormatException('The comic contains duplicate file names.');
      }
      if (offset >= dirOffset) throw damaged;
      entries[name] = _Entry(
        method,
        directory.getUint32(at + 16, Endian.little),
        compressed,
        uncompressed,
        offset,
      );
      at = end;
    }
    if (at != dirSize) throw damaged;
    final layout = repackLayout(entries.keys);
    if (layout.pages.isEmpty) {
      throw const FormatException('This comic has no page images.');
    }

    Future<Uint8List?> entry(String name, int limit) async {
      final e = entries[name]!;
      if (e.size > limit || e.compressed > limit) return null;
      final local = ByteData.sublistView(await read(e.offset, 30));
      if (local.getUint32(0, Endian.little) != 0x04034b50) throw damaged;
      final start =
          e.offset +
          30 +
          local.getUint16(26, Endian.little) +
          local.getUint16(28, Endian.little);
      if (start + e.compressed > dirOffset) throw damaged;
      final data = await read(start, e.compressed);
      final Uint8List bytes;
      if (e.method == 0) {
        bytes = data;
      } else {
        final out = _BoundedSink(e.size);
        try {
          final inflate = ZLibDecoder(raw: true).startChunkedConversion(out);
          for (var i = 0; i < data.length; i += 64 * 1024) {
            inflate.add(
              Uint8List.sublistView(data, i, _min(data.length, i + 64 * 1024)),
            );
          }
          inflate.close();
        } catch (_) {
          throw damaged;
        }
        bytes = out.bytes.takeBytes();
      }
      if (bytes.length != e.size || getCrc32(bytes) != e.crc) throw damaged;
      return bytes;
    }

    String? comicInfo;
    if (layout.comicInfo case final name?) {
      try {
        if (await entry(name, _maxComicInfoBytes) case final bytes?) {
          comicInfo = utf8.decode(bytes, allowMalformed: true);
        }
      } on FormatException {
        // Broken metadata falls back to the file name; pages decide validity.
      }
    }
    // Like the API: page 1 must read back intact when it is small enough to
    // be the cover; an image the cover cache refuses just means no cover.
    var cover = await entry(layout.pages.first, _maxCoverBytes);
    if (cover != null && !validCoverBytes(cover)) cover = null;
    return {
      ...comicMetadata(comicInfoXml: comicInfo, fileName: fileName),
      'sha256': digest.toString(),
      'fileSize': size,
      'format': 'comic',
      'coverBytes': ?cover,
    };
  } finally {
    await raf.close();
  }
}

class _BoundedSink implements Sink<List<int>> {
  _BoundedSink(this.limit);
  final int limit;
  final bytes = BytesBuilder(copy: false);
  @override
  void add(List<int> chunk) {
    if (bytes.length + chunk.length > limit) {
      throw const FormatException('A comic entry is larger than it declares.');
    }
    bytes.add(chunk);
  }

  @override
  void close() {}
}

int _min(int a, int b) => a < b ? a : b;
