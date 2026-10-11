import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/import/import_platform_io.dart';
import 'package:thereader/data/import/pdf_import_io.dart' as pdf;

void main() {
  late Directory temp;
  late File source;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp('pdf-import-test-');
    source = await File(
      '../../eval/pdf/native/edge-fixtures/named-rgb.pdf',
    ).copy('${temp.path}/book.pdf');
  });
  tearDown(() async {
    await temp.delete(recursive: true);
  });

  test(
    'PDF converts without a server and enters the normal EPUB inspection path',
    () async {
      final result = await prepareBook(source.path);
      try {
        final metadata = await inspectEpub(result);
        expect(metadata['title'], isNotEmpty);
        final zip = ZipDecoder().decodeBytes(await File(result).readAsBytes());
        expect(
          utf8.decode(zip.findFile('mimetype')!.content),
          'application/epub+zip',
        );
        expect(
          utf8.decode(zip.findFile('OEBPS/page-1.xhtml')!.content),
          contains('After image'),
        );
        expect(
          zip.files.any((f) => f.name.startsWith('OEBPS/assets/')),
          isTrue,
        );
      } finally {
        await cleanPreparedBook(source.path, result);
      }
      expect(await File(result).parent.exists(), isFalse);
      expect(await source.exists(), isTrue);
    },
  );

  test('a configured server receives no extraction requests', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var requests = 0;
    server.listen((request) {
      requests++;
      request.response.statusCode = 503;
      request.response.close();
    });
    try {
      final result = await prepareBook(
        source.path,
        origin: Uri.parse('http://127.0.0.1:${server.port}'),
      );
      await cleanPreparedBook(source.path, result);
      expect(requests, 0);
    } finally {
      await server.close(force: true);
    }
  });

  test(
    'invalid and encrypted PDF errors survive the isolate boundary',
    () async {
      source.writeAsStringSync('%PDF-1.7 broken');
      await expectLater(prepareBook(source.path), throwsFormatException);
      final fixtures = Directory('../../eval/pdf/native/fixtures');
      for (final f in fixtures.listSync().whereType<File>().where(
        (f) => f.path.endsWith('.json'),
      )) {
        if (jsonDecode(f.readAsStringSync())['error'] == 'ENCRYPTED_PDF') {
          await File(f.path.replaceAll('.json', '.pdf')).copy(source.path);
          await expectLater(
            prepareBook(source.path),
            throwsA(
              isA<FormatException>().having(
                (e) => e.message.toLowerCase(),
                'message',
                contains('encrypted'),
              ),
            ),
          );
          return;
        }
      }
      fail('Missing encrypted fixture');
    },
  );

  test('deadline kills conversion and removes its partial output', () async {
    Set<String> outputs() => Directory.systemTemp
        .listSync()
        .whereType<Directory>()
        .where((d) => d.path.split('/').last.startsWith('thereader-pdf-'))
        .map((d) => d.path)
        .toSet();
    final before = outputs();
    await expectLater(
      pdf.convertPdf(source.path, timeout: Duration.zero),
      throwsA(
        isA<FormatException>().having(
          (e) => e.message,
          'message',
          contains('timed out'),
        ),
      ),
    );
    expect(outputs().difference(before), isEmpty);
    expect(source.existsSync(), isTrue);
  });

  test('empty and oversized PDFs are rejected before conversion', () async {
    source.writeAsBytesSync([]);
    await expectLater(prepareBook(source.path), throwsFormatException);
    final handle = source.openSync(mode: FileMode.write);
    handle.truncateSync(pdf.maxPdfBytes + 1);
    handle.closeSync();
    await expectLater(prepareBook(source.path), throwsFormatException);
  });
}
