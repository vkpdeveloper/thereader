import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/api/catalog_source.dart';
import 'package:thereader/data/comic/comic_transfers.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/data/storage/key_value_store.dart';

final _bytes = Uint8List.fromList(List.generate(4096, (i) => i * 31 % 256));
final _sha = sha256.convert(_bytes).toString();
const _origin = 'http://api.test';

Book _comic() => Book(
  id: 'comic-$_sha',
  version: _sha.substring(0, 12),
  title: 'Little Nemo',
  author: 'Winsor McCay',
  description: '',
  language: 'en',
  subjects: const ['Comics'],
  coverUrl: null,
  downloadUrl: '/v1/books/comic-$_sha/download',
  fileSize: _bytes.length,
  sha256: _sha,
  updatedAt: DateTime.utc(2026, 10, 11),
  format: BookFormat.comic,
);

final _id = LibraryEntry.identity('comic-$_sha', BookSource.api, _origin);

/// Stands in for the OS downloader: tests drive status and progress.
class FakeTransfers implements ComicTransfers {
  FakeTransfers(this.dir, {this.records = const []});
  final Directory dir;
  final List<ComicTransfer> records;
  final controller = StreamController<ComicTransfer>.broadcast(sync: true);
  final enqueued = <ComicTransferRequest>[];
  final cancelled = <String>[];
  final forgotten = <String>[];
  var permissionRequests = 0;
  var started = false;

  @override
  Stream<ComicTransfer> get updates => controller.stream;

  @override
  Future<List<ComicTransfer>> start() async {
    started = true;
    return records;
  }

  @override
  Future<bool> enqueue(ComicTransferRequest request) async {
    enqueued.add(request);
    return true;
  }

  @override
  Future<void> cancel(String entryId) async => cancelled.add(entryId);

  @override
  Future<String> filePath(String entryId) async =>
      '${dir.path}/${entryId.hashCode}.cbz';

  @override
  Future<void> forget(String entryId) async {
    forgotten.add(entryId);
    final file = File(await filePath(entryId));
    if (file.existsSync()) file.deleteSync();
  }

  @override
  Future<void> requestNotificationPermission() async => permissionRequests++;

  void emit(TransferState state, {double? progress}) => controller.add(
    ComicTransfer(entryId: _id, state: state, progress: progress, sha256: _sha),
  );

  Future<void> finish(List<int> bytes) async {
    await File(await filePath(_id)).writeAsBytes(bytes);
    emit(TransferState.complete);
  }
}

Future<void> _settle() =>
    Future<void>.delayed(const Duration(milliseconds: 50));

Future<void> _until(bool Function() done) async {
  for (var i = 0; i < 200 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
  expect(done(), isTrue);
}

void main() {
  late Directory temp;
  late IoBookStore books;
  late MemoryKeyValueStore kv;
  late ApiCatalogSource source;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('reader-comic-transfers-');
    books = IoBookStore(Directory('${temp.path}/books'));
    kv = MemoryKeyValueStore();
    source = ApiCatalogSource(ApiClient(baseUrl: _origin));
  });
  tearDown(() async {
    source.client.close();
    await temp.delete(recursive: true);
  });

  Future<(LibraryRepository, FakeTransfers)> open({
    List<ComicTransfer> records = const [],
  }) async {
    final transfers = FakeTransfers(
      await Directory('${temp.path}/transfers').create(recursive: true),
      records: records,
    );
    final library = LibraryRepository(
      store: kv,
      bookStore: books,
      comicTransfers: transfers,
    );
    addTearDown(library.dispose);
    await library.load();
    return (library, transfers);
  }

  DownloadState state(LibraryRepository library) =>
      library.entry(_id)!.download;

  test(
    'progress maps into DownloadState; a verified file becomes the offline copy',
    () async {
      final (library, transfers) = await open();
      final done = library.download(_comic(), source);
      await _settle();
      expect(transfers.permissionRequests, 1);
      final request = transfers.enqueued.single;
      expect(request.entryId, _id);
      expect(request.url.toString(), '$_origin/v1/books/comic-$_sha/download');
      expect(request.headers['accept'], 'application/vnd.comicbook+zip');
      expect((request.sha256, request.fileSize), (_sha, _bytes.length));
      expect(state(library).status, DownloadStatus.queued);

      transfers.emit(TransferState.running, progress: .5);
      expect(state(library).status, DownloadStatus.downloading);
      expect(state(library).receivedBytes, 2048);
      expect(state(library).fraction, .5);
      // Meanwhile the comic reads by range.
      expect(library.canRead(_id), isTrue);
      expect((await library.openForReading(_id)).isProvisional, isTrue);

      await transfers.finish(_bytes);
      await done;
      expect(state(library).status, DownloadStatus.ready);
      final file = await library.openForReading(_id);
      expect(file.isProvisional, isFalse);
      expect(await file.readAll(), _bytes);
      expect(file.path, endsWith('.cbz'));
      await file.close();
      expect(File(await transfers.filePath(_id)).existsSync(), isFalse);
      expect(transfers.forgotten, [_id]);

      // A second download of a verified comic is a no-op.
      await library.download(_comic(), source);
      expect(transfers.enqueued, hasLength(1));
    },
  );

  test(
    'a file that fails verification is discarded and the state is honest',
    () async {
      final (library, transfers) = await open();
      final done = library.download(_comic(), source);
      await _settle();
      await transfers.finish([..._bytes.sublist(1), 0]);
      await done;
      await _until(() => transfers.forgotten.contains(_id));
      expect(state(library).status, DownloadStatus.failed);
      expect(state(library).error, contains('checksum'));
      expect(File(await transfers.filePath(_id)).existsSync(), isFalse);
      // Still readable online; Retry enqueues again.
      expect(library.canRead(_id), isTrue);
      unawaited(library.download(_comic(), source));
      await _settle();
      expect(transfers.enqueued, hasLength(2));
    },
  );

  test('OS failures and 404s fail the entry', () async {
    final (library, transfers) = await open();
    final done = library.download(_comic(), source);
    await _settle();
    transfers.emit(TransferState.notFound);
    await done;
    expect(state(library).status, DownloadStatus.failed);
    expect(state(library).error, 'This comic is no longer on the server.');
    expect(transfers.forgotten, contains(_id));
  });

  test(
    'cancel and remove cancel the OS task; late reports are ignored',
    () async {
      final (library, transfers) = await open();
      final done = library.download(_comic(), source);
      await _settle();
      transfers.emit(TransferState.running, progress: .25);
      library.cancelDownload(_id);
      await done;
      expect(transfers.cancelled, [_id]);
      expect(state(library).status, DownloadStatus.none);
      transfers.emit(TransferState.running, progress: .3);
      expect(state(library).status, DownloadStatus.none);

      unawaited(library.download(_comic(), source));
      await _settle();
      transfers.emit(TransferState.running, progress: .4);
      expect(state(library).status, DownloadStatus.downloading);
      await library.remove(_id);
      expect(transfers.cancelled, [_id, _id]);
      expect(library.entry(_id), isNull);
    },
  );

  group('launch reconciliation', () {
    Future<void> interruptedDownload() async {
      final (library, transfers) = await open();
      unawaited(library.download(_comic(), source));
      await _settle();
      transfers.emit(TransferState.running, progress: .3);
      await library.flush();
    }

    test('a live OS task keeps the comic downloading', () async {
      await interruptedDownload();
      final (library, transfers) = await open(
        records: [
          ComicTransfer(
            entryId: _id,
            state: TransferState.running,
            progress: .6,
            sha256: _sha,
          ),
        ],
      );
      expect(transfers.started, isTrue);
      expect(state(library).status, DownloadStatus.downloading);
      expect(state(library).receivedBytes, (.6 * _bytes.length).round());
      expect(transfers.enqueued, isEmpty);
      await transfers.finish(_bytes);
      await _until(() => state(library).isReady);
    });

    test(
      'a transfer that finished while the app was killed is adopted',
      () async {
        await interruptedDownload();
        final dir = await Directory('${temp.path}/transfers').create();
        await File('${dir.path}/${_id.hashCode}.cbz').writeAsBytes(_bytes);
        final (library, _) = await open(
          records: [
            ComicTransfer(
              entryId: _id,
              state: TransferState.complete,
              sha256: _sha,
            ),
          ],
        );
        await _until(() => state(library).isReady);
        final file = await library.openForReading(_id);
        expect(await file.readAll(), _bytes);
        await file.close();
      },
    );

    test('no OS task: the download is enqueued again', () async {
      await interruptedDownload();
      final (library, transfers) = await open();
      expect(transfers.enqueued.single.entryId, _id);
      expect(state(library).status, DownloadStatus.queued);
    });

    test('a failed OS task fails honestly, with Retry', () async {
      await interruptedDownload();
      final (library, transfers) = await open(
        records: [
          ComicTransfer(
            entryId: _id,
            state: TransferState.failed,
            sha256: _sha,
          ),
        ],
      );
      await _settle();
      expect(state(library).status, DownloadStatus.failed);
      expect(state(library).error, contains('try again'));
      expect(transfers.forgotten, [_id]);
      expect(transfers.enqueued, isEmpty);
    });

    test('tasks of removed books are cancelled and forgotten', () async {
      final (_, transfers) = await open(
        records: [
          ComicTransfer(
            entryId: _id,
            state: TransferState.running,
            sha256: _sha,
          ),
        ],
      );
      await _settle();
      expect(transfers.cancelled, [_id]);
      expect(transfers.forgotten, [_id]);
    });

    test('EPUB downloads still restart as failed', () async {
      final epub = Book.fromJson({
        ..._comic().toJson(),
        'id': 'epub-$_sha',
        'format': 'epub',
      });
      await kv.writeJson('library.v1', {
        'entries': [
          LibraryEntry(
            book: epub,
            source: BookSource.api,
            origin: _origin,
            addedAt: DateTime.utc(2026),
            download: const DownloadState(status: DownloadStatus.downloading),
          ).toJson(),
        ],
      });
      final (library, transfers) = await open();
      final entry = library.entries.single;
      expect(entry.download.status, DownloadStatus.failed);
      expect(transfers.enqueued, isEmpty);
    });
  });
}
