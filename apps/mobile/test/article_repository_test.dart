import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/articles/article_store_web.dart';
import 'package:thereader/data/articles/page_fetcher.dart';
import 'package:thereader/data/models/article_summary.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader_extract/thereader_extract.dart';

const _page = '''<!doctype html><html lang="en"><head><meta charset="windows-1252"><title>A Quiet Morning</title></head>
<body><nav><p>Home</p></nav><article>
<p>The kettle was the first thing to wake, long before the house and its caf\xe9 radio.</p>
<p>At seven the light had found the table, the books, and the unfinished letter.</p>
</article></body></html>''';

void main() {
  late MemoryKeyValueStore kv;
  late MemoryArticleStore files;
  late List<Uri> requested;

  ArticleRepository repo({String body = _page}) => ArticleRepository(
    store: kv,
    files: files,
    fetcher: PageFetcher(
      relayBase: () => Uri.parse('https://reader.example'),
      useRelay: false,
      client: MockClient((request) async {
        requested.add(request.url);
        return http.Response.bytes(latin1.encode(body), 200, headers: {'content-type': 'text/html'});
      }),
    ),
  );

  setUp(() {
    kv = MemoryKeyValueStore();
    files = MemoryArticleStore();
    requested = [];
  });

  test('parses typed and pasted links', () {
    expect(ArticleRepository.parseInput('example.com/story'), Uri.parse('https://example.com/story'));
    expect(ArticleRepository.parseInput('  http://a.b/c#part '), Uri.parse('http://a.b/c'));
    expect(ArticleRepository.parseInput('Read this: https://news.example.org/x?y=1 via app'), Uri.parse('https://news.example.org/x?y=1'));
    expect(ArticleRepository.parseInput('http://localhost:8787/a'), Uri.parse('http://localhost:8787/a'));
    for (final bad in ['', 'hello', 'not a link', 'ftp://example.com/file', 'mailto:me@example.com']) {
      expect(ArticleRepository.parseInput(bad), isNull, reason: bad);
    }
  });

  test('add fetches, extracts off the UI isolate, stores once and reports each phase', () async {
    final articles = repo();
    await articles.load();
    final phases = <ArticlePhase?>[];
    articles.adding.addListener(() => phases.add(articles.adding.value?.phase));

    final summary = await articles.add('example.com/morning');

    expect(requested, [Uri.parse('https://example.com/morning')]);
    expect(phases.toSet().toList(), [ArticlePhase.fetching, ArticlePhase.extracting, ArticlePhase.saving, null]);
    expect(summary.title, 'A Quiet Morning');
    expect(summary.url, 'https://example.com/morning');
    expect(summary.readingMinutes, 1);
    expect(articles.articles.single.id, summary.id);

    final stored = Article.fromJson(jsonDecode(files.files[summary.id]!) as Map<String, Object?>);
    expect(stored.blocks, hasLength(2));
    expect(inlineText((stored.blocks.first as ParagraphBlock).content), contains('café radio'));
    expect((await articles.loadArticle(summary.id)).title, 'A Quiet Morning');
  });

  test('a saved link opens from storage without another request', () async {
    final articles = repo();
    await articles.load();
    final first = await articles.add('https://example.com/morning');
    final again = await articles.add('example.com/morning#top');
    expect(again.id, first.id);
    expect(requested, hasLength(1));
    expect(articles.articles, hasLength(1));

    final reopened = repo();
    await reopened.load();
    expect((await reopened.loadArticle(first.id)).blocks, hasLength(2));
    expect(requested, hasLength(1));
  });

  test('progress, opening and removal persist', () async {
    final articles = repo();
    await articles.load();
    final summary = await articles.add('https://example.com/morning');
    await articles.markOpened(summary.id);
    await articles.saveProgress(summary.id, const ArticleProgress(block: 1, offset: 0.5, percent: 0.75));

    final reloaded = repo();
    await reloaded.load();
    final restored = reloaded.byId(summary.id)!;
    expect(restored.lastOpenedAt, isNotNull);
    expect(restored.progress!.block, 1);
    expect(restored.progress!.offset, 0.5);
    expect(restored.progress!.percent, 0.75);

    await reloaded.remove(summary.id);
    expect(reloaded.articles, isEmpty);
    expect(files.files, isEmpty);
    final empty = repo();
    await empty.load();
    expect(empty.articles, isEmpty);
  });

  test('summaries whose document is gone are dropped on load', () async {
    final articles = repo();
    await articles.load();
    final summary = await articles.add('https://example.com/morning');
    files.files.remove(summary.id);
    final reloaded = repo();
    await reloaded.load();
    expect(reloaded.articles, isEmpty);
  });

  test('explains pages without an article and invalid input', () async {
    final articles = repo(body: '<html><body><p>Too short.</p></body></html>');
    await articles.load();
    await expectLater(
      articles.add('https://example.com/empty'),
      throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains("Couldn't find an article"))),
    );
    await expectLater(articles.add('not a link'), throwsA(isA<ArticleFetchException>()));
    expect(articles.adding.value, isNull);
    expect(articles.articles, isEmpty);
  });
}
