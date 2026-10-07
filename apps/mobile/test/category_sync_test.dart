import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/models/category.dart';
import 'package:thereader/data/repositories/category_repository.dart';
import 'package:thereader/data/repositories/library_repository.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/repositories/sync_repository.dart';
import 'package:thereader/data/storage/book_store_web.dart';
import 'package:thereader/data/storage/key_value_store.dart';

const origin = 'https://reader.ordinity.com';
const book = CategoryItemRef.book('epub-ab12');
const article = CategoryItemRef.article('a1059795a40b472d904b598e027d39a2');

/// The API's category rules (docs/categories.md) behind a [MockClient]: LWW
/// by `(updatedAt, change id)`, final tombstones, one rev sequence shared by
/// both tables, pages of [pageSize] rows, and pulls only with
/// `categoriesSince`.
class CategoryCloud {
  bool legacy = false;
  int pageSize = 500;
  int rev = 0;
  final Map<String, Map<String, dynamic>> categories = {};
  final Map<String, Map<String, dynamic>> assignments = {};
  final List<Map<String, dynamic>> requests = [];

  ApiClient client(String url) =>
      ApiClient(baseUrl: url, client: MockClient(handle));

  static bool newer(String at, String id, Map<String, dynamic>? row) =>
      row == null ||
      DateTime.parse(at).isAfter(DateTime.parse(row['updatedAt'] as String)) ||
      (DateTime.parse(
            at,
          ).isAtSameMomentAs(DateTime.parse(row['updatedAt'] as String)) &&
          id.compareTo(row['changeId'] as String) > 0);

  List<Map<String, dynamic>> changesOf(int request) =>
      (requests[request]['changes'] as List).cast<Map<String, dynamic>>();

  Future<http.Response> handle(http.Request request) async {
    final input = (jsonDecode(request.body) as Map).cast<String, dynamic>();
    requests.add(input);
    final changes = (input['changes'] as List).cast<Map>();
    if (legacy &&
        (input.containsKey('categoriesSince') ||
            changes.any((c) => '${c['kind']}'.startsWith('category')))) {
      return http.Response(
        jsonEncode({
          'error': {
            'code': 'INVALID_SYNC',
            'message': 'Sync request is invalid.',
          },
        }),
        400,
      );
    }
    for (final c in changes) {
      final p = (c['payload'] as Map).cast<String, dynamic>();
      final at = c['updatedAt'] as String;
      final id = c['id'] as String;
      if (c['kind'] == 'category') {
        expect(c['bookId'], '_categories');
        expect(c['sha256'], '0' * 64);
        final key = p['categoryId'] as String;
        final row = categories[key];
        if (row?['deleted'] == true) continue; // tombstones are final
        final deleted = p['deleted'] == true;
        if (!deleted && !newer(at, id, row)) continue;
        categories[key] = {
          'id': key,
          'name': deleted ? (row?['name']) : p['name'],
          'color': deleted ? (row?['color']) : p['color'],
          'createdAt': deleted ? (row?['createdAt']) : p['createdAt'],
          'updatedAt': at,
          'changeId': id,
          'deleted': deleted,
          'rev': ++rev,
        };
      } else if (c['kind'] == 'categoryItem') {
        expect(c['bookId'], '_categories');
        final key = '${p['itemType']}:${p['itemId']}';
        if (!newer(at, id, assignments[key])) continue;
        assignments[key] = {
          'itemType': p['itemType'],
          'itemId': p['itemId'],
          'categoryId': p['categoryId'],
          'updatedAt': at,
          'changeId': id,
          'rev': ++rev,
        };
      }
    }
    final response = <String, dynamic>{
      'serverTime': DateTime.now().toUtc().toIso8601String(),
      'books': [],
    };
    if (input.containsKey('categoriesSince')) {
      final since = (input['categoriesSince'] as num?)?.toInt() ?? 0;
      final rows =
          [
            for (final r in categories.values) ('c', r),
            for (final r in assignments.values) ('a', r),
          ].where((e) => (e.$2['rev'] as int) > since).toList()..sort(
            (a, b) => (a.$2['rev'] as int).compareTo(b.$2['rev'] as int),
          );
      final page = rows.take(pageSize).toList();
      Map<String, dynamic> out(Map<String, dynamic> r) =>
          Map.of(r)..remove('changeId');
      response['categories'] = {
        'items': [
          for (final e in page)
            if (e.$1 == 'c') out(e.$2),
        ],
        'assignments': [
          for (final e in page)
            if (e.$1 == 'a') out(e.$2),
        ],
        'cursor': page.isEmpty ? since : page.last.$2['rev'],
        'more': rows.length > page.length,
      };
    }
    return http.Response(jsonEncode(response), 200);
  }
}

class Clock {
  DateTime now = DateTime.utc(2026, 10, 7, 10);
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

class Device {
  Device(this.store, this.categories, this.sync);
  final MemoryKeyValueStore store;
  final CategoryRepository categories;
  final SyncRepository sync;

  static Future<Device> create(
    CategoryCloud cloud,
    Clock clock, {
    MemoryKeyValueStore? kv,
  }) async {
    final store = kv ?? MemoryKeyValueStore();
    final library = LibraryRepository(
      store: store,
      bookStore: MemoryBookStore(),
    );
    final settings = SettingsRepository(store);
    await library.load();
    await settings.load();
    await settings.setApiBaseUrl(origin);
    final categories = CategoryRepository(store, now: clock.call);
    await categories.load();
    final sync = SyncRepository(
      store: store,
      library: library,
      settings: settings,
      categories: categories,
      clientFactory: cloud.client,
      now: clock.call,
    );
    await sync.load(startTimers: false);
    return Device(store, categories, sync);
  }

  Future<void> cycle() async {
    await sync.syncNow();
    await sync.flush();
    await categories.flush();
  }

  Future<void> dispose() async {
    sync.dispose();
    await sync.flush();
    await categories.flush();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'edits ride the next cycle with the spec payloads, then sync to another device',
    () async {
      final cloud = CategoryCloud();
      final clock = Clock();
      final a = await Device.create(cloud, clock);
      final b = await Device.create(cloud, clock);

      final c = await a.categories.create('Programming', CategoryColor.blue);
      await a.categories.assign(book, c.id);
      await a.categories.assign(
        const CategoryItemRef.article('deadbeef'),
        c.id,
      ); // pre-sync id: stays local
      expect(cloud.requests, isEmpty); // no request of their own
      expect(a.sync.pendingCount, 2);

      await a.cycle();
      expect(cloud.requests.single['categoriesSince'], 0);
      final sent = cloud.changesOf(0);
      final category = sent.singleWhere((s) => s['kind'] == 'category');
      expect(category['bookId'], '_categories');
      expect(category['sha256'], '0' * 64);
      expect(category['updatedAt'], c.updatedAt.toUtc().toIso8601String());
      expect(category['payload'], {
        'categoryId': c.id,
        'name': 'Programming',
        'color': 'blue',
        'createdAt': c.createdAt.toUtc().toIso8601String(),
        'deleted': false,
      });
      final item = sent.singleWhere((s) => s['kind'] == 'categoryItem');
      expect(item['bookId'], '_categories');
      expect(item['payload'], {
        'itemType': 'book',
        'itemId': 'epub-ab12',
        'categoryId': c.id,
      });
      expect(a.sync.pendingCount, 0);

      // Its own rows come back in the pull without being sent again.
      await a.cycle();
      expect(cloud.changesOf(1), isEmpty);
      expect(cloud.requests[1]['categoriesSince'], cloud.rev);
      expect(a.sync.pendingCount, 0);

      await b.cycle();
      expect(b.categories.categories.single.name, 'Programming');
      expect(b.categories.categoryOf(book)!.id, c.id);
      expect(cloud.changesOf(2), isEmpty); // pulled rows are not echoed
      expect(b.sync.pendingCount, 0);

      clock.advance(const Duration(minutes: 1));
      await b.categories.update(c.id, name: 'Code', color: CategoryColor.green);
      await b.cycle();
      await a.cycle();
      expect(a.categories.byId(c.id)!.name, 'Code');
      expect(a.categories.byId(c.id)!.color, CategoryColor.green);
      expect(a.sync.pendingCount, 0);
      await a.dispose();
      await b.dispose();
    },
  );

  test(
    'delete sends a tombstone and a null assignment for each item, and other devices follow',
    () async {
      final cloud = CategoryCloud();
      final clock = Clock();
      final a = await Device.create(cloud, clock);
      final b = await Device.create(cloud, clock);
      final gone = await a.categories.create('Gone', CategoryColor.blue);
      final keep = await a.categories.create('Keep', CategoryColor.red);
      await a.categories.assign(book, gone.id);
      await a.categories.assign(article, gone.id);
      await a.categories.assign(const CategoryItemRef.book('other'), keep.id);
      await a.cycle();
      await b.cycle();
      expect(b.categories.itemsIn(gone.id), [article, book]);

      clock.advance(const Duration(minutes: 1));
      await a.categories.delete(gone.id);
      await a.cycle();
      final sent = cloud.changesOf(cloud.requests.length - 1);
      expect(sent.where((s) => s['kind'] == 'category').single['payload'], {
        'categoryId': gone.id,
        'deleted': true,
      });
      expect(
        sent.where((s) => s['kind'] == 'categoryItem').map((s) => s['payload']),
        unorderedEquals([
          {'itemType': 'book', 'itemId': 'epub-ab12', 'categoryId': null},
          {'itemType': 'article', 'itemId': article.id, 'categoryId': null},
        ]),
      );
      expect(cloud.categories[gone.id]!['deleted'], isTrue);

      await b.cycle();
      expect(b.categories.byId(gone.id), isNull);
      expect(b.categories.categories.single.id, keep.id);
      expect(b.categories.categoryOf(book), isNull);
      expect(
        b.categories.categoryOf(const CategoryItemRef.book('other'))!.id,
        keep.id,
      );
      expect(b.sync.pendingCount, 0);

      // A stale edit of the deleted category cannot bring it back.
      clock.advance(const Duration(minutes: 1));
      await a.cycle();
      expect(a.categories.byId(gone.id), isNull);
      await a.dispose();
      await b.dispose();
    },
  );

  test(
    'a remote tombstone removes the category even with a newer local rename queued',
    () async {
      final cloud = CategoryCloud();
      final clock = Clock();
      final a = await Device.create(cloud, clock);
      final b = await Device.create(cloud, clock);
      final c = await a.categories.create('Shared', CategoryColor.blue);
      await a.cycle();
      await b.cycle();
      clock.advance(const Duration(minutes: 1));
      await b.categories.delete(c.id);
      await b.cycle();
      clock.advance(const Duration(minutes: 1));
      await a.categories.update(c.id, name: 'Renamed later');
      await a.cycle();
      expect(a.categories.byId(c.id), isNull);
      expect(cloud.categories[c.id]!['deleted'], isTrue);
      await a.cycle();
      expect(a.categories.byId(c.id), isNull);
      expect(a.sync.pendingCount, 0);
      await a.dispose();
      await b.dispose();
    },
  );

  test('pending local edits are not clobbered by older pulled rows', () async {
    final cloud = CategoryCloud();
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    final b = await Device.create(cloud, clock);
    final c = await a.categories.create('Programming', CategoryColor.blue);
    final d = await a.categories.create('Philosophy', CategoryColor.purple);
    await a.categories.assign(book, c.id);
    await a.cycle();
    await b.cycle();

    // B edits first (older), A edits later but has not synced yet.
    clock.advance(const Duration(minutes: 1));
    await b.categories.update(c.id, name: 'From B');
    await b.categories.assign(book, d.id);
    await b.cycle();
    clock.advance(const Duration(minutes: 1));
    await a.categories.update(c.id, name: 'From A');
    await a.categories.assign(book, null);
    await a.cycle();
    expect(a.categories.byId(c.id)!.name, 'From A');
    expect(a.categories.categoryOf(book), isNull);
    expect(cloud.categories[c.id]!['name'], 'From A');
    expect(cloud.assignments['book:epub-ab12']!['categoryId'], isNull);

    await b.cycle();
    expect(b.categories.byId(c.id)!.name, 'From A');
    expect(b.categories.categoryOf(book), isNull);
    await a.dispose();
    await b.dispose();
  });

  test('pulls page through the shared rev cursor and persist it', () async {
    final cloud = CategoryCloud();
    final clock = Clock();
    final a = await Device.create(cloud, clock);
    for (var i = 0; i < 3; i++) {
      clock.advance(const Duration(seconds: 1));
      final c = await a.categories.create('C$i', CategoryColor.values[i]);
      await a.categories.assign(CategoryItemRef.book('book-$i'), c.id);
    }
    await a.cycle();
    expect(cloud.rev, 6);

    cloud.pageSize = 4;
    final b = await Device.create(cloud, clock);
    await b.cycle();
    expect(cloud.requests.last['categoriesSince'], 0);
    expect(b.categories.categories, hasLength(2));
    await b.dispose();

    // The cursor survives a restart; the next pull continues from it.
    final restarted = await Device.create(cloud, clock, kv: b.store);
    await restarted.cycle();
    expect(cloud.requests.last['categoriesSince'], 4);
    expect(restarted.categories.categories.map((c) => c.name), [
      'C0',
      'C1',
      'C2',
    ]);
    for (var i = 0; i < 3; i++) {
      expect(
        restarted.categories.categoryOf(CategoryItemRef.book('book-$i'))!.name,
        'C$i',
      );
    }
    await restarted.cycle();
    expect(cloud.requests.last['categoriesSince'], 6);
    expect(cloud.changesOf(cloud.requests.length - 1), isEmpty);
    await a.dispose();
    await restarted.dispose();
  });

  test(
    'an older server: the batch is resent without categories, which retry six hours later',
    () async {
      final cloud = CategoryCloud()..legacy = true;
      final clock = Clock();
      final a = await Device.create(cloud, clock);
      final c = await a.categories.create('Programming', CategoryColor.blue);
      await a.categories.assign(book, c.id);
      await a.cycle();
      expect(cloud.requests, hasLength(2));
      expect(cloud.requests[0]['categoriesSince'], 0);
      expect(cloud.requests[1].containsKey('categoriesSince'), isFalse);
      expect(cloud.changesOf(1), isEmpty);
      expect(a.sync.error, isNull);
      expect(a.sync.pendingCount, 2); // kept for later

      clock.advance(const Duration(hours: 1));
      await a.cycle();
      expect(cloud.requests, hasLength(3));
      expect(cloud.requests[2].containsKey('categoriesSince'), isFalse);

      // The back-off survives a restart.
      await a.dispose();
      final restarted = await Device.create(cloud, clock, kv: a.store);
      await restarted.cycle();
      expect(cloud.requests.last.containsKey('categoriesSince'), isFalse);

      cloud.legacy = false;
      clock.advance(const Duration(hours: 6));
      await restarted.cycle();
      expect(cloud.requests.last['categoriesSince'], 0);
      expect(
        cloud.changesOf(cloud.requests.length - 1).map((s) => s['kind']),
        unorderedEquals(['category', 'categoryItem']),
      );
      expect(restarted.sync.pendingCount, 0);
      expect(cloud.categories[c.id]!['name'], 'Programming');
      await restarted.dispose();
    },
  );
}
