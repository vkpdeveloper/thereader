import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/import/import_platform_io.dart';

void main() {
  late Directory temp;
  late HttpServer server;
  late File source;
  late Uri origin;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('pdf-import-test-');
    source = File('${temp.path}/book.pdf')
      ..writeAsStringSync('%PDF-1.7 source bytes');
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    origin = Uri.parse('http://127.0.0.1:${server.port}');
  });
  tearDown(() async {
    await server.close(force: true);
    await temp.delete(recursive: true);
  });

  test(
    'PDF conversion uses the captured origin and cleans its EPUB copy',
    () async {
      final handled = server.first.then((request) async {
        expect(request.uri.path, '/v1/pdf/extract');
        expect(request.method, 'POST');
        expect(request.headers.contentType?.mimeType, 'application/pdf');
        expect(
          await utf8.decoder.bind(request).join(),
          '%PDF-1.7 source bytes',
        );
        request.response.headers.contentType = ContentType(
          'application',
          'epub+zip',
        );
        request.response.add([80, 75, 3, 4, 1, 2, 3]);
        await request.response.close();
      });
      final result = await prepareBook(source.path, origin: origin);
      await handled;
      expect(await File(result).readAsBytes(), [80, 75, 3, 4, 1, 2, 3]);
      await cleanPreparedBook(source.path, result);
      expect(await File(result).parent.exists(), isFalse);
      expect(await source.exists(), isTrue);
    },
  );

  test('server extraction errors are preserved for the user', () async {
    final handled = server.first.then((request) async {
      await request.drain<void>();
      request.response.statusCode = 422;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'error': {'message': 'This PDF needs OCR.'},
        }),
      );
      await request.response.close();
    });
    await expectLater(
      prepareBook(source.path, origin: origin),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          'This PDF needs OCR.',
        ),
      ),
    );
    await handled;
  });

  test('redirects do not forward a private PDF to another server', () async {
    final handled = server.first.then((request) async {
      await request.drain<void>();
      request.response.statusCode = 307;
      request.response.headers.set('Location', 'https://invalid.example/pdf');
      await request.response.close();
    });
    await expectLater(
      prepareBook(source.path, origin: origin),
      throwsFormatException,
    );
    await handled;
  });

  test('empty PDFs are rejected before contacting the server', () async {
    source.writeAsBytesSync([]);
    await expectLater(
      prepareBook(source.path, origin: origin),
      throwsFormatException,
    );
    await expectLater(prepareBook(source.path), throwsFormatException);
  });
}
