import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/comic/remote_comic_file.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';

final _bytes = Uint8List.fromList(List.generate(10000, (i) => i * 7 % 256));
final _sha = 'c' * 64;

Book _comic({String sha = ''}) => Book(
  id: 'comic-$_sha',
  version: 'v1',
  title: 'Vector',
  author: 'Unknown',
  description: '',
  language: 'en',
  subjects: const ['Comics'],
  coverUrl: null,
  downloadUrl: '/v1/books/comic-$_sha/download',
  fileSize: _bytes.length,
  sha256: sha.isEmpty ? _sha : sha,
  updatedAt: DateTime.utc(2026, 10, 11),
  format: BookFormat.comic,
);

class _Server {
  final requests = <http.BaseRequest>[];
  bool ignoreRanges = false;
  String etag = '"$_sha"';

  late final client = MockClient.streaming((request, _) async {
    requests.add(request);
    final match = RegExp(
      r'^bytes=(\d+)-(\d+)$',
    ).firstMatch(request.headers['range'] ?? '');
    if (ignoreRanges || match == null) {
      return http.StreamedResponse(
        Stream.value(_bytes),
        200,
        contentLength: _bytes.length,
        headers: {'etag': etag},
      );
    }
    final start = int.parse(match[1]!);
    final end = int.parse(match[2]!) + 1;
    return http.StreamedResponse(
      Stream.value(_bytes.sublist(start, end)),
      206,
      contentLength: end - start,
      headers: {
        'etag': etag,
        'content-range': 'bytes $start-${end - 1}/${_bytes.length}',
      },
    );
  });

  ApiClient get api => ApiClient(baseUrl: 'http://api.test', client: client);
}

void main() {
  test('reads edition-pinned ranges and caches blocks', () async {
    final server = _Server();
    final file = RemoteComicFile(
      book: _comic(),
      client: server.api,
      blockSize: 1024,
      maxRequestBytes: 4096,
    );
    expect(file, isA<ProvisionalBookFile>());
    expect(file.length, _bytes.length);

    expect(await file.readRange(100, 2500), _bytes.sublist(100, 2500));
    // Three missing neighbouring blocks share one request.
    expect(server.requests, hasLength(1));
    final first = server.requests.single;
    expect(first.headers['range'], 'bytes=0-3071');
    expect(first.headers['if-range'], '"$_sha"');
    expect(first.headers['accept'], 'application/vnd.comicbook+zip');

    // Cached blocks answer without the network; only the gap is fetched.
    expect(await file.readRange(1500, 2000), _bytes.sublist(1500, 2000));
    expect(server.requests, hasLength(1));
    expect(await file.readRange(2000, 4500), _bytes.sublist(2000, 4500));
    expect(server.requests, hasLength(2));
    expect(server.requests.last.headers['range'], 'bytes=3072-5119');

    // The short final block.
    expect(await file.readRange(9990, 10000), _bytes.sublist(9990));
    expect(server.requests.last.headers['range'], 'bytes=9216-9999');
    await file.close();
    expect(() => file.readRange(0, 1), throwsStateError);
  });

  test('concurrent reads of one page coalesce into one request', () async {
    final server = _Server();
    final file = RemoteComicFile(
      book: _comic(),
      client: server.api,
      blockSize: 1024,
    );
    final results = await Future.wait([
      file.readRange(0, 3000),
      file.readRange(1000, 2000),
      file.readRange(2500, 3072),
    ]);
    expect(results[0], _bytes.sublist(0, 3000));
    expect(results[1], _bytes.sublist(1000, 2000));
    expect(results[2], _bytes.sublist(2500, 3072));
    expect(server.requests, hasLength(1));
  });

  test('large reads split into bounded requests', () async {
    final server = _Server();
    final file = RemoteComicFile(
      book: _comic(),
      client: server.api,
      blockSize: 1024,
      maxRequestBytes: 4096,
    );
    expect(await file.readRange(0, 10000), _bytes);
    expect(server.requests.map((r) => r.headers['range']), [
      'bytes=0-4095',
      'bytes=4096-8191',
      'bytes=8192-9999',
    ]);
  });

  test('the LRU stays within its byte budget', () async {
    final server = _Server();
    final file = RemoteComicFile(
      book: _comic(),
      client: server.api,
      blockSize: 1024,
      maxCachedBytes: 2048,
    );
    await file.readRange(0, 1024);
    await file.readRange(1024, 2048);
    await file.readRange(2048, 3072);
    await file.readRange(1024, 2048);
    expect(server.requests, hasLength(3));
    // Block 0 was evicted first.
    await file.readRange(0, 10);
    expect(server.requests, hasLength(4));
  });

  test('a 200 fallback fails the read instead of mixing editions', () async {
    final server = _Server()..ignoreRanges = true;
    final file = RemoteComicFile(book: _comic(), client: server.api);
    await expectLater(
      file.readRange(0, 10),
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'INVALID_RANGE'),
      ),
    );
    // Later reads fail the same way without asking again.
    await expectLater(file.readRange(5000, 5010), throwsA(isA<ApiException>()));
    expect(server.requests, hasLength(1));
  });

  test('a changed validator is rejected', () async {
    final server = _Server()..etag = '"${'d' * 64}"';
    final file = RemoteComicFile(book: _comic(), client: server.api);
    await expectLater(
      file.readRange(0, 10),
      throwsA(
        isA<ApiException>().having((e) => e.code, 'code', 'INVALID_RANGE'),
      ),
    );
  });

  test('network errors are retried once, then surface', () async {
    var calls = 0;
    final client = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient((_) async {
        calls++;
        throw http.ClientException('Connection refused');
      }),
    );
    final file = RemoteComicFile(book: _comic(), client: client);
    await expectLater(
      file.readRange(0, 10),
      throwsA(isA<ApiException>().having((e) => e.isNetwork, 'network', true)),
    );
    expect(calls, 2);
  });

  group('LibraryRepository', () {
    Future<(LibraryRepository, String)> library(
      _Server server, {
      required Book book,
    }) async {
      final lib = LibraryRepository(
        store: MemoryKeyValueStore(),
        bookStore: MemoryBookStore(),
        clientForOrigin: (_) => server.api,
      );
      await lib.load();
      await lib.applyCloudEntry(
        book: book,
        origin: 'http://api.test',
        addedAt: DateTime.utc(2026),
      );
      return (
        lib,
        LibraryEntry.identity(book.id, BookSource.api, 'http://api.test'),
      );
    }

    test('an API comic without local bytes reads by range', () async {
      final server = _Server();
      final (lib, id) = await library(server, book: _comic());
      expect(lib.entry(id)!.download.status, DownloadStatus.none);
      expect(lib.canRead(id), isTrue);
      final file = await lib.openForReading(id);
      expect(file.isProvisional, isTrue);
      expect(await file.readRange(10, 20), _bytes.sublist(10, 20));
      await file.close();
    });

    test('an EPUB without local bytes is not readable', () async {
      final server = _Server();
      final epub = Book.fromJson({
        ..._comic().toJson(),
        'id': 'epub-$_sha',
        'format': 'epub',
      });
      final (lib, id) = await library(server, book: epub);
      expect(lib.canRead(id), isFalse);
      await expectLater(lib.openForReading(id), throwsStateError);
    });
  });
}
