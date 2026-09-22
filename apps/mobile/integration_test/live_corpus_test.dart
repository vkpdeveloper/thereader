// Local Worker and private corpus only. Run import-local.ts first.
// API defaults to iOS localhost; Android: --dart-define=TEST_API=http://10.0.2.2:8787
import 'dart:convert';
import 'dart:ui';
import 'package:flutter/scheduler.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:integration_test/integration_test.dart';
import 'package:thereader/main.dart' as app;
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/features/reader/reader_screen.dart';

const api = String.fromEnvironment('TEST_API', defaultValue: 'http://127.0.0.1:8787');
void event(String name, [Map<String, Object?> data = const {}]) =>
    debugPrint('BENCH ${jsonEncode({'event': name, 'at': DateTime.now().toUtc().toIso8601String(), ...data})}');
Future<void> wait(WidgetTester tester, [int seconds = 2]) async {
  await tester.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 30));
  await tester.pump(Duration(seconds: seconds));
}
Future<void> until(WidgetTester tester, bool Function() condition, {int seconds = 180}) async {
  final end = DateTime.now().add(Duration(seconds: seconds));
  while (!condition()) {
    if (DateTime.now().isAfter(end)) fail('Timed out');
    await tester.pump(const Duration(milliseconds: 200));
  }
}
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('live catalog, real corpus, native reading and durable reopen', (tester) async {
    final frames = <FrameTiming>[];
    void capture(List<FrameTiming> values) => frames.addAll(values);
    SchedulerBinding.instance.addTimingsCallback(capture);
    addTearDown(() => SchedulerBinding.instance.removeTimingsCallback(capture));
    await app.main();
    await wait(tester);
    final services = AppScope.of(tester.element(find.byType(Scaffold).first));
    await until(tester, () => services.library.loaded);
    await services.settings.setApiBaseUrl(api);
    await services.settings.setMode(AppMode.api);
    await services.settings.setPreferredEngine('readium');
    await services.settings.updateReader((p) => p.copyWith(flow: ReaderFlow.paginated));
    final source = services.currentSource;
    if (const bool.fromEnvironment('RESET_CORPUS')) {
      for (final e in services.library.entries.toList()) {
        if (e.book.id.startsWith('corpus-')) await services.library.remove(e.id);
      }
    }
    await services.settings.updateReader((_) => const ReaderPreferences(flow: ReaderFlow.paginated));
    final page = await source.listBooks(limit: 2);
    expect(page.items.length, 2);
    expect(page.nextCursor, isNotNull);
    final second = await source.listBooks(limit: 2, cursor: page.nextCursor);
    expect(second.items.map((b) => b.id).toSet().intersection(page.items.map((b) => b.id).toSet()), isEmpty);
    final search = await source.listBooks(query: 'corpus');
    expect(search.items.length, 3);
    event('catalog_search_paging_pass');
    await tester.tap(find.text('Browse'));
    await wait(tester, 3);
    for (final role in ['typical', 'long-chapter', 'large']) {
      final book = await source.getBook('corpus-$role');
      final card = find.byWidgetPredicate((w) => w is Text && w.data == book.title && w.maxLines == 1);
      await tester.scrollUntilVisible(card, 200, scrollable: find.byType(Scrollable).last);
      await tester.tap(card);
      await wait(tester);
      var entry = services.library.entryFor(book, source);
      if (entry?.download.isReady != true) {
        event('download_start', {'role': role, 'bytes': book.fileSize});
        final clock = Stopwatch()..start();
        await tester.tap(find.textContaining('Download ·'));
        await until(tester, () => services.library.entryFor(book, source)?.download.isActive == false);
        entry = services.library.entryFor(book, source)!;
        expect(entry.download.isReady, isTrue, reason: entry.download.error);
        event('download_verified', {'role': role, 'ms': clock.elapsedMilliseconds});
      }
      await wait(tester);
      for (var cycle = 0; cycle < 3; cycle++) {
        final openClock = Stopwatch()..start();
        event('open_start', {'role': role, 'cycle': cycle});
        await tester.tap(find.text(cycle == 0 && entry?.progress == null ? 'Read' : 'Continue reading'));
        await until(tester, () => find.byType(rd.ReadiumReaderWidget).evaluate().isNotEmpty);
        // Native text rendering is checked in the captured video, not inferred
        // from widget existence. This timestamp measures host availability only.
        event('native_host', {'role': role, 'cycle': cycle, 'ms': openClock.elapsedMilliseconds});
        await wait(tester, 5);
        expect(find.textContaining("Couldn't open"), findsNothing);
        await tester.tapAt(tester.getCenter(find.byType(Scaffold).last));
        await wait(tester);
        await tester.tap(find.byTooltip('Contents'));
        await wait(tester);
        final items = find.byType(ListTile);
        expect(items, findsWidgets);
        await tester.tap(items.at(items.evaluate().length > 3 ? 3 : 0));
        await wait(tester, 5);
        if (cycle == 0) {
          await tester.tap(find.byTooltip('Typography'));
          await wait(tester);
          await tester.tap(find.text('Sans'));
          await wait(tester, 3);
          await tester.tap(find.text('Serif'));
          await wait(tester);
          await tester.tapAt(const Offset(200, 120));
          await wait(tester);
          await tester.tap(find.byTooltip('Next page'));
          await wait(tester, 3);
        }
        if (cycle == 0 && role == 'typical') {
          await tester.tap(find.byTooltip('Search book'));
          await wait(tester);
          await tester.enterText(find.byType(TextField).last, 'Andor');
          await tester.tap(find.byTooltip('Find text'));
          await until(tester, () => find.byType(ListTile).evaluate().isNotEmpty);
          await wait(tester, 3);
          await tester.tap(find.byType(ListTile).first);
          await wait(tester, 4);
          event('native_search_pass');
        }
        event('read_controls_pass' , {'role': role, 'cycle': cycle});
        await tester.tap(find.byTooltip('Close book'));
        await wait(tester, 2);
        await services.library.flush();
        entry = services.library.entryFor(book, source)!;
        expect(entry.progress?.locator.engine, 'readium');
        event('close_saved', {'role': role, 'cycle': cycle});
      }
      await tester.tap(find.byType(BackButton));
      await wait(tester);
    }
    // Local storage restoration is independent of a working catalog endpoint.
    await services.settings.setApiBaseUrl('http://127.0.0.1:1');
    await tester.tap(find.text('Library'));
    await wait(tester, 3);
    final entry = services.library.entries.firstWhere((e) => e.book.id == 'corpus-large');
    event('offline_open_start');
    ReaderScreen.open(tester.element(find.byType(Scaffold).first), entry);
    await until(tester, () => find.byType(rd.ReadiumReaderWidget).evaluate().isNotEmpty);
    await wait(tester, 6);
    expect(find.textContaining("Couldn't open"), findsNothing);
    event('offline_native_open_pass');
    await tester.tapAt(tester.getCenter(find.byType(Scaffold).last));
    await wait(tester);
    await tester.tap(find.byTooltip('Close book'));
    await wait(tester);
    await services.settings.setApiBaseUrl(api);
    double percentile(List<int> values, double p) {
      values.sort();
      return values.isEmpty ? 0 : values[((values.length - 1) * p).round()] / 1000;
    }
    event('flutter_frame_diagnostics', {
      'frames': frames.length,
      'build_p95_ms': percentile(frames.map((f) => f.buildDuration.inMicroseconds).toList(), .95),
      'raster_p95_ms': percentile(frames.map((f) => f.rasterDuration.inMicroseconds).toList(), .95),
      'over_16_67_ms': frames.where((f) => f.totalSpan.inMicroseconds > 16667).length,
      'note': 'Debug simulator Flutter frames only; excludes native WebView drawing',
    });
  }, timeout: const Timeout(Duration(minutes: 20)));
}
