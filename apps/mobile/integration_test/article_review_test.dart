// Pages through stored article documents top to bottom for a screenshot
// review, and measures open time and scroll frame times.
//
//   flutter test integration_test/article_review_test.dart -d <device> \
//       --dart-define=THEREADER_ARTICLE_JSON=/abs/dir/of/article/json \
//       --dart-define=THEREADER_SHOTS_DIR=/abs/dir \
//       [--dart-define=THEREADER_REVIEW_ONLY=gwern,node-fs] \
//       [--dart-define=THEREADER_REVIEW_PAGES=40] [--dart-define=THEREADER_REVIEW_INTERACTIONS=true]
//
// Each state's name is written to `<shots>/next.txt`; the test waits until a
// host loop has taken the screenshot and deleted the file (or 15 seconds).
// Open times and frame statistics go to `<shots>/timings.txt`. Documents live
// in memory only; nothing is written to the app's storage.
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
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
import 'package:thereader/features/articles/article_blocks.dart';
import 'package:thereader/features/articles/article_media.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';
import 'package:thereader_extract/thereader_extract.dart';

const jsonDir = String.fromEnvironment('THEREADER_ARTICLE_JSON');
const shotsDir = String.fromEnvironment('THEREADER_SHOTS_DIR');
const only = String.fromEnvironment('THEREADER_REVIEW_ONLY');
const maxPages = int.fromEnvironment('THEREADER_REVIEW_PAGES', defaultValue: 40);
const interactions = bool.fromEnvironment('THEREADER_REVIEW_INTERACTIONS');

final articleScroll = find.descendant(of: find.byType(ArticleScreen), matching: find.byType(Scrollable)).first;

/// Settles, then hands the frame to the host screenshot loop.
Future<void> shoot(WidgetTester tester, String state) async {
  await tester.pumpAndSettle();
  await tester.pump(const Duration(milliseconds: 400));
  if (shotsDir.isEmpty) return;
  final next = File('$shotsDir/next.txt')..writeAsStringSync(state);
  for (var i = 0; i < 150 && next.existsSync(); i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void log(String line) {
  debugPrint('[review] $line');
  if (shotsDir.isNotEmpty) File('$shotsDir/timings.txt').writeAsStringSync('$line\n', mode: FileMode.append);
}

/// Seeds memory stores from the JSON directory, shows the app's article
/// library and returns the documents' names and summaries.
Future<List<(String, ArticleSummary)>> openLibrary(WidgetTester tester) async {
    final kv = MemoryKeyValueStore();
    final settings = SettingsRepository(kv);
    await settings.load();
    final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
    await library.load();
    final files = MemoryArticleStore();
    final filters = only.split(',').where((s) => s.isNotEmpty).toList();
    final docs = Directory(jsonDir)
        .listSync()
        .whereType<File>()
        .where((f) => f.path.endsWith('.json') && (filters.isEmpty || filters.any(f.path.contains)))
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    final summaries = <(String, ArticleSummary)>[];
    for (final (i, doc) in docs.indexed) {
      final json = doc.readAsStringSync();
      final article = Article.fromJson((jsonDecode(json) as Map).cast<String, Object?>());
      final id = 'doc$i';
      files.files[id] = json;
      final name = doc.uri.pathSegments.last.replaceFirst(RegExp(r'^\d+-'), '').replaceFirst('.json', '');
      summaries.add((
        name,
        ArticleSummary(
          id: id,
          url: article.url,
          sourceUrl: article.url,
          title: article.title,
          readingMinutes: article.readingMinutes,
          addedAt: DateTime.now().toUtc().subtract(Duration(minutes: i)),
          siteName: article.siteName,
          rtl: article.dir == ArticleDirection.rtl,
        ),
      ));
    }
    await kv.writeJson('articles.v1', {
      'items': [for (final (_, s) in summaries) s.toJson()],
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
    await tester.pumpAndSettle();
    await tester.tap(find.text('Articles'));
    await tester.pumpAndSettle();

    return summaries;
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('reviews stored article documents', (tester) async {
    final summaries = await openLibrary(tester);

    for (final (name, s) in summaries) {
      final tile = find.text(s.title).first;
      await tester.scrollUntilVisible(tile, 300, scrollable: find.byType(Scrollable).first);
      final open = Stopwatch()..start();
      await tester.tap(tile);
      while (find.byType(BlockView).evaluate().isEmpty && open.elapsed.inSeconds < 30) {
        await tester.pump(const Duration(milliseconds: 4));
      }
      open.stop();
      log('$name open ${open.elapsedMilliseconds}ms');
      await shoot(tester, '$name-p00');

      final scrollable = tester.state<ScrollableState>(articleScroll);
      final position = scrollable.position;
      final step = position.viewportDimension * 0.82;
      var page = 1;
      while (page <= maxPages && position.extentAfter > 1) {
        position.jumpTo((position.pixels + step).clamp(0, position.maxScrollExtent));
        await shoot(tester, '$name-p${page.toString().padLeft(2, '0')}');
        page++;
      }
      if (position.extentAfter > 1) {
        // Long documents: sample the rest at a few depths, then the end.
        for (final f in [0.35, 0.6, 0.85, 1.0]) {
          position.jumpTo(position.maxScrollExtent * f);
          await tester.pumpAndSettle();
          position.jumpTo(position.maxScrollExtent * f);
          await shoot(tester, '$name-at${(f * 100).round()}');
        }
      }

      // Flings from the top, recording frame times.
      position.jumpTo(0);
      await tester.pumpAndSettle();
      final timings = <FrameTiming>[];
      void collect(List<FrameTiming> t) => timings.addAll(t);
      SchedulerBinding.instance.addTimingsCallback(collect);
      for (var i = 0; i < 8; i++) {
        await tester.fling(articleScroll, const Offset(0, -500), 3000);
        await tester.pumpAndSettle();
      }
      await tester.pump(const Duration(milliseconds: 500));
      SchedulerBinding.instance.removeTimingsCallback(collect);
      if (timings.isNotEmpty) {
        final build = timings.map((t) => t.buildDuration.inMicroseconds).toList()..sort();
        final raster = timings.map((t) => t.rasterDuration.inMicroseconds).toList()..sort();
        int p(List<int> v, double q) => v[((v.length - 1) * q).round()] ~/ 1000;
        // Work over a 60 Hz frame budget; totalSpan would count the test's own waits.
        final slow = timings.where((t) => (t.buildDuration + t.rasterDuration).inMicroseconds > 16667).length;
        log('$name frames ${timings.length} build p50 ${p(build, .5)}ms p90 ${p(build, .9)}ms max ${p(build, 1)}ms '
            'raster p50 ${p(raster, .5)}ms p90 ${p(raster, .9)}ms max ${p(raster, 1)}ms over-budget $slow');
      }
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await tester.pumpAndSettle();
    }
  }, skip: jsonDir.isEmpty || interactions);

  testWidgets('follows notes, opens images and details, scrolls tables', (tester) async {
    for (final (name, s) in await openLibrary(tester)) {
      await tester.tap(find.text(s.title).first);
      await tester.pumpAndSettle();
      Future<bool> reveal(Finder finder) async {
        try {
          await tester.scrollUntilVisible(finder, 500, scrollable: articleScroll, maxScrolls: 60);
          await tester.pumpAndSettle();
          return true;
        } catch (_) {
          return false;
        }
      }

      final noted = find.byWidgetPredicate(
        (w) => w is RichText && RegExp('[¹²³⁴⁵⁶⁷⁸⁹⁰]').hasMatch(w.text.toPlainText(includeSemanticsLabels: false)),
      );
      if (await reveal(noted)) {
        final paragraph = tester.renderObject<RenderParagraph>(noted.first);
        final text = paragraph.text.toPlainText(includeSemanticsLabels: false);
        final at = text.indexOf(RegExp('[¹²³⁴⁵⁶⁷⁸⁹⁰]'));
        final box = paragraph.getBoxesForSelection(TextSelection(baseOffset: at, extentOffset: at + 1)).first;
        await shoot(tester, '$name-i1-ref');
        await tester.tapAt(paragraph.localToGlobal(box.toRect().center));
        await shoot(tester, '$name-i2-note');
        if (find.text('Back to text').evaluate().isNotEmpty) {
          await tester.tap(find.text('Back to text'));
          await shoot(tester, '$name-i3-back');
        }
      }
      final scrollable = tester.state<ScrollableState>(articleScroll);
      scrollable.position.jumpTo(0);
      await tester.pumpAndSettle();
      if (await reveal(find.byType(FigureView))) {
        await tester.tap(find.byType(FigureView).first);
        await tester.pump(const Duration(seconds: 2));
        await shoot(tester, '$name-i4-viewer');
        await tester.tap(find.byTooltip('Close'));
        await tester.pumpAndSettle();
      }
      scrollable.position.jumpTo(0);
      await tester.pumpAndSettle();
      final table = find.descendant(of: find.byType(ArticleScreen), matching: find.byType(Table));
      if (await reveal(table)) {
        await shoot(tester, '$name-i5-table');
        await tester.drag(table.first, const Offset(-600, 0));
        await shoot(tester, '$name-i6-table-scrolled');
      }
      scrollable.position.jumpTo(0);
      await tester.pumpAndSettle();
      final details = find.byIcon(Icons.chevron_right);
      if (await reveal(details)) {
        await tester.tap(details.first);
        await shoot(tester, '$name-i7-details');
      }
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await tester.pumpAndSettle();
    }
  }, skip: jsonDir.isEmpty || !interactions);
}
