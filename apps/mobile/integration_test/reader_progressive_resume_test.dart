// Serve prepare-reader-benchmark.py --padding-mib 32 output as progressive.epub.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/download/progressive_download.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/storage/book_store_io.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native resume near archive end precedes full download',
    (tester) async {
      final root = await Directory.systemTemp.createTemp('reader-progressive');
      final source = File('${root.path}/source.epub');
      const host = String.fromEnvironment(
        'BENCH_HOST',
        defaultValue: '127.0.0.1',
      );
      final setup = HttpClient();
      final response = await (await setup.getUrl(
        Uri.parse('http://$host:8923/progressive.epub'),
      )).close();
      expect(response.statusCode, 200);
      await response.pipe(source.openWrite());
      setup.close();
      final length = await source.length();
      final digest = (await sha256.bind(source.openRead()).first).toString();
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var serving = true;
      server.listen((request) async {
        final match = RegExp(
          r'^bytes=(\d+)-(\d+)$',
        ).firstMatch(request.headers.value('range') ?? '');
        if (match == null) {
          request.response.statusCode = 400;
          await request.response.close();
          return;
        }
        final start = int.parse(match[1]!);
        final end = int.parse(match[2]!) + 1;
        request.response.statusCode = 206;
        request.response.contentLength = end - start;
        request.response.headers.set(
          'content-range',
          'bytes $start-${end - 1}/$length',
        );
        request.response.headers.set('etag', '"$digest"');
        final file = await source.open();
        try {
          await file.setPosition(start);
          for (var offset = start; offset < end && serving; offset += 65536) {
            await Future<void>.delayed(const Duration(milliseconds: 200));
            request.response.add(await file.read(min(65536, end - offset)));
            await request.response.flush();
          }
          await request.response.close();
        } on IOException {
          // Expected when a fulfilled reader range is cancelled or during cleanup.
        } finally {
          await file.close();
        }
      });
      final api = ApiClient(baseUrl: 'http://127.0.0.1:${server.port}');
      final store = IoBookStore(Directory('${root.path}/cache'));
      var received = 0;
      final readable = Completer<void>();
      final download = (await ProgressiveDownload.create(
        store: store,
        book: Book.fromJson({
          'id': 'synthetic',
          'version': '1',
          'title': 'Synthetic',
          'downloadUrl': '/book.epub',
          'fileSize': length,
          'sha256': digest,
        }),
        storageId: 'synthetic',
        client: api,
        onProgress: (bytes, _) => received = bytes,
        onReadable: () {
          if (!readable.isCompleted) readable.complete();
        },
      ))!;
      final transfer = Stopwatch()..start();
      final completed = download.run();
      // Observe failures immediately, even while awaiting early readability.
      unawaited(
        completed.then<void>(
          (_) {},
          onError: (Object e, StackTrace st) {
            if (!readable.isCompleted) readable.completeError(e, st);
          },
        ),
      );
      ReadiumReaderController? controller;
      try {
        await readable.future.timeout(const Duration(seconds: 60));
        const engine = ReadiumReaderEngine();
        const href = 'OEBPS/Text/chapter-9.xhtml';
        final opening = Stopwatch()..start();
        debugPrint(
          'PROGRESSIVE_BENCH ${jsonEncode({'event': 'open', 'received': received, 'total': length, 'transferMs': transfer.elapsedMilliseconds})}',
        );
        controller =
            await engine.open(
                  file: await download.open(),
                  prefs: const ReaderPreferences(),
                  initialLocator: const ReadingLocator(
                    href: href,
                    progression: .8,
                  ),
                )
                as ReadiumReaderController;
        final current = controller;
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: Builder(
                builder: (context) => engine.buildView(context, current),
              ),
            ),
          ),
        );
        while ((!current.pageVisible.value ||
                current.locator.value?.raw?['locations']?['cssSelector'] ==
                    null ||
                ((current.locator.value?.progression ?? 0) - .8).abs() >
                    .025) &&
            opening.elapsed < const Duration(seconds: 60)) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(current.pageVisible.value, isTrue);
        expect(current.locator.value?.href, href);
        expect(current.locator.value?.progression, closeTo(.8, .025));
        expect(
          current.locator.value?.raw?['locations']?['cssSelector'],
          isNotNull,
        );
        expect(
          received,
          lessThan(length),
          reason:
              'The requested late chapter must render before the whole archive arrives',
        );
        debugPrint(
          'PROGRESSIVE_BENCH ${jsonEncode({'event': 'positioned', 'openMs': opening.elapsedMilliseconds, 'transferMs': transfer.elapsedMilliseconds, 'received': received, 'total': length, 'progression': current.locator.value?.progression})}',
        );
        for (var i = 0; i < 60; i++) {
          await tester.pump(const Duration(milliseconds: 50));
          expect(
            current.locator.value?.progression,
            closeTo(.8, .025),
            reason:
                'A late startup event must not replace the restored position',
          );
        }
        await tester.pumpWidget(const SizedBox.shrink());
        current.dispose();
        controller = null;
        final key = await completed.timeout(const Duration(minutes: 2));
        expect(
          (await sha256.bind(File('${store.root.path}/$key').openRead()).first)
              .toString(),
          digest,
        );
        debugPrint(
          'PROGRESSIVE_BENCH ${jsonEncode({'event': 'verified', 'transferMs': transfer.elapsedMilliseconds, 'total': length})}',
        );
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        controller?.dispose();
        await download.cancel();
        await download.release();
        serving = false;
        api.close();
        await server.close(force: true);
        // Native teardown is asynchronous. Keep temporary files in this test
        // app's sandbox until its isolated test device/app is removed.
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
