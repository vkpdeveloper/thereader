import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:truffle/src/js.dart';
import 'package:truffle/truffle.dart';

/// Markdown export, against the TypeScript reference's goldens
/// (`packages/truffle/test/markdown.test.ts` writes both):
/// `fixtures/expected/<name>.md` is `article.markdown` for each conformance
/// page, and `fixtures/markdown/cases.json` holds `blocksMarkdown` cases.
const _root = '../truffle/fixtures/';

void main() {
  final manifest = (jsonDecode(File('${_root}manifest.json').readAsStringSync()) as Map).cast<String, String>();
  String page(String name) => File('${_root}pages/$name.html').readAsStringSync();

  group('markdown of the conformance fixtures', () {
    for (final MapEntry(key: name, value: url) in manifest.entries) {
      test(name, () {
        final article = extractArticle(page(name), Uri.parse(url), markdown: true);
        final plain = extractArticle(page(name), Uri.parse(url));
        if (article == null || plain == null) {
          expect(article, isNull);
          return;
        }
        expect(article.markdown, File('${_root}expected/$name.md').readAsStringSync());
        // The option adds the field and changes nothing else.
        expect(plain.markdown, isNull);
        expect(plain.toJson().containsKey('markdown'), isFalse);
        expect(articleMarkdown(plain), article.markdown);
        final json = article.toJson();
        expect(json.remove('markdown'), article.markdown);
        expect(jsonEncode(json), jsonEncode(plain.toJson()));
      });
    }
  });

  group('markdown cases', () {
    final cases = (jsonDecode(File('${_root}markdown/cases.json').readAsStringSync()) as List).cast<Json>();
    for (final c in cases) {
      test(c['name'], () {
        final blocks = [for (final b in c['blocks'] as List) Block.fromJson(b as Json)];
        expect(blocksMarkdown(blocks), c['markdown']);
      });
    }
  });

  test('no markdown unless asked for', () {
    final article = extractArticle(page('blog-basic'), Uri.parse(manifest['blog-basic']!))!;
    expect(article.markdown, isNull);
    expect(jsonEncode(article.toJson()), endsWith(']}'));
  });

  test('markdown is the last key when asked for, and round-trips', () {
    final article = extractArticle(page('blog-basic'), Uri.parse(manifest['blog-basic']!), markdown: true)!;
    final json = article.toJson();
    expect(json.keys.last, 'markdown');
    expect(article.markdown, endsWith('\n'));
    final encoded = jsonEncode(json);
    expect(encoded, endsWith(',"markdown":${jsonEncode(article.markdown)}}'));
    final back = Article.fromJson(jsonDecode(encoded) as Json);
    expect(back.markdown, article.markdown);
    expect(jsonEncode(back.toJson()), encoded);
  });

  test('an article with no title starts with its body', () {
    final article = Article(
      url: 'https://example.com/',
      title: '',
      wordCount: 1,
      readingMinutes: 1,
      blocks: [
        ParagraphBlock([const TextRun('Body.')]),
      ],
    );
    expect(articleMarkdown(article), 'Body.\n');
    expect(blocksMarkdown(const []), '');
  });

  test('isPunctuationOrSymbol is /[\\p{P}\\p{S}]/u for every BMP code unit', () {
    final pattern = RegExp(r'[\p{P}\p{S}]', unicode: true);
    for (var c = 0; c <= 0xffff; c++) {
      expect(isPunctuationOrSymbol(c), pattern.hasMatch(String.fromCharCode(c)), reason: c.toRadixString(16));
    }
  });

  test(r'collapseJsSpace is .replace(/\s+/g, " ")', () {
    final pattern = RegExp(r'\s+');
    for (final s in ['', 'a', ' ', '  ', 'a b', 'a  b', ' a\tb\n', 'x\u0085y', 'a 　b', '﻿', 'a  ']) {
      expect(collapseJsSpace(s), s.replaceAll(pattern, ' '), reason: jsonEncode(s));
    }
  });
}
