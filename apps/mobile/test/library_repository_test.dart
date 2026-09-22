import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';

void main() {
  // Asset futures cached under one test's FakeAsync zone never resolve in the next.
  setUp(rootBundle.clear);
  TestWidgetsFlutterBinding.ensureInitialized();

  test('sample download goes queued -> downloading -> ready and persists', () async {
    final kv = MemoryKeyValueStore();
    final store = MemoryBookStore();
    final lib = LibraryRepository(store: kv, bookStore: store);
    await lib.load();
    final source = SampleCatalogSource(bundle: rootBundle, chunkSize: 512);
    final page = await source.listBooks();
    expect(page.items.length, 3);
    final book = page.items.first;

    final seen = <DownloadStatus>{};
    lib.addListener(() {
      final e = lib.entry(book.id);
      if (e != null) seen.add(e.download.status);
    });
    await lib.download(book, source);

    final entry = lib.entry(book.id)!;
    expect(entry.download.isReady, isTrue);
    expect(seen, containsAll([DownloadStatus.queued, DownloadStatus.downloading, DownloadStatus.ready]));
    expect(await store.sizeOf(entry.download.path!), book.fileSize);

    // Reading progress survives a reload.
    await lib.saveProgress(
      book.id,
      const ReadingLocator(href: 'OEBPS/chapter-2.xhtml', progression: 0.5, totalProgression: 0.5),
    );
    final again = LibraryRepository(store: kv, bookStore: store);
    await again.load();
    expect(again.entry(book.id)!.progress!.locator.href, 'OEBPS/chapter-2.xhtml');
    expect(again.continueReading.single.id, book.id);
  });

  test('a ready entry whose file vanished is reported, not faked', () async {
    final kv = MemoryKeyValueStore();
    final store = MemoryBookStore();
    final lib = LibraryRepository(store: kv, bookStore: store);
    await lib.load();
    final source = SampleCatalogSource(bundle: rootBundle);
    final book = (await source.listBooks()).items.first;
    await lib.download(book, source);
    store.files.clear();

    final again = LibraryRepository(store: kv, bookStore: store);
    await again.load();
    expect(again.entry(book.id)!.download.status, DownloadStatus.failed);
  });
}
