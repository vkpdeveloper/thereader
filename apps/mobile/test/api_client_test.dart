import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/models/book.dart';

void main() {
  test('normalises base URLs and resolves relative contract URLs', () {
    final c = ApiClient(
      baseUrl: '127.0.0.1:8787/',
      client: MockClient((_) async => http.Response('', 404)),
    );
    expect(c.baseUri.toString(), 'http://127.0.0.1:8787');
    expect(
      c.resolve('/v1/books/x/download').toString(),
      'http://127.0.0.1:8787/v1/books/x/download',
    );
    expect(
      c.resolve('https://cdn.example/cover.jpg').toString(),
      'https://cdn.example/cover.jpg',
    );
    expect(
      () => ApiClient.normalizeBaseUrl('   '),
      throwsA(isA<ApiException>()),
    );
    expect(
      () => ApiClient.normalizeBaseUrl('ftp://x'),
      throwsA(isA<ApiException>()),
    );
  });

  test('parses a books page and forwards query parameters', () async {
    Uri? seen;
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient((req) async {
        seen = req.url;
        return http.Response(
          jsonEncode({
            'items': [
              {
                'id': 'the-quiet-hour',
                'version': '1',
                'title': 'The Quiet Hour',
                'author': 'The Reader',
                'description': 'd',
                'language': 'en',
                'subjects': ['Essays'],
                'coverUrl': null,
                'downloadUrl': '/v1/books/the-quiet-hour/download',
                'fileSize': 1234,
                'sha256': 'a' * 64,
                'updatedAt': '2026-09-22T00:00:00.000Z',
              },
            ],
            'nextCursor': 'abc',
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    final page = await c.listBooks(query: 'quiet', limit: 10);
    expect(seen!.path, '/v1/books');
    expect(seen!.queryParameters, {'limit': '10', 'q': 'quiet'});
    expect(page.items.single.title, 'The Quiet Hour');
    expect(page.nextCursor, 'abc');
  });

  test('surfaces contract error envelopes', () async {
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient(
        (_) async => http.Response(
          jsonEncode({
            'error': {'code': 'NOT_FOUND', 'message': 'Book not found.'},
          }),
          404,
        ),
      ),
    );
    await expectLater(
      c.getBook('nope'),
      throwsA(
        isA<ApiException>()
            .having((e) => e.code, 'code', 'NOT_FOUND')
            .having((e) => e.message, 'message', 'Book not found.')
            .having((e) => e.isNetwork, 'isNetwork', false),
      ),
    );
  });

  test('marks connection failures as network errors', () async {
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient(
        (_) async => throw http.ClientException('Connection refused'),
      ),
    );
    await expectLater(
      c.health(),
      throwsA(
        isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', true),
      ),
    );
  });

  test('range connection failures use the friendly network envelope', () async {
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient(
        (_) async => throw http.ClientException('Connection refused'),
      ),
    );
    await expectLater(
      c.streamRange(_rangeBook, 0, 4, onChunk: (_) async {}),
      throwsA(
        isA<ApiException>()
            .having((e) => e.code, 'code', 'NETWORK')
            .having((e) => e.isNetwork, 'isNetwork', true)
            .having(
              (e) => e.message,
              'message',
              contains('Nothing is listening'),
            ),
      ),
    );
  });

  test('range connect timeout aborts and closes a late response', () async {
    final transport = _LateRangeClient();
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: transport,
      timeout: const Duration(milliseconds: 5),
    );
    await expectLater(
      c.streamRange(_rangeBook, 0, 4, onChunk: (_) async {}),
      throwsA(
        isA<ApiException>()
            .having((e) => e.code, 'code', 'TIMEOUT')
            .having((e) => e.isNetwork, 'isNetwork', true),
      ),
    );
    await transport.aborted.future.timeout(const Duration(seconds: 1));

    final bodyCancelled = Completer<void>();
    final body = StreamController<List<int>>(
      onCancel: () {
        if (!bodyCancelled.isCompleted) bodyCancelled.complete();
      },
    );
    transport.response.complete(
      http.StreamedResponse(
        body.stream,
        206,
        contentLength: 4,
        headers: {
          'content-range': 'bytes 0-3/4',
          'etag': '"${_rangeBook.sha256}"',
        },
      ),
    );
    await bodyCancelled.future.timeout(const Duration(seconds: 1));
    await body.close();
  });

  test('range body timeout aborts the request and closes the stream', () async {
    final transport = _StalledBodyClient();
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: transport,
      timeout: const Duration(milliseconds: 5),
    );
    await expectLater(
      c.streamRange(_rangeBook, 0, 4, onChunk: (_) async {}),
      throwsA(
        isA<ApiException>()
            .having((e) => e.code, 'code', 'TIMEOUT')
            .having((e) => e.isNetwork, 'isNetwork', true),
      ),
    );
    await Future.wait([
      transport.aborted.future,
      transport.bodyCancelled.future,
    ]).timeout(const Duration(seconds: 1));
    await transport.closeBody();
  });
}

final _rangeBook = Book.fromJson({
  'id': 'range-book',
  'version': '1',
  'title': 'Range Book',
  'author': 'The Reader',
  'description': 'Test fixture',
  'language': 'en',
  'subjects': <String>[],
  'coverUrl': null,
  'downloadUrl': '/v1/books/range-book/download',
  'fileSize': 4,
  'sha256': 'a' * 64,
  'updatedAt': '2026-09-22T00:00:00.000Z',
});

class _LateRangeClient extends http.BaseClient {
  final response = Completer<http.StreamedResponse>();
  final aborted = Completer<void>();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    final trigger = (request as http.AbortableRequest).abortTrigger;
    trigger?.then((_) {
      if (!aborted.isCompleted) aborted.complete();
    });
    return response.future;
  }
}

class _StalledBodyClient extends http.BaseClient {
  _StalledBodyClient() {
    body = StreamController<List<int>>(
      onCancel: () {
        if (!bodyCancelled.isCompleted) bodyCancelled.complete();
      },
    );
  }

  late final StreamController<List<int>> body;
  final aborted = Completer<void>();
  final bodyCancelled = Completer<void>();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final trigger = (request as http.AbortableRequest).abortTrigger;
    trigger?.then((_) {
      if (!aborted.isCompleted) aborted.complete();
    });
    return http.StreamedResponse(
      body.stream,
      206,
      contentLength: 4,
      headers: {
        'content-range': 'bytes 0-3/4',
        'etag': '"${_rangeBook.sha256}"',
      },
    );
  }

  Future<void> closeBody() => body.close();
}
