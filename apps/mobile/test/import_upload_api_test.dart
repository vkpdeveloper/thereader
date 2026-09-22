import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/import/upload_api.dart';
import 'package:thereader/data/models/book.dart';

Book book(List<int> bytes) => Book(
  id: 'epub-test',
  version: '1',
  title: 'Fixture',
  author: 'Author',
  description: '',
  language: 'en',
  subjects: const [],
  coverUrl: null,
  downloadUrl: '/v1/books/epub-test/download',
  fileSize: bytes.length,
  sha256: sha256.convert(bytes).toString(),
  updatedAt: DateTime.utc(2026),
);

void main() {
  test(
    'multipart retries skip acknowledged parts and stream bounded disk ranges',
    () async {
      const partSize = 8 * 1024 * 1024;
      const fileSize = 8 * partSize + 17;
      final publication = Book.fromJson({
        ...book([1]).toJson(),
        'fileSize': fileSize,
      });
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final accepted = <int, String>{for (var i = 1; i <= 7; i++) i: 'etag-$i'};
      final requests = <int>[];
      final ranges = <(int, int)>[];
      var failLast = true;
      var maximumChunk = 0;
      var completed = false;
      final serving = server.listen((request) async {
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path.endsWith('/prepare')) {
          await request.drain<void>();
          request.response.write(
            jsonEncode({
              'book': publication.toJson(),
              'uploaded': false,
              'uploadUrl': null,
              'multipart': {
                'uploadId': 'session-one',
                'partSize': partSize,
                'parts': accepted.entries
                    .map((p) => {'partNumber': p.key, 'etag': p.value})
                    .toList(),
              },
            }),
          );
        } else if (request.method == 'PUT') {
          final number = int.parse(request.uri.pathSegments.last);
          requests.add(number);
          expect(request.headers.value('x-upload-id'), 'session-one');
          expect(
            request.headers.contentType!.mimeType,
            'application/octet-stream',
          );
          expect(request.headers.contentLength, number == 9 ? 17 : partSize);
          var received = 0;
          await for (final chunk in request) {
            received += chunk.length;
          }
          expect(received, number == 9 ? 17 : partSize);
          if (number == 9 && failLast) {
            failLast = false;
            request.response.statusCode = 503;
            request.response.write(
              jsonEncode({
                'error': {'message': 'Retry later', 'code': 'RETRY'},
              }),
            );
          } else {
            accepted[number] = 'etag-$number';
            request.response.write(
              jsonEncode({'partNumber': number, 'etag': accepted[number]}),
            );
          }
        } else {
          final body =
              jsonDecode(await utf8.decoder.bind(request).join()) as Map;
          expect(body['uploadId'], 'session-one');
          expect(accepted.length, 9);
          completed = true;
          request.response.statusCode = 201;
          request.response.write(
            jsonEncode({'book': publication.toJson(), 'uploaded': true}),
          );
        }
        await request.response.close();
      });
      Stream<List<int>> diskRange(int start, int end) async* {
        ranges.add((start, end));
        for (var offset = start; offset < end; offset += 65536) {
          final count = end - offset < 65536 ? end - offset : 65536;
          if (count > maximumChunk) maximumChunk = count;
          yield List<int>.filled(count, 0);
        }
      }

      final origin = Uri.parse('http://127.0.0.1:${server.port}');
      var api = UploadApi(origin);
      final first = await api.prepare(publication);
      await expectLater(
        api.uploadMultipart(
          publication,
          first.multipart!,
          diskRange,
          onProgress: (_) {},
        ),
        throwsA(isA<ApiException>()),
      );
      api.close();
      expect(completed, isFalse);
      expect(accepted.length, 8);
      // A new client/process reconstructs its session entirely from prepare.
      api = UploadApi(origin);
      final resumed = await api.prepare(publication);
      final progress = <int>[];
      final result = await api.uploadMultipart(
        publication,
        resumed.multipart!,
        diskRange,
        onProgress: progress.add,
      );
      expect(result.sha256, publication.sha256);
      expect(requests, [8, 9, 9]);
      expect(ranges, [
        (7 * partSize, 8 * partSize),
        (8 * partSize, fileSize),
        (8 * partSize, fileSize),
      ]);
      expect(maximumChunk, 65536);
      expect(progress.first, 8 * partSize);
      expect(progress.last, fileSize);
      expect(completed, isTrue);
      api.close();
      await serving.cancel();
      await server.close(force: true);
    },
  );

  test('multipart rejects malformed part lists and session identifiers', () {
    for (final json in [
      {'uploadId': 'bad\r\nheader', 'partSize': 8388608, 'parts': []},
      {'uploadId': 'session', 'partSize': 100000000, 'parts': []},
      {
        'uploadId': 'session',
        'partSize': 8388608,
        'parts': [
          {'partNumber': 10, 'etag': 'x'},
        ],
      },
      {
        'uploadId': 'session',
        'partSize': 8388608,
        'parts': [
          {'partNumber': 1, 'etag': 'x'},
          {'partNumber': 1, 'etag': 'y'},
        ],
      },
    ]) {
      expect(
        () => MultipartUpload.fromJson(json, 64 * 1024 * 1024 + 1),
        throwsA(isA<ApiException>()),
      );
    }
  });
  test(
    'raw PUT starts streaming before later chunks exist and uses exact length',
    () async {
      final payload = List<int>.generate(3 * 65536, (i) => i % 251);
      final publication = book(payload);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final firstReceived = Completer<void>();
      final rest = Completer<void>();
      final received = <int>[];
      final serving = () async {
        final request = await server.first;
        expect(request.method, 'PUT');
        expect(request.headers.contentLength, payload.length);
        expect(request.headers.contentType!.mimeType, 'application/epub+zip');
        await for (final chunk in request) {
          received.addAll(chunk);
          if (!firstReceived.isCompleted) firstReceived.complete();
        }
        request.response.headers.contentType = ContentType.json;
        request.response.statusCode = 201;
        request.response.write(
          jsonEncode({'book': publication.toJson(), 'uploaded': true}),
        );
        await request.response.close();
      }();
      final api = UploadApi(Uri.parse('http://127.0.0.1:${server.port}'));
      Stream<List<int>> source() async* {
        yield payload.sublist(0, 65536);
        await rest.future;
        yield payload.sublist(65536, 131072);
        yield payload.sublist(131072);
      }

      final progress = <int>[];
      final uploading = api.upload(
        publication,
        '/v1/uploads/${publication.sha256}',
        source(),
        onProgress: progress.add,
      );
      await firstReceived.future.timeout(const Duration(seconds: 3));
      expect(received.length, lessThan(payload.length));
      rest.complete();
      expect((await uploading).sha256, publication.sha256);
      await serving;
      expect(received, payload);
      expect(progress, [65536, 131072, payload.length]);
      api.close();
      await server.close(force: true);
    },
  );

  test(
    'prepare rejects cross-origin destinations and mismatched returned checksum',
    () async {
      final publication = book([1, 2, 3]);
      for (final response in [
        {
          'book': publication.toJson(),
          'uploaded': false,
          'uploadUrl': 'https://other.example/v1/uploads/file',
        },
        {
          'book': {...publication.toJson(), 'sha256': 'a' * 64},
          'uploaded': true,
          'uploadUrl': null,
        },
      ]) {
        final api = UploadApi(
          Uri.parse('https://books.example'),
          client: MockClient((request) async {
            expect(request.method, 'POST');
            expect(request.followRedirects, isFalse);
            expect(
              (jsonDecode(request.body) as Map)['sha256'],
              publication.sha256,
            );
            return http.Response(jsonEncode(response), 200);
          }),
        );
        await expectLater(
          api.prepare(publication),
          throwsA(isA<ApiException>()),
        );
        api.close();
      }
    },
  );
}
