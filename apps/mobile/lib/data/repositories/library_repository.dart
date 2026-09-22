import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/catalog_source.dart';
import '../download/downloader.dart';
import '../download/progressive_download.dart';
import '../models/book.dart';
import '../models/library.dart';
import '../storage/book_store.dart';
import '../storage/key_value_store.dart';

/// The user's local library: which books were added, their durable download
/// state and reading progress. This is the source of truth for offline use.
class LibraryRepository extends ChangeNotifier {
  LibraryRepository({
    required KeyValueStore store,
    required BookStore bookStore,
  }) : _store = store,
       _bookStore = bookStore,
       _downloader = Downloader(store: bookStore);

  static const _key = 'library.v1';

  final KeyValueStore _store;
  final BookStore _bookStore;
  final Downloader _downloader;
  final Map<String, LibraryEntry> _entries = {};
  final Set<String> _cancelRequests = {};
  final Map<String, ProgressiveDownload> _progressive = {};
  final Map<String, LibraryEntry> _verifiedBeforeUpdate = {};
  bool _loaded = false;
  Future<void> _writes = Future.value();

  BookStore get bookStore => _bookStore;
  bool get loaded => _loaded;

  UnmodifiableListView<LibraryEntry> get entries =>
      UnmodifiableListView(_entries.values);

  LibraryEntry? entry(String id) => _entries[id];

  LibraryEntry? entryFor(Book book, CatalogSource source) =>
      entry(LibraryEntry.identity(book.id, source.source, source.origin));

  /// Ready books, most recently opened first.
  List<LibraryEntry> get continueReading {
    final list =
        _entries.values
            .where((e) => canRead(e.id) && e.lastOpenedAt != null)
            .toList()
          ..sort((a, b) => b.lastOpenedAt!.compareTo(a.lastOpenedAt!));
    return list;
  }

  /// Partial publications stay online-only until their final SHA is verified.
  bool canRead(String id) =>
      _entries[id]?.download.isReady == true ||
      (_entries[id]?.download.isActive == true &&
          _progressive[id]?.canRead == true);

  Future<BookFile> openForReading(String id) async {
    final entry = _entries[id];
    if (entry?.download.isReady == true) {
      return _bookStore.open(entry!.download.path!);
    }
    final partial = _progressive[id];
    if (partial?.canRead == true) return partial!.open();
    throw StateError('This book is not ready to read yet.');
  }

  Future<void> load() async {
    final json = await _store.readJson(_key);
    if (json != null) {
      for (final raw in (json['entries'] as List<dynamic>? ?? const [])) {
        try {
          final e = LibraryEntry.fromJson((raw as Map).cast<String, dynamic>());
          _entries[e.id] = e;
        } catch (_) {
          // Skip a corrupt record instead of losing the whole library.
        }
      }
    }
    // Reconcile with disk: a "ready" record whose file vanished is not ready.
    for (final e in _entries.values.toList()) {
      final path = e.download.path;
      if (e.download.isReady &&
          (path == null || !await _bookStore.exists(path))) {
        _entries[e.id] = e.copyWith(
          download: const DownloadState(
            status: DownloadStatus.failed,
            error: 'The file is missing from storage.',
          ),
        );
      }
    }
    _loaded = true;
    notifyListeners();
    await _persist();
  }

  Future<void> _persist() {
    final snapshot = {
      'entries': _entries.values
          .map(
            (e) =>
                (e.download.isActive ? (_verifiedBeforeUpdate[e.id] ?? e) : e)
                    .toJson(),
          )
          .toList(),
    };
    // Serialize snapshots: a slower old write must never replace newer progress.
    final next = _writes.then((_) => _store.writeJson(_key, snapshot));
    _writes = next.catchError((Object error) {
      debugPrint('Library persistence failed: $error');
    });
    return next;
  }

  Future<void> flush() => _writes;

  void _put(LibraryEntry e, {bool persist = true}) {
    _entries[e.id] = e;
    notifyListeners();
    if (persist) unawaited(_persist());
  }

  /// Adds (or refreshes) a book and starts downloading it from [source].
  /// Returns when the download finishes or fails; state is observable
  /// through [entry] while it runs.
  Future<void> download(Book book, CatalogSource source) async {
    final id = LibraryEntry.identity(book.id, source.source, source.origin);
    final existing = _entries[id];
    if (existing != null && existing.download.isActive) return;

    if (existing?.download.isReady == true) {
      _verifiedBeforeUpdate[id] = existing!;
    }
    var e = existing == null
        ? LibraryEntry(
            book: book,
            source: source.source,
            origin: source.origin,
            addedAt: DateTime.now(),
          )
        : existing.copyWith(
            book: book,
            clearProgress: existing.book.sha256 != book.sha256,
          );
    e = e.copyWith(
      download: DownloadState(
        status: DownloadStatus.queued,
        totalBytes: book.fileSize,
      ),
    );
    _cancelRequests.remove(id);
    _put(e);

    try {
      var lastPaint = DateTime.now();
      void progress(int received, int? total) {
        final now = DateTime.now();
        final done = total != null && received >= total;
        if (done ||
            (received >= book.fileSize * .05 &&
                e.download.receivedBytes < book.fileSize * .05) ||
            now.difference(lastPaint).inMilliseconds >= 80) {
          lastPaint = now;
          // Reading locators may change while bytes arrive. Never overwrite
          // newer reading progress with the entry captured at download start.
          e = (_entries[id] ?? e).copyWith(
            download: e.download.copyWith(
              status: done
                  ? DownloadStatus.verifying
                  : DownloadStatus.downloading,
              receivedBytes: received,
              totalBytes: total,
            ),
          );
          _put(e, persist: false);
        }
      }

      final partial = source is ApiCatalogSource
          ? await ProgressiveDownload.create(
              store: _bookStore,
              book: book,
              storageId: id,
              client: source.client,
              onProgress: progress,
              onReadable: () => notifyListeners(),
            )
          : null;
      if (partial != null) _progressive[id] = partial;
      if (_cancelRequests.contains(id)) {
        await partial?.cancel();
        throw DownloadCancelled();
      }
      _put(
        e = (_entries[id] ?? e).copyWith(
          download: e.download.copyWith(
            status: DownloadStatus.downloading,
            clearError: true,
          ),
        ),
      );
      final path = partial != null
          ? await partial.run()
          : await _downloader.download(
              book: book,
              storageId: id,
              source: await source.openDownload(book),
              isCancelled: () => _cancelRequests.contains(id),
              onProgress: progress,
            );
      e = _entries[id] ?? e;
      _put(
        e.copyWith(
          download: DownloadState(
            status: DownloadStatus.ready,
            receivedBytes: book.fileSize,
            totalBytes: book.fileSize,
            path: path,
          ),
        ),
      );
      if (existing?.download.path != null && existing!.download.path != path) {
        await _bookStore.delete(existing.download.path!);
      }
    } on DownloadCancelled {
      final verified = _verifiedBeforeUpdate[id] ?? existing;
      _put(
        verified?.download.isReady == true
            ? verified!
            : (_entries[id] ?? e).copyWith(
                download: DownloadState(totalBytes: book.fileSize),
              ),
      );
    } catch (err) {
      final message = switch (err) {
        DownloadFailure f => f.message,
        ApiException a => a.message,
        _ => 'Download failed: $err',
      };
      final verified = _verifiedBeforeUpdate[id] ?? existing;
      _put(
        verified?.download.isReady == true
            ? verified!.copyWith(
                download: verified.download.copyWith(
                  error: 'Update failed. $message',
                ),
              )
            : (_entries[id] ?? e).copyWith(
                download: DownloadState(
                  status: DownloadStatus.failed,
                  totalBytes: book.fileSize,
                  error: message,
                ),
              ),
      );
    } finally {
      await flush();
      await _progressive.remove(id)?.release();
      _cancelRequests.remove(id);
      _verifiedBeforeUpdate.remove(id);
    }
  }

  void cancelDownload(String bookId) {
    final e = _entries[bookId];
    if (e != null && e.download.isActive) {
      _cancelRequests.add(bookId);
      unawaited(_progressive[bookId]?.cancel());
    }
  }

  Future<void> remove(String bookId) async {
    if (_entries[bookId]?.download.isActive == true) return;
    final e = _entries.remove(bookId);
    notifyListeners();
    if (e?.download.path != null) await _bookStore.delete(e!.download.path!);
    if (e != null) await _bookStore.deleteBook(bookId);
    await _persist();
  }

  Future<void> markOpened(String bookId, {String? expectedSha256}) async {
    final now = DateTime.now();
    await _updateReadingState(
      bookId,
      expectedSha256: expectedSha256,
      update: (entry) => entry.copyWith(lastOpenedAt: now),
    );
  }

  Future<void> saveProgress(
    String bookId,
    ReadingLocator locator, {
    String? expectedSha256,
  }) async {
    final now = DateTime.now();
    await _updateReadingState(
      bookId,
      expectedSha256: expectedSha256,
      update: (entry) => entry.copyWith(
        progress: ReadingProgress(locator: locator, updatedAt: now),
        lastOpenedAt: now,
      ),
    );
  }

  Future<void> _updateReadingState(
    String bookId, {
    required String? expectedSha256,
    required LibraryEntry Function(LibraryEntry entry) update,
  }) async {
    final current = _entries[bookId];
    if (current == null) return;
    if (expectedSha256 == null || current.book.sha256 == expectedSha256) {
      final verified = _verifiedBeforeUpdate[bookId];
      if (verified?.book.sha256 == current.book.sha256) {
        _verifiedBeforeUpdate[bookId] = update(verified!);
      }
      _put(update(current));
      await flush();
      return;
    }

    // A verified edition can remain open while its replacement downloads.
    // Route that reader's progress to the recovery snapshot rather than
    // contaminating the new edition. Once replacement finishes the snapshot
    // is removed, so late writes from the old reader are safely ignored.
    final verified = _verifiedBeforeUpdate[bookId];
    if (verified?.book.sha256 != expectedSha256) return;
    _verifiedBeforeUpdate[bookId] = update(verified!);
    await _persist();
  }
}
