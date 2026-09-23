import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/download/downloader.dart';
import 'package:thereader/data/download/progressive_download.dart';
import 'package:thereader/data/download/segment_plan.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/storage/book_store.dart';
import 'package:thereader/data/storage/book_store_io.dart';

const _chunkSize = 64 * 1024;

Uint8List _payload(int length) {
  final bytes = Uint8List(length);
  for (var index = 0; index < bytes.length; index++) {
    bytes[index] = (index * 31 + 17) % 251;
  }
  return bytes;
}

Book _bookFor(Uint8List bytes, {String? shaOverride}) => Book(
  id: 'progressive-book',
  version: '1',
  title: 'Progressive Book',
  author: 'The Reader',
  description: 'A progressive download fixture.',
  language: 'en',
  subjects: const ['Tests'],
  coverUrl: null,
  downloadUrl: '/v1/books/progressive-book/download',
  fileSize: bytes.length,
  sha256: shaOverride ?? sha256.convert(bytes).toString(),
  updatedAt: DateTime.utc(2026, 9, 22),
);

class _RangeCall {
  const _RangeCall(this.start, this.end, this.inFlight, {this.ranged = true});
  final int start;
  final int end;

  /// Requests open at the server when this one arrived, including itself.
  final int inFlight;

  /// False for the plain GET a session falls back to without byte ranges.
  final bool ranged;
}

class _RangeOrigin {
  _RangeOrigin(this.bytes, this.book)
    : mock = MockClient.streaming(
        (_, _) async => throw StateError('uninitialized'),
      ) {
    mock = MockClient.streaming(_respond);
  }

  final Uint8List bytes;
  final Book book;
  late MockClient mock;
  final calls = <_RangeCall>[];
  final gates = <int, Completer<void>>{};
  final _started = <int, Completer<void>>{};

  /// Ranges starting here drop their last byte this many times.
  final truncate = <int, int>{};

  /// Ranges starting here answer with these statuses first, one per request.
  final failures = <int, List<int>>{};
  final bodies = <int, Stream<List<int>>>{};
  bool fullBodyFallback = false;
  int inFlight = 0;
  int maxInFlight = 0;

  Future<void> waitUntilStarted(int start) =>
      _started.putIfAbsent(start, Completer<void>.new).future;

  Iterable<_RangeCall> callsFrom(int start) =>
      calls.where((call) => call.start == start);

  /// Keeps [inFlight] open until the client finishes or drops the body, and
  /// forwards cancellation (an `async*` wrapper would not while it waits).
  Stream<List<int>> _tracked(Stream<List<int>> body) {
    late StreamSubscription<List<int>> input;
    var open = true;
    void finish() {
      if (open) {
        open = false;
        inFlight--;
      }
    }

    final output = StreamController<List<int>>();
    output
      ..onListen = () {
        input = body.listen(
          output.add,
          onError: output.addError,
          onDone: () {
            finish();
            output.close();
          },
        );
      }
      ..onPause = (() => input.pause())
      ..onResume = (() => input.resume())
      ..onCancel = () {
        finish();
        return input.cancel();
      };
    return output.stream;
  }

  Future<http.StreamedResponse> _respond(
    http.BaseRequest request,
    http.ByteStream _,
  ) async {
    expect(request.method, 'GET');
    expect(request.url.path, book.downloadUrl);
    maxInFlight = max(maxInFlight, ++inFlight);
    final range = request.headers['range'];
    if (range == null) {
      calls.add(_RangeCall(0, bytes.length, inFlight, ranged: false));
      return http.StreamedResponse(
        _tracked(_slices(bytes)),
        HttpStatus.ok,
        contentLength: bytes.length,
        headers: {'etag': '"${book.sha256}"'},
      );
    }
    expect(request.headers['accept-encoding'], 'identity');
    expect(request.headers['if-range'], '"${book.sha256}"');
    final match = RegExp(r'^bytes=(\d+)-(\d+)$').firstMatch(range);
    if (match == null) throw StateError('Missing bounded Range header');
    final start = int.parse(match[1]!);
    final end = int.parse(match[2]!) + 1;
    calls.add(_RangeCall(start, end, inFlight));
    final started = _started.putIfAbsent(start, Completer<void>.new);
    if (!started.isCompleted) started.complete();
    final gate = gates[start];
    if (gate != null) await gate.future;

    final statuses = failures[start];
    if (statuses != null && statuses.isNotEmpty) {
      return http.StreamedResponse(
        _tracked(Stream.value(utf8.encode('{"error":"busy"}'))),
        statuses.removeAt(0),
      );
    }
    if (fullBodyFallback) {
      return http.StreamedResponse(
        _tracked(_slices(bytes)),
        HttpStatus.ok,
        contentLength: bytes.length,
        headers: {'etag': '"${book.sha256}"'},
      );
    }

    var body = Uint8List.sublistView(bytes, start, end);
    if ((truncate[start] ?? 0) > 0) {
      truncate[start] = truncate[start]! - 1;
      body = Uint8List.sublistView(body, 0, body.length - 1);
    }
    return http.StreamedResponse(
      // Custom bodies go through untouched so tests observe their exact
      // backpressure and cancellation; they are not counted in flight.
      bodies[start] ?? _tracked(_slices(body)),
      HttpStatus.partialContent,
      contentLength: end - start,
      headers: {
        'content-range': 'bytes $start-${end - 1}/${book.fileSize}',
        'content-type': 'application/epub+zip',
        'etag': '"${book.sha256}"',
      },
    );
  }

  /// Network-sized fragments that deliberately straddle chunk boundaries.
  static Stream<List<int>> _slices(Uint8List body) async* {
    const fragment = 40 * 1024 + 7;
    for (var offset = 0; offset < body.length; offset += fragment) {
      yield Uint8List.sublistView(
        body,
        offset,
        min(offset + fragment, body.length),
      );
    }
  }

  void releaseAll() {
    for (final gate in gates.values) {
      if (!gate.isCompleted) gate.complete();
    }
  }
}

class _LoopbackResponse {
  const _LoopbackResponse(this.status, this.headers, this.body);
  final int status;
  final Map<String, String> headers;
  final Uint8List body;
}

Future<_LoopbackResponse> _loopback(
  Uri uri, {
  String method = 'GET',
  String? range,
}) async {
  final socket = await Socket.connect(uri.host, uri.port);
  final request = StringBuffer()
    ..write('$method ${uri.path} HTTP/1.1\r\n')
    ..write('Host: ${uri.host}:${uri.port}\r\n')
    ..write('Connection: close\r\n');
  if (range != null) request.write('Range: $range\r\n');
  request.write('\r\n');
  socket.write(request.toString());
  await socket.flush();
  final responseBytes = await socket.fold<List<int>>(<int>[], (all, chunk) {
    all.addAll(chunk);
    return all;
  });
  await socket.close();

  const separator = [13, 10, 13, 10];
  var headerEnd = -1;
  for (
    var index = 0;
    index <= responseBytes.length - separator.length;
    index++
  ) {
    if (responseBytes[index] == separator[0] &&
        responseBytes[index + 1] == separator[1] &&
        responseBytes[index + 2] == separator[2] &&
        responseBytes[index + 3] == separator[3]) {
      headerEnd = index;
      break;
    }
  }
  if (headerEnd < 0) throw StateError('Loopback response had no HTTP headers');
  final lines = ascii.decode(responseBytes.sublist(0, headerEnd)).split('\r\n');
  final status = int.parse(lines.first.split(' ')[1]);
  final headers = <String, String>{};
  for (final line in lines.skip(1)) {
    final separator = line.indexOf(':');
    if (separator > 0) {
      headers[line.substring(0, separator).toLowerCase()] = line
          .substring(separator + 1)
          .trim();
    }
  }
  return _LoopbackResponse(
    status,
    headers,
    Uint8List.fromList(responseBytes.sublist(headerEnd + 4)),
  );
}

Future<List<File>> _files(Directory root) async {
  if (!await root.exists()) return const [];
  return root
      .list(recursive: true, followLinks: false)
      .where((entry) => entry is File)
      .cast<File>()
      .toList();
}

/// Four-chunk segments keep fixtures small while exercising real splitting.
const _policy = SegmentPolicy(
  minSegment: 4 * _chunkSize,
  maxSegment: 4 * _chunkSize,
  singleRequestLimit: 2 * _chunkSize,
  demandSplitDistance: _chunkSize,
  maxAttempts: 3,
  retryDelay: Duration(milliseconds: 1),
);

class _Fixture {
  _Fixture._(this.root, this.store, this.bytes, this.book, this.origin);

  static Future<_Fixture> create(
    int length, {
    String? shaOverride,
    String prefix = 'reader-progressive-',
  }) async {
    final root = await Directory.systemTemp.createTemp(prefix);
    final bytes = _payload(length);
    final book = _bookFor(bytes, shaOverride: shaOverride);
    final fixture = _Fixture._(
      root,
      IoBookStore(root),
      bytes,
      book,
      _RangeOrigin(bytes, book),
    );
    addTearDown(fixture.dispose);
    return fixture;
  }

  final Directory root;
  final IoBookStore store;
  final Uint8List bytes;
  final Book book;
  final _RangeOrigin origin;
  final progress = <int>[];
  final readable = Completer<void>();
  ProgressiveDownload? session;

  Future<ProgressiveDownload> start({
    SegmentPolicy policy = _policy,
    Duration timeout = const Duration(seconds: 5),
  }) async => session = (await ProgressiveDownload.create(
    store: store,
    book: book,
    storageId: book.id,
    client: ApiClient(
      baseUrl: 'https://reader.test',
      client: origin.mock,
      timeout: timeout,
    ),
    policy: policy,
    onProgress: (received, total) {
      expect(total, book.fileSize);
      progress.add(received);
    },
    onReadable: readable.complete,
  ))!;

  Future<Uint8List> committed(String key) async {
    final file = await store.open(key);
    try {
      return await file.readAll();
    } finally {
      await file.close();
    }
  }

  Future<void> dispose() async {
    origin.releaseAll();
    await session?.cancel();
    await session?.release();
    origin.mock.close();
    if (await root.exists()) await root.delete(recursive: true);
  }
}

Matcher _failsWith(String code) => throwsA(
  predicate(
    (error) =>
        (error is DownloadFailure && error.code == code) ||
        (error is ApiException && error.code == code),
    'fails with $code',
  ),
);

void main() {
  test(
    'an overlong streamed response never publishes its final chunk',
    () async {
      final bytes = _payload(2 * _chunkSize);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      final body = StreamController<List<int>>();
      origin.bodies[0] = body.stream;
      final firstWritten = Completer<void>();
      var chunks = 0;
      final operation =
          ApiClient(
            baseUrl: 'https://reader.test',
            client: origin.mock,
          ).streamRange(
            book,
            0,
            bytes.length,
            onChunk: (_) async {
              chunks++;
              if (chunks == 1) firstWritten.complete();
            },
          );
      final failure = expectLater(
        operation,
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'INVALID_RANGE',
          ),
        ),
      );
      body.add(Uint8List.sublistView(bytes, 0, _chunkSize));
      await firstWritten.future;
      body.add(Uint8List.sublistView(bytes, _chunkSize));
      await Future<void>.delayed(Duration.zero);
      expect(chunks, 1, reason: 'The last chunk waits for exact-length EOF');
      body.add([0]);
      await failure;
      expect(chunks, 1);
      await body.close();
      origin.mock.close();
    },
  );

  test(
    'range ingestion bounds chunk buffers and backpressures a slow disk sink',
    () async {
      final bytes = _payload(3 * _chunkSize);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      var produced = 0;
      Stream<List<int>> source() async* {
        produced++;
        yield Uint8List.sublistView(bytes, 0, 2 * _chunkSize);
        produced++;
        yield Uint8List.sublistView(bytes, 2 * _chunkSize);
      }

      origin.bodies[0] = source();
      final entered = Completer<void>();
      final diskGate = Completer<void>();
      final lengths = <int>[];
      final received = BytesBuilder(copy: false);
      final operation =
          ApiClient(
            baseUrl: 'https://reader.test',
            client: origin.mock,
          ).streamRange(
            book,
            0,
            bytes.length,
            onChunk: (chunk) async {
              lengths.add(chunk.length);
              received.add(chunk);
              if (lengths.length == 1) {
                entered.complete();
                await diskGate.future;
              }
            },
          );
      await entered.future;
      expect(lengths, [_chunkSize]);
      expect(
        produced,
        1,
        reason: 'Do not request another network event while disk is blocked',
      );
      diskGate.complete();
      await operation;
      expect(lengths, [_chunkSize, _chunkSize, _chunkSize]);
      expect(received.takeBytes(), bytes);
      origin.mock.close();
    },
  );

  group('SegmentPolicy', () {
    const policy = SegmentPolicy();

    List<(int, int)> sorted(List<(int, int)> plan) =>
        [...plan]..sort((a, b) => a.$1.compareTo(b.$1));

    void expectPartition(List<(int, int)> plan, int size) {
      var next = 0;
      for (final (start, end) in sorted(plan)) {
        expect(start, next);
        expect(end, greaterThan(start));
        next = end;
      }
      expect(next, size);
    }

    test('a 181 MiB book is 32 segments plus the ZIP tail', () {
      const size = 189916272;
      final plan = policy.plan(size);
      expect(plan, hasLength(33));
      expect(plan.first.$2, size, reason: 'the tail is fetched first');
      expect(plan.first.$1, greaterThan(size - 2 * SegmentPolicy.alignment));
      expectPartition(plan, size);
      for (final (start, end) in plan.skip(1)) {
        expect(start % SegmentPolicy.alignment, 0);
        expect(end - start, lessThanOrEqualTo(policy.maxSegment));
      }
    });

    test('request counts stay inside the free-plan budget', () {
      expect(policy.plan(1), [(0, 1)]);
      expect(policy.plan(policy.singleRequestLimit), hasLength(1));
      expect(policy.plan(policy.singleRequestLimit + 1), hasLength(2));
      expect(policy.plan(30021276), hasLength(9));
      expect(policy.plan(512 * 1024 * 1024), hasLength(33));
      expect(policy.plan(1024 * 1024 * 1024), hasLength(65));
      for (final size in [
        policy.singleRequestLimit + 1,
        5 * 1024 * 1024 + 3,
        30021276,
        189916272,
        600000001,
      ]) {
        expectPartition(policy.plan(size), size);
      }
      expect(() => policy.plan(0), throwsArgumentError);
    });
  });

  test('assembles every size exactly once with aggregated progress', () async {
    final sizes = [
      1,
      _chunkSize - 1,
      2 * _chunkSize,
      2 * _chunkSize + 1,
      5 * _chunkSize + 7,
      16 * _chunkSize,
      32 * _chunkSize + 123,
    ];
    for (final size in sizes) {
      final fixture = await _Fixture.create(size);
      final session = await fixture.start();
      final key = await session.run();
      final plan = _policy.plan(size);
      final origin = fixture.origin;
      expect(await fixture.committed(key), fixture.bytes, reason: '$size');
      expect(origin.calls, hasLength(plan.length), reason: '$size');
      expect(
        origin.calls.fold<int>(0, (sum, call) => sum + call.end - call.start),
        size,
        reason: 'every byte is requested once for $size',
      );
      expect(fixture.readable.isCompleted, isTrue);
      final progress = fixture.progress;
      for (var index = 1; index < progress.length; index++) {
        expect(progress[index], greaterThan(progress[index - 1]));
      }
      expect(progress.last, size);
      final files = await _files(fixture.root);
      expect(files.map((file) => file.path.endsWith('.part')), [false]);
    }
  });

  test('a zero-byte catalog entry is rejected before any request', () async {
    final root = await Directory.systemTemp.createTemp('reader-zero-');
    addTearDown(() => root.delete(recursive: true));
    final book = _bookFor(Uint8List(0));
    final origin = _RangeOrigin(Uint8List(0), book);
    await expectLater(
      ProgressiveDownload.create(
        store: IoBookStore(root),
        book: book,
        storageId: book.id,
        client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
        onProgress: (_, _) {},
        onReadable: () {},
      ),
      throwsA(isA<DownloadFailure>()),
    );
    expect(origin.calls, isEmpty);
    expect(await _files(root), isEmpty);
  });

  test(
    'probes range support with one request, then runs the pool in parallel',
    () async {
      final fixture = await _Fixture.create(64 * _chunkSize + 5);
      final session = await fixture.start(
        policy: const SegmentPolicy(
          minSegment: _chunkSize,
          maxSegment: _chunkSize,
          singleRequestLimit: _chunkSize,
          retryDelay: Duration(milliseconds: 1),
        ),
      );
      final key = await session.run();
      final origin = fixture.origin;
      expect(await fixture.committed(key), fixture.bytes);
      expect(origin.calls.first.start, 62 * _chunkSize);
      expect(origin.calls.first.inFlight, 1);
      expect(origin.calls[1].start, 0);
      expect(origin.maxInFlight, SegmentPolicy.defaultConnections);
    },
  );

  test(
    'retries failed and truncated segments from where they stopped',
    () async {
      final fixture = await _Fixture.create(16 * _chunkSize + 9);
      final origin = fixture.origin;
      origin.failures[4 * _chunkSize] = [503, 429];
      origin.truncate[8 * _chunkSize] = 1;
      final session = await fixture.start();
      final key = await session.run();
      expect(await fixture.committed(key), fixture.bytes);
      expect(origin.callsFrom(4 * _chunkSize), hasLength(3));
      // Three whole chunks were written before the body ended one byte
      // short, so the retry asks only for the last chunk.
      expect(origin.callsFrom(8 * _chunkSize), hasLength(1));
      expect(origin.callsFrom(11 * _chunkSize).single.end, 12 * _chunkSize);
      expect(fixture.progress.last, fixture.bytes.length);
    },
  );

  test('a segment that keeps failing fails the download cleanly', () async {
    final fixture = await _Fixture.create(16 * _chunkSize + 9);
    final origin = fixture.origin;
    origin.failures[8 * _chunkSize] = List.filled(10, 503, growable: true);
    final session = await fixture.start();
    await expectLater(
      session.run(),
      throwsA(
        isA<ApiException>().having((e) => e.statusCode, 'statusCode', 503),
      ),
    );
    expect(origin.callsFrom(8 * _chunkSize), hasLength(_policy.maxAttempts));
    expect(session.canRead, isFalse);
    await session.release();
    expect(await _files(fixture.root), isEmpty);
  });

  test('a non-retryable answer fails without retrying', () async {
    final fixture = await _Fixture.create(16 * _chunkSize + 9);
    final origin = fixture.origin;
    origin.failures[4 * _chunkSize] = [416];
    final session = await fixture.start();
    await expectLater(session.run(), _failsWith('INVALID_RANGE'));
    expect(origin.callsFrom(4 * _chunkSize), hasLength(1));
    await session.release();
    expect(await _files(fixture.root), isEmpty);
  });

  test(
    'checksum mismatch never replaces the partial file with a durable edition',
    () async {
      final fixture = await _Fixture.create(
        16 * _chunkSize + 19,
        shaOverride: 'f' * 64,
      );
      final session = await fixture.start();
      await expectLater(session.run(), _failsWith('CHECKSUM_MISMATCH'));
      await session.release();
      expect(await _files(fixture.root), isEmpty);
    },
  );

  test('falls back to one plain stream when ranges are ignored', () async {
    final fixture = await _Fixture.create(16 * _chunkSize + 3);
    fixture.origin.fullBodyFallback = true;
    final session = await fixture.start();
    final key = await session.run();
    expect(await fixture.committed(key), fixture.bytes);
    final calls = fixture.origin.calls;
    expect(calls.map((call) => call.ranged), [true, false]);
    expect(fixture.origin.maxInFlight, 1);
    expect(fixture.progress.last, fixture.bytes.length);
  });

  test(
    'cancel promptly aborts every worker and waiter and discards the file',
    () async {
      final fixture = await _Fixture.create(32 * _chunkSize + 123);
      final origin = fixture.origin;
      final listening = Completer<void>();
      final cancelled = Completer<void>();
      final body = StreamController<List<int>>(
        onListen: listening.complete,
        onCancel: cancelled.complete,
      );
      addTearDown(body.close);
      origin.bodies[4 * _chunkSize] = body.stream;
      final blocked = Completer<void>();
      origin.gates[8 * _chunkSize] = blocked;
      final session = await fixture.start();
      final runFailure = expectLater(
        session.run(),
        throwsA(isA<DownloadCancelled>()),
      );
      await fixture.readable.future;
      await listening.future;
      await origin.waitUntilStarted(8 * _chunkSize);
      final lease = await session.open();
      final readFailure = expectLater(
        lease.readRange(5 * _chunkSize, 5 * _chunkSize + 10),
        throwsA(isA<DownloadCancelled>()),
      );
      await session.cancel();
      await Future.wait([
        runFailure,
        readFailure,
        cancelled.future,
      ]).timeout(const Duration(seconds: 2));
      blocked.complete();
      await lease.close();
      await session.release();
      expect(session.canRead, isFalse);
      await expectLater(session.open(), throwsA(isA<StateError>()));
      expect(await _files(fixture.root), isEmpty);
    },
  );

  test(
    'reader demands jump the queue, split distant segments, and commit atomically',
    () async {
      final fixture = await _Fixture.create(32 * _chunkSize + 123);
      final origin = fixture.origin;
      final bytes = fixture.bytes;
      final book = fixture.book;
      // One background worker, stalled on the second segment [4, 8).
      final stalled = Completer<void>();
      origin.gates[4 * _chunkSize] = stalled;
      final session = await fixture.start(
        policy: const SegmentPolicy(
          connections: 1,
          minSegment: 4 * _chunkSize,
          maxSegment: 4 * _chunkSize,
          singleRequestLimit: 2 * _chunkSize,
          demandSplitDistance: _chunkSize,
          retryDelay: Duration(milliseconds: 1),
        ),
      );
      var completed = false;
      final run = session.run().then((key) {
        completed = true;
        return key;
      });

      await fixture.readable.future;
      await origin.waitUntilStarted(4 * _chunkSize);
      expect(session.canRead, isTrue);
      // The ZIP tail first, then the front of the book for the 5% threshold.
      expect(origin.calls.take(2).map((call) => call.start), [
        31 * _chunkSize,
        0,
      ]);
      final beforeCommit = await _files(fixture.root);
      expect(beforeCommit.map((file) => file.path.endsWith('.part')), [true]);

      final lease = await session.open();
      expect(lease.isProvisional, isTrue);

      // Far into a pending segment [20, 24): split it and fetch from chunk 21
      // on the reserved demand connection. Duplicate reads share the request.
      final demandStart = 21 * _chunkSize + 37;
      final demandEnd = demandStart + 4096;
      final duplicateReads = await Future.wait([
        lease.readRange(demandStart, demandEnd),
        lease.readRange(demandStart, demandEnd),
      ]).timeout(const Duration(seconds: 2));
      expect(
        duplicateReads[0],
        Uint8List.sublistView(bytes, demandStart, demandEnd),
      );
      expect(duplicateReads[1], duplicateReads[0]);
      final split = origin.callsFrom(21 * _chunkSize).single;
      expect(split.end, 24 * _chunkSize);
      expect(split.inFlight, 2);

      // Near the start of a pending segment [16, 20): promote it whole.
      expect(
        await lease.readRange(16 * _chunkSize + 10, 16 * _chunkSize + 20),
        Uint8List.sublistView(
          bytes,
          16 * _chunkSize + 10,
          16 * _chunkSize + 20,
        ),
      );
      expect(origin.callsFrom(16 * _chunkSize).single.end, 20 * _chunkSize);

      // Far ahead of the stalled worker inside its own segment: split it too.
      final ahead = lease.readRange(7 * _chunkSize + 5, 7 * _chunkSize + 50);
      expect(
        await ahead.timeout(const Duration(seconds: 2)),
        Uint8List.sublistView(bytes, 7 * _chunkSize + 5, 7 * _chunkSize + 50),
      );
      expect(origin.callsFrom(7 * _chunkSize).single.end, 8 * _chunkSize);
      expect(completed, isFalse);

      final publication = Uri.parse(lease.path!);
      final head = await _loopback(publication, method: 'HEAD');
      expect(head.status, HttpStatus.ok);
      expect(head.headers['content-length'], '${book.fileSize}');
      expect(head.headers['accept-ranges'], 'bytes');
      expect(head.body, isEmpty);

      final suffix = await _loopback(publication, range: 'bytes=-17');
      expect(suffix.status, HttpStatus.partialContent);
      expect(
        suffix.headers['content-range'],
        'bytes ${book.fileSize - 17}-${book.fileSize - 1}/${book.fileSize}',
      );
      expect(suffix.body, Uint8List.sublistView(bytes, bytes.length - 17));

      final httpStart = 22 * _chunkSize + 11;
      final httpEnd = httpStart + 2048;
      final bounded = await _loopback(
        publication,
        range: 'bytes=$httpStart-${httpEnd - 1}',
      );
      expect(bounded.status, HttpStatus.partialContent);
      expect(bounded.body, Uint8List.sublistView(bytes, httpStart, httpEnd));
      await expectLater(lease.readRange(-1, 1), throwsA(isA<RangeError>()));

      stalled.complete();
      final key = await run;
      expect(await fixture.committed(key), bytes);
      // Received bytes are counted once each: nothing was written twice.
      expect(fixture.progress.last, book.fileSize);
      // Nine planned requests plus one per split.
      expect(origin.calls, hasLength(_policy.plan(book.fileSize).length + 2));
      expect(origin.maxInFlight, 2);
      expect(
        (await _files(fixture.root)).any((f) => f.path.endsWith('.part')),
        isFalse,
      );

      // Releasing repository ownership must not invalidate an active reader
      // lease, even though the .part file has been atomically renamed.
      await session.release();
      expect(
        await lease.readRange(demandStart, demandEnd),
        Uint8List.sublistView(bytes, demandStart, demandEnd),
      );
      final afterRename = await _loopback(publication, range: 'bytes=-17');
      expect(afterRename.body, Uint8List.sublistView(bytes, bytes.length - 17));
      await lease.close();
      await expectLater(
        Socket.connect(publication.host, publication.port),
        throwsA(isA<SocketException>()),
      );
    },
  );
}
