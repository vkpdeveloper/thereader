import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/download/downloader.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/storage/book_store_web.dart';

Book bookFor(List<int> bytes, {int? sizeOverride, String? shaOverride}) => Book(
      id: 'test-book',
      version: '1',
      title: 'Test',
      author: 'The Reader',
      description: '',
      language: 'en',
      subjects: const [],
      coverUrl: null,
      downloadUrl: '/v1/books/test-book/download',
      fileSize: sizeOverride ?? bytes.length,
      sha256: shaOverride ?? sha256.convert(bytes).toString(),
      updatedAt: DateTime.utc(2026, 9, 22),
    );

Stream<List<int>> chunked(List<int> bytes, int size) async* {
  for (var i = 0; i < bytes.length; i += size) {
    yield bytes.sublist(i, (i + size).clamp(0, bytes.length));
  }
}

void main() {
  final payload = utf8.encode('x' * 10000);

  test('commits the file only when size and sha256 match', () async {
    final store = MemoryBookStore();
    final downloader = Downloader(store: store);
    final progress = <int>[];
    final path = await downloader.download(
      book: bookFor(payload),
      source: DownloadStream(stream: chunked(payload, 1000), contentLength: payload.length),
      onProgress: (r, _) => progress.add(r),
      isCancelled: () => false,
    );
    expect(await store.exists(path), isTrue);
    expect(await store.sizeOf(path), payload.length);
    expect(progress.last, payload.length);
  });

  test('rejects a checksum mismatch and leaves nothing behind', () async {
    final store = MemoryBookStore();
    final downloader = Downloader(store: store);
    await expectLater(
      downloader.download(
        book: bookFor(payload, shaOverride: 'f' * 64),
        source: DownloadStream(stream: chunked(payload, 4096), contentLength: payload.length),
        onProgress: (_, _) {},
        isCancelled: () => false,
      ),
      throwsA(isA<DownloadFailure>().having((f) => f.code, 'code', 'CHECKSUM_MISMATCH')),
    );
    expect(store.files, isEmpty);
  });

  test('rejects a truncated stream', () async {
    final store = MemoryBookStore();
    final downloader = Downloader(store: store);
    await expectLater(
      downloader.download(
        book: bookFor(payload),
        source: DownloadStream(stream: chunked(payload.sublist(0, 5000), 4096), contentLength: null),
        onProgress: (_, _) {},
        isCancelled: () => false,
      ),
      throwsA(isA<DownloadFailure>().having((f) => f.code, 'code', 'SIZE_MISMATCH')),
    );
    expect(store.files, isEmpty);
  });

  test('rejects a Content-Length that disagrees with the catalog', () async {
    final store = MemoryBookStore();
    final downloader = Downloader(store: store);
    await expectLater(
      downloader.download(
        book: bookFor(payload),
        source: DownloadStream(stream: chunked(payload, 4096), contentLength: payload.length + 1),
        onProgress: (_, _) {},
        isCancelled: () => false,
      ),
      throwsA(isA<DownloadFailure>().having((f) => f.code, 'code', 'SIZE_MISMATCH')),
    );
  });

  test('cancellation discards partial data', () async {
    final store = MemoryBookStore();
    final downloader = Downloader(store: store);
    var chunks = 0;
    Stream<List<int>> counting() async* {
      await for (final c in chunked(payload, 1000)) {
        chunks++;
        yield c;
      }
    }

    await expectLater(
      downloader.download(
        book: bookFor(payload),
        source: DownloadStream(stream: counting(), contentLength: payload.length),
        onProgress: (_, _) {},
        isCancelled: () => chunks >= 3,
      ),
      throwsA(isA<DownloadCancelled>()),
    );
    expect(store.files, isEmpty);
  });
}
