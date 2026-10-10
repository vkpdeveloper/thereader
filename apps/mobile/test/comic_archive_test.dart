import 'dart:math';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/reader/comic/comic_archive.dart';

/// Range-only file: reading it whole is a test failure.
class RangeOnlyFile implements BookFile {
  RangeOnlyFile(this.bytes);
  final Uint8List bytes;
  final List<(int, int)> reads = [];
  int failNext = 0;
  bool closed = false;

  @override
  int get length => bytes.length;
  @override
  String? get path => null;

  @override
  Future<Uint8List> readRange(int start, int end) async {
    await Future<void>.delayed(Duration.zero);
    if (failNext > 0) {
      failNext--;
      throw StateError('range request failed');
    }
    reads.add((start, end));
    return Uint8List.sublistView(bytes, start, min(end, bytes.length));
  }

  @override
  Future<Uint8List> readAll() => throw StateError('readAll must not be used for comics');

  @override
  Future<void> close() async => closed = true;
}

Uint8List noise(int length, int seed) {
  final r = Random(seed);
  return Uint8List.fromList(List.generate(length, (_) => r.nextInt(256)));
}

/// Compressible but not trivially (four bits of entropy a byte): the
/// deflated entry is still large.
Uint8List pattern(int length) {
  final r = Random(7);
  return Uint8List.fromList(List.generate(length, (_) => r.nextInt(16) * 17));
}

Uint8List buildCbz(Map<String, (Uint8List, bool deflate)> entries, {String? comment}) {
  final archive = Archive();
  for (final MapEntry(key: name, value: (bytes, deflate)) in entries.entries) {
    archive.add(
      deflate
          ? (ArchiveFile.bytes(name, bytes)..compression = CompressionType.deflate)
          : ArchiveFile.noCompress(name, bytes.length, bytes),
    );
  }
  if (comment != null) archive.comment = comment;
  return ZipEncoder().encodeBytes(archive);
}

void main() {
  final stored = noise(3000, 1);
  final small = pattern(5000);
  final large = pattern(900 * 1024);
  final cover = noise(1200, 2);

  Uint8List sample({String? comment}) => buildCbz({
    'Comic/page10.jpg': (stored, false),
    'Comic/page2.png': (small, true),
    'Comic/page3.webp': (large, true),
    r'Comic\Cover.jpg': (cover, false),
    'Comic/ComicInfo.xml': (Uint8List.fromList('<ComicInfo/>'.codeUnits), true),
    '__MACOSX/Comic/._page2.png': (noise(40, 3), false),
    'Comic/.hidden.jpg': (noise(40, 4), false),
  }, comment: comment);

  test('reads the directory from the tail and orders pages by the contract', () async {
    final file = RangeOnlyFile(sample(comment: 'a comment that shifts the EOCD'));
    final archive = await ComicArchive.open(file);
    expect(archive.pages, [
      'Comic/Cover.jpg',
      'Comic/page2.png',
      'Comic/page3.webp',
      'Comic/page10.jpg',
    ]);
    // Small archive: the tail read already held the whole directory.
    expect(file.reads, hasLength(1));
    expect(file.reads.single.$2, file.length);
  });

  test('stored and deflated pages read back exactly, each by its own range', () async {
    final file = RangeOnlyFile(sample());
    final archive = await ComicArchive.open(file);
    file.reads.clear();
    expect(await archive.readPage(0), cover);
    expect(await archive.readPage(1), small);
    expect(await archive.readPage(3), stored);
    // One request per page: header and data share a range.
    expect(file.reads, hasLength(3));
    // Above the threshold, inflate runs off the UI isolate and still matches.
    expect(archive.entry(2).compressedSize, greaterThan(ComicArchive.inflateInIsolateAbove));
    expect(await archive.readPage(2), large);
  });

  test('concurrent page reads are serialised over the shared file', () async {
    final file = RangeOnlyFile(sample());
    final archive = await ComicArchive.open(file);
    final pages = await Future.wait([for (var i = 0; i < 4; i++) archive.readPage(i)]);
    expect(pages[0], cover);
    expect(pages[3], stored);
  });

  test('a failed range read fails only that page, and a retry succeeds', () async {
    final file = RangeOnlyFile(sample());
    final archive = await ComicArchive.open(file);
    file.failNext = 1;
    await expectLater(archive.readPage(1), throwsStateError);
    expect(await archive.readPage(3), stored);
    expect(await archive.readPage(1), small);
  });

  test('large directories are fetched with one extra range', () async {
    final entries = <String, (Uint8List, bool)>{
      for (var i = 0; i < 1500; i++) 'Comic/a very long folder name/page $i.jpg': (Uint8List(64), false),
    };
    final file = RangeOnlyFile(buildCbz(entries));
    final archive = await ComicArchive.open(file);
    expect(archive.pages, hasLength(1500));
    expect(archive.pages[2], 'Comic/a very long folder name/page 2.jpg');
    expect(file.reads, hasLength(2));
  });

  test('switching to the downloaded copy keeps reading and closes the stream', () async {
    final bytes = sample();
    final streaming = RangeOnlyFile(bytes);
    final archive = await ComicArchive.open(streaming);
    final local = RangeOnlyFile(bytes);
    await archive.replaceFile(local);
    expect(streaming.closed, isTrue);
    expect(await archive.readPage(3), stored);
    expect(local.reads, isNotEmpty);
  });

  test('encrypted entries, non-archives and empty comics are refused', () async {
    final bytes = sample();
    // Set flag bit 0 on the first central directory record.
    final data = ByteData.sublistView(bytes);
    for (var i = bytes.length - 22; i >= 0; i--) {
      if (data.getUint32(i, Endian.little) == 0x02014b50) {
        data.setUint16(i + 8, data.getUint16(i + 8, Endian.little) | 1, Endian.little);
      }
    }
    await expectLater(
      ComicArchive.open(RangeOnlyFile(bytes)),
      throwsA(isA<ComicFormatException>().having((e) => e.message, 'message', contains('encrypted'))),
    );
    await expectLater(
      ComicArchive.open(RangeOnlyFile(noise(4096, 9))),
      throwsA(isA<ComicFormatException>()),
    );
    await expectLater(
      ComicArchive.open(RangeOnlyFile(buildCbz({'notes.txt': (noise(10, 5), false)}))),
      throwsA(isA<ComicFormatException>().having((e) => e.message, 'message', contains('no pages'))),
    );
  });
}
