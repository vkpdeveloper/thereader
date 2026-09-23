import 'dart:async';
import 'dart:collection';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;

import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';
import '../storage/book_store_io.dart';
import 'downloader.dart';
import 'progressive_download.dart';
import 'segment_plan.dart';

Future<ProgressiveDownload?> createProgressiveDownload({
  required BookStore store,
  required Book book,
  required String storageId,
  required ApiClient client,
  required ProgressCallback onProgress,
  required void Function() onReadable,
  SegmentPolicy policy = const SegmentPolicy(),
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
    policy,
    part,
    target,
    handle,
    server,
    p.relative(target.path, from: store.root.path),
    onProgress,
    onReadable,
  );
}

/// One contiguous byte range of the edition. Pieces partition the file and
/// are kept sorted by [start]; bytes `[start, next)` are on disk.
class _Piece {
  _Piece(this.start, this.end) : next = start;
  final int start;

  /// Shrinks when a reader demand splits the piece while it is streaming.
  int end;
  int next;
  bool active = false;
  bool urgent = false;
  Completer<void>? _abort;

  bool get done => next >= end;

  Future<void> attempt() => (_abort = Completer<void>()).future;

  void stop() {
    final abort = _abort;
    if (abort != null && !abort.isCompleted) abort.complete();
  }
}

class _SparseDownload implements ProgressiveDownload {
  _SparseDownload(
    this.book,
    this.client,
    this.policy,
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

  static const chunkSize = SegmentPolicy.alignment;
  final Book book;
  final ApiClient client;
  final SegmentPolicy policy;
  final File part;
  final File target;
  final RandomAccessFile handle;
  final HttpServer server;
  final String key;
  final ProgressCallback onProgress;
  final void Function() onReadable;
  late final Uri uri;
  final List<_Piece> _pieces = [];
  final Queue<_Piece> _queue = Queue();
  final Queue<_Piece> _urgent = Queue();
  final Completer<void> _halted = Completer<void>();
  Completer<void> _changed = Completer<void>();
  Future<void> _disk = Future.value();
  int _workers = 0;
  int _received = 0;
  int _leases = 0;
  // Until one 206 response arrives, a server that ignores Range would answer
  // every worker with the whole file, so only one request may be in flight.
  bool _rangesConfirmed = false;
  bool _sequential = false;
  bool _released = false;
  bool _committed = false;
  bool _stopped = false;
  bool _closed = false;
  bool _readable = false;
  Future<void>? _closing;
  Object? _failure;

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

  /// Wakes every waiter so it can re-check the bytes it needs.
  void _notify() {
    final changed = _changed;
    _changed = Completer<void>();
    changed.complete();
  }

  void _halt() {
    if (!_halted.isCompleted) _halted.complete();
    _queue.clear();
    _urgent.clear();
    for (final piece in _pieces) {
      piece.stop();
    }
    _notify();
  }

  void _fail(Object error) {
    _failure ??= error;
    _halt();
  }

  int? _firstMissing(int start, int end) {
    for (final piece in _pieces) {
      if (piece.end <= start) continue;
      if (piece.start >= end) break;
      final missing = max(start, piece.next);
      if (missing < min(end, piece.end)) return missing;
    }
    return null;
  }

  Future<void> _waitFor(int start, int end, {bool demand = false}) async {
    while (true) {
      _check();
      final missing = _firstMissing(start, end);
      if (missing == null) return;
      if (demand) _prioritize(missing);
      await _changed.future;
    }
  }

  /// Moves the bytes at [offset] ahead of background segments. A demand far
  /// from where its piece is (or would be) streaming splits the piece at a
  /// chunk boundary, so the reader waits for one round trip instead of for a
  /// multi-megabyte segment. Each split costs at most one extra request.
  void _prioritize(int offset) {
    if (_sequential || !_rangesConfirmed) return;
    final piece = _pieces.firstWhere(
      (piece) => piece.start <= offset && offset < piece.end,
    );
    if (piece.done) return;
    final from = piece.active ? piece.next : piece.start;
    if (offset < from + policy.demandSplitDistance) {
      if (!piece.active && !piece.urgent) {
        piece.urgent = true;
        _urgent.add(piece);
        _pump();
      }
      return;
    }
    final at = offset ~/ chunkSize * chunkSize;
    final rest = _Piece(at, piece.end)..urgent = true;
    // An active worker stops at its new end once it writes the preceding
    // chunk; chunk writes never straddle [at] because both are aligned.
    piece.end = at;
    _pieces.insert(_pieces.indexOf(piece) + 1, rest);
    _urgent.add(rest);
    _pump();
  }

  void _pump() {
    while (!_stopped && _failure == null) {
      final limit = !_rangesConfirmed
          ? 1
          : policy.connections +
                (_urgent.isEmpty ? 0 : policy.demandConnections);
      if (_workers >= limit) return;
      final queue = _urgent.isNotEmpty ? _urgent : _queue;
      if (queue.isEmpty) return;
      final piece = queue.removeFirst();
      // A piece promoted to the urgent queue stays in the background queue.
      if (piece.active || piece.done) continue;
      piece.active = true;
      _workers++;
      unawaited(_fetch(piece));
    }
  }

  Future<void> _write(_Piece piece, Uint8List bytes) async {
    _check();
    final offset = piece.next;
    if (offset + bytes.length > piece.end) {
      throw DownloadFailure(
        'Received more data than the catalog size (${book.fileSize} bytes).',
        code: 'SIZE_MISMATCH',
      );
    }
    await _withDisk(() async {
      _check();
      await handle.setPosition(offset);
      await handle.writeFrom(bytes);
    });
    _check();
    piece.next = offset + bytes.length;
    _received += bytes.length;
    onProgress(_received, book.fileSize);
    _notify();
    if (!_rangesConfirmed) {
      _rangesConfirmed = true;
      _pump();
    }
  }

  Future<void> _fetch(_Piece piece) async {
    var attempt = 0;
    try {
      while (!piece.done) {
        _check();
        final requestedEnd = piece.end;
        try {
          await client.streamRange(
            book,
            piece.next,
            requestedEnd,
            chunkSize: chunkSize,
            abortTrigger: piece.attempt(),
            onChunk: (bytes) async {
              await _write(piece, bytes);
              // Split by a reader demand: the rest is another piece's work.
              if (piece.done && piece.end < requestedEnd) piece.stop();
            },
          );
        } catch (error) {
          if (piece.done) break;
          _check();
          if (!_rangesConfirmed && _ignoresRanges(error)) {
            await _streamWhole();
            return;
          }
          if (++attempt >= policy.maxAttempts || !_retryable(error)) rethrow;
          final wake = Completer<void>();
          final timer = Timer(policy.retryDelay * (1 << (attempt - 1)), () {
            if (!wake.isCompleted) wake.complete();
          });
          await Future.any([wake.future, _halted.future]);
          timer.cancel();
        }
      }
    } catch (error) {
      _fail(error);
    } finally {
      piece.active = false;
      _workers--;
      _pump();
    }
  }

  static bool _ignoresRanges(Object error) =>
      error is ApiException &&
      error.code == 'INVALID_RANGE' &&
      error.statusCode == HttpStatus.ok;

  static bool _retryable(Object error) => switch (error) {
    http.RequestAbortedException() => false,
    ApiException(isNetwork: true) => true,
    ApiException(code: 'TRUNCATED_RANGE') => true,
    ApiException(statusCode: 408 || 429 || 502 || 503 || 504) => true,
    http.ClientException() || SocketException() || HttpException() => true,
    TimeoutException() => true,
    _ => false,
  };

  /// Fallback for servers without byte ranges: one sequential response into
  /// the same sparse file. Reader demands simply wait for it.
  Future<void> _streamWhole() async {
    _sequential = true;
    _queue.clear();
    _urgent.clear();
    final whole = _Piece(0, book.fileSize)..active = true;
    _pieces
      ..clear()
      ..add(whole);
    final source = await client.openDownload(book);
    final length = source.contentLength;
    if (length != null && length > 0 && length != book.fileSize) {
      throw DownloadFailure(
        'The server reported $length bytes but the catalog says ${book.fileSize}.',
        code: 'SIZE_MISMATCH',
      );
    }
    final input = StreamIterator(source.stream);
    try {
      while (await Future.any([
        input.moveNext(),
        _halted.future.then((_) => false),
      ])) {
        final chunk = input.current;
        await _write(
          whole,
          chunk is Uint8List ? chunk : Uint8List.fromList(chunk),
        );
      }
      _check();
      if (!whole.done) {
        throw DownloadFailure(
          'Download ended early: ${whole.next} of ${book.fileSize} bytes.',
          code: 'SIZE_MISMATCH',
        );
      }
    } finally {
      whole.active = false;
      await input.cancel();
    }
  }

  @override
  Future<String> run() async {
    try {
      for (final (start, end) in policy.plan(book.fileSize)) {
        final piece = _Piece(start, end);
        _pieces.add(piece);
        _queue.add(piece);
      }
      _pieces.sort((a, b) => a.start.compareTo(b.start));
      _pump();
      final hashing = _hashPrefix()..ignore();
      // ZIP's central directory is at the tail, which the plan fetches first.
      // Keep the 5% readiness threshold so the opening chapters are local.
      await _waitFor(
        max(0, book.fileSize - SegmentPolicy.zipTailWindow),
        book.fileSize,
      );
      await _waitFor(0, (book.fileSize * .05).ceil());
      _readable = true;
      onReadable();
      await _waitFor(0, book.fileSize);
      final digest = await hashing;
      _check();
      await _withDisk(() => handle.flush());
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
      _halt();
      await _cleanupIfUnused();
      rethrow;
    }
  }

  /// Hashes the contiguous downloaded prefix while later segments are still
  /// arriving. Every byte is written exactly once, so this is the same
  /// full-file SHA-256 as a pass after the download, minus the wait.
  Future<Digest> _hashPrefix() async {
    final result = _DigestSink();
    final hasher = sha256.startChunkedConversion(result);
    final reader = await part.open();
    try {
      var hashed = 0;
      while (hashed < book.fileSize) {
        _check();
        final available = _firstMissing(hashed, book.fileSize) ?? book.fileSize;
        if (available == hashed) {
          await _changed.future;
          continue;
        }
        final end = min(available, hashed + 8 * chunkSize);
        await reader.setPosition(hashed);
        final bytes = await reader.read(end - hashed);
        if (bytes.length != end - hashed) {
          throw DownloadFailure('The local book cache is incomplete.');
        }
        hasher.add(bytes);
        hashed = end;
      }
      hasher.close();
      return result.digest!;
    } finally {
      await reader.close();
    }
  }

  Future<Uint8List> _read(int start, int end) async {
    _check();
    if (start < 0 || end < start || end > book.fileSize) {
      throw RangeError('Invalid range');
    }
    if (start == end) return Uint8List(0);
    await _waitFor(start, end, demand: true);
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
    _halt();
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

class _DigestSink implements Sink<Digest> {
  Digest? digest;
  @override
  void add(Digest data) => digest = data;
  @override
  void close() {}
}
