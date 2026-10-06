import 'dart:convert';
import 'dart:io';

import 'package:html/parser.dart' as html_parser;
import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

/// `fromDocument` (package:html) against the tree jsdom gives the TypeScript
/// engine for the same page (`packages/truffle/scripts/parser-cases.ts`).
/// Cases marked `known` are package:html tree-construction gaps the port
/// documents instead of reproducing.
void main() {
  final cases = (jsonDecode(File('test/fixtures/parser_cases.json').readAsStringSync()) as List).cast<Json>();
  for (final c in cases) {
    final known = c['known'] as String?;
    test(c['name'], () {
      final actual = fromDocument(html_parser.parse(c['html'] as String)).toJson();
      expect(jsonDecode(jsonEncode(actual)), equals(c['vdoc']));
    }, skip: known);
  }

  test('extractTree reads the VDocument JSON the TypeScript dump writes', () {
    final c = cases.firstWhere((c) => c['name'] == 'body noscript image');
    final doc = VDocument.fromJson(c['vdoc'] as Json);
    expect(jsonEncode(doc.toJson()), jsonEncode(c['vdoc']));
  });
}
