import 'dart:convert';
import 'dart:io';
import 'package:pdf_extractor/pdf_extractor.dart';
import 'package:test/test.dart';

Object comparable(Map<String, dynamic> doc) {
  final names = <String, String>{};
  for (final (i, a) in (doc['assets'] as List? ?? []).indexed)
    names[a['name']] = 'asset-$i';
  dynamic visit(dynamic v, [String key = '']) {
    if (key == 'durationMs') return 0;
    if (v is String) {
      for (final e in names.entries) v = v.replaceAll(e.key, e.value);
      return v;
    }
    if (v is num) return (v * 1e8).round() / 1e8;
    if (v is List) return v.map((x) => visit(x)).toList();
    if (v is Map) {
      final out = <String, dynamic>{};
      for (final e in v.entries) {
        final k = e.key as String, x = e.value;
        if (k == 'data' || k == 'durationMs') continue;
        if (x == null ||
            x == '' ||
            x == false ||
            x == 0 ||
            x is List && x.isEmpty)
          continue;
        out[k] = visit(x, k);
      }
      return out;
    }
    return v;
  }

  final value = visit(doc) as Map;
  value['warnings'] = (doc['warnings'] as List? ?? [])
      .map((w) => [w['code'], w['page'] ?? 0])
      .toList();
  return value;
}

void main() {
  final root = Directory('../../eval/pdf/native/fixtures');
  for (final file in root.listSync().whereType<File>().where(
    (f) => f.path.endsWith('.pdf'),
  )) {
    test(file.uri.pathSegments.last, () {
      final gold = jsonDecode(
        File(file.path.replaceFirst('.pdf', '.json')).readAsStringSync(),
      );
      final bytes = file.readAsBytesSync();
      if (gold['error'] != null) {
        expect(
          () => extract(bytes),
          throwsA(
            isA<PdfException>().having((e) => e.code, 'code', gold['error']),
          ),
        );
        return;
      }
      final actual = jsonDecode(jsonEncode(extract(bytes)));
      expect(comparable(actual), comparable(gold['document']));
    });
  }
}
