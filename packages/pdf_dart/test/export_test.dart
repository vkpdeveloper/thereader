import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:archive/archive.dart';
import 'package:pdf_extractor/pdf_extractor.dart';
import 'package:test/test.dart';
import 'package:image/image.dart' as image;

void main() {
  for (final name in ['named-rgb', 'named-icc']) {
    test('inline $name keeps RGB bytes and following text', () {
      final d = extract(
        File('../../eval/pdf/native/edge-fixtures/$name.pdf').readAsBytesSync(),
      );
      expect(
        d.pages.expand((p) => p.blocks).any((b) => b.text == 'After image'),
        true,
      );
      expect(d.assets.length, 1);
      final pixel = image.decodePng(d.assets.single.data)!.getPixel(0, 0);
      expect([pixel.r, pixel.g, pixel.b, pixel.a], [255, 0, 0, 255]);
    });
  }

  test(
    'EPUB is deterministic with an uncompressed first mimetype and safe XHTML',
    () {
      final d = Document()
        ..title = 'A < B & C'
        ..sha256 = 'abc'
        ..language = 'en';
      d.pages.add(
        Page(
          number: 1,
          width: 600,
          height: 800,
          blocks: [
            Block(
              kind: 'heading',
              text: 'Safe <script>',
              level: 1,
              box: const Rect(0, 0, 100, 20),
            ),
            Block(
              kind: 'code',
              text: 'print("hello")',
              language: 'python',
              box: const Rect(0, 20, 100, 20),
            ),
          ],
        ),
      );
      final bytes = epub(d);
      expect(epub(d), bytes);
      expect(ByteData.sublistView(bytes).getUint16(8, Endian.little), 0);
      final zip = ZipDecoder().decodeBytes(bytes);
      expect(zip.first.name, 'mimetype');
      expect(utf8.decode(zip.first.content), 'application/epub+zip');
      final page = utf8.decode(zip.findFile('OEBPS/page-1.xhtml')!.content);
      expect(page, contains('Safe &lt;script&gt;'));
      expect(page, contains('language-python'));
      expect(page, contains('<section id="page-1"'));
    },
  );
  test('EPUB rejects asset traversal', () {
    final d = Document();
    d.assets.add(Asset('assets/../outside', 'image/png', 1, 1, Uint8List(0)));
    expect(() => epub(d), throwsA(isA<PdfException>()));
  });
  test(
    'complex tables preserve headers, grouped rows and spans in Markdown',
    () {
      final d = Document(),
          table = Table(
            rows: 3,
            columns: 2,
            headerRows: 1,
            cells: [
              TableCell(
                row: 0,
                column: 0,
                colSpan: 2,
                text: 'Model',
                header: true,
                scope: 'colgroup',
                box: const Rect(0, 0, 20, 10),
              ),
              TableCell(
                row: 1,
                column: 0,
                rowSpan: 2,
                text: '32K',
                header: true,
                scope: 'rowgroup',
                box: const Rect(0, 10, 10, 20),
              ),
              TableCell(
                row: 1,
                column: 1,
                text: '1',
                box: const Rect(10, 10, 10, 10),
              ),
              TableCell(
                row: 2,
                column: 1,
                text: '2',
                box: const Rect(10, 20, 10, 10),
              ),
            ],
          );
      d.pages.add(
        Page(
          number: 1,
          width: 100,
          height: 100,
          blocks: [
            Block(kind: 'table', table: table, box: const Rect(0, 0, 20, 30)),
          ],
        ),
      );
      final md = markdown(d);
      expect(md, contains('colspan="2"'));
      expect(md, contains('rowspan="2"'));
      expect(md, contains('scope="rowgroup"'));
      expect(md, contains('headers="table-1-0-r0-c0 table-1-0-r1-c0"'));
    },
  );
  test('timeouts are reported as cancellation before parsing', () {
    final bytes = File(
      '../../eval/pdf/native/fixtures/cc720d5a85e5f3edd331f47999cf24120e88a65b7e71b59eab409cf4d048da53.pdf',
    ).readAsBytesSync();
    expect(
      () => extract(bytes, options: Options(cancelled: () => true)),
      throwsA(isA<PdfException>().having((e) => e.code, 'code', 'ABORTED')),
    );
  });
}
