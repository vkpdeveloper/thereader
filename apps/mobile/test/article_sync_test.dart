import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/articles/article_store_web.dart';
import 'package:thereader/data/articles/page_fetcher.dart';
import 'package:thereader/data/models/article_summary.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/repositories/sync_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';

const origin = 'https://reader.ordinity.com';

String page(String title) => '''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>$title</title></head>
<body><nav><p>Home</p></nav><article>
<p>The kettle was the first thing to wake, long before the house and its radio.</p>
<p>By seven the light had found the table, the books, and the unfinished letter.</p>
<p>Later the rain came, and with it the slow work of the afternoon.</p>
</article></body></html>''';

/// The API's article rules (LWW, tombstones, a rev per accepted write, the
/// body store) behind a [MockClient].
class ArticleCloud {
  bool legacy = false;
  bool failPuts = false;
  int rev = 0;
  int puts = 0;
  int gets = 0;
  final Map<String, Map<String, dynamic>> rows = {};
  final Map<String, Uint8List> bodies = {};
  final List<Map<String, dynamic>> requests = [];

  ApiClient client(String url) => ApiClient(baseUrl: url, client: MockClient(handle));

  static bool newer(String at, String id, String? rowAt, String? rowId) =>
      rowAt == null ||
      DateTime.parse(at).isAfter(DateTime.parse(rowAt)) ||
      (DateTime.parse(at).isAtSameMomentAs(DateTime.parse(rowAt)) && id.compareTo(rowId ?? '') > 0);

  static http.Response error(int status, String code) =>
      http.Response(jsonEncode({'error': {'code': code, 'message': code}}), status);

  Future<http.Response> handle(http.Request request) async {
    final body = RegExp(r'^/v1/article-bodies/([a-f0-9]{64})$').firstMatch(request.url.path);
    if (body != null) {
      final sha = body.group(1)!;
      if (request.method == 'PUT') {
        if (failPuts) throw http.ClientException('Connection refused', request.url);
        puts++;
        expect(request.headers['content-type'], 'application/gzip');
        final plain = Uint8List.fromList(const GZipDecoder().decodeBytes(request.bodyBytes));
        if (sha256.convert(plain).toString() != sha) return error(422, 'CHECKSUM_MISMATCH');
        bodies[sha] = request.bodyBytes;
        return http.Response('{"created":true}', 201);
      }
      gets++;
      final stored = bodies[sha];
      if (stored == null) return error(404, 'NOT_FOUND');
      return http.Response.bytes(stored, 200, headers: {'content-type': 'application/gzip'});
    }
    final input = (jsonDecode(request.body) as Map).cast<String, dynamic>();
    requests.add(input);
    final changes = (input['changes'] as List).cast<Map>();
    if (legacy && (input.containsKey('articlesSince') || changes.any((c) => '${c['kind']}'.startsWith('article')))) {
      return error(400, 'INVALID_SYNC');
    }
    final ordered = [...changes]..sort((a, b) => (a['kind'] == 'articleProgress' ? 1 : 0) - (b['kind'] == 'articleProgress' ? 1 : 0));
    for (final c in ordered) {
      expect(c['bookId'], '_articles');
      final p = (c['payload'] as Map).cast<String, dynamic>();
      final id = p['articleId'] as String;
      final row = rows[id];
      final at = c['updatedAt'] as String;
      if (c['kind'] == 'article') {
        if (row != null && !newer(at, c['id'] as String, row['updatedAt'] as String, row['changeId'] as String)) continue;
        final deleted = p['deleted'] == true;
        final resurrect = !deleted && row?['deleted'] == true;
        rows[id] = {
          ...?(deleted ? row : p),
          'id': id,
          'updatedAt': at,
          'changeId': c['id'],
          'deleted': deleted,
          'position': resurrect ? null : row?['position'],
          'positionUpdatedAt': resurrect ? null : row?['positionUpdatedAt'],
          'positionChangeId': resurrect ? null : row?['positionChangeId'],
          'rev': ++rev,
        };
      } else if (c['kind'] == 'articleProgress') {
        if (row == null || row['deleted'] == true) continue;
        if (!newer(at, c['id'] as String, row['positionUpdatedAt'] as String?, row['positionChangeId'] as String?)) continue;
        row
          ..['position'] = p['position']
          ..['positionUpdatedAt'] = at
          ..['positionChangeId'] = c['id']
          ..['rev'] = ++rev;
      }
    }
    final response = <String, dynamic>{'serverTime': DateTime.now().toUtc().toIso8601String(), 'books': [], 'preferences': null};
    if (input.containsKey('articlesSince')) {
      final since = (input['articlesSince'] as num?)?.toInt() ?? 0;
      final changed = rows.values.where((r) => (r['rev'] as int) > since).toList()
        ..sort((a, b) => (a['rev'] as int).compareTo(b['rev'] as int));
      response['articles'] = {
        'items': [for (final r in changed) Map.of(r)..remove('rev')],
        'cursor': changed.isEmpty ? since : changed.last['rev'],
        'more': false,
      };
    }
    return http.Response(jsonEncode(response), 200);
  }
}

class Clock {
  DateTime now = DateTime.utc(2026, 10, 6, 10);
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

class Device {
  Device(this.store, this.files, this.articles, this.sync, this.fetches);
  final MemoryKeyValueStore store;
  final MemoryArticleStore files;
  final ArticleRepository articles;
  final SyncRepository sync;
  final List<Uri> fetches;

  static Future<Device> create(ArticleCloud cloud, Clock clock, {MemoryKeyValueStore? kv, MemoryArticleStore? files}) async {
    final store = kv ?? MemoryKeyValueStore();
    final documents = files ?? MemoryArticleStore();
    final fetches = <Uri>[];
    final library = LibraryRepository(store: store, bookStore: MemoryBookStore());
    final settings = SettingsRepository(store);
    await library.load();
    await settings.load();
    final articles = ArticleRepository(
      store: store,
      files: documents,
      now: clock.call,
      cloud: () => cloud.client(origin),
      fetcher: PageFetcher(
        relayBase: () => Uri.parse(origin),
        useRelay: false,
        client: MockClient((request) async {
          fetches.add(request.url);
          return http.Response(page('Story ${request.url.path}'), 200, headers: {'content-type': 'text/html; charset=utf-8'});
        }),
      ),
    );
    await articles.load();
    final sync = SyncRepository(store: store, library: library, settings: settings, articles: articles, clientFactory: cloud.client);
    await sync.load(startTimers: false);
    return Device(store, documents, articles, sync, fetches);
  }

  /// One cycle, plus the downloads it starts.
  Future<void> cycle() async {
    await sync.syncNow();
    await articles.prefetch(SyncRepository.articlePrefetchPerCycle);
    await sync.flush();
    await articles.flush();
  }

  Future<void> dispose() async {
    sync.dispose();
    await sync.flush();
    await articles.flush();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('ids match the web app for the same URLs', () {
    expect(ArticleRepository.urlKey('https://www.Example.com/a/b/?utm_source=x&id=2#top'), 'example.com/a/b?id=2');
    // Shared vectors: `articleSync.test.ts` checks the same ids.
    expect(ArticleRepository.idFor('https://www.Example.com/a/b/?utm_source=x&id=2#top'), 'a1059795a40b472d904b598e027d39a2');
    expect(ArticleRepository.idFor('http://example.com/a/b?id=2'), 'a1059795a40b472d904b598e027d39a2');
    expect(ArticleRepository.idFor('https://example.com/'), 'a379a6f6eeafb9a55e378c118034e275');
    expect(ArticleRepository.idFor('https://blog.example.org/2026/10/story?ref=home&fbclid=1'), 'a505279b9eb30ca7b81c2a1c4b5ce03b');
    expect(ArticleRepository.idFor('https://user@WWW.example.com:443/caf%C3%A9/'), 'e57c58164fa0fc9433461248091a8c90');
  });

  test('a save uploads once and the other device reads it without fetching the page', () async {
    final cloud = ArticleCloud();
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    final b = await Device.create(cloud, clock);

    final saved = await a.articles.add('https://example.com/story');
    expect(saved.id, ArticleRepository.idFor('https://example.com/story'));
    expect(saved.bodySha256, matches(RegExp(r'^[a-f0-9]{64}$')));
    expect(sha256.convert(utf8.encode(a.files.files[saved.id]!)).toString(), saved.bodySha256);
    await a.cycle();
    expect(cloud.puts, 1);
    final sent = (cloud.requests.single['changes'] as List).cast<Map>();
    expect(sent.single['kind'], 'article');
    expect((sent.single['payload'] as Map)['blockCount'], greaterThan(0));
    expect(a.sync.pendingCount, 0);
    await a.cycle();
    expect(a.sync.pendingCount, 0);
    expect(cloud.puts, 1);

    await b.cycle();
    final remote = b.articles.byId(saved.id)!;
    expect(remote.title, saved.title);
    expect(remote.stored, isTrue); // small documents prefetch during sync
    expect(cloud.gets, 1);
    expect(b.files.files[saved.id], a.files.files[saved.id]);
    expect((await b.articles.loadArticle(saved.id)).title, saved.title);
    expect(b.fetches, isEmpty);
    expect(b.sync.pendingCount, 0);
    await a.dispose();
    await b.dispose();
  });

  test('an article whose document is still uploading opens later; the queue survives restart', () async {
    final cloud = ArticleCloud()..failPuts = true;
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    final b = await Device.create(cloud, clock);
    final saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    expect(cloud.requests, hasLength(1));
    expect(a.sync.error, isNull);

    await b.cycle();
    expect(b.articles.byId(saved.id)!.stored, isFalse);
    await expectLater(
      b.articles.loadArticle(saved.id),
      throwsA(isA<ArticleFetchException>().having((e) => e.message, 'message', contains("hasn't finished uploading"))),
    );

    await a.dispose();
    cloud.failPuts = false;
    final restarted = await Device.create(cloud, clock, kv: a.store, files: a.files);
    await restarted.cycle();
    expect(cloud.puts, 1);
    expect((await b.articles.loadArticle(saved.id)).title, saved.title);
    expect(b.articles.byId(saved.id)!.stored, isTrue);
    await restarted.dispose();
    await b.dispose();
  });

  test('deletions propagate and saving again resurrects', () async {
    final cloud = ArticleCloud();
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    final b = await Device.create(cloud, clock);
    final saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    await b.cycle();

    clock.advance(const Duration(seconds: 1));
    await b.articles.remove(saved.id);
    await b.cycle();
    expect(cloud.rows[saved.id]!['deleted'], isTrue);
    await a.cycle();
    expect(a.articles.byId(saved.id), isNull);
    expect(a.files.files.containsKey(saved.id), isFalse);
    expect(a.sync.pendingCount, 0);
    await b.cycle();
    expect(b.sync.pendingCount, 0);

    clock.advance(const Duration(seconds: 1));
    final again = await a.articles.add('https://example.com/story');
    expect(again.id, saved.id);
    await a.cycle();
    expect(cloud.rows[saved.id]!['deleted'], isFalse);
    await b.cycle();
    expect(b.articles.byId(saved.id), isNotNull);
    await a.dispose();
    await b.dispose();
  });

  test('reading positions sync by time', () async {
    final cloud = ArticleCloud();
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    final b = await Device.create(cloud, clock);
    final saved = await a.articles.add('https://example.com/story');
    await a.cycle();
    await b.cycle();

    clock.advance(const Duration(seconds: 1));
    await a.articles.saveProgress(saved.id, const ArticleProgress(block: 2, offset: 0.5, percent: 0.7));
    await a.cycle();
    expect(cloud.rows[saved.id]!['position'], {'block': 2, 'offset': 0.5, 'percent': 0.7});
    await b.cycle();
    expect(b.articles.byId(saved.id)!.progress!.block, 2);
    expect(b.articles.byId(saved.id)!.progress!.percent, 0.7);
    expect(b.sync.pendingCount, 0);

    // An older position queued elsewhere does not move it back.
    clock.advance(const Duration(seconds: 2));
    await b.articles.saveProgress(saved.id, const ArticleProgress(block: 3, offset: 0, percent: 0.9));
    clock.advance(const Duration(seconds: -1));
    await a.articles.saveProgress(saved.id, const ArticleProgress(block: 1, offset: 0, percent: 0.3));
    await b.cycle();
    await a.cycle();
    expect(a.articles.byId(saved.id)!.progress!.percent, 0.9);
    await a.dispose();
    await b.dispose();
  });

  test('a server without article sync keeps everything else syncing', () async {
    final cloud = ArticleCloud()..legacy = true;
    final a = await Device.create(cloud, Clock());
    await a.articles.add('https://example.com/story');
    await a.cycle();
    // Rejected once with articles, then sent again without them.
    expect(cloud.requests, hasLength(2));
    expect(cloud.requests.last.containsKey('articlesSince'), isFalse);
    expect(a.sync.error, isNull);
    expect(a.sync.pendingCount, 1);
    await a.dispose();
  });

  test('articles saved before sync move to their shared id and record their hash', () async {
    final kv = MemoryKeyValueStore();
    final files = MemoryArticleStore();
    final cloud = ArticleCloud();
    final clock = Clock();
    final first = await Device.create(cloud, clock, kv: kv, files: files);
    final saved = await first.articles.add('https://example.com/old');
    await first.dispose();
    // Rewrite it the way the previous version stored it.
    const legacyId = 'deadbeef';
    final json = files.files.remove(saved.id)!;
    files.files[legacyId] = json;
    final legacy = saved.toJson()
      ..['id'] = legacyId
      ..remove('bodySha256')
      ..remove('bodySize')
      ..remove('blockCount')
      ..['progress'] = {'block': 1, 'offset': 0.0, 'percent': 0.4};
    kv.values['articles.v1'] = jsonEncode({
      'items': [legacy],
    });
    kv.values.remove('cloud_sync.v1');

    final reopened = await Device.create(cloud, clock, kv: kv, files: files);
    expect(reopened.articles.articles.map((s) => s.id), [saved.id]);
    // A screen opened with the old id this session still finds it.
    expect(reopened.articles.byId(legacyId)!.id, saved.id);
    final migrated = reopened.articles.byId(saved.id)!;
    expect(migrated.bodySha256, saved.bodySha256);
    expect(migrated.progress!.percent, 0.4);
    expect(files.files.containsKey(legacyId), isFalse);
    expect((await reopened.articles.loadArticle(saved.id)).title, saved.title);
    await reopened.dispose();
  });

  test('the wire payload clips long text and drops what the API would reject', () {
    final base = ArticleSummary(
      id: 'a' * 32,
      url: 'https://example.com/x',
      sourceUrl: 'https://example.com/x',
      title: 't' * 1200,
      readingMinutes: 0,
      addedAt: DateTime.utc(2026, 9, 1),
      excerpt: 'e' * 3000,
      favicon: 'data:image/png;base64,${'A' * 3000}',
      leadImage: 'javascript:x',
      bodySha256: 'b' * 64,
      bodySize: 100,
    );
    final payload = SyncRepository.articlePayload(base)!;
    expect((payload['title'] as String).length, 1000);
    expect((payload['excerpt'] as String).length, 2000);
    expect(payload['favicon'], isNull);
    expect(payload['leadImage'], isNull);
    expect(payload['readingMinutes'], 1);
    expect(payload['savedAt'], '2026-09-01T00:00:00.000Z');
  });
}
