import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/core/theme/app_colors.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/articles/article_store_web.dart';
import 'package:thereader/data/articles/page_fetcher.dart';
import 'package:thereader/data/models/article_summary.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

/// The shared every-block fixture of the Dart article model.
final String fixture = File('../../packages/truffle_dart/test/fixtures/every_block.json').readAsStringSync();

final summary = ArticleSummary(
  id: 'f1x7ure',
  url: 'https://example.com/posts/every-block',
  sourceUrl: 'https://example.com/posts/every-block',
  title: 'Every block the reader can draw',
  siteName: 'Example Journal',
  readingMinutes: 1,
  addedAt: DateTime.utc(2026, 10, 1),
);

const _page = '<html><head><title>Saved From A Link</title></head><body>'
    '<p>This paragraph is long enough to be kept by the placeholder engine.</p></body></html>';

Future<AppServices> makeServices(WidgetTester tester, {bool withFixture = true}) async {
  final kv = MemoryKeyValueStore();
  final settings = SettingsRepository(kv);
  await settings.load();
  final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
  await library.load();
  final files = MemoryArticleStore();
  if (withFixture) {
    files.files[summary.id] = fixture;
    await kv.writeJson('articles.v1', {
      'items': [summary.toJson()],
    });
  }
  final articles = ArticleRepository(
    store: kv,
    files: files,
    fetcher: PageFetcher(
      relayBase: () => Uri.parse('https://reader.example'),
      useRelay: false,
      client: MockClient((_) async => http.Response(_page, 200, headers: {'content-type': 'text/html'})),
    ),
  );
  await articles.load();
  // Parsing runs on a background isolate; finish it outside the fake clock.
  if (withFixture) await tester.runAsync(() => articles.loadArticle(summary.id));
  return AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [DartReaderEngine()]),
    catalogSource: SampleCatalogSource(),
    articles: articles,
  );
}

Widget screen(AppServices services) => AppScope(
  services: services,
  child: MaterialApp(theme: AppTheme.dark, home: ArticleScreen(summary: summary)),
);

/// Where [glyphs] are drawn, in the first paragraph that contains them.
Offset glyphCenter(WidgetTester tester, String glyphs) {
  final paragraph = tester
      .renderObjectList<RenderParagraph>(find.byType(RichText))
      .firstWhere((p) => p.text.toPlainText(includeSemanticsLabels: false).contains(glyphs));
  final at = paragraph.text.toPlainText(includeSemanticsLabels: false).indexOf(glyphs);
  final box = paragraph.getBoxesForSelection(TextSelection(baseOffset: at, extentOffset: at + glyphs.length)).first;
  return paragraph.localToGlobal(box.toRect().center);
}

Finder rich(String text) => find.textContaining(text, findRichText: true);

void main() {
  setUp(rootBundle.clear);

  testWidgets('draws every block and inline type of the article model', (tester) async {
    tester.view.physicalSize = const Size(430, 16000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final services = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    expect(find.text('Every block the reader can draw'), findsOneWidget);
    expect(find.text('EXAMPLE JOURNAL'), findsOneWidget);
    expect(rich('Jane Doe and John Roe  ·  Sep\u00a030, 2026  ·  1\u00a0min read'), findsOneWidget);
    expect(rich('bold italic link'), findsOneWidget);
    expect(find.text('Ctrl'), findsOneWidget, reason: 'kbd');

    expect(rich('Lists and quotes'), findsOneWidget);
    expect(find.text('3.'), findsOneWidget, reason: 'ordered start');
    expect(find.text('4.'), findsOneWidget);
    expect(find.text('•'), findsWidgets);
    expect(find.byIcon(Icons.check_box_rounded), findsOneWidget);
    expect(find.byIcon(Icons.check_box_outline_blank_rounded), findsOneWidget);
    expect(rich('— Edsger W. Dijkstra'), findsOneWidget);
    expect(rich('Read slowly. The words will wait.'), findsOneWidget);

    expect(find.text('fib.py'), findsOneWidget);
    expect(find.text('Python'), findsOneWidget);
    expect(find.text('TypeScript'), findsOneWidget);
    expect(find.byTooltip('Copy code'), findsNWidgets(3));
    final python = tester.widget<RichText>(find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('def fib')));
    final colors = AppColors.defaults;
    final keyword = <Color?>[];
    python.text.visitChildren((span) {
      if (span is TextSpan && span.text == 'def') keyword.add(span.style?.color);
      return true;
    });
    expect(keyword, [colors.purple], reason: 'Python keywords are highlighted in the theme');

    expect(rich('A single figure with a caption'), findsOneWidget);
    expect(rich('Photo: Picsum'), findsOneWidget);
    expect(rich('A three image gallery.'), findsOneWidget);
    expect(find.text('YouTube  ·  A video facade'), findsOneWidget);
    expect(find.text('Episode 12: Reading slowly'), findsOneWidget);
    expect(rich('Mastodon'), findsOneWidget);
    expect(rich('Embedded posts keep their text.'), findsOneWidget);
    expect(find.text('Open on CodePen'), findsOneWidget);

    expect(find.byType(Table), findsOneWidget);
    expect(rich('Release sizes'), findsOneWidget);
    expect(rich('Split per ABI'), findsOneWidget);
    expect(rich('A footer cell spanning two columns'), findsOneWidget);
    expect(find.text('·  ·  ·'), findsOneWidget, reason: 'rule');
    expect(find.byType(Math), findsNWidgets(2), reason: 'inline and block TeX');
    expect(find.text('y = f(x)'), findsOneWidget, reason: 'MathML-only math falls back to text');
    expect(rich('The distance between lines of text.'), findsOneWidget);
    expect(rich('Careful'), findsOneWidget);
    expect(find.text('Tip'), findsOneWidget);
    expect(rich('An unstyled callout.'), findsOneWidget);
    expect(rich('Level six'), findsOneWidget);
    expect(find.text('NOTES'), findsOneWidget);
    expect(rich('The first note.'), findsOneWidget);

    expect(rich('Forty-two.'), findsNothing);
    await tester.tap(rich('Show the answer'));
    await tester.pumpAndSettle();
    expect(rich('Forty-two.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a note reference jumps to the note and back', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final services = await makeServices(tester);
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();

    expect(rich('The first note.'), findsNothing, reason: 'blocks build lazily');
    await tester.tapAt(glyphCenter(tester, '¹'));
    await tester.pumpAndSettle();
    final note = tester.getRect(rich('The first note.'));
    expect(note.top, inInclusiveRange(0, 844));
    expect(find.text('Back to text'), findsOneWidget);

    await tester.tap(find.text('Back to text'));
    await tester.pumpAndSettle();
    expect(find.text('Every block the reader can draw'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('reading position is saved and restored', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final services = await makeServices(tester);
    final articles = services.articles!;
    await tester.pumpWidget(screen(services));
    await tester.pumpAndSettle();
    expect(articles.byId(summary.id)!.lastOpenedAt, isNotNull);

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -2500));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 1));
    final saved = articles.byId(summary.id)!.progress!;
    expect(saved.block, greaterThan(3));
    expect(saved.percent, inExclusiveRange(0, 1));

    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(
      AppScope(
        services: services,
        child: MaterialApp(theme: AppTheme.dark, home: ArticleScreen(summary: articles.byId(summary.id)!)),
      ),
    );
    await tester.pumpAndSettle();
    final scroll = tester.state<ScrollableState>(
      find.descendant(of: find.byType(CustomScrollView), matching: find.byType(Scrollable)).first,
    );
    expect(scroll.position.pixels, greaterThan(1500));
    expect(find.text('${(saved.percent * 100).round()}%'), findsOneWidget);
  });

  testWidgets('the library saves a link, opens it, lists it and removes it', (tester) async {
    final services = await makeServices(tester, withFixture: false);
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    expect(find.text('Nothing here yet.'), findsOneWidget);

    await tester.tap(find.byTooltip('Save article from link'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'example.com/saved');
    await tester.runAsync(() async {
      await tester.tap(find.text('Save article'));
      for (var i = 0; i < 50 && services.articles!.articles.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
    await tester.pumpAndSettle();
    expect(find.byType(ArticleScreen), findsOneWidget);
    expect(find.text('Saved From A Link'), findsOneWidget);

    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(find.text('Saved From A Link'), findsOneWidget, reason: 'listed in the library');
    await tester.tap(find.text('Articles'));
    await tester.pumpAndSettle();
    await tester.longPress(find.text('Saved From A Link'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove from library'));
    await tester.pumpAndSettle();
    expect(services.articles!.articles, isEmpty);
    expect(find.text('Nothing here yet.'), findsOneWidget);
  });

  testWidgets('the add sheet explains a bad link inline', (tester) async {
    final services = await makeServices(tester, withFixture: false);
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Save article from link'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'not a link');
    await tester.tap(find.text('Save article'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Enter a web address'), findsOneWidget);
    expect(jsonEncode(services.articles!.articles), '[]');
  });
}
