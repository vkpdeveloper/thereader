// Manual benchmark against a local API. Skipped unless READER_BENCH_URL is set:
// READER_BENCH_URL=http://127.0.0.1:8787 READER_BENCH_BOOK=corpus-large \
//   flutter test test/download_benchmark_test.dart
// READER_BENCH_THROTTLE=rttMs,perConnectionMiBps,linkMiBps (e.g. 80,2.5,10)
// routes through a local proxy that models a real network, because loopback
// is limited only by CPU and hides any benefit of parallel connections.
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/download/downloader.dart';
import 'package:thereader/data/download/progressive_download.dart';
import 'package:thereader/data/storage/book_store_io.dart';

class _CountingClient extends http.BaseClient {
  final _inner = http.Client();
  int requests = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests++;
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}

/// Adds one RTT per request, caps each response's rate, and shares a link cap.
Future<HttpServer> _throttlingProxy(Uri upstream, String spec) async {
  final [rttMs, perConnection, link] = spec
      .split(',')
      .map(double.parse)
      .toList();
  final upstreamClient = HttpClient()..autoUncompress = false;
  final clock = Stopwatch()..start();
  var linkFree = 0.0;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    await Future<void>.delayed(Duration(milliseconds: rttMs.round()));
    final out = await upstreamClient.openUrl(
      request.method,
      upstream.replace(path: request.uri.path, query: request.uri.query),
    );
    request.headers.forEach((name, values) {
      if (name != 'host') out.headers.set(name, values);
    });
    final response = await out.close();
    request.response.statusCode = response.statusCode;
    response.headers.forEach((name, values) {
      if (name != 'transfer-encoding') {
        request.response.headers.set(name, values);
      }
    });
    var connectionFree = clock.elapsedMicroseconds / 1e6;
    try {
      await for (final chunk in response) {
        for (var offset = 0; offset < chunk.length; offset += 65536) {
          final slice = chunk.sublist(
            offset,
            min(offset + 65536, chunk.length),
          );
          final now = clock.elapsedMicroseconds / 1e6;
          final seconds = slice.length / 1048576;
          connectionFree = max(connectionFree, now) + seconds / perConnection;
          linkFree = max(linkFree, now) + seconds / link;
          final ready = max(connectionFree, linkFree) - now;
          if (ready > 0) {
            await Future<void>.delayed(
              Duration(microseconds: (ready * 1e6).round()),
            );
          }
          request.response.add(slice);
          await request.response.flush();
        }
      }
      await request.response.close();
    } catch (_) {
      // The client cancelled this response.
    }
  });
  return server;
}

void main() {
  final url = Platform.environment['READER_BENCH_URL'];
  final bookId = Platform.environment['READER_BENCH_BOOK'] ?? 'corpus-large';
  final throttle = Platform.environment['READER_BENCH_THROTTLE'];

  test(
    'single stream vs parallel download timings',
    () async {
      var base = url!;
      HttpServer? proxy;
      if (throttle != null) {
        proxy = await _throttlingProxy(Uri.parse(url), throttle);
        base = 'http://127.0.0.1:${proxy.port}';
        stdout.writeln('throttle rttMs,perConnMiBps,linkMiBps = $throttle');
      }
      final probe = ApiClient(baseUrl: base);
      final book = await probe.getBook(bookId);
      probe.close();
      stdout.writeln('book ${book.id}: ${book.fileSize} bytes');

      for (final mode in ['single', 'parallel']) {
        final root = await Directory.systemTemp.createTemp('reader-bench-');
        final store = IoBookStore(root);
        final counting = _CountingClient();
        final client = ApiClient(baseUrl: base, client: counting);
        final watch = Stopwatch()..start();
        Duration? readable;
        final String key;
        if (mode == 'single') {
          key = await Downloader(store: store).download(
            book: book,
            source: await client.openDownload(book),
            onProgress: (_, _) {},
            isCancelled: () => false,
          );
        } else {
          final session = (await ProgressiveDownload.create(
            store: store,
            book: book,
            storageId: book.id,
            client: client,
            onProgress: (_, _) {},
            onReadable: () => readable = watch.elapsed,
          ))!;
          key = await session.run();
          await session.release();
        }
        watch.stop();
        expect(await store.sizeOf(key), book.fileSize);
        final file = File('${root.path}/$key');
        final hashWatch = Stopwatch()..start();
        expect(
          (await sha256.bind(file.openRead()).first).toString(),
          book.sha256,
        );
        final seconds = watch.elapsedMilliseconds / 1000;
        stdout.writeln(
          '$mode: ${seconds.toStringAsFixed(2)} s, '
          '${(book.fileSize / 1048576 / seconds).toStringAsFixed(1)} MiB/s, '
          '${counting.requests} requests'
          '${readable == null ? '' : ', readable after ${readable!.inMilliseconds} ms'}'
          ' (a separate sha256 pass takes ${hashWatch.elapsedMilliseconds} ms)',
        );
        client.close();
        await root.delete(recursive: true);
      }
      await proxy?.close(force: true);
    },
    skip: url == null ? 'Set READER_BENCH_URL to run' : false,
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
