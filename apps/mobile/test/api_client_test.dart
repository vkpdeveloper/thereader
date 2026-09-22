import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';

void main() {
  test('normalises base URLs and resolves relative contract URLs', () {
    final c = ApiClient(baseUrl: '127.0.0.1:8787/', client: MockClient((_) async => http.Response('', 404)));
    expect(c.baseUri.toString(), 'http://127.0.0.1:8787');
    expect(c.resolve('/v1/books/x/download').toString(), 'http://127.0.0.1:8787/v1/books/x/download');
    expect(c.resolve('https://cdn.example/cover.jpg').toString(), 'https://cdn.example/cover.jpg');
    expect(() => ApiClient.normalizeBaseUrl('   '), throwsA(isA<ApiException>()));
    expect(() => ApiClient.normalizeBaseUrl('ftp://x'), throwsA(isA<ApiException>()));
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
              }
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
      client: MockClient((_) async => http.Response(
            jsonEncode({'error': {'code': 'NOT_FOUND', 'message': 'Book not found.'}}),
            404,
          )),
    );
    await expectLater(
      c.getBook('nope'),
      throwsA(isA<ApiException>()
          .having((e) => e.code, 'code', 'NOT_FOUND')
          .having((e) => e.message, 'message', 'Book not found.')
          .having((e) => e.isNetwork, 'isNetwork', false)),
    );
  });

  test('marks connection failures as network errors', () async {
    final c = ApiClient(
      baseUrl: 'http://api.test',
      client: MockClient((_) async => throw http.ClientException('Connection refused')),
    );
    await expectLater(
      c.health(),
      throwsA(isA<ApiException>().having((e) => e.isNetwork, 'isNetwork', true)),
    );
  });
}
