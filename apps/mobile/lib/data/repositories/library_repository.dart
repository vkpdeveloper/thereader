import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/catalog_source.dart';
import '../download/downloader.dart';
import '../models/book.dart';
import '../models/library.dart';
import '../storage/book_store.dart';
import '../storage/key_value_store.dart';

/// The user's local library: which books were added, their durable download
/// state and reading progress. This is the source of truth for offline use.
class LibraryRepository extends ChangeNotifier {
  LibraryRepository({required KeyValueStore store, required BookStore bookStore})
    : _store = store,
      _bookStore = bookStore,
      _downloader = Downloader(store: bookStore);

  static const _key = 'library.v1';

  final KeyValueStore _store;
  final BookStore _bookStore;
  final Downloader _downloader;
  final Map<String, LibraryEntry> _entries = {};
  final Set<String> _cancelRequests = {};
  bool _loaded = false;
  Future<void> _writes = Future.value();

  BookStore get bookStore => _bookStore;
  bool get loaded => _loaded;

  UnmodifiableListView<LibraryEntry> get entries => UnmodifiableListView(_entries.values);

  LibraryEntry? entry(String id) => _entries[id];

  LibraryEntry? entryFor(Book book, CatalogSource source) =>
      entry(LibraryEntry.identity(book.id, source.source, source.origin));

  /// Ready books, most recently opened first.
  List<LibraryEntry> get continueReading {
    final list = _entries.values.where((e) => e.download.isReady && e.lastOpenedAt != null).toList()
      ..sort((a, b) => b.lastOpenedAt!.compareTo(a.lastOpenedAt!));
    return list;
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
      if (e.download.isReady && (path == null || !await _bookStore.exists(path))) {
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
    final snapshot = {'entries': _entries.values.map((e) => e.toJson()).toList()};
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

    var e = existing == null
        ? LibraryEntry(
            book: book,
            source: source.source,
            origin: source.origin,
            addedAt: DateTime.now(),
          )
        : existing.copyWith(book: book, clearProgress: existing.book.sha256 != book.sha256);
    e = e.copyWith(
      download: DownloadState(status: DownloadStatus.queued, totalBytes: book.fileSize),
    );
    _cancelRequests.remove(id);
    _put(e);

    try {
      final stream = await source.openDownload(book);
      _put(
        e = e.copyWith(
          download: e.download.copyWith(status: DownloadStatus.downloading, clearError: true),
        ),
      );
      var lastPaint = DateTime.now();
      final path = await _downloader.download(
        book: book,
        storageId: id,
        source: stream,
        isCancelled: () => _cancelRequests.contains(id),
        onProgress: (received, total) {
          final now = DateTime.now();
          final done = total != null && received >= total;
          if (done || now.difference(lastPaint).inMilliseconds >= 80) {
            lastPaint = now;
            _put(
              e = e.copyWith(
                download: e.download.copyWith(
                  status: done ? DownloadStatus.verifying : DownloadStatus.downloading,
                  receivedBytes: received,
                  totalBytes: total,
                ),
              ),
              persist: false,
            );
          }
        },
      );
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
    } on DownloadCancelled {
      _put(e.copyWith(download: DownloadState(totalBytes: book.fileSize)));
    } catch (err) {
      final message = switch (err) {
        DownloadFailure f => f.message,
        ApiException a => a.message,
        _ => 'Download failed: $err',
      };
      _put(
        e.copyWith(
          download: DownloadState(
            status: DownloadStatus.failed,
            totalBytes: book.fileSize,
            error: message,
          ),
        ),
      );
    } finally {
      await flush();
      _cancelRequests.remove(id);
    }
  }

  void cancelDownload(String bookId) {
    final e = _entries[bookId];
    if (e != null && e.download.isActive) _cancelRequests.add(bookId);
  }

  Future<void> remove(String bookId) async {
    if (_entries[bookId]?.download.isActive == true) return;
    final e = _entries.remove(bookId);
    notifyListeners();
    if (e?.download.path != null) await _bookStore.delete(e!.download.path!);
    if (e != null) await _bookStore.deleteBook(bookId);
    await _persist();
  }

  Future<void> markOpened(String bookId) async {
    final e = _entries[bookId];
    if (e == null) return;
    _put(e.copyWith(lastOpenedAt: DateTime.now()));
    await flush();
  }

  Future<void> saveProgress(String bookId, ReadingLocator locator) async {
    final e = _entries[bookId];
    if (e == null) return;
    _put(
      e.copyWith(
        progress: ReadingProgress(locator: locator, updatedAt: DateTime.now()),
        lastOpenedAt: DateTime.now(),
      ),
    );
    await flush();
  }
}
