import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/comic/comic_reader_screen.dart';
import 'package:thereader/features/comic/comic_reader_view.dart';
import 'package:thereader/features/reader/reader_screen.dart';
import 'package:thereader/reader/comic/comic_page_store.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

const portrait = Size(2 / 3, 1);
const wide = Size(3 / 2, 1);

/// Page images made once per test outside the fake-async zone; the decoder
/// hands out clones, identified by the one-byte "file" of each page.
class FakePages {
  FakePages(this.sizes, this.images);
  final List<Size> sizes;
  final Map<Size, ui.Image> images;
  int decodes = 0;
  final List<Size> targets = [];

  static Future<FakePages> make(WidgetTester tester, List<Size> sizes) async {
    final images = <Size, ui.Image>{};
    await tester.runAsync(() async {
      for (final s in sizes.toSet()) {
        images[s] = await createTestImage(width: (s.width * 300).round(), height: (s.height * 300).round());
      }
    });
    return FakePages(sizes, images);
  }

  Future<DecodedComicPage> decode(Uint8List bytes, Size Function(Size) targetFor) async {
    decodes++;
    final size = sizes[bytes[0]] * 1200;
    targets.add(targetFor(size));
    return DecodedComicPage(size, images[sizes[bytes[0]]]!.clone());
  }

  ComicPageStore store({Future<Uint8List> Function(int page)? read}) => ComicPageStore(
    pageCount: sizes.length,
    read: read ?? (p) async => Uint8List.fromList([p]),
    decode: decode,
  );
}

void main() {
  late ComicViewController controller;

  setUp(() => controller = ComicViewController());

  Future<void> setScreen(WidgetTester tester, Size size) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pump();
    await tester.pump();
  }

  Future<void> pumpView(
    WidgetTester tester,
    ComicPageStore store, {
    Size screen = const Size(390, 844),
    int initialPage = 0,
  }) async {
    await setScreen(tester, screen);
    await tester.pumpWidget(
      MaterialApp(
        home: ComicReaderView(store: store, controller: controller, initialPage: initialPage),
      ),
    );
    await tester.pump();
    await tester.pump();
  }

  Finder leaf() => find.byKey(const ValueKey('leaf'));
  Matrix4 leafMatrix(WidgetTester tester) =>
      tester.widget<Transform>(find.descendant(of: leaf(), matching: find.byType(Transform))).transform;

  Future<void> tapThird(WidgetTester tester, {required bool right}) async {
    final size = tester.getSize(find.byType(ComicReaderView));
    await tester.tapAt(Offset(right ? size.width - 20 : 20, size.height / 2));
    // Single taps wait out the double-tap window.
    await tester.pump(kDoubleTapTimeout + const Duration(milliseconds: 10));
  }

  testWidgets('a tap on the outer thirds turns the page with a hinge flip', (tester) async {
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());
    expect(controller.firstPage, 0);

    await tapThird(tester, right: true);
    await tester.pump(const Duration(milliseconds: 200));
    expect(leaf(), findsOneWidget, reason: 'the leaf is mid-turn');
    expect(controller.firstPage, 0);
    await tester.pump(ComicReaderView.turnDuration);
    await tester.pump();
    expect(leaf(), findsNothing);
    expect(controller.firstPage, 1);

    await tapThird(tester, right: false);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 0);
    // Nothing before the cover.
    await tapThird(tester, right: false);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 0);
  });

  testWidgets('the centre third toggles chrome instead of turning', (tester) async {
    final pages = await FakePages.make(tester, List.filled(3, portrait));
    var taps = 0;
    await setScreen(tester, const Size(390, 844));
    await tester.pumpWidget(
      MaterialApp(
        home: ComicReaderView(store: pages.store(), controller: controller, onCenterTap: () => taps++),
      ),
    );
    await tester.pump();
    await tester.tapAt(const Offset(195, 422));
    await tester.pump(kDoubleTapTimeout + const Duration(milliseconds: 10));
    await tester.pumpAndSettle();
    expect(taps, 1);
    expect(controller.firstPage, 0);
  });

  testWidgets('the leaf follows a drag and completes on release', (tester) async {
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());

    final gesture = await tester.startGesture(const Offset(360, 400));
    final cosines = <double>[];
    for (var i = 0; i < 8; i++) {
      await gesture.moveBy(const Offset(-30, 0));
      await tester.pump(const Duration(milliseconds: 16));
      if (leaf().evaluate().isNotEmpty) cosines.add(leafMatrix(tester).entry(0, 0));
    }
    expect(cosines.length, greaterThan(5));
    // Further left, further turned: the leaf's x scale (cos θ) keeps falling.
    for (var i = 1; i < cosines.length; i++) {
      expect(cosines[i], lessThan(cosines[i - 1]));
    }
    expect(controller.firstPage, 0);
    await gesture.up();
    await tester.pumpAndSettle();
    expect(controller.firstPage, 1);

    // A drag to the right turns back.
    await tester.timedDragFrom(const Offset(30, 400), const Offset(300, 0), const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(controller.firstPage, 0);
  });

  testWidgets('a short slow drag springs back; a quick flick turns', (tester) async {
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());

    final gesture = await tester.startGesture(const Offset(300, 400));
    for (var i = 0; i < 6; i++) {
      await gesture.moveBy(const Offset(-10, 0));
      await tester.pump(const Duration(milliseconds: 120));
    }
    expect(leaf(), findsOneWidget);
    await gesture.up();
    await tester.pumpAndSettle();
    expect(controller.firstPage, 0);
    expect(leaf(), findsNothing);

    await tester.flingFrom(const Offset(300, 400), const Offset(-80, 0), 1500);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 1);
  });

  testWidgets('arrow and page keys turn pages', (tester) async {
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 2);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 1);
  });

  testWidgets('reduced motion turns with a short cross-fade, no leaf', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(
      disableAnimations: true,
    );
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());

    await tapThird(tester, right: true);
    await tester.pump(const Duration(milliseconds: 60));
    expect(leaf(), findsNothing);
    final fading = tester.widgetList<Opacity>(find.byType(Opacity)).map((o) => o.opacity);
    expect(fading.any((o) => o > 0 && o < 1), isTrue);
    await tester.pump(ComicReaderView.fadeDuration);
    await tester.pump();
    expect(controller.firstPage, 1);

    // Swipes decide; they don't drag a leaf.
    await tester.timedDragFrom(const Offset(300, 400), const Offset(-120, 0), const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 16));
    expect(leaf(), findsNothing);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 2);
  });

  testWidgets('landscape shows spreads; rotation keeps the page', (tester) async {
    final pages = await FakePages.make(tester, List.filled(7, portrait));
    await pumpView(tester, pages.store(), screen: const Size(844, 390));
    expect((controller.firstPage, controller.lastPage), (0, 0));
    await tapThird(tester, right: true);
    await tester.pumpAndSettle();
    expect((controller.firstPage, controller.lastPage), (1, 2));

    // Portrait shows the spread's first page; turning lands on page 3.
    await setScreen(tester, const Size(390, 844));
    expect((controller.firstPage, controller.lastPage), (1, 1));
    await tapThird(tester, right: true);
    await tester.pumpAndSettle();
    await tapThird(tester, right: true);
    await tester.pumpAndSettle();
    expect(controller.firstPage, 3);

    await setScreen(tester, const Size(844, 390));
    expect((controller.firstPage, controller.lastPage), (3, 4));
    await setScreen(tester, const Size(390, 844));
    expect(controller.firstPage, 3);
  });

  testWidgets('rotating mid-flip lands the flip and keeps that page', (tester) async {
    final pages = await FakePages.make(tester, List.filled(7, portrait));
    await pumpView(tester, pages.store());
    await tapThird(tester, right: true);
    await tester.pump(const Duration(milliseconds: 200));
    expect(leaf(), findsOneWidget);
    await setScreen(tester, const Size(844, 390));
    expect(leaf(), findsNothing);
    expect((controller.firstPage, controller.lastPage), (1, 2));
  });

  testWidgets('a double-page scan found while reading re-pairs without leaving the page', (
    tester,
  ) async {
    final sizes = [portrait, portrait, portrait, wide, portrait, portrait, portrait, portrait];
    final pages = await FakePages.make(tester, sizes);
    final store = pages.store();
    // Page 4 opens in spread [3|4] while page 3's size is still unknown.
    await pumpView(tester, store, screen: const Size(844, 390), initialPage: 4);
    await tester.pumpAndSettle();
    expect(store.isWide(3), isTrue);
    expect((controller.firstPage, controller.lastPage), (4, 5));
    await tapThird(tester, right: false);
    await tester.pumpAndSettle();
    expect((controller.firstPage, controller.lastPage), (3, 3));
    await tapThird(tester, right: false);
    await tester.pumpAndSettle();
    expect((controller.firstPage, controller.lastPage), (1, 2));
  });

  testWidgets('double tap zooms; zoomed drags pan; zooming out restores flips', (tester) async {
    final pages = await FakePages.make(tester, List.filled(4, portrait));
    await pumpView(tester, pages.store());
    double scale() => tester
        .widget<InteractiveViewer>(find.byType(InteractiveViewer))
        .transformationController!
        .value
        .getMaxScaleOnAxis();

    Future<void> doubleTap() async {
      await tester.tapAt(const Offset(195, 400));
      await tester.pump(const Duration(milliseconds: 60));
      await tester.tapAt(const Offset(195, 400));
      await tester.pumpAndSettle();
    }

    await doubleTap();
    expect(scale(), greaterThan(2));
    await tester.timedDragFrom(const Offset(300, 400), const Offset(-200, 0), const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(controller.firstPage, 0);
    expect(scale(), greaterThan(2));

    await doubleTap();
    expect(scale(), closeTo(1, 0.01));
    await tester.timedDragFrom(const Offset(300, 400), const Offset(-200, 0), const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(controller.firstPage, 1);
  });

  testWidgets('pages decode at display size; only nearby spreads stay decoded', (tester) async {
    final pages = await FakePages.make(tester, List.filled(12, portrait));
    final store = pages.store();
    await pumpView(tester, store);
    // 390×844 view, 2:3 page, DPR 1: decoded 390 wide, not the 1200 source.
    expect(pages.targets.first.width, closeTo(390, 1));
    expect(store.decodedPages.toSet(), {0, 1, 2});
    for (var i = 0; i < 6; i++) {
      await tapThird(tester, right: true);
      await tester.pumpAndSettle();
    }
    expect(controller.firstPage, 6);
    expect(store.decodedPages.every((p) => (p - 6).abs() <= 2), isTrue);
    expect(store.decodedPages, containsAll([5, 6, 7]));
  });

  group('page store', () {
    testWidgets('failed reads retry quietly, then offer a retry', (tester) async {
      final pages = await FakePages.make(tester, List.filled(3, portrait));
      var failuresLeft = 2;
      var reads = 0;
      final store = pages.store(
        read: (p) async {
          reads++;
          if (p == 1 && failuresLeft-- > 0) throw StateError('offline');
          return Uint8List.fromList([p]);
        },
      );
      Size target(int _, Size s) => s;
      store.request([1, 0], keep: {0, 1}, target: target);
      await tester.pump();
      expect(store.imageOf(0), isNotNull, reason: 'one page failing holds up no other');
      expect(store.imageOf(1), isNull);
      expect(store.isLoading(1), isTrue);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump(const Duration(seconds: 5));
      expect(store.imageOf(1), isNotNull);
      expect(store.errorOf(1), isNull);

      // Always failing: gives up after the automatic retries.
      final stuck = pages.store(read: (p) async => throw StateError('offline'));
      stuck.request([2], keep: {2}, target: target);
      await tester.pump(const Duration(seconds: 30));
      expect(stuck.errorOf(2), isNotNull);
      expect(stuck.isLoading(2), isFalse);
      store.dispose();
      stuck.dispose();
      expect(reads, greaterThan(3));
    });

    testWidgets('evicts what it is not asked to keep and sharpens on zoom', (tester) async {
      final pages = await FakePages.make(tester, List.filled(8, portrait));
      final store = pages.store();
      var factor = 0.25;
      Size target(int _, Size s) => s * factor;
      store.request([0, 1, 2], keep: {0, 1, 2}, target: target);
      await tester.pump();
      expect(store.decodedPages.toSet(), {0, 1, 2});
      store.request([6], keep: {6}, target: target);
      await tester.pump();
      expect(store.decodedPages.toSet(), {6});
      final before = pages.decodes;
      factor = 0.75;
      store.request([6], keep: {6}, target: target);
      await tester.pump();
      expect(pages.decodes, before + 1);
      // Re-asking at the same size is free.
      store.request([6], keep: {6}, target: target);
      await tester.pump();
      expect(pages.decodes, before + 1);
      store.dispose();
    });
  });

  group('screen', () {
    tearDown(() => ComicReaderScreen.debugDecoder = null);

    Uint8List cbz(int pages) {
      final archive = Archive();
      for (var i = 0; i < pages; i++) {
        archive.add(ArchiveFile.noCompress('Issue/page${i + 1}.png', 1, [i]));
      }
      return ZipEncoder().encodeBytes(archive);
    }

    testWidgets('opens through ReaderScreen.open, restores and saves the contract locator', (
      tester,
    ) async {
      final pages = await FakePages.make(tester, List.filled(5, portrait));
      ComicReaderScreen.debugDecoder = pages.decode;
      await setScreen(tester, const Size(390, 844));
      final bytes = cbz(5);
      final entry = LibraryEntry(
        book: Book.fromJson({
          'id': 'comic-abc',
          'title': 'Vector #1',
          'format': 'comic',
          'downloadUrl': '',
          'fileSize': bytes.length,
          'sha256': 'abc',
        }),
        source: BookSource.sample,
        origin: 'sample',
        addedAt: DateTime(2026),
        download: const DownloadState(status: DownloadStatus.ready, path: 'comic.cbz'),
        progress: ReadingProgress(
          locator: const ReadingLocator(href: 'Issue/page3.png', progression: 0, engine: 'comic'),
          updatedAt: DateTime(2026),
        ),
      );
      final kv = MemoryKeyValueStore();
      final settings = SettingsRepository(kv);
      await settings.load();
      final bookStore = MemoryBookStore()..files['comic.cbz'] = bytes;
      await kv.writeJson('library.v1', {
        'entries': [entry.toJson()],
      });
      final library = LibraryRepository(store: kv, bookStore: bookStore);
      await library.load();
      final services = AppServices(
        settings: settings,
        library: library,
        readerService: ReaderService(engines: [const DartReaderEngine()]),
        catalogSource: SampleCatalogSource(),
      );
      await tester.pumpWidget(
        AppScope(
          services: services,
          child: MaterialApp(
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () => ReaderScreen.open(context, entry),
                child: const Text('Read'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Read'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      await tester.pump();
      expect(find.byType(ComicReaderScreen), findsOneWidget);
      expect(find.byType(ReaderScreen), findsNothing);
      expect(controllerOf(tester).firstPage, 2, reason: 'restored by href');

      // Chrome: centre tap shows the page count; a turn hides it again.
      await tester.tapAt(const Offset(195, 422));
      await tester.pump(kDoubleTapTimeout + const Duration(milliseconds: 10));
      await tester.pumpAndSettle();
      expect(find.text('Page 3 of 5'), findsOneWidget);
      await tester.tap(find.byTooltip('Next page'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));

      final saved = library.entry(entry.id)!.progress!.locator;
      expect(saved.toJson(), {
        'href': 'Issue/page4.png',
        'progression': 0.0,
        'totalProgression': 0.75,
        'title': 'Page 4 of 5',
        'engine': 'comic',
        'raw': {'page': 3, 'pages': 5},
      });

      await tester.tap(find.byTooltip('Close comic'));
      await tester.pumpAndSettle();
      expect(find.byType(ComicReaderScreen), findsNothing);
    });
  });
}

ComicViewController controllerOf(WidgetTester tester) =>
    tester.widget<ComicReaderView>(find.byType(ComicReaderView)).controller;
