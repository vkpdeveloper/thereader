import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/covers/cover_cache.dart';
import 'package:thereader/data/covers/cover_disk.dart';
import 'package:thereader/data/covers/cover_disk_io.dart';
import 'package:thereader/data/covers/cover_validation.dart';

final png = Uint8List.fromList([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
void main() {
  test(
    'at most three bounded network responses are ingested concurrently',
    () async {
      final gate = Completer<void>();
      var active = 0, peak = 0;
      final cache = CoverCache(
        disk: MemoryCoverDisk(),
        clientFactory: () => MockClient((_) async {
          active++;
          if (active > peak) peak = active;
          await gate.future;
          active--;
          return http.Response.bytes(
            png,
            200,
            headers: {'content-type': 'image/png'},
          );
        }),
      );
      final all = Future.wait(
        List.generate(
          6,
          (i) => cache.load('$i', Uri.parse('https://example.test/$i')),
        ),
      );
      for (var i = 0; i < 100 && active < 3; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }
      expect(active, 3);
      gate.complete();
      await all;
      expect(peak, 3);
    },
  );

  test(
    'coalesces cover fetches and survives a fresh offline cache instance',
    () async {
      final temp = await Directory.systemTemp.createTemp('cover-cache-test');
      addTearDown(() => temp.delete(recursive: true));
      var requests = 0;
      final gate = Completer<void>();
      final disk = IoCoverDisk(temp);
      final cache = CoverCache(
        disk: disk,
        clientFactory: () => MockClient((_) async {
          requests++;
          await gate.future;
          return http.Response.bytes(
            png,
            200,
            headers: {'content-type': 'image/png'},
          );
        }),
      );
      final url = Uri.parse('https://example.test/cover');
      final a = cache.load('a', url), b = cache.load('a', url);
      gate.complete();
      expect(await a, png);
      expect(await b, png);
      expect(requests, 1);
      final offline = CoverCache(
        disk: IoCoverDisk(temp),
        clientFactory: () =>
            MockClient((_) async => throw StateError('offline')),
      );
      expect(await offline.load('a', url), png);
    },
  );
  test('corrupted disk bytes are discarded and fetched again', () async {
    final temp = await Directory.systemTemp.createTemp('cover-corrupt');
    addTearDown(() => temp.delete(recursive: true));
    var requests = 0;
    CoverCache cache() => CoverCache(
      disk: IoCoverDisk(temp),
      clientFactory: () => MockClient((_) async {
        requests++;
        return http.Response.bytes(
          png,
          200,
          headers: {'content-type': 'image/png'},
        );
      }),
    );
    final uri = Uri.parse('https://example.test/cover');
    await cache().load('a', uri);
    final file = (await temp.list().toList()).single as File;
    final damaged = await file.readAsBytes();
    damaged[damaged.length - 1] ^= 1;
    await file.writeAsBytes(damaged);
    expect(await cache().load('a', uri), png);
    expect(requests, 2);
  });

  test(
    'failure stays unavailable until retry TTL; no-cover is separate',
    () async {
      var now = DateTime.utc(2026);
      var requests = 0;
      final cache = CoverCache(
        disk: MemoryCoverDisk(),
        now: () => now,
        clientFactory: () => MockClient((_) async {
          requests++;
          return requests == 1
              ? http.Response('', 503)
              : http.Response.bytes(
                  png,
                  200,
                  headers: {'content-type': 'image/png'},
                );
        }),
      );
      final url = Uri.parse('https://example.test/cover');
      expect(await cache.load('none', null), isNull);
      await expectLater(cache.load('a', url), throwsA(isA<CoverUnavailable>()));
      await expectLater(cache.load('a', url), throwsA(isA<CoverUnavailable>()));
      expect(requests, 1);
      now = now.add(const Duration(seconds: 31));
      expect(await cache.load('a', url), png);
      expect(requests, 2);
    },
  );
  test('embedded cover remains readable during offline publication', () async {
    final cache = CoverCache(
      disk: MemoryCoverDisk(),
      clientFactory: () => MockClient((_) async => throw StateError('offline')),
    );
    await cache.storeEmbedded('a', png);
    expect(await cache.load('a', null), png);
    expect(await cache.load('a', Uri.parse('https://example.test/cover')), png);
  });
  test('oversized stream rejected and disk/memory bounds enforced', () async {
    final temp = await Directory.systemTemp.createTemp('cover-bounds');
    addTearDown(() => temp.delete(recursive: true));
    final disk = IoCoverDisk(temp, maxBytes: 84, maxEntryBytes: 15);
    await disk.write('a' * 64, png);
    await disk.write('b' * 64, png);
    await disk.write('c' * 64, png);
    final files = await temp.list().where((e) => e is File).toList();
    expect(files.length, 2);
    final cache = CoverCache(
      disk: disk,
      maxEntryBytes: 15,
      maxMemoryBytes: 15,
      clientFactory: () => MockClient(
        (_) async => http.Response.bytes(
          [...png, ...png],
          200,
          headers: {'content-type': 'image/png'},
        ),
      ),
    );
    await expectLater(
      cache.load('a', Uri.parse('https://example.test/cover')),
      throwsA(isA<CoverUnavailable>()),
    );
    await cache.storeEmbedded('b', png);
    await cache.storeEmbedded('c', png);
    expect(cache.memoryBytes, lessThanOrEqualTo(15));
  });
  test('SVG rejects entity-encoded external CSS in text and attributes', () {
    Uint8List svg(String body) => Uint8List.fromList(
      '<svg xmlns="http://www.w3.org/2000/svg">$body</svg>'.codeUnits,
    );
    for (final body in [
      '<style>&#64;import "https://example.test/external.css";</style>',
      '<style>&#64;font-face { font-family: remote; }</style>',
      '<style>rect { fill: &#117;rl(https://example.test/paint.svg); }</style>',
      '<rect style="fill: &#117;rl(https://example.test/paint.svg)"/>',
      '<rect fill="&#117;rl(https://example.test/paint.svg)"/>',
    ]) {
      expect(validCoverBytes(svg(body)), isFalse, reason: body);
    }
    expect(
      validCoverBytes(svg('<rect fill="&#117;rl(&#35;gradient)"/>')),
      isTrue,
    );
  });

  test(
    'SVG cannot fetch secondary network resources or execute active content',
    () {
      Uint8List svg(String body) => Uint8List.fromList(
        '<svg xmlns="http://www.w3.org/2000/svg">$body</svg>'.codeUnits,
      );
      expect(validCoverBytes(svg('<rect width="20" height="30"/>')), isTrue);
      expect(
        validCoverBytes(
          svg('<image href="data:image/png;base64,iVBORw0KGgo="/>'),
        ),
        isTrue,
      );
      expect(
        validCoverBytes(svg('<image href="https://example.test/image.png"/>')),
        isFalse,
      );
      expect(validCoverBytes(svg('<script>alert(1)</script>')), isFalse);
    },
  );
}
