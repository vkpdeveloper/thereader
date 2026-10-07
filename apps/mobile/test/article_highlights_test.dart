import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/core/theme/highlight_colors.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/articles/article_anchors.dart';
import 'package:thereader/data/articles/article_store_web.dart';
import 'package:thereader/data/articles/page_fetcher.dart';
import 'package:thereader/data/models/article_summary.dart';
import 'package:thereader/data/models/highlight.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/data/repositories/highlight_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/articles/article_highlights.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/features/articles/article_style.dart';
import 'package:thereader/features/articles/article_text.dart';
import 'package:thereader/features/reader/highlight_sheets.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

/// The shared every-block fixture of the Dart article model.
final String fixture = File('../../packages/truffle_dart/test/fixtures/every_block.json').readAsStringSync();

final summary = ArticleSummary(
  id: '76faff49e6928df24de0670458eb6518',
  url: 'https://example.com/posts/every-block',
  sourceUrl: 'https://example.com/posts/every-block',
  title: 'Every block the reader can draw',
  siteName: 'Example Journal',
  readingMinutes: 1,
  addedAt: DateTime.utc(2026, 10, 1),
);

Future<(AppServices, HighlightRepository)> makeServices(WidgetTester tester) async {
  final kv = MemoryKeyValueStore();
  final settings = SettingsRepository(kv);
  await settings.load();
  final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
  await library.load();
  final files = MemoryArticleStore()..files[summary.id] = fixture;
  await kv.writeJson('articles.v1', {
    'items': [summary.toJson()],
  });
  final articles = ArticleRepository(
    store: kv,
    files: files,
    fetcher: PageFetcher(
      relayBase: () => Uri.parse('https://reader.example'),
      useRelay: false,
      client: MockClient((_) async => http.Response('', 404)),
    ),
  );
  await articles.load();
  final highlights = HighlightRepository(kv);
  await highlights.load();
  // Parsing runs on a background isolate; finish it outside the fake clock.
  await tester.runAsync(() => articles.loadArticle(summary.id));
  final services = AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [DartReaderEngine()]),
    catalogSource: SampleCatalogSource(),
    articles: articles,
    highlights: highlights,
  );
  return (services, highlights);
}

Widget screen(AppServices services) => AppScope(
  services: services,
  child: MaterialApp(theme: AppTheme.dark, home: ArticleScreen(summary: summary)),
);

/// The paragraph that draws [glyphs], and where they are in it.
(RenderParagraph, int) paragraphWith(WidgetTester tester, String glyphs) {
  final paragraph = tester
      .renderObjectList<RenderParagraph>(find.byType(RichText))
      .firstWhere((p) => p.text.toPlainText(includeSemanticsLabels: false).contains(glyphs));
  return (paragraph, paragraph.text.toPlainText(includeSemanticsLabels: false).indexOf(glyphs));
}

Offset glyphCenter(WidgetTester tester, String glyphs) {
  final (paragraph, at) = paragraphWith(tester, glyphs);
  final box = paragraph.getBoxesForSelection(TextSelection(baseOffset: at, extentOffset: at + glyphs.length)).first;
  return paragraph.localToGlobal(box.toRect().center);
}

/// The text spans of the paragraph drawing [glyphs] whose text is exactly [piece].
List<TextSpan> spansOf(WidgetTester tester, String glyphs, String piece) {
  final (paragraph, _) = paragraphWith(tester, glyphs);
  final found = <TextSpan>[];
  paragraph.text.visitChildren((span) {
    if (span is TextSpan && span.text == piece) found.add(span);
    return true;
  });
  return found;
}

ArticleHighlights controllerOf(WidgetTester tester) =>
    ArticleScope.of(tester.element(find.byType(ArticleText).first)).highlights!;

void main() {
  setUp(rootBundle.clear);

  testWidgets('block texts match what every paragraph draws, so offsets point at the drawn glyphs', (tester) async {
    tester.view.physicalSize = const Size(430, 16000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (services, _) = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    final model = controllerOf(tester).model;
    var checked = 0;
    for (final element in find.byType(ArticleText).evaluate()) {
      final state = (element as StatefulElement).state as HighlightableText;
      final anchor = state.anchor;
      if (anchor == null) continue;
      final rich = tester.widget<RichText>(find.descendant(of: find.byWidget(element.widget), matching: find.byType(RichText)).first);
      // Block text leaves out inline widgets, and reads note marks as their labels.
      final drawn = rich.text
          .toPlainText(includeSemanticsLabels: false)
          .replaceAll('\uFFFC', '')
          .replaceAll('\u2060', '')
          .replaceAllMapped(RegExp('[⁰¹²³⁴⁵⁶⁷⁸⁹]'), (m) => '${'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(m[0]!)}');
      expect(model.text(anchor.block)!.substring(anchor.base, anchor.base + anchor.length), drawn);
      checked++;
    }
    expect(checked, greaterThan(30), reason: 'paragraphs, list items, quotes, captions, cells, notes');
    // Inline widgets (math, images, keyboard keys) and list markers are not text.
    expect(model.text(3), startsWith('First bulletSecond bullet'));
    expect(model.text(3), isNot(contains('•')));
    expect(model.text(8), isNull, reason: 'code blocks are not article text here');
  });

  testWidgets('select a word, highlight it from the toolbar, add a note, delete it and undo', (tester) async {
    tester.view.physicalSize = const Size(430, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (services, repo) = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    await tester.longPressAt(glyphCenter(tester, 'reliability'));
    await tester.pumpAndSettle();
    expect(find.byType(HighlightSelectionToolbar), findsOneWidget);
    expect(controllerOf(tester).selection(), isNotNull);

    // The default colour comes first; pick green instead.
    await tester.tap(find.bySemanticsLabel('green'));
    await tester.pumpAndSettle();
    expect(find.byType(HighlightSelectionToolbar), findsNothing);
    final h = repo.forArticle(summary.id).single;
    expect((h.text, h.color, h.bookId, h.sha256), ('reliability', 'green', 'article-${summary.id}', '0' * 64));
    final loc = ArticleLocator.parse(h.locator)!;
    expect((loc.block, loc.highlight, loc.title, loc.href), (5, 'reliability', 'Lists and quotes', summary.url));

    final colors = ArticleScope.of(tester.element(find.byType(ArticleText).first)).style.colors;
    final painted = spansOf(tester, 'Simplicity', 'reliability').single;
    expect(painted.style!.backgroundColor, HighlightColors.tint(HighlightColor.green, colors));
    expect(painted.style!.decorationStyle, isNot(TextDecorationStyle.dotted));

    // Tapping the passage opens its actions; write a note.
    await tester.tapAt(glyphCenter(tester, 'reliability'));
    await tester.pumpAndSettle();
    expect(find.text('Delete'), findsOneWidget);
    await tester.tap(find.text('Note'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Dijkstra, 1975');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(repo.byId(h.id)!.note, 'Dijkstra, 1975');
    final noted = spansOf(tester, 'Simplicity', 'reliability').single;
    expect(noted.style!.decorationStyle, TextDecorationStyle.dotted, reason: 'noted passages get a dotted underline');

    // The note shows above the actions; delete, then undo.
    await tester.tapAt(glyphCenter(tester, 'reliability'));
    await tester.pumpAndSettle();
    expect(find.text('Dijkstra, 1975'), findsOneWidget);
    expect(find.text('Edit note'), findsOneWidget);
    await tester.tap(find.text('Delete'));
    await tester.pumpAndSettle();
    expect(repo.forArticle(summary.id), isEmpty);
    expect(spansOf(tester, 'Simplicity', 'reliability'), isEmpty, reason: 'no longer drawn apart');
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    final restored = repo.forArticle(summary.id).single;
    expect((restored.text, restored.color, restored.note), ('reliability', 'green', 'Dijkstra, 1975'));
  });

  testWidgets('words after inline widgets (raised text, keys, images, math) highlight the right glyphs', (tester) async {
    tester.view.physicalSize = const Size(430, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (services, repo) = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    // "H₂O, E = mc², … press Ctrl + C, bold italic link and a note¹."
    await tester.longPressAt(glyphCenter(tester, 'note\u2060'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('yellow'));
    await tester.pumpAndSettle();
    // "A line / break, an inline image [dog], inline math [a²+b²=c²] … with a second note²."
    await tester.longPressAt(glyphCenter(tester, 'second'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('blue'));
    await tester.pumpAndSettle();

    final items = repo.forArticle(summary.id);
    expect([for (final h in items) (h.text, ArticleLocator.parse(h.locator)!.block)], [('note', 0), ('second', 1)]);
    expect(spansOf(tester, 'and a ', 'note'), hasLength(1));
    expect(spansOf(tester, 'with a ', 'second'), hasLength(1));
  });

  testWidgets('a selection without article text keeps the system toolbar', (tester) async {
    tester.view.physicalSize = const Size(430, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (services, _) = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    // The title is part of the page, not of the article's blocks.
    await tester.longPressAt(tester.getCenter(find.text('Every block the reader can draw')));
    await tester.pumpAndSettle();
    expect(find.byType(HighlightSelectionToolbar), findsNothing);
    expect(find.byType(AdaptiveTextSelectionToolbar), findsOneWidget);
  });

  testWidgets('a highlight from another device is drawn, listed with its note, and opened from the list', (tester) async {
    tester.view.physicalSize = const Size(430, 932);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final (services, repo) = await makeServices(tester);
    // As the web app writes it: offsets from its own block text, which
    // counts code; the quote finds the passage here.
    await repo.create(
      bookId: ArticleAnchors.bookIdFor(summary.id),
      sha256: ArticleAnchors.sha256,
      origin: 'https://reader.ordinity.com',
      locator: {
        'type': 'article',
        'href': summary.url,
        'articleId': summary.id,
        'block': 30,
        'start': 4,
        'endBlock': 30,
        'end': 14,
        'title': 'Level six',
        'locations': {'progression': 0.97, 'totalProgression': 0.97},
        'text': {'before': 'The ', 'highlight': 'first note', 'after': '.'},
      },
      text: 'first note',
      color: 'purple',
      note: 'From the web.',
    );
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();
    expect(find.text('first note'), findsNothing, reason: 'the notes are far below');

    await tester.tap(find.byTooltip('Highlights'));
    await tester.pumpAndSettle();
    expect(find.text('From the web.'), findsOneWidget);
    expect(find.text('Level six'), findsOneWidget);
    await tester.tap(find.text('first note'));
    await tester.pumpAndSettle();

    final center = glyphCenter(tester, 'first note');
    expect(center.dy, inInclusiveRange(0, 932), reason: 'jumped to the passage');
    final colors = ArticleScope.of(tester.element(find.byType(ArticleText).first)).style.colors;
    final span = spansOf(tester, 'The first note', 'first note').single;
    expect(span.style!.backgroundColor, isNot(HighlightColors.tint(HighlightColor.purple, colors)), reason: 'marked for a moment');
    await tester.pump(const Duration(seconds: 2));
    expect(spansOf(tester, 'The first note', 'first note').single.style!.backgroundColor, HighlightColors.tint(HighlightColor.purple, colors));

    // Deleting from the list offers Undo on the sheet itself. (A small
    // scroll back brings the floating bar in.)
    await tester.drag(find.byType(CustomScrollView), const Offset(0, 120));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Highlights'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Delete highlight'));
    await tester.pumpAndSettle();
    expect(repo.forArticle(summary.id), isEmpty);
    expect(find.text('No highlights yet.'), findsOneWidget);
    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(repo.forArticle(summary.id).single.note, 'From the web.');
    expect(find.text('From the web.'), findsOneWidget, reason: 'back in the open list');
  });
}
