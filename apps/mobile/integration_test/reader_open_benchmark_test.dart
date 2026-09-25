// Private corpus served separately; never bundled or committed.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:integration_test/integration_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('cached native resume benchmark', (tester) async {
    final root = await Directory.systemTemp.createTemp('reader-bench');
    final store = IoBookStore(root);
    const host = String.fromEnvironment(
      'BENCH_HOST',
      defaultValue: '127.0.0.1',
    );
    const engine = ReadiumReaderEngine();
    const synthetic = bool.fromEnvironment('BENCH_SYNTHETIC');
    const paginated = bool.fromEnvironment('BENCH_PAGINATED');
    const cycles = int.fromEnvironment('BENCH_CYCLES', defaultValue: 3);
    expect(cycles, greaterThan(0), reason: 'BENCH_CYCLES must be positive');
    var selectedFixtures = 0;
    for (final fixture in [
      if (synthetic) ('synthetic', 'OEBPS/Text/chapter-9.xhtml', .8),
      if (!synthetic) ...[
        ('typical', 'OEBPS/Text/part0019.xhtml', .5),
        ('long-chapter', 'OEBPS/Text/01_math_fundamentals_fragment.xhtml', .8),
        ('long-chapter', 'OEBPS/Text/07_applications_fragment.xhtml', .8),
      ],
    ]) {
      const onlyHref = String.fromEnvironment('BENCH_HREF');
      if (onlyHref.isNotEmpty && fixture.$2 != onlyHref) continue;
      selectedFixtures++;
      final file = File('${root.path}/${fixture.$1}.epub');
      if (!await file.exists()) {
        final client = HttpClient();
        final response = await (await client.getUrl(
          Uri.parse('http://$host:8923/${fixture.$1}.epub'),
        )).close();
        expect(response.statusCode, 200);
        await response.pipe(file.openWrite());
        client.close();
      }
      ReadingLocator? saved;
      for (var cycle = 0; cycle < cycles; cycle++) {
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: const Scaffold(body: Center(child: Text('Opening…'))),
          ),
        );
        await tester.pump();
        final watch = Stopwatch()..start();
        debugPrint(
          'OPEN_BENCH ${jsonEncode({'event': 'start', 'book': fixture.$1, 'href': fixture.$2, 'cycle': cycle})}',
        );
        final controller =
            await engine.open(
                  file: await store.open('${fixture.$1}.epub'),
                  prefs: const ReaderPreferences(
                    flow: paginated
                        ? ReaderFlow.paginated
                        : ReaderFlow.scrolled,
                  ),
                  initialLocator:
                      saved ??
                      ReadingLocator(href: fixture.$2, progression: fixture.$3),
                )
                as ReadiumReaderController;
        final openedMs = watch.elapsedMilliseconds;
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
        while (!controller.pageVisible.value &&
            watch.elapsed < const Duration(seconds: 120)) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        debugPrint(
          'OPEN_BENCH ${jsonEncode({'event': 'ready', 'book': fixture.$1, 'href': fixture.$2, 'cycle': cycle, 'publicationMs': openedMs, 'readyMs': watch.elapsedMilliseconds, 'ready': controller.pageVisible.value})}',
        );
        // This vendored widget sets isReady only on its current-page channel
        // callback. A global ready status can come from a neighboring preload.
        final dynamic nativeState = tester.state(
          find.byType(rd.ReadiumReaderWidget),
        );
        while ((nativeState.isReady != true ||
                controller.locator.value?.raw?['locations']?['cssSelector'] ==
                    null ||
                ((controller.locator.value?.progression ?? 0) - fixture.$3)
                        .abs() >
                    .025) &&
            watch.elapsed < const Duration(seconds: 120)) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        debugPrint(
          'OPEN_BENCH ${jsonEncode({'event': 'positioned', 'book': fixture.$1, 'href': fixture.$2, 'cycle': cycle, 'ms': watch.elapsedMilliseconds, 'locator': controller.locator.value?.toJson()})}',
        );
        // Native ready is not a first-readable-text assertion. Capture external
        // screenshots during this window while continuing to schedule frames.
        for (var i = 0; i < 100; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        debugPrint(
          'OPEN_BENCH ${jsonEncode({'event': 'settled', 'book': fixture.$1, 'href': fixture.$2, 'cycle': cycle, 'ms': watch.elapsedMilliseconds, 'locator': controller.locator.value?.toJson()})}',
        );
        expect(nativeState.isReady, isTrue);
        expect(controller.pageVisible.value, isTrue);
        expect(controller.locator.value?.href, fixture.$2);
        expect(
          controller.locator.value?.raw?['locations']?['cssSelector'],
          isNotNull,
        );
        expect(
          controller.locator.value?.progression,
          closeTo(fixture.$3, .025),
        );
        if (saved != null) {
          expect(
            controller.locator.value?.raw?['locations']?['cssSelector'],
            saved.raw?['locations']?['cssSelector'],
            reason: 'Reopening must preserve the saved text anchor',
          );
        }
        saved = controller.locator.value;
        await tester.pumpWidget(const SizedBox.shrink());
        controller.dispose();
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
      }
    }
    await root.delete(recursive: true);
    expect(
      selectedFixtures,
      greaterThan(0),
      reason: 'BENCH_HREF must match at least one fixture',
    );
  }, timeout: const Timeout(Duration(minutes: 15)));
}
