import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/reader/reader_screen.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

Future<AppServices> makeServices({ReaderEngine engine = const DartReaderEngine(), LibraryEntry? existing}) async {
  final kv = MemoryKeyValueStore();
  final settings = SettingsRepository(kv);
  await settings.load();
  final bookStore = MemoryBookStore();
  if (existing != null) {
    bookStore.files[existing.download.path!] = Uint8List(0);
    await kv.writeJson('library.v1', {'entries': [existing.toJson()]});
  }
  final library = LibraryRepository(store: kv, bookStore: bookStore);
  await library.load();
  return AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: [engine]),
    // Bundled fixtures stand in for the API; shipping builds have no such switch.
    catalogSource: SampleCatalogSource(),
  );
}

void main() {
  // Asset futures cached under one test's FakeAsync zone never resolve in the next.
  setUp(rootBundle.clear);
  testWidgets('library empty state offers Browse, and Browse lists the fixture catalog', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();

    expect(find.text('Nothing here yet.'), findsOneWidget);
    expect(find.textContaining('Sample mode'), findsNothing);
    await tester.tap(find.text('Browse books'));
    await tester.pumpAndSettle();

    Finder row(String title) => find.byWidgetPredicate((w) => w is Text && w.data == title && w.maxLines == 1);
    expect(row('The Quiet Hour'), findsOneWidget);
    expect(row('A Walk in the Rain'), findsOneWidget);
    expect(row('Notes on Attention'), findsOneWidget);

    // Local subject filter narrows without a network call.
    await tester.tap(find.text('Fiction'));
    await tester.pumpAndSettle();
    expect(row('A Walk in the Rain'), findsOneWidget);
    expect(row('The Quiet Hour'), findsNothing);
  });

  testWidgets('book detail downloads, verifies and opens the reader', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Browse'));
    await tester.pumpAndSettle();
    await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data == 'The Quiet Hour' && w.maxLines == 1));
    await tester.pumpAndSettle();

    expect(find.textContaining('Download ·'), findsOneWidget);
    await tester.tap(find.textContaining('Download ·'));
    await tester.pumpAndSettle();

    expect(find.text('Downloaded and verified. '), findsOneWidget);
    final entry = services.library.entries.singleWhere((e) => e.book.id == 'the-quiet-hour');
    final detailContext = tester.element(find.text('Read'));
    final firstOpen = ReaderScreen.open(detailContext, entry);
    // Multiple callers must not create two owners of the native singleton.
    ReaderScreen.open(detailContext, entry);
    await tester.pumpAndSettle();
    expect(find.byType(ReaderScreen, skipOffstage: false), findsOneWidget);

    expect(find.textContaining('There is an hour before the house wakes', findRichText: true), findsOneWidget);
    expect(services.library.entries.single.lastOpenedAt, isNotNull);

    Navigator.of(tester.element(find.byType(ReaderScreen))).pop();
    // The underlying detail is usable before the outgoing route is disposed.
    ReaderScreen.open(detailContext, entry);
    await tester.pumpAndSettle();
    await firstOpen;
    expect(find.byType(ReaderScreen, skipOffstage: false), findsNothing);

    // Leaving the reader flushes the position save and cancels its timers.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
    expect(services.library.entries.singleWhere((e) => e.book.id == 'the-quiet-hour').progress, isNotNull);
  });

  testWidgets('settings has no sample mode and shows the production API', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    expect(find.text('Sample mode'), findsNothing);
    expect(find.text('Your API'), findsNothing);
    expect(find.text('LIBRARY API'), findsOneWidget);
    expect(find.text('Use default'), findsNothing);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, 'https://reader.ordinity.com');
    expect(services.settings.settings.apiBaseUrl, 'https://reader.ordinity.com');
  });

  testWidgets('delete lives in the app bar, asks first, and is absent beside Read', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Browse'));
    await tester.pumpAndSettle();
    await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data == 'The Quiet Hour' && w.maxLines == 1));
    await tester.pumpAndSettle();

    // Nothing to remove before a download exists.
    expect(find.byTooltip('Remove download'), findsNothing);
    await tester.tap(find.textContaining('Download ·'));
    await tester.pumpAndSettle();
    expect(find.text('Read'), findsOneWidget);

    final remove = find.byTooltip('Remove download');
    expect(remove, findsOneWidget);
    final appBar = find.byType(AppBar);
    expect(find.descendant(of: appBar, matching: remove), findsOneWidget);
    // The reading action and the delete action are not neighbours.
    final readRect = tester.getRect(find.text('Read'));
    final removeRect = tester.getRect(remove);
    expect(removeRect.bottom, lessThan(readRect.top));
    expect(removeRect.right, greaterThan(tester.getRect(find.byType(BackButton)).right));

    await tester.tap(remove);
    await tester.pumpAndSettle();
    expect(find.text('Remove download?'), findsOneWidget);
    await tester.tap(find.text('Keep'));
    await tester.pumpAndSettle();
    expect(services.library.entries, hasLength(1));
    expect(find.text('Read'), findsOneWidget);

    await tester.tap(remove);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(services.library.entries, isEmpty);
    expect(find.byTooltip('Remove download'), findsNothing);
    expect(find.textContaining('Download ·'), findsOneWidget);
  });

  testWidgets('scaffold background is pure black', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
    expect(Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor, const Color(0xFF000000));
    expect(scaffold, isNotNull);
  });

  testWidgets('back during async open waits for old owner cleanup before reopening', (tester) async {
    final engine = _DelayedEngine();
    final entry = LibraryEntry(
      book: Book.fromJson({'id': 'pending', 'downloadUrl': '', 'fileSize': 0, 'sha256': ''}),
      source: BookSource.sample, origin: 'sample', addedAt: DateTime(2026),
      download: const DownloadState(status: DownloadStatus.ready, path: 'pending.epub'),
    );
    final services = await makeServices(engine: engine, existing: entry);
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    final context = tester.element(find.byType(Scaffold));
    final first = ReaderScreen.open(context, entry);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(engine.opens, 1);
    Navigator.of(context).pop();
    await tester.pumpAndSettle();
    await ReaderScreen.open(context, entry);
    await tester.pump();
    expect(engine.opens, 1);
    expect(find.byType(ReaderScreen), findsNothing);

    final abandoned = _StubController();
    engine.pending.complete(abandoned);
    await tester.pumpAndSettle();
    await first;
    expect(abandoned.disposed, isTrue);

    final second = ReaderScreen.open(context, entry);
    await tester.pumpAndSettle();
    expect(engine.opens, 2);
    expect(find.byType(ReaderScreen), findsOneWidget);
    Navigator.of(context).pop();
    await tester.pumpAndSettle();
    await second;
    expect(engine.nextController.disposed, isTrue);
  });
}

class _DelayedEngine implements ReaderEngine {
  final pending = Completer<ReaderController>();
  final nextController = _StubController();
  int opens = 0;
  @override String get id => 'readium';
  @override EngineAvailability get availability => const EngineAvailability.available('Test');
  @override Future<ReaderController> open({required BookFile file, required ReaderPreferences prefs, ReadingLocator? initialLocator}) async {
    await file.close();
    opens++;
    return opens == 1 ? pending.future : nextController;
  }
  @override Widget buildView(BuildContext context, ReaderController controller) => const SizedBox.expand();
}

class _StubController extends ReaderController {
  bool disposed = false;
  @override final ValueNotifier<ReadingLocator?> locator = ValueNotifier<ReadingLocator?>(null);
  @override PublicationInfo get info => const PublicationInfo(title: 'Test', author: '', spineCount: 1, toc: []);
  @override Future<void> goTo(ReadingLocator locator) async {}
  @override Future<void> goToHref(String href) async {}
  @override Future<bool> next() async => false;
  @override Future<bool> previous() async => false;
  @override void applyPreferences(ReaderPreferences prefs) {}
  @override void dispose() { disposed = true; locator.dispose(); }
}
