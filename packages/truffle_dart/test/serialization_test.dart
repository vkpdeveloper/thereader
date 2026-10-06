import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:truffle/truffle.dart';

// Saved-article sync uploads `jsonEncode(article.toJson())`, and the API checks
// only the document's ends without parsing it (apps/api/src/article-bodies.ts):
// compact JSON that starts with `{"schema":1,` and ends with `}`, the same as
// the TypeScript engine (packages/truffle/test/serialization.test.ts).
void main() {
  test('articles serialize with schema first, compactly', () {
    final json = jsonDecode(File('test/fixtures/every_block.json').readAsStringSync()) as Json;
    final encoded = jsonEncode(Article.fromJson(json).toJson());
    expect(encoded, startsWith('{"schema":1,"url":'));
    expect(encoded, endsWith('}'));
  });
}
