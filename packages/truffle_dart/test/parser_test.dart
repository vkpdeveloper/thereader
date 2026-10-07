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

  test('attributes written on the VDocument leave the DOM unchanged', () {
    final dom = html_parser.parse('<body><div id="a" class="x">text</div><p title="t">p</p></body>');
    final vdoc = fromDocument(dom);
    final div = vdoc.body.children.first as VElement;
    expect(div.attrs, {'id': 'a', 'class': 'x'});
    div.attrs['data-x-as-p'] = '';
    div.attrs.remove('class');
    expect(div.attrs, {'id': 'a', 'data-x-as-p': ''});
    expect(div.attrs.keys, ['id', 'data-x-as-p']);
    final domDiv = dom.body!.children.first;
    expect(domDiv.attributes, {'id': 'a', 'class': 'x'});
    // The whole pipeline marks div paragraphs: still nothing written to the DOM.
    extractTree(fromDocument(dom), 'https://example.com/');
    expect(domDiv.attributes, {'id': 'a', 'class': 'x'});
  });
}
