import 'dart:async';
import 'dart:collection';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../api/api_client.dart';
import '../models/book.dart';
import '../storage/book_store.dart';

/// Reads a comic's CBZ straight from the API while its offline copy is still
/// transferring (or was never downloaded). Every request is pinned to the
/// edition with `If-Range: "<sha256>"` and must come back as a 206 with the
/// exact `Content-Range`; a 200 or a changed validator fails the read instead
/// of mixing editions. See docs/comics.md, "Downloads".
///
/// Bytes are fetched in aligned blocks. Neighbouring missing blocks of one
/// read share a request and concurrent reads of the same block share its
/// fetch, so one page costs one or a few requests. A small LRU keeps recent
/// blocks (the ZIP directory, pages around the current one).
class RemoteComicFile implements ProvisionalBookFile {
  RemoteComicFile({
    required this.book,
    required ApiClient client,
    this.blockSize = 256 * 1024,
    this.maxCachedBytes = 24 * 1024 * 1024,
    this.maxRequestBytes = 8 * 1024 * 1024,
    this.maxAttempts = 2,
  }) : _client = client,
       assert(maxRequestBytes >= blockSize);

  final Book book;
  final ApiClient _client;
  final int blockSize;
  final int maxCachedBytes;
  final int maxRequestBytes;
  final int maxAttempts;

  final LinkedHashMap<int, Uint8List> _cache = LinkedHashMap();
  final Map<int, Future<Uint8List>> _inFlight = {};
  final Completer<void> _closed = Completer<void>();
  int _cachedBytes = 0;
  int _requests = 0;

  /// Set when the server answered for another edition (or without ranges):
  /// every later read fails the same way rather than retrying forever.
  Object? _fatal;

  /// HTTP range requests sent so far; for tests and diagnostics.
  int get requestCount => _requests;

  @override
  int get length => book.fileSize;

  @override
  String? get path => null;

  @override
  Future<Uint8List> readRange(int start, int end) async {
    if (_closed.isCompleted) throw StateError('The comic was closed.');
    if (start < 0 || end < start || end > length) {
      throw RangeError('Invalid range $start-$end of $length');
    }
    if (start == end) return Uint8List(0);
    final first = start ~/ blockSize;
    final last = (end - 1) ~/ blockSize;
    final blocks = <int, Future<Uint8List>>{};
    int? runStart;
    void flush(int until) {
      if (runStart == null) return;
      for (var from = runStart!; from < until;) {
        final runFrom = from;
        final to = _min(until, from + maxRequestBytes ~/ blockSize);
        final fetch = _fetch(runFrom, to);
        for (var b = runFrom; b < to; b++) {
          final block = fetch.then((run) => _slice(run, runFrom, b));
          // Unawaited copies must not report the same failure twice.
          block.ignore();
          _inFlight[b] = block;
          blocks[b] = block;
        }
        fetch.whenComplete(() {
          for (var b = runFrom; b < to; b++) {
            if (identical(_inFlight[b], blocks[b])) _inFlight.remove(b);
          }
        }).ignore();
        from = to;
      }
      runStart = null;
    }

    for (var b = first; b <= last; b++) {
      final cached = _cache.remove(b);
      if (cached != null) {
        _cache[b] = cached;
        blocks[b] = Future.value(cached);
        flush(b);
      } else if (_inFlight[b] case final pending?) {
        blocks[b] = pending;
        flush(b);
      } else {
        runStart ??= b;
      }
    }
    flush(last + 1);

    final out = Uint8List(end - start);
    for (var b = first; b <= last; b++) {
      final bytes = await blocks[b]!;
      final blockStart = b * blockSize;
      final from = _max(start, blockStart);
      final to = _min(end, blockStart + bytes.length);
      out.setRange(from - start, to - start, bytes, from - blockStart);
    }
    return out;
  }

  Uint8List _slice(Uint8List run, int firstBlock, int block) {
    final offset = (block - firstBlock) * blockSize;
    return Uint8List.sublistView(
      run,
      offset,
      _min(run.length, offset + blockSize),
    );
  }

  /// Fetches blocks `[from, to)` as one range and caches each block.
  Future<Uint8List> _fetch(int from, int to) async {
    final fatal = _fatal;
    if (fatal != null) throw fatal;
    final start = from * blockSize;
    final end = _min(length, to * blockSize);
    for (var attempt = 1; ; attempt++) {
      if (_closed.isCompleted) throw StateError('The comic was closed.');
      final bytes = BytesBuilder(copy: false);
      try {
        _requests++;
        await _client.streamRange(
          book,
          start,
          end,
          chunkSize: _min(end - start, 256 * 1024),
          abortTrigger: _closed.future,
          onChunk: (chunk) async => bytes.add(chunk),
        );
      } on ApiException catch (error) {
        if (error.code == 'INVALID_RANGE') {
          _fatal ??= ApiException(
            'This comic changed on the server or cannot be read online. '
            'Download it again.',
            code: 'INVALID_RANGE',
            statusCode: error.statusCode,
          );
          throw _fatal!;
        }
        if (attempt >= maxAttempts ||
            !(error.isNetwork || error.code == 'TRUNCATED_RANGE')) {
          rethrow;
        }
        continue;
      } on http.RequestAbortedException {
        throw StateError('The comic was closed.');
      }
      final run = bytes.takeBytes();
      if (run.length != end - start) {
        throw ApiException(
          'The comic download was interrupted.',
          code: 'TRUNCATED_RANGE',
        );
      }
      for (var b = from; b < to; b++) {
        _remember(b, _slice(run, from, b));
      }
      return run;
    }
  }

  void _remember(int block, Uint8List bytes) {
    if (_closed.isCompleted || bytes.length > maxCachedBytes) return;
    final previous = _cache.remove(block);
    if (previous != null) _cachedBytes -= previous.length;
    _cache[block] = bytes;
    _cachedBytes += bytes.length;
    while (_cachedBytes > maxCachedBytes && _cache.isNotEmpty) {
      final oldest = _cache.keys.first;
      _cachedBytes -= _cache.remove(oldest)!.length;
    }
  }

  @override
  Future<Uint8List> readAll() => throw UnsupportedError(
    'A comic read over the network cannot be loaded entirely into memory.',
  );

  @override
  Future<void> close() async {
    if (_closed.isCompleted) return;
    _closed.complete();
    _cache.clear();
    _cachedBytes = 0;
  }
}

int _min(int a, int b) => a < b ? a : b;
int _max(int a, int b) => a > b ? a : b;
