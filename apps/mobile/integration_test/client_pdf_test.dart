// Stage harness.pdf in the app's Documents/pdf-client-test directory before
// running. No fixture download or extraction server is used by this test.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/import/epub_import_service.dart';
import 'package:thereader/data/import/upload_api.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

class _OfflineUpload extends UploadApi {
  _OfflineUpload(super.origin);
  @override
  Future<PreparedUpload> prepare(Book book) async =>
      throw ApiException('Offline during on-device PDF test', isNetwork: true);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('imports the requested PDF locally and reads it while offline', (
    tester,
  ) async {
    final documents = await getApplicationDocumentsDirectory();
    final source = File('${documents.path}/pdf-client-test/harness.pdf');
    expect(
      source.existsSync(),
      isTrue,
      reason:
          'Stage the requested paper in Documents/pdf-client-test/harness.pdf',
    );
    final root = await Directory.systemTemp.createTemp(
      'pdf-client-integration-',
    );
    final books = IoBookStore(Directory('${root.path}/books'));
    final kv = MemoryKeyValueStore();
    final library = LibraryRepository(store: kv, bookStore: books);
    final client = ApiClient(baseUrl: 'http://127.0.0.1:9');
    final imports = EpubImportService(
      bookStore: books,
      library: library,
      store: kv,
      clientForCurrentOrigin: () => client,
      uploadApiFactory: (origin) => _OfflineUpload(origin),
    );
    await library.load();
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: const Scaffold(
          body: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                CircularProgressIndicator(),
                Text('Converting PDF on this device…'),
              ],
            ),
          ),
        ),
      ),
    );
    var ticks = 0;
    final timer = Timer.periodic(
      const Duration(milliseconds: 20),
      (_) => ticks++,
    );
    final watch = Stopwatch()..start();
    final entry = await imports.importPath(source.path);
    timer.cancel();
    expect(entry, isNotNull, reason: imports.error);
    expect(
      ticks,
      greaterThan(1),
      reason: 'The UI isolate must stay responsive',
    );
    expect(entry!.download.isReady, isTrue);
    expect(
      imports.pendingCount,
      1,
      reason: 'Offline upload must not block local reading',
    );
    final stored = File('${books.root.path}/${entry.download.path}');
    final zip = ZipDecoder().decodeBytes(await stored.readAsBytes());
    final page7 = utf8.decode(zip.findFile('OEBPS/page-7.xhtml')!.content);
    expect(page7, contains('colspan="2"'));
    expect(page7, contains('rowspan="5"'));
    expect(page7, contains('Nemotron-3'));
    debugPrint(
      'PDF_CLIENT_IMPORT ${jsonEncode({'title': entry.book.title, 'elapsedMs': watch.elapsedMilliseconds, 'uiTicks': ticks, 'pendingUpload': imports.pendingCount, 'epubBytes': await stored.length(), 'mergedTable': true})}',
    );
    const engine = ReadiumReaderEngine();
    final controller =
        await engine.open(
              file: await books.open(entry.download.path!),
              prefs: const ReaderPreferences(flow: ReaderFlow.scrolled),
              initialLocator: const ReadingLocator(
                href: 'OEBPS/page-1.xhtml',
                progression: 0,
              ),
            )
            as ReadiumReaderController;
    expect(controller.info.spineCount, 44);
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
    final opening = Stopwatch()..start();
    while (!controller.pageVisible.value &&
        opening.elapsed < const Duration(seconds: 60)) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(controller.pageVisible.value, isTrue);
    debugPrint('PDF_CLIENT_READER title visible');
    for (var i = 0; i < 100; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await controller.goToHref('OEBPS/page-7.xhtml');
    for (var i = 0; i < 50; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(controller.locator.value?.href, 'OEBPS/page-7.xhtml');
    debugPrint('PDF_CLIENT_READER table visible');
    for (var i = 0; i < 300; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.pumpWidget(const SizedBox.shrink());
    controller.dispose();
    imports.dispose();
    library.dispose();
    client.close();
    // Give the native reader time to release its file lease before cleanup.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await root.delete(recursive: true);
    expect(source.existsSync(), isTrue);
  });
}
