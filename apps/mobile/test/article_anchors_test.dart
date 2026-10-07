import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/articles/article_anchors.dart';

/// Block texts of a small article; empty strings are blocks without text.
const texts = [
  'Plain text, bold, italic, underline, strike, inline code and small print.',
  'A second paragraph about reading slowly.',
  '',
  'Code',
  'export function share(url) { return encodeURIComponent(url); }',
  'the quick brown fox jumps over the lazy dog, then the fox sleeps',
];
final count = texts.length;
BlockText reader(List<String> list) => (i) => i >= 0 && i < list.length && list[i].isNotEmpty ? list[i] : null;
final articleId = 'a' * 32;
const href = 'https://example.com/posts/every-block';

ArticleSpan spanOf(List<String> list, int block, String needle, [int from = 0]) {
  final start = list[block].indexOf(needle, from);
  expect(start, greaterThanOrEqualTo(0), reason: '"$needle" is not in block $block');
  return ArticleSpan(block, start, block, start + needle.length);
}

ArticleLocator describe(ArticleSpan span, List<String> list, {int maxQuote = ArticleAnchors.maxQuote}) =>
    describeSpan(span, reader(list), list.length, articleId: articleId, href: href, maxQuote: maxQuote);

/// Through JSON, as a synced locator arrives.
ArticleLocator roundTrip(ArticleLocator loc) =>
    ArticleLocator.parse((jsonDecode(jsonEncode(loc.toJson())) as Map).cast())!;

void main() {
  test('article highlights carry the article id and the sentinel edition; books never match', () {
    final bookId = ArticleAnchors.bookIdFor(articleId);
    // The API's BOOK_ID_PATTERN.
    expect(RegExp(r'^[a-z0-9]+(?:-[a-z0-9]+)*$').hasMatch(bookId), isTrue);
    expect(ArticleAnchors.articleIdOf(bookId: bookId, sha256: ArticleAnchors.sha256), articleId);
    expect(ArticleAnchors.articleIdOf(bookId: bookId, sha256: 'f' * 64), isNull);
    expect(ArticleAnchors.articleIdOf(bookId: 'moby-dick', sha256: ArticleAnchors.sha256), isNull);
  });

  test('a passage round-trips through its locator by offsets, in the web shape', () {
    final span = spanOf(texts, 0, 'italic, underline');
    final loc = describe(span, texts);
    final json = loc.toJson();
    expect(json, containsPair('type', 'article'));
    expect(json, containsPair('href', href));
    expect(json, containsPair('articleId', articleId));
    expect(json, containsPair('block', 0));
    expect(json, containsPair('endBlock', 0));
    expect(json['locations'], {'progression': loc.progression, 'totalProgression': loc.progression});
    expect(loc.highlight, 'italic, underline');
    expect(loc.before!.endsWith('bold, '), isTrue);
    expect(loc.after!.startsWith(', strike'), isTrue);
    expect(resolveLocator(roundTrip(loc), reader(texts), count), span);
  });

  test('a locator the web app wrote resolves here', () {
    // Shape from docs/cloud-sync.md; the web counts block text a little
    // differently, so its offsets may be off and the quote decides.
    final web = ArticleLocator.parse({
      'type': 'article',
      'href': href,
      'articleId': articleId,
      'block': 1,
      'start': 9,
      'endBlock': 1,
      'end': 25,
      'title': 'The brief',
      'locations': {'progression': 0.2, 'totalProgression': 0.2},
      'text': {'before': 'A second ', 'highlight': 'paragraph about', 'after': ' reading'},
    })!;
    expect(web.title, 'The brief');
    expect(resolveLocator(web, reader(texts), count), spanOf(texts, 1, 'paragraph about'));
    final shifted = [...texts]..[1] = 'Now: ${texts[1]}';
    expect(spanText(resolveLocator(web, reader(shifted), count)!, reader(shifted)), 'paragraph about');
  });

  test('a passage across blocks joins them with a line break and skips blocks without text', () {
    final start = texts[1].length - 5;
    final span = ArticleSpan(1, start, 4, 6);
    final loc = describe(span, texts);
    expect(loc.highlight, '${texts[1].substring(start)}\nCode\nexport');
    expect(resolveLocator(roundTrip(loc), reader(texts), count), span);
  });

  test('ends on block edges and on blocks without text move inward', () {
    final text = reader(texts);
    expect(normalizeSpan(ArticleSpan(0, texts[0].length, 1, 2), text, count), const ArticleSpan(1, 0, 1, 2));
    expect(normalizeSpan(const ArticleSpan(2, 0, 3, 3), text, count), const ArticleSpan(3, 0, 3, 3));
    expect(normalizeSpan(const ArticleSpan(0, 2, 1, 0), text, count), ArticleSpan(0, 2, 0, texts[0].length));
    expect(normalizeSpan(const ArticleSpan(0, 3, 0, 3), text, count), isNull);
  });

  test('text that moved inside its block is found again by the quote', () {
    final span = spanOf(texts, 0, 'inline code');
    final loc = describe(span, texts);
    final shifted = [...texts]..[0] = texts[0].replaceFirst('Plain text', 'Plain [image] text');
    final found = resolveLocator(loc, reader(shifted), count)!;
    expect(found.start, span.start + ' [image]'.length);
    expect(spanText(found, reader(shifted)), 'inline code');
  });

  test('blocks inserted before the passage are searched past', () {
    final span = spanOf(texts, 4, 'encodeURIComponent(url)');
    final loc = describe(span, texts);
    final resaved = ['A new lede.', 'Another new paragraph.', ...texts];
    expect(resolveLocator(loc, reader(resaved), count + 2), ArticleSpan(6, span.start, 6, span.end));
  });

  test('of repeated words, the one with matching context wins', () {
    final line = texts[5];
    final second = line.indexOf('the', line.indexOf('the quick') + 1);
    final loc = describe(ArticleSpan(5, second, 5, second + 3), texts);
    final edited = [...texts]..[5] = '// counts words\n$line';
    expect(resolveLocator(loc, reader(edited), count)!.start, second + '// counts words\n'.length);
  });

  test('a passage that is gone resolves to nothing, and a stripped quote trusts the offsets', () {
    final span = spanOf(texts, 0, 'small print');
    final loc = describe(span, texts);
    final removed = [...texts]..[0] = texts[0].replaceFirst('small print', 'fine type');
    expect(resolveLocator(loc, reader(removed), count), isNull);

    // The API size cap may drop the context, or the whole `text`.
    final bare = ArticleLocator.parse({...loc.toJson()}..remove('text'))!;
    expect(resolveLocator(bare, reader(texts), count), span);
  });

  test('a passage longer than the cap is cut, and progression orders passages', () {
    final long = ArticleSpan(4, 0, 4, texts[4].length);
    final cut = describe(long, texts, maxQuote: 20);
    expect(cut.highlight, hasLength(20));
    expect(cut.end - cut.start, 20);

    final early = describe(spanOf(texts, 0, 'bold'), texts);
    final late = describe(spanOf(texts, 4, 'share'), texts);
    expect(early.progression, lessThan(late.progression));
    expect(late.progression, lessThan(1));
  });

  test('malformed locators are rejected', () {
    final loc = describe(spanOf(texts, 0, 'bold'), texts).toJson();
    expect(ArticleLocator.parse({...loc, 'type': 'epub'}), isNull);
    expect(ArticleLocator.parse({...loc, 'block': -1}), isNull);
    expect(ArticleLocator.parse({...loc, 'endBlock': 0, 'block': 3}), isNull);
    expect(
      ArticleLocator.parse({
        'href': 'OEBPS/ch1.xhtml',
        'locations': {'progression': 0.2},
      }),
      isNull,
    );
  });
}
