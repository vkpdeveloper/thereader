import 'dart:async';
import 'dart:collection';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;

import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import '../storage/book_store_io.dart';
import 'downloader.dart';
import 'progressive_download.dart';

Future<ProgressiveDownload?> createProgressiveDownload({
  required BookStore store,
  required Book book,
  required String storageId,
  required ApiClient client,
  required ProgressCallback onProgress,
  required void Function() onReadable,
}) async {
  if (store is! IoBookStore) return null;
  if (book.fileSize <= 0) {
    throw DownloadFailure('The book has an invalid size.');
  }
  final directory = Directory(
    p.join(store.root.path, storageId.replaceAll(RegExp(r'[^a-z0-9._-]'), '_')),
  );
  await directory.create(recursive: true);
  final version = '${book.version}-${book.sha256}'.replaceAll(
    RegExp(r'[^a-z0-9._-]'),
    '_',
  );
  final target = File(p.join(directory.path, '$version.epub'));
  final part = File('${target.path}.part');
  final handle = await part.open(mode: FileMode.write);
  HttpServer server;
  try {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  } catch (_) {
    await handle.close();
    await part.delete();
    rethrow;
  }
  return _SparseDownload(
    book,
    client,
    part,
    target,
    handle,
    server,
    p.relative(target.path, from: store.root.path),
    onProgress,
    onReadable,
  );
}

class _ChunkRequest {
  _ChunkRequest(this.index, this.lastIndex) {
    // Foreground callers await individual chunks; keep an unobserved group
    // failure handled while background callers can still await it normally.
    unawaited(
      done.future.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
    );
  }
  final int index;
  final int lastIndex;
  final done = Completer<void>();
  final abort = Completer<void>();
  final Map<int, Completer<void>> _chunks = {};

  Future<void> chunk(int index) =>
      _chunks.putIfAbsent(index, Completer<void>.new).future;
  void completeChunk(int index) {
    final waiter = _chunks.remove(index);
    if (waiter != null && !waiter.isCompleted) waiter.complete();
  }

  void fail(Object error, [StackTrace? stack]) {
    if (!done.isCompleted) done.completeError(error, stack);
    for (final waiter in _chunks.values) {
      if (!waiter.isCompleted) waiter.completeError(error, stack);
    }
    _chunks.clear();
    stop();
  }

  void stop() {
    if (!abort.isCompleted) abort.complete();
  }
}

class _SparseDownload implements ProgressiveDownload {
  _SparseDownload(
    this.book,
    this.client,
    this.part,
    this.target,
    this.handle,
    this.server,
    this.key,
    this.onProgress,
    this.onReadable,
  ) {
    final random = Random.secure();
    final token = List.generate(
      24,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    uri = Uri.parse('http://127.0.0.1:${server.port}/$token/publication.epub');
    server.listen(_serve);
  }

  static const chunkSize = 64 * 1024;
  final Book book;
  final ApiClient client;
  final File part;
  final File target;
  final RandomAccessFile handle;
  final HttpServer server;
  final String key;
  final ProgressCallback onProgress;
  final void Function() onReadable;
  late final Uri uri;
  final Set<int> _present = {};
  final Map<int, _ChunkRequest> _pending = {};
  final Queue<_ChunkRequest> _foreground = Queue();
  final Queue<_ChunkRequest> _background = Queue();
  Future<void> _disk = Future.value();
  int _workers = 0;
  int _received = 0;
  int _leases = 0;
  bool _released = false;
  bool _committed = false;
  bool _stopped = false;
  bool _closed = false;
  bool _readable = false;
  Future<void>? _closing;
  Object? _failure;
  int get _count => (book.fileSize + chunkSize - 1) ~/ chunkSize;

  @override
  bool get canRead => _readable && !_stopped;

  void _check() {
    if (_failure != null) throw _failure!;
    if (_stopped) throw DownloadCancelled();
  }

  Future<T> _withDisk<T>(Future<T> Function() action) {
    final operation = _disk.then((_) => action());
    _disk = operation.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return operation;
  }

  Future<void> _ensure(int index, {bool foreground = true}) {
    _check();
    if (_present.contains(index)) return Future.value();
    final existing = _pending[index];
    if (existing != null) {
      if (foreground && _background.remove(existing)) _foreground.add(existing);
      return foreground ? existing.chunk(index) : existing.done.future;
    }
    // Coalesce background bytes into 1 MiB requests to avoid a network round
    // trip per 64 KiB chunk. Demand reads remain small and get reserved slots.
    var lastIndex = index;
    if (!foreground) {
      while (lastIndex + 1 < min(index + 16, _count) &&
          !_present.contains(lastIndex + 1) &&
          !_pending.containsKey(lastIndex + 1)) {
        lastIndex++;
      }
    }
    final request = _ChunkRequest(index, lastIndex);
    for (var i = index; i <= lastIndex; i++) {
      _pending[i] = request;
    }
    (foreground ? _foreground : _background).add(request);
    final ready = foreground ? request.chunk(index) : request.done.future;
    _pump();
    return ready;
  }

  void _pump() {
    while (!_stopped &&
        _failure == null &&
        _workers < 3 &&
        (_foreground.isNotEmpty || _background.isNotEmpty)) {
      final request = (_foreground.isNotEmpty ? _foreground : _background)
          .removeFirst();
      _workers++;
      unawaited(_fetch(request));
    }
  }

  Future<void> _fetch(_ChunkRequest request) async {
    try {
      final start = request.index * chunkSize;
      final end = min((request.lastIndex + 1) * chunkSize, book.fileSize);
      var index = request.index;
      await client.streamRange(
        book,
        start,
        end,
        chunkSize: chunkSize,
        abortTrigger: request.abort.future,
        onChunk: (bytes) async {
          _check();
          final chunkIndex = index++;
          await _withDisk(() async {
            _check();
            await handle.setPosition(chunkIndex * chunkSize);
            await handle.writeFrom(bytes);
          });
          _check();
          _present.add(chunkIndex);
          _received += bytes.length;
          onProgress(_received, book.fileSize);
          request.completeChunk(chunkIndex);
        },
      );
      _check();
      if (!request.done.isCompleted) request.done.complete();
    } catch (error, stack) {
      _failure ??= error;
      // Fail queued and in-flight chunk waiters immediately. A streamed range
      // may have delivered earlier chunks, but its failed tail invalidates the
      // provisional session and must never reach durable storage.
      for (final pending in _pending.values.toSet()) {
        pending.fail(_failure!, stack);
      }
      _foreground.clear();
      _background.clear();
    } finally {
      request.stop();
      for (var i = request.index; i <= request.lastIndex; i++) {
        _pending.remove(i);
      }
      _workers--;
      _pump();
    }
  }

  @override
  Future<String> run() async {
    try {
      // ZIP's central directory is at the tail, not in the first 5%. Cache the
      // maximum normal EOCD search window before enabling demand-based reading.
      final tailStart = max(0, book.fileSize - 65557) ~/ chunkSize;
      for (var i = tailStart; i < _count; i++) {
        await _ensure(i);
      }
      for (
        var i = 0;
        _received < (book.fileSize * .05).ceil() && i < _count;
        i++
      ) {
        await _ensure(i);
      }
      _check();
      _readable = true;
      onReadable();
      // One background request leaves two slots for chapters demanded by the
      // reader. Requests for the same chunk share one in-flight future.
      for (var i = 0; i < _count; i++) {
        await _ensure(i, foreground: false);
      }
      _check();
      await _withDisk(() => handle.flush());
      final digest = await sha256.bind(part.openRead()).first;
      _check();
      if (digest.toString() != book.sha256) {
        throw DownloadFailure(
          'The downloaded book failed its integrity check.',
          code: 'CHECKSUM_MISMATCH',
        );
      }
      await part.rename(target.path);
      _committed = true;
      return key;
    } catch (error) {
      _failure ??= error;
      _stopped = true;
      await _cleanupIfUnused();
      rethrow;
    }
  }

  Future<Uint8List> _read(int start, int end) async {
    _check();
    if (start < 0 || end < start || end > book.fileSize) {
      throw RangeError('Invalid range');
    }
    if (start == end) return Uint8List(0);
    for (var i = start ~/ chunkSize; i <= (end - 1) ~/ chunkSize; i++) {
      await _ensure(i);
    }
    return _withDisk(() async {
      _check();
      await handle.setPosition(start);
      final result = await handle.read(end - start);
      if (result.length != end - start) {
        throw DownloadFailure('The local book cache is incomplete.');
      }
      return result;
    });
  }

  Future<void> _serve(HttpRequest request) async {
    final response = request.response;
    var disconnected = false;
    unawaited(
      response.done.then<void>(
        (_) {
          disconnected = true;
        },
        onError: (Object _, StackTrace _) {
          disconnected = true;
        },
      ),
    );
    try {
      if (request.uri.path != uri.path || _stopped || _closed) {
        response.statusCode = HttpStatus.notFound;
        await response.close();
        return;
      }
      if (request.method != 'GET' && request.method != 'HEAD') {
        response.statusCode = HttpStatus.methodNotAllowed;
        response.headers.set(HttpHeaders.allowHeader, 'GET, HEAD');
        await response.close();
        return;
      }
      response.headers
        ..set(HttpHeaders.contentTypeHeader, 'application/epub+zip')
        ..set(HttpHeaders.acceptRangesHeader, 'bytes')
        ..set(HttpHeaders.etagHeader, '"${book.sha256}"')
        ..set(HttpHeaders.cacheControlHeader, 'no-store');
      var start = 0;
      var end = book.fileSize;
      final range = request.method == 'GET'
          ? request.headers.value(HttpHeaders.rangeHeader)
          : null;
      if (range != null) {
        final match = RegExp(r'^bytes=(\d*)-(\d*)$').firstMatch(range);
        if (match == null || (match[1]!.isEmpty && match[2]!.isEmpty)) {
          throw const FormatException('Invalid range');
        }
        if (match[1]!.isEmpty) {
          final suffix = int.parse(match[2]!);
          if (suffix <= 0) throw const FormatException('Invalid suffix');
          start = max(0, book.fileSize - suffix);
        } else {
          start = int.parse(match[1]!);
          end = match[2]!.isEmpty
              ? book.fileSize
              : min(book.fileSize, int.parse(match[2]!) + 1);
        }
        if (start >= book.fileSize || start >= end) {
          throw const FormatException('Unsatisfiable range');
        }
        response.statusCode = HttpStatus.partialContent;
        response.headers.set(
          HttpHeaders.contentRangeHeader,
          'bytes $start-${end - 1}/${book.fileSize}',
        );
      }
      response.contentLength = end - start;
      if (request.method != 'HEAD') {
        for (
          var offset = start;
          offset < end && !disconnected;
          offset += chunkSize
        ) {
          final bytes = await _read(offset, min(offset + chunkSize, end));
          if (disconnected) break;
          response.add(bytes);
          await response.flush();
        }
      }
      await response.close();
    } on FormatException {
      response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
      response.headers.set(
        HttpHeaders.contentRangeHeader,
        'bytes */${book.fileSize}',
      );
      response.contentLength = 0;
      await response.close();
    } catch (_) {
      // A reader may cancel open-ended streams after obtaining the ZIP entry.
      // Closing that socket must not cancel the publication's background task.
      try {
        await response.close();
      } catch (_) {}
    }
  }

  @override
  Future<BookFile> open() async {
    if (!canRead) throw StateError('This book is not ready for early reading.');
    _leases++;
    return _SparseLease(this);
  }

  Future<void> _closeLease() async {
    _leases--;
    await _cleanupIfUnused();
  }

  @override
  Future<void> cancel() async {
    _stopped = true;
    final cancelled = DownloadCancelled();
    for (final request in _pending.values.toSet()) {
      request.fail(cancelled);
      for (var i = request.index; i <= request.lastIndex; i++) {
        _pending.remove(i);
      }
    }
    _foreground.clear();
    _background.clear();
  }

  @override
  Future<void> release() async {
    if (!_committed && !_stopped) await cancel();
    _released = true;
    await _cleanupIfUnused();
  }

  Future<void> _cleanupIfUnused() async {
    if (!_released || _leases != 0) return;
    if (_closing != null) return _closing;
    _closing = _cleanup();
    return _closing;
  }

  Future<void> _cleanup() async {
    _closed = true;
    await server.close(force: true);
    // In-flight HTTP ranges are bounded; they check _stopped before touching disk.
    await _withDisk(() => handle.close());
    if (!_committed && await part.exists()) await part.delete();
  }
}

class _SparseLease implements ProvisionalBookFile {
  _SparseLease(this.session);
  final _SparseDownload session;
  bool _closed = false;
  @override
  int get length => session.book.fileSize;
  @override
  String get path => session.uri.toString();
  @override
  Future<Uint8List> readRange(int start, int end) => session._read(start, end);
  @override
  Future<Uint8List> readAll() => throw UnsupportedError(
    'A streaming book cannot be loaded entirely into memory.',
  );
  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await session._closeLease();
  }
}
