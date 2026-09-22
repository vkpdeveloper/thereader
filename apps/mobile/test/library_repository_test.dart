import 'package:flutter/services.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/models/book.dart';
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
      final e = lib.entryFor(book, source);
      if (e != null) seen.add(e.download.status);
    });
    await lib.download(book, source);

    final entry = lib.entryFor(book, source)!;
    expect(entry.download.isReady, isTrue);
    expect(
      seen,
      containsAll([DownloadStatus.queued, DownloadStatus.downloading, DownloadStatus.ready]),
    );
    expect(await store.sizeOf(entry.download.path!), book.fileSize);

    // Reading progress survives a reload.
    await lib.saveProgress(
      lib.entryFor(book, source)!.id,
      const ReadingLocator(href: 'OEBPS/chapter-2.xhtml', progression: 0.5, totalProgression: 0.5),
    );
    final again = LibraryRepository(store: kv, bookStore: store);
    await again.load();
    expect(again.entryFor(book, source)!.progress!.locator.href, 'OEBPS/chapter-2.xhtml');
    expect(again.continueReading.single.book.id, book.id);
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
    expect(again.entryFor(book, source)!.download.status, DownloadStatus.failed);
  });
  test('same catalog id at different origins remains independently readable', () async {
    final lib = LibraryRepository(store: MemoryKeyValueStore(), bookStore: MemoryBookStore());
    await lib.load();
    final sample = SampleCatalogSource(bundle: rootBundle);
    final api = _OtherOrigin(sample);
    final book = (await sample.listBooks()).items.first;
    await lib.download(book, sample);
    await lib.download(book, api);
    expect(lib.entries.length, 2);
    final a = lib.entryFor(book, sample)!;
    final b = lib.entryFor(book, api)!;
    expect(a.download.path, isNot(b.download.path));
    await lib.remove(a.id);
    expect(await lib.bookStore.exists(b.download.path!), isTrue);
  });

  test('interrupted downloads become retryable after restart', () async {
    for (final status in [DownloadStatus.queued, DownloadStatus.downloading, DownloadStatus.verifying]) {
      final state = DownloadState.fromJson({'status': status.name, 'receivedBytes': 12});
      expect(state.status, DownloadStatus.failed);
      expect(state.isActive, isFalse);
      expect(state.error, contains('Interrupted'));
    }
  });

  test('slow old persistence cannot overwrite newer progress', () async {
    final kv = _SerializedStore();
    final lib = LibraryRepository(store: kv, bookStore: MemoryBookStore());
    await lib.load();
    final source = SampleCatalogSource(bundle: rootBundle);
    final book = (await source.listBooks()).items.first;
    await lib.download(book, source);
    final id = lib.entryFor(book, source)!.id;
    await Future.wait([
      lib.saveProgress(id, const ReadingLocator(href: 'one', progression: .1)),
      lib.saveProgress(id, const ReadingLocator(href: 'two', progression: .9)),
    ]);
    expect(kv.maxConcurrentWrites, 1);
    final again = LibraryRepository(store: kv, bookStore: lib.bookStore);
    await again.load();
    expect(again.entry(id)!.progress!.locator.href, 'two');
  });

}

class _OtherOrigin implements CatalogSource {
  _OtherOrigin(this.base);
  final CatalogSource base;
  @override
  BookSource get source => BookSource.api;
  @override
  String get origin => 'http://example.test/';
  @override
  Future<BookPage> listBooks({int limit = 24, String? cursor, String? query}) =>
      base.listBooks(limit: limit, cursor: cursor, query: query);
  @override
  Future<Book> getBook(String id) => base.getBook(id);
  @override
  Future<DownloadStream> openDownload(Book book) => base.openDownload(book);
  @override
  Uri? coverUri(Book book) => null;
}

class _SerializedStore extends MemoryKeyValueStore {
  int active = 0;
  int maxConcurrentWrites = 0;
  @override
  Future<void> write(String key, String value) async {
    active++;
    if (active > maxConcurrentWrites) maxConcurrentWrites = active;
    await Future<void>.delayed(const Duration(milliseconds: 5));
    await super.write(key, value);
    active--;
  }
}
