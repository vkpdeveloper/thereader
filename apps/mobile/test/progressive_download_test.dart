import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/download/downloader.dart';
import 'package:thereader/data/download/progressive_download.dart';
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
  const _RangeCall(this.start, this.end);
  final int start;
  final int end;
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
  final truncate = <int>{};
  final bodies = <int, Stream<List<int>>>{};
  bool fullBodyFallback = false;

  Future<void> waitUntilStarted(int start) =>
      _started.putIfAbsent(start, Completer<void>.new).future;

  Future<http.StreamedResponse> _respond(
    http.BaseRequest request,
    http.ByteStream _,
  ) async {
    expect(request.method, 'GET');
    expect(request.url.path, book.downloadUrl);
    expect(request.headers['accept-encoding'], 'identity');
    expect(request.headers['if-range'], '"${book.sha256}"');
    final match = RegExp(
      r'^bytes=(\d+)-(\d+)$',
    ).firstMatch(request.headers['range'] ?? '');
    if (match == null) throw StateError('Missing bounded Range header');
    final start = int.parse(match[1]!);
    final end = int.parse(match[2]!) + 1;
    calls.add(_RangeCall(start, end));
    final started = _started.putIfAbsent(start, Completer<void>.new);
    if (!started.isCompleted) started.complete();
    final gate = gates[start];
    if (gate != null) await gate.future;

    if (fullBodyFallback) {
      return http.StreamedResponse(
        Stream<List<int>>.value(bytes),
        HttpStatus.ok,
        contentLength: bytes.length,
        headers: {'etag': '"${book.sha256}"'},
      );
    }

    var body = Uint8List.sublistView(bytes, start, end);
    if (truncate.contains(start)) {
      body = Uint8List.sublistView(body, 0, body.length - 1);
    }
    return http.StreamedResponse(
      bodies[start] ?? Stream<List<int>>.value(body),
      HttpStatus.partialContent,
      contentLength: end - start,
      headers: {
        'content-range': 'bytes $start-${end - 1}/${book.fileSize}',
        'content-type': 'application/epub+zip',
        'etag': '"${book.sha256}"',
      },
    );
  }

  int callsForChunk(int index) =>
      calls.where((call) => call.start == index * _chunkSize).length;

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
    'a demanded chunk streams to disk before its 1 MiB background group finishes',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'reader-streamed-group-',
      );
      final bytes = _payload(32 * _chunkSize + 123);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      final listening = Completer<void>();
      final body = StreamController<List<int>>(
        onListen: () => listening.complete(),
      );
      origin.bodies[_chunkSize] = body.stream;
      final readable = Completer<void>();
      final progress = <int>[];
      final session = (await ProgressiveDownload.create(
        store: IoBookStore(root),
        book: book,
        storageId: book.id,
        client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
        onProgress: (received, _) => progress.add(received),
        onReadable: () => readable.complete(),
      ))!;
      BookFile? lease;
      var completed = false;
      final run = session.run().then((key) {
        completed = true;
        return key;
      });
      addTearDown(() async {
        await session.cancel();
        await lease?.close();
        await session.release();
        await body.close();
        origin.mock.close();
        if (await root.exists()) await root.delete(recursive: true);
      });
      await readable.future;
      await listening.future;
      lease = await session.open();
      final before = progress.last;
      final demand = lease.readRange(_chunkSize + 19, _chunkSize + 200);
      // Network fragments need not coincide with disk chunk boundaries.
      body.add(Uint8List.sublistView(bytes, _chunkSize, _chunkSize + 17));
      body.add(Uint8List.sublistView(bytes, _chunkSize + 17, 2 * _chunkSize));
      expect(
        await demand.timeout(const Duration(seconds: 2)),
        Uint8List.sublistView(bytes, _chunkSize + 19, _chunkSize + 200),
      );
      expect(progress.last, before + _chunkSize);
      expect(completed, isFalse);
      expect(body.isClosed, isFalse);
      expect(origin.callsForChunk(1), 1);
      expect(origin.callsForChunk(2), 0);
      final nextDemand = lease.readRange(2 * _chunkSize, 2 * _chunkSize + 80);
      body.add(Uint8List.sublistView(bytes, 2 * _chunkSize, 3 * _chunkSize));
      expect(
        await nextDemand.timeout(const Duration(seconds: 2)),
        Uint8List.sublistView(bytes, 2 * _chunkSize, 2 * _chunkSize + 80),
      );
      expect(progress.last, before + 2 * _chunkSize);
      // A separate demand still has a reserved slot while the group is stalled.
      expect(
        await lease.readRange(20 * _chunkSize, 20 * _chunkSize + 10),
        Uint8List.sublistView(bytes, 20 * _chunkSize, 20 * _chunkSize + 10),
      );
      body.add(Uint8List.sublistView(bytes, 3 * _chunkSize, 17 * _chunkSize));
      await body.close();
      final key = await run;
      expect(await IoBookStore(root).exists(key), isTrue);
      expect(progress.last, bytes.length);
      expect(origin.callsForChunk(1), 1);
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

  test(
    'cancel promptly aborts a stalled streamed group and all chunk waiters',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'reader-streamed-cancel-',
      );
      final bytes = _payload(32 * _chunkSize + 123);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      final listening = Completer<void>();
      final cancelled = Completer<void>();
      final body = StreamController<List<int>>(
        onListen: () => listening.complete(),
        onCancel: () => cancelled.complete(),
      );
      origin.bodies[_chunkSize] = body.stream;
      final readable = Completer<void>();
      final session = (await ProgressiveDownload.create(
        store: IoBookStore(root),
        book: book,
        storageId: book.id,
        client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
        onProgress: (_, _) {},
        onReadable: () => readable.complete(),
      ))!;
      final runFailure = expectLater(
        session.run(),
        throwsA(isA<DownloadCancelled>()),
      );
      await readable.future;
      await listening.future;
      final lease = await session.open();
      final readFailure = expectLater(
        lease.readRange(2 * _chunkSize, 3 * _chunkSize),
        throwsA(isA<DownloadCancelled>()),
      );
      await session.cancel();
      await Future.wait([
        runFailure,
        readFailure,
        cancelled.future,
      ]).timeout(const Duration(seconds: 2));
      await session.cancel();
      await lease.close();
      await session.release();
      expect(await _files(root), isEmpty);
      await body.close();
      origin.mock.close();
      await root.delete(recursive: true);
    },
  );

  test(
    'prioritizes ZIP tail, becomes readable at 5%, deduplicates demand reads, and commits atomically',
    () async {
      final root = await Directory.systemTemp.createTemp('reader-progressive-');
      final store = IoBookStore(root);
      final bytes = _payload(32 * _chunkSize + 123);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      final blockedBackground = Completer<void>();
      origin.gates[_chunkSize] = blockedBackground;
      final readable = Completer<void>();
      final progress = <int>[];
      final session = await ProgressiveDownload.create(
        store: store,
        book: book,
        storageId: book.id,
        client: ApiClient(
          baseUrl: 'https://reader.test',
          client: origin.mock,
          timeout: const Duration(seconds: 5),
        ),
        onProgress: (received, _) => progress.add(received),
        onReadable: () => readable.complete(),
      );
      expect(session, isNotNull);
      final download = session!;
      BookFile? lease;
      var runCompleted = false;
      final run = download.run().then((key) {
        runCompleted = true;
        return key;
      });
      addTearDown(() async {
        origin.releaseAll();
        await lease?.close();
        await download.cancel();
        await download.release();
        origin.mock.close();
        if (await root.exists()) await root.delete(recursive: true);
      });

      await readable.future;
      await origin.waitUntilStarted(_chunkSize);
      expect(download.canRead, isTrue);
      expect(runCompleted, isFalse);
      expect(progress.last, greaterThanOrEqualTo((book.fileSize * .05).ceil()));
      expect(progress.last, lessThan(book.fileSize));
      expect(origin.calls.take(3).map((call) => call.start), [
        31 * _chunkSize,
        32 * _chunkSize,
        0,
      ]);
      final beforeCommit = await _files(root);
      expect(beforeCommit.any((file) => file.path.endsWith('.part')), isTrue);
      expect(
        beforeCommit.any(
          (file) =>
              file.path.endsWith('.epub') && !file.path.endsWith('.epub.part'),
        ),
        isFalse,
      );

      lease = await download.open();
      expect(lease.isProvisional, isTrue);
      // The blocked background request covers chunks 1-16. A demand outside
      // that span must use one of the two reserved foreground worker slots.
      final demandStart = 20 * _chunkSize + 37;
      final demandEnd = demandStart + 4096;
      final duplicateReads = await Future.wait([
        lease.readRange(demandStart, demandEnd),
        lease.readRange(demandStart, demandEnd),
      ]);
      expect(
        duplicateReads[0],
        Uint8List.sublistView(bytes, demandStart, demandEnd),
      );
      expect(duplicateReads[1], duplicateReads[0]);
      expect(origin.callsForChunk(20), 1);

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
      expect(origin.callsForChunk(22), 1);
      await expectLater(lease.readRange(-1, 1), throwsA(isA<RangeError>()));

      blockedBackground.complete();
      final key = await run;
      expect(runCompleted, isTrue);
      expect(progress.last, book.fileSize);
      expect(await store.exists(key), isTrue);
      expect(await store.sizeOf(key), book.fileSize);
      final committed = await store.open(key);
      final committedBytes = await committed.readAll();
      await committed.close();
      expect(committedBytes, bytes);
      expect(sha256.convert(committedBytes).toString(), book.sha256);
      expect(
        (await _files(root)).any((file) => file.path.endsWith('.part')),
        isFalse,
      );
      final backgroundGroup = origin.calls.singleWhere(
        (call) => call.start == _chunkSize,
      );
      expect(backgroundGroup.end, 17 * _chunkSize);
      for (var index = 0; index < 33; index++) {
        final start = index * _chunkSize;
        final end = (start + _chunkSize).clamp(0, book.fileSize);
        expect(
          origin.calls.where((call) => call.start <= start && call.end >= end),
          hasLength(1),
          reason: 'chunk $index should be fetched exactly once',
        );
      }
      expect(origin.calls.length, lessThan(10));

      // Releasing repository ownership must not invalidate an active reader
      // lease, even though the .part file has been atomically renamed.
      await download.release();
      expect(
        await lease.readRange(demandStart, demandEnd),
        Uint8List.sublistView(bytes, demandStart, demandEnd),
      );
      final afterRename = await _loopback(publication, range: 'bytes=-17');
      expect(afterRename.body, Uint8List.sublistView(bytes, bytes.length - 17));
      await lease.close();
      lease = null;
      await expectLater(
        Socket.connect(publication.host, publication.port),
        throwsA(isA<SocketException>()),
      );
    },
  );

  test('cancellation stops readiness and discards the partial file', () async {
    final root = await Directory.systemTemp.createTemp(
      'reader-progressive-cancel-',
    );
    final store = IoBookStore(root);
    final bytes = _payload(16 * _chunkSize + 23);
    final book = _bookFor(bytes);
    final origin = _RangeOrigin(bytes, book);
    final tailStart = (book.fileSize - 65557) ~/ _chunkSize * _chunkSize;
    final blocked = Completer<void>();
    origin.gates[tailStart] = blocked;
    var readable = false;
    final session = (await ProgressiveDownload.create(
      store: store,
      book: book,
      storageId: book.id,
      client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
      onProgress: (_, _) {},
      onReadable: () => readable = true,
    ))!;
    addTearDown(() async {
      origin.releaseAll();
      await session.cancel();
      await session.release();
      origin.mock.close();
      if (await root.exists()) await root.delete(recursive: true);
    });

    final expectation = expectLater(
      session.run(),
      throwsA(isA<DownloadCancelled>()),
    );
    await origin.waitUntilStarted(tailStart);
    await session.cancel();
    blocked.complete();
    await expectation;
    await session.release();

    expect(readable, isFalse);
    expect(session.canRead, isFalse);
    await expectLater(session.open(), throwsA(isA<StateError>()));
    expect(await _files(root), isEmpty);
  });

  test(
    'checksum mismatch never replaces the partial file with a durable edition',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'reader-progressive-hash-',
      );
      final store = IoBookStore(root);
      final bytes = _payload(4 * _chunkSize + 19);
      final book = _bookFor(bytes, shaOverride: 'f' * 64);
      final origin = _RangeOrigin(bytes, book);
      final session = (await ProgressiveDownload.create(
        store: store,
        book: book,
        storageId: book.id,
        client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
        onProgress: (_, _) {},
        onReadable: () {},
      ))!;
      addTearDown(() async {
        await session.release();
        origin.mock.close();
        if (await root.exists()) await root.delete(recursive: true);
      });

      await expectLater(
        session.run(),
        throwsA(
          isA<DownloadFailure>().having(
            (failure) => failure.code,
            'code',
            'CHECKSUM_MISMATCH',
          ),
        ),
      );
      await session.release();
      expect(await _files(root), isEmpty);
    },
  );

  test(
    'truncated range fails the progressive download and is discarded',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'reader-progressive-short-',
      );
      final store = IoBookStore(root);
      final bytes = _payload(4 * _chunkSize + 19);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book);
      final tailStart = (book.fileSize - 65557) ~/ _chunkSize * _chunkSize;
      origin.truncate.add(tailStart);
      final session = (await ProgressiveDownload.create(
        store: store,
        book: book,
        storageId: book.id,
        client: ApiClient(baseUrl: 'https://reader.test', client: origin.mock),
        onProgress: (_, _) {},
        onReadable: () {},
      ))!;
      addTearDown(() async {
        await session.release();
        origin.mock.close();
        if (await root.exists()) await root.delete(recursive: true);
      });

      await expectLater(
        session.run(),
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'TRUNCATED_RANGE',
          ),
        ),
      );
      await session.release();
      expect(await _files(root), isEmpty);
    },
  );

  test(
    'invalid range fallback fails the session and discards its partial file',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'reader-progressive-invalid-',
      );
      final store = IoBookStore(root);
      final bytes = _payload(2 * _chunkSize);
      final book = _bookFor(bytes);
      final origin = _RangeOrigin(bytes, book)..fullBodyFallback = true;
      final client = ApiClient(
        baseUrl: 'https://reader.test',
        client: origin.mock,
      );
      final session = (await ProgressiveDownload.create(
        store: store,
        book: book,
        storageId: book.id,
        client: client,
        onProgress: (_, _) {},
        onReadable: () {},
      ))!;
      addTearDown(() async {
        await session.release();
        origin.mock.close();
        if (await root.exists()) await root.delete(recursive: true);
      });

      await expectLater(
        client.readRange(book, 1, 1),
        throwsA(isA<RangeError>()),
      );
      expect(origin.calls, isEmpty);
      await expectLater(
        client.readRange(book, 0, _chunkSize),
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'INVALID_RANGE',
          ),
        ),
      );
      await expectLater(
        session.run(),
        throwsA(
          isA<ApiException>().having(
            (error) => error.code,
            'code',
            'INVALID_RANGE',
          ),
        ),
      );
      await session.release();
      expect(await _files(root), isEmpty);
    },
  );
}
