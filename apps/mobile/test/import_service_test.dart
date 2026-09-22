import 'dart:async';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/import/epub_import_service.dart';
import 'package:thereader/data/import/import_platform_io.dart';
import 'package:thereader/data/import/upload_api.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/data/storage/key_value_store.dart';

List<int> epub({
  String? extraName,
  String? extraText,
  String? metadata,
  bool externalDtd = false,
}) {
  final archive = Archive();
  void add(String name, String text) =>
      archive.add(ArchiveFile.string(name, text));
  add('mimetype', 'application/epub+zip');
  add(
    'META-INF/container.xml',
    '${externalDtd ? '<!DOCTYPE container PUBLIC "publisher" "https://invalid.example/never-fetch.dtd">' : ''}<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  add(
    'book.opf',
    metadata ??
        '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Local &amp; ready</dc:title><dc:creator>A Reader</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>',
  );
  add('chapter.xhtml', '<html><body>Readable text</body></html>');
  if (extraName != null) add(extraName, extraText!);
  return ZipEncoder().encode(archive);
}

class FakeUpload extends UploadApi {
  FakeUpload(
    super.origin, {
    this.offline = false,
    this.deduplicate = false,
    this.gate,
  });
  bool offline;
  final bool deduplicate;
  final Completer<void>? gate;
  bool closed = false;
  List<int> received = [];
  Book canonical(Book book) =>
      Book.fromJson({...book.toJson(), 'id': 'legacy-existing-id'});
  @override
  Future<PreparedUpload> prepare(Book book) async {
    await gate?.future;
    if (offline) throw ApiException('Offline', isNetwork: true);
    return PreparedUpload(
      book: canonical(book),
      uploaded: deduplicate,
      uploadUrl: deduplicate ? null : '/v1/uploads/${book.sha256}',
    );
  }

  @override
  Future<Book> upload(
    Book book,
    String url,
    Stream<List<int>> bytes, {
    required void Function(int sent) onProgress,
  }) async {
    await for (final chunk in bytes) {
      received.addAll(chunk);
      onProgress(received.length);
    }
    return canonical(book);
  }

  @override
  void close() {
    closed = true;
    super.close();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory temp;
  late File source;
  late IoBookStore books;
  late MemoryKeyValueStore kv;
  late LibraryRepository library;
  late ApiClient client;
  setUp(() async {
    temp = await Directory.systemTemp.createTemp('reader-import-test-');
    source = await File('${temp.path}/source.epub').writeAsBytes(epub());
    books = IoBookStore(Directory('${temp.path}/books'));
    kv = MemoryKeyValueStore();
    library = LibraryRepository(store: kv, bookStore: books);
    await library.load();
    client = ApiClient(baseUrl: 'https://books.example');
  });
  tearDown(() async {
    client.close();
    library.dispose();
    await temp.delete(recursive: true);
  });

  test(
    'publisher external DTD is ignored without permitting internal entities',
    () async {
      await source.writeAsBytes(epub(externalDtd: true));
      expect((await inspectEpub(source.path))['title'], 'Local & ready');
      await source.writeAsBytes(
        epub(
          metadata:
              '<!DOCTYPE package [<!ENTITY custom "expanded">]><package>&custom;</package>',
        ),
      );
      await expectLater(inspectEpub(source.path), throwsFormatException);
    },
  );

  test(
    'metadata inspection never expands unrelated image entries and rejects oversized files',
    () async {
      final bytes = epub(
        extraName: 'broken-image.bin',
        extraText: 'image' * 1000,
      );
      // Damage only the image's compressed payload. Metadata import intentionally
      // does not decode image bytes; native Readium owns publication rendering.
      for (var i = 0; i < bytes.length - 30; i++) {
        if (bytes[i] == 0x50 &&
            bytes[i + 1] == 0x4b &&
            bytes[i + 2] == 3 &&
            bytes[i + 3] == 4) {
          final nameLength = bytes[i + 26] | bytes[i + 27] << 8;
          final extraLength = bytes[i + 28] | bytes[i + 29] << 8;
          final name = String.fromCharCodes(
            bytes.sublist(i + 30, i + 30 + nameLength),
          );
          if (name == 'broken-image.bin') {
            bytes[i + 30 + nameLength + extraLength] = 0xff;
            break;
          }
        }
      }
      await source.writeAsBytes(bytes);
      expect((await inspectEpub(source.path))['title'], 'Local & ready');
      final sparse = await source.open(mode: FileMode.write);
      await sparse.truncate(512 * 1024 * 1024 + 1);
      await sparse.close();
      await expectLater(inspectEpub(source.path), throwsFormatException);
    },
  );

  test(
    'restart between canonical adoption and queue deletion does not duplicate the book',
    () async {
      var service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) => FakeUpload(client.baseUri, offline: true),
      );
      final entry = (await service.importPath(source.path))!;
      await service.retryPending();
      await library.adoptCanonical(
        entryId: entry.id,
        book: Book.fromJson({
          ...entry.book.toJson(),
          'id': 'legacy-existing-id',
        }),
        origin: entry.origin,
      );
      service.dispose();
      library.dispose();
      library = LibraryRepository(store: kv, bookStore: books);
      await library.load();
      service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) => FakeUpload(client.baseUri, deduplicate: true),
      );
      addTearDown(service.dispose);
      await service.load();
      expect(library.entries.length, 1);
      await service.retryPending();
      expect(library.entries.single.book.id, 'legacy-existing-id');
      expect(service.pendingCount, 0);
    },
  );

  test(
    'metadata extraction returns streamed checksum and rejects malformed/DRM/oversized metadata',
    () async {
      final metadata = await inspectEpub(source.path);
      expect(metadata['title'], 'Local & ready');
      expect(
        metadata['sha256'],
        sha256.convert(await source.readAsBytes()).toString(),
      );
      await source.writeAsBytes(
        epub(
          extraName: 'META-INF/encryption.xml',
          extraText:
              '<encryption><EncryptionMethod Algorithm="urn:drm"/></encryption>',
        ),
      );
      await expectLater(inspectEpub(source.path), throwsFormatException);
      await source.writeAsBytes(
        epub(metadata: '<package>${'x' * (2 * 1024 * 1024)}</package>'),
      );
      await expectLater(inspectEpub(source.path), throwsFormatException);
      await source.writeAsString('not an EPUB file, despite its extension');
      await expectLater(inspectEpub(source.path), throwsFormatException);
    },
  );

  test(
    'ZIP encryption is rejected while font obfuscation remains importable',
    () async {
      final bytes = epub();
      // Central-directory encryption bit: metadata must reject before decoding.
      for (var i = 0; i < bytes.length - 10; i++) {
        if (bytes[i] == 0x50 &&
            bytes[i + 1] == 0x4b &&
            bytes[i + 2] == 1 &&
            bytes[i + 3] == 2) {
          bytes[i + 8] |= 1;
          break;
        }
      }
      await source.writeAsBytes(bytes);
      await expectLater(inspectEpub(source.path), throwsFormatException);
      await source.writeAsBytes(
        epub(
          extraName: 'META-INF/encryption.xml',
          extraText:
              '<encryption><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></encryption>',
        ),
      );
      expect((await inspectEpub(source.path))['title'], 'Local & ready');
    },
  );

  test(
    'local readable return precedes upload and canonical adoption preserves locator',
    () async {
      final gate = Completer<void>();
      final upload = FakeUpload(client.baseUri, gate: gate);
      final service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) => upload,
      );
      addTearDown(service.dispose);
      final entry = (await service.importPath(source.path))!;
      expect(entry.download.isReady, isTrue);
      expect(service.pendingCount, 1);
      final file = await library.openForReading(entry.id);
      expect(await file.readAll(), await source.readAsBytes());
      await file.close();
      await library.saveProgress(
        entry.id,
        const ReadingLocator(href: 'chapter.xhtml', progression: .4),
      );
      gate.complete();
      await service.retryPending();
      expect(service.pendingCount, 0);
      expect(library.entries.single.book.id, 'legacy-existing-id');
      expect(library.entries.single.progress!.locator.progression, .4);
      expect(library.entry(entry.id)!.download.path, entry.download.path);
      expect(upload.received, await source.readAsBytes());
    },
  );

  test(
    'offline queue survives restart, stays origin-bound and deduplicates without uploading',
    () async {
      final offline = FakeUpload(client.baseUri, offline: true);
      var service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) => offline,
      );
      final entry = (await service.importPath(source.path))!;
      await service.retryPending();
      expect(service.errorFor(entry.id), 'Offline');
      service.dispose();
      final original = client;
      client = ApiClient(baseUrl: 'https://different.example');
      var calls = 0;
      final online = FakeUpload(original.baseUri, deduplicate: true);
      service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) {
          calls++;
          return online;
        },
      );
      addTearDown(service.dispose);
      await service.load();
      await service.retryPending();
      expect(calls, 0);
      expect(service.isPending(entry.id), isTrue);
      client.close();
      client = original;
      await service.retryPending();
      expect(calls, 1);
      expect(online.received, isEmpty);
      expect(service.pendingCount, 0);
      expect(library.entries.single.book.id, 'legacy-existing-id');
    },
  );

  test(
    'cancelled pending upload cannot adopt or resurrect deleted local book',
    () async {
      final gate = Completer<void>();
      final upload = FakeUpload(client.baseUri, gate: gate);
      final service = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
        uploadApiFactory: (_) => upload,
      );
      final entry = (await service.importPath(source.path))!;
      await Future<void>.delayed(Duration.zero);
      await service.cancelPending(entry.id);
      await library.remove(entry.id);
      gate.complete();
      await service.retryPending();
      expect(upload.closed, isTrue);
      expect(library.entries, isEmpty);
      service.dispose();
      final reloaded = EpubImportService(
        bookStore: books,
        library: library,
        store: kv,
        clientForCurrentOrigin: () => client,
      );
      addTearDown(reloaded.dispose);
      await reloaded.load();
      expect(reloaded.pendingCount, 0);
      expect(library.entries, isEmpty);
    },
  );
}
