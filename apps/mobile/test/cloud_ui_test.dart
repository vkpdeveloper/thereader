import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/app.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/import/epub_import_service.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/repositories/sync_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/book/book_detail_screen.dart';
import 'package:thereader/features/shared/cloud_status.dart';
import 'package:thereader/reader/dart_engine/dart_reader_engine.dart';
import 'package:thereader/reader/engine/reader_engine.dart';

/// UI-only coverage for the cloud additions: the import action, the quiet
/// library and book page, and the Settings section that is the one place
/// upload and sync state appear. The services are hand-rolled fakes driven
/// directly by each test.

LibraryEntry _entry({String id = 'imported', bool ready = true}) => LibraryEntry(
  book: Book.fromJson({
    'id': id,
    'title': 'Imported Book',
    'author': 'Someone',
    'downloadUrl': '',
    'fileSize': 1234,
    'sha256': 'abc',
  }),
  source: BookSource.sample,
  origin: 'sample',
  addedAt: DateTime(2026),
  download: ready
      ? const DownloadState(status: DownloadStatus.ready, path: 'imported.epub')
      : const DownloadState(),
);

Future<AppServices> makeServices({
  FakeImports? imports,
  FakeSync? sync,
  LibraryEntry? existing,
}) async {
  final kv = MemoryKeyValueStore();
  final settings = SettingsRepository(kv);
  await settings.load();
  final bookStore = MemoryBookStore();
  if (existing != null) {
    if (existing.download.path != null) bookStore.files[existing.download.path!] = Uint8List(0);
    await kv.writeJson('library.v1', {
      'entries': [existing.toJson()],
    });
  }
  final library = LibraryRepository(store: kv, bookStore: bookStore);
  await library.load();
  return AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [DartReaderEngine()]),
    catalogSource: SampleCatalogSource(),
    imports: imports,
    sync: sync,
  );
}

/// Any cloud glyph anywhere on screen. The library and book page must never
/// show one; only Settings speaks about uploads and sync.
const _cloudGlyphs = [
  Icons.cloud_outlined,
  Icons.cloud_off_outlined,
  Icons.cloud_upload_outlined,
  Icons.cloud_queue_outlined,
  Icons.cloud_done_outlined,
];

Finder cloudIcons() => find.byWidgetPredicate((w) => w is Icon && _cloudGlyphs.contains(w.icon));

/// Settings grew a theme grid; a tall test surface keeps its later sections
/// on screen without scrolling choreography.
Future<void> pumpApp(WidgetTester tester, AppServices services) async {
  tester.view.physicalSize = const Size(800, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(TheReaderApp(services: services));
  await tester.pumpAndSettle();
}

void main() {
  setUp(rootBundle.clear);

  group('formatting', () {
    test('reading time reads naturally', () {
      expect(formatReadingTime(0), 'No reading time yet');
      expect(formatReadingTime(20000), 'Under a minute');
      expect(formatReadingTime(12 * 60000), '12 min');
      expect(formatReadingTime(2 * 3600000), '2 h');
      expect(formatReadingTime(3 * 3600000 + 12 * 60000), '3 h 12 min');
    });

    test('relative time collapses recent moments', () {
      final now = DateTime(2026, 9, 23, 12);
      expect(formatRelativeTime(now.subtract(const Duration(seconds: 10)), now: now), 'Just now');
      expect(formatRelativeTime(now.subtract(const Duration(minutes: 4)), now: now), '4 min ago');
      expect(formatRelativeTime(now.subtract(const Duration(hours: 2)), now: now), '2 h ago');
      expect(formatRelativeTime(now.subtract(const Duration(hours: 30)), now: now), 'Yesterday');
      expect(formatRelativeTime(DateTime(2026, 1, 5), now: now), '2026-01-05');
    });
  });

  testWidgets('without services the cloud UI is absent everywhere', (tester) async {
    final services = await makeServices(existing: _entry());
    await pumpApp(tester, services);
    expect(find.byTooltip('Import EPUB'), findsNothing);
    expect(cloudIcons(), findsNothing);

    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('CLOUD SYNC'), findsNothing);
    expect(find.text('Sync now'), findsNothing);
    expect(find.textContaining('preferences stay on this device'), findsOneWidget);
  });

  testWidgets('import action lives top-right, opens the picker and lands on the book page',
      (tester) async {
    final imports = FakeImports()..result = _entry();
    final services = await makeServices(imports: imports);
    await pumpApp(tester, services);

    final button = find.byTooltip('Import EPUB');
    expect(button, findsOneWidget);
    final title = find.text('Library').first;
    expect(tester.getRect(button).left, greaterThan(tester.getRect(title).right));
    expect(find.textContaining('import an EPUB'), findsOneWidget);

    await tester.tap(button);
    await tester.pump();
    // While the pick is in flight the action is replaced by a spinner.
    expect(find.bySemanticsLabel('Importing EPUB'), findsOneWidget);
    imports.completePick();
    await tester.pumpAndSettle();
    expect(imports.picks, 1);
    expect(find.byType(BookDetailScreen), findsOneWidget);
    expect(find.text('Imported Book'), findsWidgets);
  });

  testWidgets('a cancelled pick stays on the library without noise', (tester) async {
    final imports = FakeImports()..result = null;
    final services = await makeServices(imports: imports);
    await pumpApp(tester, services);
    await tester.tap(find.byTooltip('Import EPUB'));
    imports.completePick();
    await tester.pumpAndSettle();
    expect(find.byType(BookDetailScreen), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
    expect(find.byTooltip('Import EPUB'), findsOneWidget);
  });

  testWidgets('the library stays quiet through waiting, uploading and failed uploads',
      (tester) async {
    final entry = _entry();
    final imports = FakeImports();
    final sync = FakeSync()..pendingCount = 3;
    final services = await makeServices(imports: imports, sync: sync, existing: entry);
    await pumpApp(tester, services);

    void expectQuiet() {
      expect(cloudIcons(), findsNothing);
      expect(find.textContaining('waiting'), findsNothing);
      expect(find.textContaining('Uploading'), findsNothing);
      expect(find.textContaining('failed'), findsNothing);
      expect(find.textContaining('Syncing'), findsNothing);
      expect(find.textContaining('synced'), findsNothing);
      expect(find.text('Retry'), findsNothing);
      expect(find.byType(SnackBar), findsNothing);
    }

    expectQuiet();
    imports
      ..pending.add(entry.id)
      ..notify();
    await tester.pumpAndSettle();
    expectQuiet();

    imports
      ..uploading = entry.id
      ..uploadFraction = 0.4
      ..notify();
    await tester.pumpAndSettle();
    expectQuiet();

    imports
      ..uploading = null
      ..uploadFraction = null
      ..errors[entry.id] = 'Server said no.'
      ..error = 'Import failed badly.'
      ..notify();
    sync
      ..error = 'Could not reach the API.'
      ..notify();
    await tester.pumpAndSettle();
    expectQuiet();
    // The book itself is still presented normally.
    expect(find.text('Imported Book'), findsOneWidget);
    // Filter link and tile status both say "Downloaded"; nothing about clouds.
    expect(find.text('Downloaded'), findsNWidgets(2));

    // Settings is where the same state is reported, with the failures.
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Server said no.'), findsOneWidget);
    expect(find.text('Import failed badly.'), findsOneWidget);
    expect(find.text('Could not reach the API.'), findsOneWidget);
    expect(find.text('3 changes not yet synced'), findsOneWidget);
  });

  testWidgets('a failed pick is reported at once with a snackbar', (tester) async {
    final imports = FakeImports()..pickError = StateError('not an EPUB');
    final services = await makeServices(imports: imports);
    await pumpApp(tester, services);
    await tester.tap(find.byTooltip('Import EPUB'));
    imports.completePick();
    await tester.pumpAndSettle();
    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.textContaining('Could not import that file.'), findsOneWidget);
    expect(find.byTooltip('Import EPUB'), findsOneWidget);
  });

  testWidgets('settings shows a Cloud sync section with last sync, pending, error and Sync now',
      (tester) async {
    final sync = FakeSync()
      ..lastSyncedAt = DateTime.now().subtract(const Duration(minutes: 3))
      ..pendingCount = 2
      ..totalReadingMilliseconds = 3 * 3600000 + 12 * 60000;
    final imports = FakeImports()..pending.add('x');
    final services = await makeServices(sync: sync, imports: imports);
    await pumpApp(tester, services);
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();

    expect(find.text('CLOUD SYNC'), findsOneWidget);
    expect(find.text('3 min ago'), findsOneWidget);
    expect(find.text('2 changes not yet synced'), findsOneWidget);
    expect(find.text('3 h 12 min'), findsOneWidget);
    expect(find.textContaining('1 book waiting to upload'), findsOneWidget);
    // The About copy no longer claims everything stays on the device.
    expect(find.textContaining('preferences stay on this device'), findsNothing);
    expect(find.textContaining('sync through your Reader API'), findsWidgets);

    await tester.ensureVisible(find.text('Sync now'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sync now'));
    await tester.pump();
    expect(find.text('Syncing'), findsOneWidget);
    sync.completeSync();
    await tester.pumpAndSettle();
    expect(sync.syncs, 1);
    expect(find.text('Sync now'), findsOneWidget);

    await tester.ensureVisible(find.text('Retry uploads'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Retry uploads'));
    await tester.pumpAndSettle();
    expect(imports.retries, 1);

    sync
      ..error = 'Could not reach the API.'
      ..notify();
    await tester.pumpAndSettle();
    expect(find.text('Could not reach the API.'), findsOneWidget);
  });

  testWidgets('book detail shows no cloud state but still cancels the upload before removing',
      (tester) async {
    final entry = _entry();
    final imports = FakeImports()..pending.add(entry.id);
    final sync = FakeSync()..perEntry[entry.id] = 45 * 60000;
    final services = await makeServices(imports: imports, sync: sync, existing: entry);
    // The upload must be cancelled while the entry (and its file) still exist.
    imports.onCancel = () => expect(services.library.entries, hasLength(1));
    await pumpApp(tester, services);
    await tester.longPress(
      find.byWidgetPredicate((w) => w is Text && w.data == 'Imported Book' && w.maxLines == 2),
    );
    await tester.pumpAndSettle();
    expect(find.byType(BookDetailScreen), findsOneWidget);

    expect(find.text('CLOUD'), findsNothing);
    expect(cloudIcons(), findsNothing);
    expect(find.textContaining('across your devices'), findsNothing);
    expect(find.textContaining('Upload waiting'), findsNothing);
    expect(find.textContaining('waiting'), findsNothing);
    expect(find.text('Read'), findsOneWidget);

    final remove = find.byTooltip('Remove download');
    expect(find.descendant(of: find.byType(AppBar), matching: remove), findsOneWidget);
    await tester.tap(remove);
    await tester.pumpAndSettle();
    expect(find.textContaining('waiting upload will be cancelled'), findsOneWidget);
    await tester.tap(find.text('Remove'));
    await tester.pumpAndSettle();
    expect(imports.cancelled, [entry.id]);
    expect(services.library.entries, isEmpty);
  });
}

/// Test double for the import service. `noSuchMethod` keeps the fake valid
/// if the real class grows members this UI does not use.
class FakeImports extends ChangeNotifier implements EpubImportService {
  LibraryEntry? result;
  Object? pickError;
  final pending = <String>{};
  final errors = <String, String>{};
  final cancelled = <String>[];
  VoidCallback? onCancel;
  String? uploading;
  int picks = 0;
  int retries = 0;
  bool _busy = false;
  Completer<void>? _pick;

  void notify() => notifyListeners();
  void completePick() => _pick?.complete();

  @override
  bool get busy => _busy;
  @override
  bool get isSupported => true;
  @override
  String? error;
  @override
  double? uploadFraction;
  @override
  int get pendingCount => pending.length;
  @override
  bool isUploading(String entryId) => uploading == entryId;
  @override
  bool isPending(String entryId) => pending.contains(entryId) || uploading == entryId;
  @override
  String? errorFor(String entryId) => errors[entryId];

  @override
  Future<LibraryEntry?> pickAndImport() async {
    picks++;
    _busy = true;
    notifyListeners();
    _pick = Completer<void>();
    await _pick!.future;
    _busy = false;
    notifyListeners();
    final error = pickError;
    if (error != null) throw error;
    return result;
  }

  @override
  Future<void> retryPending() async {
    retries++;
  }

  @override
  Future<void> cancelPending(String entryId) async {
    onCancel?.call();
    cancelled.add(entryId);
    pending.remove(entryId);
    errors.remove(entryId);
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeSync extends ChangeNotifier implements SyncRepository {
  final perEntry = <String, int>{};
  int syncs = 0;
  bool _syncing = false;
  Completer<void>? _sync;

  void notify() => notifyListeners();
  void completeSync() => _sync?.complete();

  @override
  bool get isSyncing => _syncing;
  @override
  String? error;
  @override
  DateTime? lastSyncedAt;
  @override
  int pendingCount = 0;
  @override
  int totalReadingMilliseconds = 0;
  @override
  int readingMillisecondsFor(LibraryEntry entry) => perEntry[entry.id] ?? 0;

  @override
  Future<void> syncNow() async {
    syncs++;
    _syncing = true;
    notifyListeners();
    _sync = Completer<void>();
    await _sync!.future;
    _syncing = false;
    lastSyncedAt = DateTime.now();
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
