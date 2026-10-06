import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:thereader_extract/thereader_extract.dart';

/// The shared conformance fixtures (`packages/extract/fixtures`): every page,
/// parsed with package:html and extracted with its manifest URL, must produce
/// the TypeScript reference's JSON, and serializing it as the reference does
/// (`JSON.stringify(article, null, 2)`) must reproduce the file byte for byte.
const _root = '../extract/fixtures/';

void main() {
  final manifest = (jsonDecode(File('${_root}manifest.json').readAsStringSync()) as Map).cast<String, String>();

  test('every page has a manifest entry', () {
    final pages =
        Directory('${_root}pages')
            .listSync()
            .map((f) => f.uri.pathSegments.last)
            .where((name) => name.endsWith('.html'))
            .map((name) => name.substring(0, name.length - 5))
            .toList()
          ..sort();
    expect(pages, manifest.keys.toList()..sort());
  });

  for (final MapEntry(key: name, value: url) in manifest.entries) {
    test(name, () {
      final html = File('${_root}pages/$name.html').readAsStringSync();
      final expectedText = File('${_root}expected/$name.json').readAsStringSync();
      final article = extractArticle(html, Uri.parse(url));
      final json = article?.toJson();
      expect(jsonDecode(jsonEncode(json)), equals(jsonDecode(expectedText)));
      expect('${const JsonEncoder.withIndent('  ').convert(json)}\n', expectedText);
      // The stored form round-trips through the model.
      if (json != null) expect(Article.fromJson(jsonDecode(jsonEncode(json)) as Json).toJson(), equals(json));
    });
  }
}
