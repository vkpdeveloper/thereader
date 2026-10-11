library pdf_extractor;

import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:archive/archive.dart' as archive;
import 'package:test/test.dart';

part '../lib/src/model.dart';
part '../lib/src/syntax.dart';
part '../lib/src/filters.dart';
part '../lib/src/parser.dart';

Uint8List _bytes(String s) => Uint8List.fromList(s.codeUnits);

void main() {
  test('lexer retains literal escaping and indirect references', () {
    final l = _Lexer(
          _bytes(r'[12 0 R /A#20B (one\n\050two\051three) <FEFF0041>]'),
        ),
        a = l.value() as List;
    expect(a[0], const _Ref(12, 0));
    expect(_named(a[1]), 'A B');
    expect(_binary((a[2] as _Literal).bytes), 'one\n(two)three');
    expect((a[3] as _Literal).bytes, [254, 255, 0, 65]);
  });
  test('bounded original inflate decodes generic encoder fixtures', () {
    for (final level in [0, 1, 6, 9]) {
      final raw = _bytes('abc EI xyz ${'hello'.padRight(90000, '!')}'),
          compressed = archive.ZLibEncoderWeb().encodeBytes(raw, level: level);
      final (data, length) = _inflateMember(compressed, raw.length);
      expect(data, raw);
      expect(length, compressed.length);
      expect(
        () => _inflate(compressed, 10),
        throwsA(
          isA<PdfException>().having((e) => e.code, 'code', 'RESOURCE_LIMIT'),
        ),
      );
      final corrupt = Uint8List.fromList(compressed);
      corrupt[corrupt.length - 1] ^= 1;
      expect(() => _inflate(corrupt, raw.length), throwsA(isA<PdfException>()));
    }
  });
  final root = Directory('../../eval/pdf/native/fixtures');
  for (final file in root.listSync().whereType<File>().where(
    (f) => f.path.endsWith('.pdf'),
  )) {
    test('Go PDF object fixture ${file.uri.pathSegments.last}', () {
      final data = file.readAsBytesSync(),
          expected =
              jsonDecode(
                    File(
                      file.path.replaceAll('.pdf', '.json'),
                    ).readAsStringSync(),
                  )
                  as Map;
      if (expected['error'] == 'ENCRYPTED_PDF') {
        expect(
          () => _PDF(data),
          throwsA(
            isA<PdfException>().having((e) => e.code, 'code', 'ENCRYPTED_PDF'),
          ),
        );
        return;
      }
      final p = _PDF(data);
      expect(_named(p.dict(p.trailer['Root'])['Type']), 'Catalog');
      expect(
        () => _PDF(data, const Options(limits: Limits(inputBytes: 32))),
        throwsA(isA<PdfException>()),
      );
    });
  }
}
