// Saves and reads articles on a real device/simulator. Pauses let an external
// screenshot loop capture each state; with THEREADER_SHOTS_DIR set, each
// state's name is written to `<dir>/next.txt` just before its pause.
//
//   flutter test integration_test/article_walkthrough_test.dart -d <device> \
//       --dart-define=THEREADER_ARTICLE_URLS=https://example.com/a,https://example.com/b \
//       --dart-define=THEREADER_ARTICLE_JSON=/abs/dir/of/article/json \
//       --dart-define=THEREADER_SHOTS_DIR=/abs/dir
//
// URLS goes through the library's add sheet with live network fetches.
// JSON renders stored article documents (for example the model fixture or
// engine output) from in-memory storage. Both are optional; simulators can
// read host paths.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:integration_test/integration_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/articles/article_store_web.dart';
import 'package:thereader/data/articles/page_fetcher.dart';
import 'package:thereader/data/models/article_summary.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/articles/article_code.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/main.dart' as app;
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';
import 'package:truffle/truffle.dart';

const urls = String.fromEnvironment('THEREADER_ARTICLE_URLS');
const jsonDir = String.fromEnvironment('THEREADER_ARTICLE_JSON');
const shotsDir = String.fromEnvironment('THEREADER_SHOTS_DIR');

Future<void> pause(WidgetTester tester, String state, [int seconds = 3]) async {
  await tester.pumpAndSettle();
  if (shotsDir.isNotEmpty) File('$shotsDir/next.txt').writeAsStringSync(state);
  await tester.pump(Duration(seconds: seconds));
}

Future<void> waitFor(WidgetTester tester, Finder finder, {int seconds = 40}) async {
  for (var i = 0; i < seconds * 4 && finder.evaluate().isEmpty; i++) {
    await tester.pump(const Duration(milliseconds: 250));
  }
  expect(finder, findsWidgets);
}

final articleScroll = find.descendant(of: find.byType(ArticleScreen), matching: find.byType(Scrollable)).first;

Future<void> scrollArticle(WidgetTester tester, double by) async {
  await tester.drag(articleScroll, Offset(0, -by));
  await tester.pumpAndSettle();
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('saves links through the library', (tester) async {
    await app.main();
    await tester.pump(const Duration(seconds: 2));
    final list = urls.split(',').where((u) => u.isNotEmpty).toList();
    for (var i = 0; i < list.length; i++) {
      await tester.tap(find.byTooltip('Save article from link'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), list[i]);
      await tester.tap(find.text('Save article'));
      await tester.pump(const Duration(milliseconds: 200));
      if (shotsDir.isNotEmpty) File('$shotsDir/next.txt').writeAsStringSync('url$i-saving');
      await waitFor(tester, find.byType(ArticleScreen));
      expect(find.textContaining("Couldn't"), findsNothing);
      await pause(tester, 'url$i-top');
      await scrollArticle(tester, 900);
      await pause(tester, 'url$i-scrolled', 2);
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await tester.pumpAndSettle();
    }
    await pause(tester, 'library');
    await tester.tap(find.text('Articles'));
    await pause(tester, 'library-articles');
  }, skip: urls.isEmpty);

  testWidgets('renders stored article documents', (tester) async {
    final kv = MemoryKeyValueStore();
    final settings = SettingsRepository(kv);
    await settings.load();
    final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
    await library.load();
    final files = MemoryArticleStore();
    final summaries = <ArticleSummary>[];
    final docs = Directory(jsonDir).listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    for (final (i, doc) in docs.indexed) {
      final json = doc.readAsStringSync();
      final article = Article.fromJson(jsonDecodeMap(json));
      final id = 'doc$i';
      files.files[id] = json;
      summaries.add(
        ArticleSummary(
          id: id,
          url: article.url,
          sourceUrl: article.url,
          title: article.title,
          readingMinutes: article.readingMinutes,
          addedAt: DateTime.now().toUtc().subtract(Duration(minutes: i)),
          siteName: article.siteName,
          leadImage: article.leadImage?.src,
        ),
      );
    }
    await kv.writeJson('articles.v1', {
      'items': [for (final s in summaries) s.toJson()],
    });
    final articles = ArticleRepository(
      store: kv,
      files: files,
      fetcher: PageFetcher(relayBase: () => Uri.parse('https://invalid.invalid'), client: http.Client()),
    );
    await articles.load();
    await tester.pumpWidget(
      TheReaderApp(
        services: AppServices(
          settings: settings,
          library: library,
          readerService: ReaderService(engines: const [DartReaderEngine()]),
          articles: articles,
        ),
      ),
    );
    await pause(tester, 'docs-library');
    for (final (i, s) in summaries.indexed) {
      await tester.tap(find.text(s.title).first);
      await waitFor(tester, find.byType(ArticleScreen));
      await pause(tester, 'doc$i-top');
      final code = find.byType(CodeBlockView);
      for (var page = 1; page <= 6; page++) {
        if (page == 3 && code.evaluate().isEmpty) {
          await tester.scrollUntilVisible(code.first, 600, scrollable: articleScroll, maxScrolls: 40).catchError((_) {});
        } else {
          await scrollArticle(tester, 650);
        }
        await pause(tester, 'doc$i-page$page', 2);
      }
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await tester.pumpAndSettle();
    }
  }, skip: jsonDir.isEmpty);
}

Map<String, Object?> jsonDecodeMap(String json) => (jsonDecode(json) as Map).cast<String, Object?>();
