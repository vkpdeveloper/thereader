import 'dart:async';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../models/book.dart';
import '../models/library.dart';
import '../repositories/library_repository.dart';
import '../storage/book_store.dart';
import '../storage/key_value_store.dart';
import 'import_platform.dart' as platform;
import 'upload_api.dart';

class EpubImportService extends ChangeNotifier {
  EpubImportService({
    required BookStore bookStore,
    required LibraryRepository library,
    required KeyValueStore store,
    required ApiClient Function() clientForCurrentOrigin,
    UploadApi Function(Uri origin)? uploadApiFactory,
  }) : _books = bookStore,
       _library = library,
       _store = store,
       _currentClient = clientForCurrentOrigin,
       _uploadApiFactory = uploadApiFactory ?? ((origin) => UploadApi(origin));

  static const _key = 'imports.pending.v1';
  final BookStore _books;
  final LibraryRepository _library;
  final KeyValueStore _store;
  final ApiClient Function() _currentClient;
  final UploadApi Function(Uri) _uploadApiFactory;
  final Map<String, _Pending> _pending = {};
  final Map<String, String> _errors = {};
  Future<void> _writes = Future.value();
  Future<void>? _loading;
  Future<void>? _retrying;
  bool _retryRequested = false;
  UploadApi? _activeApi;
  String? _activeId;
  bool _disposed = false;
  bool _busy = false;
  String? _error;
  double? _fraction;

  bool get busy => _busy;
  bool get isSupported => platform.importSupported && _books.isDurable;
  String? get error => _error;
  double? get uploadFraction => _fraction;
  int get pendingCount => _pending.length;
  bool isUploading(String entryId) => _matches(_activeId, entryId);
  bool isPending(String entryId) =>
      _pending.keys.any((id) => _matches(id, entryId));
  String? errorFor(String entryId) {
    for (final id in _errors.keys) {
      if (_matches(id, entryId)) return _errors[id];
    }
    return null;
  }

  bool _matches(String? queuedId, String entryId) {
    if (queuedId == null) return false;
    if (queuedId == entryId) return true;
    final queued = _pending[queuedId];
    final entry = _library.entry(entryId);
    return queued != null &&
        entry?.origin == queued.origin &&
        entry?.book.sha256 == queued.book.sha256;
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> load() => _loading ??= _load();
  Future<void> _load() async {
    final json = await _store.readJson(_key);
    for (final raw in (json?['items'] as List? ?? const [])) {
      try {
        var pending = _Pending.fromJson((raw as Map).cast<String, dynamic>());
        if (!await _books.exists(pending.path)) continue;
        final canonical = _library.entries
            .where(
              (entry) =>
                  entry.origin == pending.origin &&
                  entry.book.sha256 == pending.book.sha256 &&
                  entry.download.path == pending.path,
            )
            .firstOrNull;
        if (canonical != null) {
          pending = _Pending(
            book: canonical.book,
            origin: pending.origin,
            path: pending.path,
          );
        }
        _pending[pending.id] = pending;
        // Recover the small transaction window between queue and library writes.
        if (_library.entry(pending.id) == null) {
          await _library.importLocal(
            book: pending.book,
            origin: pending.origin,
            path: pending.path,
          );
        }
      } catch (_) {
        /* A malformed queue item must not prevent reading. */
      }
    }
    await _persist();
    _notify();
  }

  Future<void> _persist() {
    final snapshot = {'items': _pending.values.map((p) => p.toJson()).toList()};
    final write = _writes.then((_) => _store.writeJson(_key, snapshot));
    _writes = write.catchError((Object _) {});
    return write;
  }

  Future<LibraryEntry?> pickAndImport() async {
    if (_busy || !isSupported) return null;
    _busy = true;
    _error = null;
    _notify();
    String? picked;
    try {
      final origin = _currentClient().baseUri.toString();
      picked = await platform.pickEpub();
      return picked == null ? null : await _import(picked, origin);
    } catch (e) {
      _error = _message(e);
      return null;
    } finally {
      if (picked != null) {
        try {
          await platform.cleanPickedEpub(picked);
        } catch (_) {}
      }
      _busy = false;
      _notify();
    }
  }

  /// Native/test entry point; the source file belongs to its caller and is kept.
  Future<LibraryEntry?> importPath(String path) async {
    if (_busy || !isSupported) return null;
    _busy = true;
    _error = null;
    _notify();
    try {
      return await _import(path, _currentClient().baseUri.toString());
    } catch (e) {
      _error = _message(e);
      return null;
    } finally {
      _busy = false;
      _notify();
    }
  }

  Future<LibraryEntry> _import(String sourcePath, String origin) async {
    await load();
    // Origin was captured before picker/file work; never close its shared client.
    final metadata = await platform.inspectEpub(sourcePath);
    final sha = metadata['sha256'] as String;
    final book = Book.fromJson({
      ...metadata,
      'id': 'epub-$sha',
      'version': sha.substring(0, 12),
      'downloadUrl': '/v1/books/epub-$sha/download',
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    });
    final existing = _library.entries
        .where(
          (e) =>
              e.origin == origin && e.book.sha256 == sha && e.download.isReady,
        )
        .firstOrNull;
    if (existing != null) {
      unawaited(retryPending());
      return existing;
    }
    final id = LibraryEntry.identity(book.id, BookSource.api, origin);
    if (_library.entry(id)?.download.isActive == true) {
      throw const FormatException(
        'A download of this EPUB is already running.',
      );
    }
    final sink = await _books.openSink(
      // Separate staging namespace prevents a concurrently started catalog
      // download from sharing this import's .part file before adoption.
      bookId: 'import-$id',
      version: '${book.version}-$sha',
    );
    String? storedPath;
    var queued = false;
    try {
      var bytes = 0;
      final digest = _DigestSink();
      final hash = sha256.startChunkedConversion(digest);
      await for (final chunk in platform.readImportFile(sourcePath)) {
        bytes += chunk.length;
        if (bytes > book.fileSize) {
          throw const FormatException('The EPUB changed while importing.');
        }
        hash.add(chunk);
        await sink.add(chunk);
      }
      hash.close();
      if (bytes != book.fileSize || digest.value.toString() != sha) {
        throw const FormatException('The EPUB changed while importing.');
      }
      storedPath = await sink.commit();
      _pending[id] = _Pending(book: book, origin: origin, path: storedPath);
      await _persist();
      queued = true;
      final entry = await _library.importLocal(
        book: book,
        origin: origin,
        path: storedPath,
      );
      _notify();
      unawaited(retryPending());
      return entry;
    } catch (_) {
      if (!queued) {
        _pending.remove(id);
        if (storedPath != null) {
          await _books.delete(storedPath);
        } else {
          await sink.abort();
        }
      }
      rethrow;
    }
  }

  Future<void> retryPending() {
    if (_disposed) return Future.value();
    if (_retrying != null) {
      _retryRequested = true;
      return _retrying!;
    }
    return _retrying = _retry().whenComplete(() {
      _retrying = null;
      if (_retryRequested) {
        _retryRequested = false;
        unawaited(retryPending());
      }
    });
  }

  Future<void> _retry() async {
    try {
      await load();
      final origin = _currentClient().baseUri.toString();
      for (final pending in _pending.values.toList()) {
        if (_disposed ||
            pending.origin != origin ||
            !_pending.containsKey(pending.id)) {
          continue;
        }
        final api = _uploadApiFactory(Uri.parse(pending.origin));
        _activeApi = api;
        _activeId = pending.id;
        _fraction = null;
        _errors.remove(pending.id);
        _notify();
        try {
          if (!await _books.exists(pending.path) ||
              _library.entry(pending.id) == null) {
            await cancelPending(pending.id);
            continue;
          }
          final prepared = await api.prepare(pending.book);
          if (!_pending.containsKey(pending.id) || _disposed) continue;
          var canonical = prepared.book;
          if (!prepared.uploaded) {
            final file = await _books.open(pending.path);
            try {
              Stream<List<int>> bytes(int rangeStart, int rangeEnd) async* {
                for (
                  var start = rangeStart;
                  start < rangeEnd;
                  start += 64 * 1024
                ) {
                  if (!_pending.containsKey(pending.id) || _disposed) {
                    throw StateError('Upload cancelled.');
                  }
                  final end = start + 64 * 1024 < rangeEnd
                      ? start + 64 * 1024
                      : rangeEnd;
                  yield await file.readRange(start, end);
                }
              }

              if (file.length != pending.book.fileSize) {
                throw const FormatException(
                  'The local EPUB size changed. Import it again.',
                );
              }
              var lastPaint = DateTime.now();
              void progress(int sent) {
                _fraction = sent / pending.book.fileSize;
                final now = DateTime.now();
                if (sent == pending.book.fileSize ||
                    now.difference(lastPaint).inMilliseconds >= 80) {
                  lastPaint = now;
                  _notify();
                }
              }

              canonical = prepared.multipart != null
                  ? await api.uploadMultipart(
                      pending.book,
                      prepared.multipart!,
                      bytes,
                      onProgress: progress,
                    )
                  : await api.upload(
                      pending.book,
                      prepared.uploadUrl!,
                      bytes(0, file.length),
                      onProgress: progress,
                    );
            } finally {
              await file.close();
            }
          }
          if (!_pending.containsKey(pending.id) || _disposed) continue;
          await _library.adoptCanonical(
            entryId: pending.id,
            book: canonical,
            origin: pending.origin,
          );
          // Keep pending membership until canonical metadata is durable, so
          // cloud sync never tries to send a transient book ID.
          _pending.remove(pending.id);
          try {
            await _persist();
          } catch (_) {
            _pending[pending.id] = pending;
            rethrow;
          }
          _errors.remove(pending.id);
        } catch (e) {
          if (_pending.containsKey(pending.id) && !_disposed) {
            _errors[pending.id] = _message(e);
          }
        } finally {
          api.close();
          _activeApi = null;
          _activeId = null;
          _fraction = null;
          _notify();
        }
      }
    } catch (e) {
      _error = _message(e);
      _notify();
    }
  }

  /// Call and await before deleting local bytes. Aborts an active request and
  /// durably removes retry intent, preventing a restart from resurrecting it.
  Future<void> cancelPending(String entryId) async {
    await load();
    final ids = _pending.keys.where((id) => _matches(id, entryId)).toList();
    final removed = <String, _Pending>{};
    for (final id in ids) {
      if (_activeId == id) _activeApi?.close();
      removed[id] = _pending.remove(id)!;
      _errors.remove(id);
    }
    try {
      await _persist();
    } catch (_) {
      _pending.addAll(removed);
      rethrow;
    }
    _notify();
  }

  static String _message(Object error) => switch (error) {
    ApiException e => e.message,
    FormatException e => e.message,
    _ =>
      'Could not finish the import or upload. Your existing books are unchanged.',
  };
  @override
  void dispose() {
    _disposed = true;
    _activeApi?.close();
    super.dispose();
  }
}

class _Pending {
  _Pending({required this.book, required this.origin, required this.path});
  final Book book;
  final String origin;
  final String path;
  String get id => LibraryEntry.identity(book.id, BookSource.api, origin);
  Map<String, dynamic> toJson() => {
    'book': book.toJson(),
    'origin': origin,
    'path': path,
  };
  factory _Pending.fromJson(Map<String, dynamic> json) => _Pending(
    book: Book.fromJson((json['book'] as Map).cast<String, dynamic>()),
    origin: json['origin'] as String,
    path: json['path'] as String,
  );
}

class _DigestSink implements Sink<Digest> {
  Digest? value;
  @override
  void add(Digest data) => value = data;
  @override
  void close() {}
}
