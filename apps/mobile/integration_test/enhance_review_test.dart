// Reviews maths/code rendering in the Readium engine on a simulator or
// emulator, for before/after screenshots.
//
// Books are private local copies (nobs, llm, ladr3e, ladr4e, plus the committed
// apps/web/fixtures/enhance-sampler.epub copied as sampler.epub), served with
// screenshots and carried highlight locators by tool/enhance_review_host.py:
//   python3 -I tool/enhance_review_host.py <books> <out> after
//   flutter test integration_test/enhance_review_test.dart -d <device>
// The iOS simulator shares the host network (the default REVIEW_HOST); on the
// Android emulator pass `--dart-define=REVIEW_HOST=10.0.2.2:8931` and run the
// helper with PLATFORM=android. No sync and no app storage are involved:
// books go to a temporary IoBookStore and open through ReadiumReaderEngine
// directly, the same path ReaderScreen uses.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/highlight.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

const _host = String.fromEnvironment(
  'REVIEW_HOST',
  defaultValue: '127.0.0.1:8931',
);

/// Comma-separated stop names to run; empty runs all.
const _only = String.fromEnvironment('REVIEW_ONLY');

/// Extra wait on NOBS chapters, whose ~1,000 images each load before Readium
/// shows the page.
const _nobsSettle = int.fromEnvironment(
  'REVIEW_NOBS_SETTLE',
  defaultValue: 8000,
);

/// Skips highlight, resume and ToC checks (screenshots only).
const _shotsOnly = bool.fromEnvironment('REVIEW_SHOTS_ONLY');

class _Stop {
  const _Stop(
    this.name,
    this.book,
    this.href, {
    this.flow = ReaderFlow.scrolled,
    this.theme,
    this.query,
  });
  final String name;
  final String book;
  final String href;
  final ReaderFlow flow;
  final String? theme;

  /// Text to search for and jump to after arriving at [href].
  final String? query;
}

final _stops = [
  _Stop(
    'nobs-ch1',
    'nobs',
    'OEBPS/Text/01_math_fundamentals_fragment.xhtml#sec-solving_equations',
  ),
  _Stop(
    'nobs-ch5',
    'nobs',
    'OEBPS/Text/05_linear_transformations_fragment.xhtml#sec-finding_matrix_representations',
  ),
  _Stop(
    'nobs-ch5-paginated',
    'nobs',
    'OEBPS/Text/05_linear_transformations_fragment.xhtml#sec-finding_matrix_representations',
    flow: ReaderFlow.paginated,
  ),
  _Stop('llm-tokenizing', 'llm', 'OEBPS/Text/chapter-2.xhtml#p24'),
  _Stop(
    'llm-tokenizing-paginated',
    'llm',
    'OEBPS/Text/chapter-2.xhtml#p28',
    flow: ReaderFlow.paginated,
  ),
  _Stop(
    'llm-tokenizing-nord',
    'llm',
    'OEBPS/Text/chapter-2.xhtml#p28',
    theme: 'nord',
  ),
  _Stop(
    'ladr-385',
    'ladr3e',
    'index_split_001.html#p111',
    query: 'Two affine subsets parallel to U are equal or disjoint',
  ),
  // The calibre 6 conversion of the same book (garbled TeX-font math).
  _Stop(
    'ladr3e-v2-13',
    'ladr3e-v2',
    'index_split_000.html',
    query: 'Properties of complex arithmetic',
  ),
  _Stop(
    'ladr3e-v2-385',
    'ladr3e-v2',
    'index_split_001.html#p111',
    query: 'Two affine subsets parallel to U are equal or disjoint',
  ),
  // A MathML EPUB of the 4th edition, converted from the open-access PDF.
  _Stop('ladr4e-3103', 'ladr4e', 'OEBPS/text/ch03-05.xhtml#n3.103'),
  _Stop(
    'ladr4e-912',
    'ladr4e',
    'OEBPS/text/ch09-01.xhtml#n9.12',
    flow: ReaderFlow.paginated,
  ),
  // apps/web/fixtures/enhance-sampler.epub
  for (final c in ['mathml', 'tex', 'code', 'images', 'table', 'pdf'])
    _Stop('sampler-$c', 'sampler', 'OEBPS/$c.xhtml'),
  _Stop(
    'sampler-code-paginated',
    'sampler',
    'OEBPS/code.xhtml',
    flow: ReaderFlow.paginated,
  ),
  _Stop(
    'sampler-mathml-paginated',
    'sampler',
    'OEBPS/mathml.xhtml',
    flow: ReaderFlow.paginated,
  ),
];

/// Highlights carried across builds: (book, quoted text).
const _carried = [
  ('ladr3e', 'Two affine subsets parallel to U are equal or disjoint'),
  ('llm', 'split input text into individual tokens'),
  ('sampler', 'Work through the list from left to right'),
];

Future<String> _get(String path) async {
  final client = HttpClient();
  try {
    final response = await (await client.getUrl(
      Uri.parse('http://$_host$path'),
    )).close();
    final body = await response
        .transform(const SystemEncoding().decoder)
        .join();
    if (response.statusCode != 200) {
      throw HttpException('$path: ${response.statusCode} $body');
    }
    return body;
  } finally {
    client.close();
  }
}

Future<void> _log(String m) async {
  debugPrint('[review] $m');
  try {
    await _get('/log?m=${Uri.encodeQueryComponent(m)}');
  } catch (_) {}
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('maths and code review stops', (tester) async {
    final root = await Directory.systemTemp.createTemp('enhance-review');
    final store = IoBookStore(root);
    const engine = ReadiumReaderEngine();
    final only = _only.isEmpty ? null : _only.split(',').toSet();

    Future<bool> fetch(String book) async {
      final file = File('${root.path}/$book.epub');
      if (await file.exists()) return true;
      final client = HttpClient();
      try {
        final response = await (await client.getUrl(
          Uri.parse('http://$_host/books/$book.epub'),
        )).close();
        if (response.statusCode != 200) return false;
        await response.pipe(file.openWrite());
        return true;
      } finally {
        client.close();
      }
    }

    Future<ReadiumReaderController> open(
      String book,
      ReaderPreferences prefs, {
      ReadingLocator? at,
    }) async {
      final watch = Stopwatch()..start();
      final controller =
          await engine.open(
                file: await store.open('$book.epub'),
                prefs: prefs,
                initialLocator: at,
              )
              as ReadiumReaderController;
      await _log('$book opened in ${watch.elapsedMilliseconds}ms');
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Builder(
              builder: (context) => engine.buildView(context, controller),
            ),
          ),
        ),
      );
      final dynamic state = tester.state(find.byType(rd.ReadiumReaderWidget));
      while ((!controller.pageVisible.value ||
              state.isReady != true ||
              controller.locator.value == null) &&
          watch.elapsed < const Duration(seconds: 90)) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      await _log(
        '$book ready in ${watch.elapsedMilliseconds}ms at ${controller.locator.value?.href}',
      );
      return controller;
    }

    Future<void> settle([int ms = 2500]) async {
      for (var i = 0; i < ms ~/ 50; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    Future<void> close(ReadiumReaderController controller) async {
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await settle(800);
    }

    ReadiumReaderController? current;
    String? currentKey;
    for (final stop in _stops) {
      if (only != null && !only.contains(stop.name)) continue;
      if (!await fetch(stop.book)) {
        await _log('${stop.name}: no ${stop.book}.epub on the host, skipped');
        continue;
      }
      // Consecutive stops in the same book and settings share one opening:
      // NOBS alone takes over a minute to open on a simulator.
      final key = '${stop.book}/${stop.flow}/${stop.theme}';
      if (current != null && currentKey != key) {
        await close(current);
        current = null;
      }
      final prefs = ReaderPreferences(flow: stop.flow, themeId: stop.theme);
      final controller = current ??= await open(stop.book, prefs);
      currentKey = key;
      if (stop.href.isNotEmpty) {
        // Fragment as a location, not in the href: Readium Swift looks the
        // href up in the reading order verbatim.
        final [path, ...rest] = stop.href.split('#');
        final ok = await controller.readium.goToLocator(
          rd.Locator(
            href: path,
            type: 'application/xhtml+xml',
            locations: rd.Locations(
              fragments: rest,
              cssSelector: rest.isEmpty ? null : '#${rest.first}',
            ),
          ),
        );
        final watch = Stopwatch()..start();
        while (controller.locator.value?.href != path &&
            watch.elapsed < const Duration(seconds: 90)) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        await _log(
          '${stop.name}: goTo $ok -> ${controller.locator.value?.href} in ${watch.elapsedMilliseconds}ms',
        );
        // Large chapters (NOBS: 1.5 MB, ~1,000 equations) lay out slowly.
        await settle(stop.book == 'nobs' ? _nobsSettle : 1500);
      }
      final query = stop.query;
      if (query != null) {
        final matches = await controller.search(query);
        if (matches.isNotEmpty) await controller.goTo(matches.first.locator);
        await settle(1500);
      }
      await settle();
      await _log('${stop.name}: at ${controller.locator.value?.toJson()}');
      await _get('/shot/${stop.name}');
    }
    if (current != null) await close(current);

    // Highlights made before the enhancer must land on the same words. The
    // first run (e.g. a build without the enhancer) stores each search
    // locator on the host; later runs apply that stored locator as is.
    if (!_shotsOnly && (only == null || only.contains('carry'))) {
      for (final (book, query) in _carried) {
        if (!await fetch(book)) continue;
        final controller = await open(book, const ReaderPreferences());
        final key = 'carry-$book';
        var raw = await _get('/get?k=$key');
        if (raw.isEmpty) {
          final matches = await controller.search(query);
          expect(matches, isNotEmpty, reason: '$book: search finds "$query"');
          raw = jsonEncode(matches.first.locator.toJson());
          await _get('/put?k=$key&v=${Uri.encodeQueryComponent(raw)}');
        }
        final locator = ReadingLocator.fromJson(
          (jsonDecode(raw) as Map).cast<String, dynamic>(),
        );
        await controller.goTo(locator);
        await settle(1500);
        final now = DateTime.now();
        controller.setHighlights([
          Highlight(
            id: key,
            bookId: book,
            sha256: '',
            origin: 'local',
            locator: locator.raw!,
            text: query,
            color: 'green',
            createdAt: now,
            updatedAt: now,
          ),
        ]);
        await settle();
        await _get('/shot/$key');
        await close(controller);
      }
    }

    if (_shotsOnly || (only != null && !only.contains('checks'))) {
      await root.delete(recursive: true);
      return;
    }

    // Existing behaviour on the derived copy: highlight anchoring, resume,
    // table of contents.
    if (await fetch('llm')) {
      const prefs = ReaderPreferences();
      var controller = await open('llm', prefs);
      final matches = await controller.search(
        'split input text into individual tokens',
      );
      expect(matches, isNotEmpty, reason: 'search finds the sentence');
      final match = matches.first;
      final now = DateTime.now();
      final highlight = Highlight(
        id: 'review-1',
        bookId: 'llm',
        sha256: '',
        origin: 'local',
        locator: match.locator.raw!,
        text: 'split input text into individual tokens',
        color: 'yellow',
        createdAt: now,
        updatedAt: now,
      );
      await controller.goTo(match.locator);
      await settle(1500);
      controller.setHighlights([highlight]);
      await settle();
      await _get('/shot/check-highlight');
      final saved = controller.locator.value!;
      await _log('saved ${saved.toJson()}');
      await close(controller);

      controller = await open('llm', prefs, at: saved);
      controller.setHighlights([highlight]);
      await settle();
      final restored = controller.locator.value!;
      await _log('restored ${restored.toJson()}');
      expect(restored.href, saved.href);
      expect(restored.progression, closeTo(saved.progression, .03));
      await _get('/shot/check-highlight-reopen');

      final toc = controller.info.toc;
      final target = toc.firstWhere(
        (t) => t.title.contains('Working with text data'),
        orElse: () => toc[toc.length ~/ 2],
      );
      await controller.goToHref(target.href);
      await settle();
      await _log(
        'toc ${target.title} ${target.href} -> ${controller.locator.value?.href}',
      );
      expect(
        controller.locator.value?.href.split('#').first,
        target.href.split('#').first,
      );
      await _get('/shot/check-toc');

      // A live theme change recolours code panels and syntax without a
      // reload (thereader-themes.css keys on ReadiumCSS's colours).
      final code = (await controller.search(
        'urllib.request.urlretrieve',
      )).first;
      await controller.goTo(code.locator);
      await settle(1500);
      controller.applyPreferences(const ReaderPreferences(themeId: 'dracula'));
      await settle();
      await _get('/shot/check-theme-live');
      await close(controller);
    }
    await root.delete(recursive: true);
  }, timeout: const Timeout(Duration(minutes: 30)));
}
