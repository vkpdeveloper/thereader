import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

Future<AppServices> makeServices() async {
  final kv = MemoryKeyValueStore();
  final settings = SettingsRepository(kv);
  await settings.load();
  final library = LibraryRepository(store: kv, bookStore: MemoryBookStore());
  await library.load();
  return AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [DartReaderEngine()]),
    sampleSource: SampleCatalogSource(),
  );
}

void main() {
  // Asset futures cached under one test's FakeAsync zone never resolve in the next.
  setUp(rootBundle.clear);
  testWidgets('library empty state offers Browse, and Browse lists sample books', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();

    expect(find.text('Nothing here yet.'), findsOneWidget);
    expect(find.text('SAMPLE MODE'), findsOneWidget);
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
    await tester.tap(find.text('Read'));
    await tester.pumpAndSettle();

    expect(find.textContaining('There is an hour before the house wakes', findRichText: true), findsOneWidget);
    final entry = services.library.entries.singleWhere((e) => e.book.id == 'the-quiet-hour');
    expect(entry.lastOpenedAt, isNotNull);

    // Leaving the reader flushes the position save and cancels its timers.
    await tester.tap(find.byType(GestureDetector).first, warnIfMissed: false);
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
    expect(services.library.entries.singleWhere((e) => e.book.id == 'the-quiet-hour').progress, isNotNull);
  });

  testWidgets('scaffold background is pure black', (tester) async {
    final services = await makeServices();
    await tester.pumpWidget(TheReaderApp(services: services));
    await tester.pumpAndSettle();
    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
    expect(Theme.of(tester.element(find.byType(Scaffold).first)).scaffoldBackgroundColor, const Color(0xFF000000));
    expect(scaffold, isNotNull);
  });
}
