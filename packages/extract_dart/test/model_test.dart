import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:thereader_extract/thereader_extract.dart';

Json _fixture(String name) => jsonDecode(File('test/fixtures/$name').readAsStringSync()) as Json;

void main() {
  group('model', () {
    test('every block and inline type round-trips to the same JSON', () {
      final json = _fixture('every_block.json');
      final article = Article.fromJson(json);
      expect(article.toJson(), equals(json));
      expect(jsonDecode(jsonEncode(article.toJson())), equals(json));
    });

    test('covers every block and inline type of the TypeScript model', () {
      final article = Article.fromJson(_fixture('every_block.json'));
      final blocks = <String>{};
      final inlines = <String>{};
      void walkInlines(List<Inline>? content) {
        for (final i in content ?? const <Inline>[]) {
          inlines.add(i.type);
        }
      }

      void walk(List<Block>? list) {
        for (final b in list ?? const <Block>[]) {
          blocks.add(b.type);
          switch (b) {
            case HeadingBlock(:final content) || ParagraphBlock(:final content):
              walkInlines(content);
            case ListBlock(:final items):
              for (final item in items) {
                walk(item.blocks);
              }
            case QuoteBlock(:final blocks, :final cite):
              walk(blocks);
              walkInlines(cite);
            case EmbedBlock(:final blocks):
              walk(blocks);
            case FootnotesBlock(:final items):
              for (final item in items) {
                walk(item.blocks);
              }
            default:
          }
        }
      }

      walk(article.blocks);
      expect(blocks, {
        'heading', 'paragraph', 'list', 'quote', 'code', 'figure', 'video', 'audio', 'embed', 'table', 'rule', //
        'math', 'definitions', 'details', 'callout', 'footnotes',
      });
      expect(inlines, {'text', 'break', 'image', 'math', 'ref'});
    });

    test('keeps required nulls and omits absent optionals', () {
      final code = CodeBlock(code: 'x', language: null).toJson();
      expect(code, {'type': 'code', 'code': 'x', 'language': null});
      final callout = CalloutBlock(variant: null, blocks: const []).toJson();
      expect(callout, {'type': 'callout', 'variant': null, 'blocks': <Object?>[]});
      expect(const TextRun('a').toJson(), {'type': 'text', 'text': 'a'});
      expect(const ListItem(blocks: [], checked: false).toJson(), {'blocks': <Object?>[], 'checked': false});
    });

    test('rejects unknown types', () {
      expect(() => Block.fromJson({'type': 'marquee'}), throwsFormatException);
      expect(() => Inline.fromJson({'type': 'blink'}), throwsFormatException);
    });
  });

  group('text', () {
    test('articleText and countWords match the TypeScript engine', () {
      final article = Article.fromJson(_fixture('every_block.json'));
      final expected = jsonDecode(File('test/fixtures/every_block.text.json').readAsStringSync()) as String;
      expect(articleText(article), expected);
      expect(countWords(articleText(article)), article.wordCount);
    });

    test('countWords follows JavaScript whitespace and counts CJK at two per word', () {
      final cases = {
        '': 0,
        '  ': 0,
        'hello world': 2,
        '日本語': 2,
        '日本語の文章と English words.': 6,
        ' a\u00a0b\u2003c ': 3,
        'x\u0085y': 1,
        '\ufeffword\ufeff': 1,
        'tab\tsep\nline': 3,
        '한국어 텍스트': 3,
      };
      cases.forEach((text, words) => expect(countWords(text), words, reason: jsonEncode(text)));
    });
  });

  group('stub extractor', () {
    final cases = _fixture('placeholder_cases.json');
    for (final MapEntry(key: name, value: raw) in cases.entries) {
      test('matches the former TypeScript placeholder: $name', () {
        final c = raw as Json;
        final article = extractArticle(c['html'] as String, Uri.parse(c['url'] as String));
        expect(article?.toJson(), equals(c['expected']));
      });
    }
  });
}
