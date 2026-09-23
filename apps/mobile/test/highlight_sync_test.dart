import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/repositories/highlight_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/repositories/sync_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';

final book = Book.fromJson({
  'id': 'test-book',
  'sha256': 'a' * 64,
  'fileSize': 1,
  'title': 'Test',
  'downloadUrl': '/v1/books/test-book/download',
  'updatedAt': '2026-01-01T00:00:00Z',
});
const origin = 'https://reader.ordinity.com';
const locator = {
  'href': 'OEBPS/ch01.xhtml',
  'type': 'application/xhtml+xml',
  'title': 'Chapter 1',
  'locations': {'progression': 0.2, 'totalProgression': 0.05},
  'text': {'highlight': 'attention is all you need'},
};

/// Mirrors the API's highlight contract: LWW by (updatedAt, id), a rev per
/// accepted write, and pulls only when `highlightsSince` is present.
class HighlightCloud {
  /// Behaves like a Worker deployed before highlight sync.
  bool legacy = false;
  int pageSize = 500;
  int rev = 0;
  final Map<String, Map<String, dynamic>> rows = {};
  final List<Map<String, dynamic>> requests = [];

  ApiClient client(String url) =>
      ApiClient(baseUrl: url, client: MockClient(handle));

  Future<http.Response> handle(http.Request request) async {
    final input = (jsonDecode(request.body) as Map).cast<String, dynamic>();
    requests.add(input);
    final changes = (input['changes'] as List).cast<Map>();
    if (legacy &&
        (input.containsKey('highlightsSince') ||
            changes.any((c) => c['kind'] == 'highlight'))) {
      return http.Response(
        jsonEncode({
          'error': {'code': 'INVALID_SYNC', 'message': 'Sync request is invalid.'},
        }),
        400,
      );
    }
    for (final c in changes.where((c) => c['kind'] == 'highlight')) {
      final p = c['payload'] as Map;
      final id = p['highlightId'] as String;
      final old = rows[id];
      final stamp = c['updatedAt'] as String;
      if (old != null &&
          DateTime.parse(stamp).compareTo(DateTime.parse(old['updatedAt'])) <=
              0) {
        continue;
      }
      rows[id] = {
        'id': id,
        'bookId': c['bookId'],
        'sha256': c['sha256'],
        'locator': p['locator'],
        'text': p['text'],
        'color': p['color'],
        'note': p['note'],
        'createdAt': p['createdAt'],
        'updatedAt': stamp,
        'deleted': p['deleted'],
        'rev': ++rev,
      };
    }
    final body = <String, dynamic>{
      'serverTime': DateTime.now().toUtc().toIso8601String(),
      'books': [],
      'preferences': null,
    };
    if (input.containsKey('highlightsSince')) {
      final since = (input['highlightsSince'] as num?)?.toInt() ?? 0;
      final changed =
          rows.values.where((r) => (r['rev'] as int) > since).toList()
            ..sort((a, b) => (a['rev'] as int).compareTo(b['rev'] as int));
      final page = changed.take(pageSize).toList();
      body['highlights'] = {
        'items': [
          for (final r in page) Map.of(r)..remove('rev'),
        ],
        'cursor': page.isEmpty ? since : page.last['rev'],
        'more': changed.length > page.length,
      };
    }
    return http.Response(jsonEncode(body), 200);
  }
}

class Device {
  Device(this.store, this.highlights, this.sync);
  final MemoryKeyValueStore store;
  final HighlightRepository highlights;
  final SyncRepository sync;

  static Future<Device> create(
    HighlightCloud cloud, {
    MemoryKeyValueStore? persisted,
  }) async {
    final store = persisted ?? MemoryKeyValueStore();
    final library = LibraryRepository(
      store: store,
      bookStore: MemoryBookStore(),
    );
    final settings = SettingsRepository(store);
    final highlights = HighlightRepository(store);
    await library.load();
    await settings.load();
    await highlights.load();
    if (library.entries.isEmpty) {
      await library.importLocal(book: book, origin: origin, path: 'local.epub');
    }
    final sync = SyncRepository(
      store: store,
      library: library,
      settings: settings,
      highlights: highlights,
      clientFactory: cloud.client,
    );
    await sync.load(startTimers: false);
    return Device(store, highlights, sync);
  }

  Future<String> highlight({String color = 'yellow'}) async => (await highlights
          .create(
            bookId: book.id,
            sha256: book.sha256,
            origin: origin,
            locator: Map.of(locator),
            text: 'attention is all you need',
            color: color,
          ))
      .id;

  List<String> colors() => [
    for (final h in highlights.forEdition(origin, book.sha256)) h.color,
  ];

  Future<void> dispose() async {
    sync.dispose();
    await sync.flush();
    await highlights.flush();
  }
}

List<Map> highlightChanges(Map<String, dynamic> request) => [
  for (final c in (request['changes'] as List).cast<Map>())
    if (c['kind'] == 'highlight') c,
];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('highlights persist locally across restarts, tombstones included', () async {
    final store = MemoryKeyValueStore();
    final repo = HighlightRepository(store);
    await repo.load();
    final a = await repo.create(
      bookId: book.id,
      sha256: book.sha256,
      origin: origin,
      locator: Map.of(locator),
      text: 'one',
      color: 'green',
    );
    final b = await repo.create(
      bookId: book.id,
      sha256: book.sha256,
      origin: origin,
      locator: Map.of(locator),
      text: 'two',
      color: 'yellow',
    );
    await repo.recolor(a.id, 'purple');
    await repo.delete(b.id);
    await repo.flush();

    final reopened = HighlightRepository(store);
    await reopened.load();
    final live = reopened.forEdition(origin, book.sha256);
    expect(live.map((h) => (h.text, h.color)), [('one', 'purple')]);
    expect(reopened.byId(b.id)!.deleted, isTrue);
    expect(live.single.locator['href'], 'OEBPS/ch01.xhtml');
    expect(live.single.chapter, 'Chapter 1');
  });

  test('edits never send a request; they ride the next sync request', () async {
    final cloud = HighlightCloud();
    final device = await Device.create(cloud);
    await device.highlight();
    final id = await device.highlight(color: 'blue');
    await device.highlights.recolor(id, 'pink');
    await pumpEventQueue();
    expect(cloud.requests, isEmpty);
    expect(device.sync.pendingCount, greaterThanOrEqualTo(2));

    await device.sync.syncNow();
    expect(cloud.requests, hasLength(1));
    final sent = cloud.requests.single;
    expect(sent['highlightsSince'], 0);
    expect(highlightChanges(sent), hasLength(2));
    expect(cloud.rows[id]!['color'], 'pink');

    // Nothing new: the next cycle sends no highlight changes and pulls
    // from the advanced cursor.
    await device.sync.syncNow();
    expect(highlightChanges(cloud.requests.last), isEmpty);
    expect(cloud.requests.last['highlightsSince'], 2);
    await device.dispose();
  });

  test('create, recolour and delete propagate between devices', () async {
    final cloud = HighlightCloud();
    final a = await Device.create(cloud);
    final b = await Device.create(cloud);
    final id = await a.highlight(color: 'green');
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.colors(), ['green']);

    await b.highlights.recolor(id, 'purple');
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.colors(), ['purple']);

    await a.highlights.delete(id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.colors(), isEmpty);
    expect(b.highlights.byId(id)!.deleted, isTrue);

    // Pulled copies are not echoed back as new changes.
    await b.sync.syncNow();
    expect(highlightChanges(cloud.requests.last), isEmpty);
    await a.dispose();
    await b.dispose();
  });

  test('last write wins by updatedAt', () async {
    final cloud = HighlightCloud();
    final a = await Device.create(cloud);
    final b = await Device.create(cloud);
    final id = await a.highlight();
    await a.sync.syncNow();
    await b.sync.syncNow();

    await a.highlights.recolor(id, 'blue');
    await Future<void>.delayed(const Duration(milliseconds: 5));
    await b.highlights.recolor(id, 'pink');
    // The newer edit (b) reaches the server first; a's older one loses.
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.colors(), ['pink']);
    expect(cloud.rows[id]!['color'], 'pink');

    // An older remote copy never overwrites a newer local one.
    final local = a.highlights.byId(id)!;
    final applied = await a.highlights.applyRemote([
      local.copyWith(
        color: 'green',
        updatedAt: local.updatedAt.subtract(const Duration(seconds: 1)),
      ),
    ]);
    expect(applied, isFalse);
    expect(a.colors(), ['pink']);
    await a.dispose();
    await b.dispose();
  });

  test('pulls page through the cursor', () async {
    final cloud = HighlightCloud()..pageSize = 2;
    final a = await Device.create(cloud);
    for (var i = 0; i < 5; i++) {
      await a.highlight();
    }
    await a.sync.syncNow();
    final b = await Device.create(cloud);
    await b.sync.syncNow();
    expect(b.colors(), hasLength(2));
    await b.sync.syncNow();
    await b.sync.syncNow();
    expect(b.colors(), hasLength(5));
    expect(cloud.requests.last['highlightsSince'], 4);
    await a.dispose();
    await b.dispose();
  });

  test('a server without highlight sync keeps the rest syncing', () async {
    final cloud = HighlightCloud()..legacy = true;
    final store = MemoryKeyValueStore();
    var device = await Device.create(cloud, persisted: store);
    await device.highlight();
    await device.sync.syncNow();
    expect(device.sync.error, isNull);
    // Rejected once, then retried without highlight data.
    expect(cloud.requests, hasLength(2));
    expect(cloud.requests.last.containsKey('highlightsSince'), isFalse);
    expect(highlightChanges(cloud.requests.last), isEmpty);
    expect(device.sync.pendingCount, 1);

    // Later cycles skip highlights directly, even after a restart.
    await device.dispose();
    device = await Device.create(cloud, persisted: store);
    await device.sync.syncNow();
    expect(cloud.requests, hasLength(3));
    expect(cloud.requests.last.containsKey('highlightsSince'), isFalse);
    expect(device.sync.pendingCount, 1);
    await device.dispose();
  });
}
