import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:thereader/data/api/api_client.dart';
import 'package:thereader/data/models/book.dart';
import 'package:thereader/data/models/library.dart';
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

class Cloud {
  final Map<String, dynamic> row = {
    'bookId': book.id,
    'sha256': book.sha256,
    'inLibrary': true,
    'addedAt': '2026-01-01T00:00:00.000Z',
    'libraryUpdatedAt': '2026-01-01T00:00:00.000Z',
    'progress': null,
    'progressUpdatedAt': null,
    'lastOpenedAt': null,
    'readingMilliseconds': 0,
  };
  final Map<String, int> sessions = {};
  Map<String, dynamic>? preferences;
  bool offline = false;
  bool loseResponse = false;
  Future<void> Function()? duringRequest;
  final List<List<dynamic>> batches = [];
  ApiClient client(String url) =>
      ApiClient(baseUrl: url, client: MockClient(handle));
  Future<http.Response> handle(http.Request request) async {
    if (offline) throw http.ClientException('Offline');
    if (request.url.path.startsWith('/v1/books/')) {
      return http.Response(jsonEncode({'book': book.toJson()}), 200);
    }
    final input = jsonDecode(request.body) as Map;
    final changes = input['changes'] as List;
    batches.add(changes);
    for (final c in changes) {
      final stamp = c['updatedAt'] as String;
      final payload = c['payload'] as Map;
      switch (c['kind']) {
        case 'progress':
          if (row['progressUpdatedAt'] == null ||
              stamp.compareTo(row['progressUpdatedAt'] as String) > 0) {
            row['progress'] = payload;
            row['progressUpdatedAt'] = stamp;
            row['lastOpenedAt'] = stamp;
          }
        case 'session':
          final id = '${input['deviceId']}:${c['id']}';
          sessions[id] = max(
            sessions[id] ?? 0,
            payload['readingMilliseconds'] as int,
          );
          row['readingMilliseconds'] = sessions.values.fold(0, (a, b) => a + b);
        case 'preferences':
          if (preferences == null ||
              stamp.compareTo(preferences!['updatedAt'] as String) > 0) {
            preferences = {'value': payload['value'], 'updatedAt': stamp};
          }
      }
    }
    final encoded = jsonEncode({
      'serverTime': DateTime.now().toUtc().toIso8601String(),
      'books': [row],
      'preferences': preferences,
    });
    await duringRequest?.call();
    if (loseResponse) {
      loseResponse = false;
      throw http.ClientException('Connection lost after commit');
    }
    return http.Response(encoded, 200);
  }
}

class Device {
  Device(this.store, this.library, this.settings, this.sync);
  final MemoryKeyValueStore store;
  final LibraryRepository library;
  final SettingsRepository settings;
  final SyncRepository sync;
  LibraryEntry get entry => library.entries.single;
  static Future<Device> create(
    Cloud cloud, {
    MemoryKeyValueStore? persisted,
    bool local = true,
    bool Function(String)? pending,
  }) async {
    final store = persisted ?? MemoryKeyValueStore();
    final library = LibraryRepository(
      store: store,
      bookStore: MemoryBookStore(),
    );
    final settings = SettingsRepository(store);
    await library.load();
    await settings.load();
    if (local && library.entries.isEmpty) {
      await library.importLocal(book: book, origin: origin, path: 'local.epub');
    }
    final sync = SyncRepository(
      store: store,
      library: library,
      settings: settings,
      clientFactory: cloud.client,
      isUploadPending: pending,
    );
    await sync.load(startTimers: false);
    return Device(store, library, settings, sync);
  }

  Future<void> dispose() async {
    sync.dispose();
    await sync.flush();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'normalized server locator does not requeue acknowledged progress',
    () async {
      final cloud = Cloud();
      final a = await Device.create(cloud);
      addTearDown(a.dispose);
      await a.library.saveProgress(
        a.entry.id,
        const ReadingLocator(
          href: 'chapter.xhtml',
          progression: 0,
          raw: {
            'locations': {'progression': 0.0, 'position': 1},
          },
        ),
      );
      await a.sync.syncNow();
      // JavaScript JSON.stringify serializes whole-valued doubles as integers.
      // It may also return equivalent native maps in a different key order.
      final local = a.entry.progress!;
      cloud.row['progress'] = {
        ...local.locator.toJson(),
        'raw': {
          'locations': {'position': 1, 'progression': 0},
        },
      };
      for (var i = 0; i < 3; i++) {
        await a.sync.syncNow();
        expect(a.sync.pendingCount, 0);
        expect(cloud.batches.last, isEmpty);
      }
      expect(identical(a.entry.progress, local), isTrue);
    },
  );

  test(
    'oversized native context retains portable position without poisoning sync',
    () async {
      final cloud = Cloud();
      final a = await Device.create(cloud);
      addTearDown(a.dispose);
      await a.library.saveProgress(
        a.entry.id,
        ReadingLocator(
          href: 'chapter.xhtml',
          progression: .4,
          raw: {'context': 'x' * 40000},
        ),
      );
      await a.sync.syncNow();
      final sent =
          cloud.batches.last.where((c) => c['kind'] == 'progress').single
              as Map;
      expect((sent['payload'] as Map)['raw'], isNull);
      expect((sent['payload'] as Map)['href'], 'chapter.xhtml');
      expect(a.sync.pendingCount, 0);
    },
  );

  test(
    'canonical adoption preserves local bytes and an already open reader identity',
    () async {
      final cloud = Cloud();
      final a = await Device.create(cloud);
      addTearDown(a.dispose);
      final oldId = a.entry.id;
      final canonical = Book.fromJson({
        ...book.toJson(),
        'id': 'legacy-canonical',
      });
      await a.library.adoptCanonical(
        entryId: oldId,
        book: canonical,
        origin: origin,
      );
      await a.library.saveProgress(
        oldId,
        const ReadingLocator(href: 'kept.xhtml', progression: .5),
        expectedSha256: book.sha256,
      );
      expect(a.library.entries, hasLength(1));
      expect(a.library.canRead(oldId), isTrue);
      expect(a.entry.download.path, 'local.epub');
      expect(a.entry.book.id, 'legacy-canonical');
      expect(a.entry.progress!.locator.href, 'kept.xhtml');
      await a.library.remove(oldId, keepMetadata: true);
      expect(a.entry.download.isReady, isFalse);
      expect(a.entry.progress!.locator.href, 'kept.xhtml');
    },
  );

  test(
    'two devices sync position, cumulative reading time and typography without marking bytes downloaded',
    () async {
      final cloud = Cloud();
      final a = await Device.create(cloud);
      final b = await Device.create(cloud, local: false);
      addTearDown(a.dispose);
      addTearDown(b.dispose);
      await a.library.saveProgress(
        a.entry.id,
        const ReadingLocator(
          href: 'chapter3.xhtml',
          progression: .4,
          totalProgression: .6,
        ),
      );
      await a.settings.updateReader((p) => p.copyWith(fontSize: 24));
      await a.sync.recordReadingSession(
        a.entry,
        sessionId: 'reading-one',
        readingMilliseconds: 45000,
      );
      await a.sync.syncNow();
      await b.sync.syncNow();
      expect(b.entry.progress!.locator.href, 'chapter3.xhtml');
      expect(b.entry.download.isReady, isFalse);
      expect(b.settings.reader.fontSize, 24);
      expect(b.sync.totalReadingMilliseconds, 45000);
      expect(a.sync.pendingCount, 0);
      await b.sync.syncNow();
      expect(
        cloud.batches.last,
        isEmpty,
        reason: 'Remote merges must not echo back as fresh edits',
      );
    },
  );

  test(
    'offline queue survives restart and a lost response does not double-count time',
    () async {
      final cloud = Cloud()..offline = true;
      final a = await Device.create(cloud);
      await a.library.saveProgress(
        a.entry.id,
        const ReadingLocator(href: 'offline.xhtml', progression: .2),
      );
      await a.sync.recordReadingSession(
        a.entry,
        sessionId: 'offline-session',
        readingMilliseconds: 60000,
      );
      await a.sync.syncNow();
      expect(a.sync.error, isNotNull);
      await a.dispose();
      final restarted = await Device.create(cloud, persisted: a.store);
      addTearDown(restarted.dispose);
      expect(restarted.sync.pendingCount, greaterThan(0));
      cloud.offline = false;
      cloud.loseResponse = true;
      await restarted.sync.syncNow();
      expect(restarted.sync.pendingCount, greaterThan(0));
      await restarted.sync.syncNow();
      expect(cloud.row['readingMilliseconds'], 60000);
      expect(restarted.sync.totalReadingMilliseconds, 60000);
      expect(restarted.sync.pendingCount, 0);
    },
  );

  test('updates made during an in-flight request remain queued', () async {
    final cloud = Cloud();
    final a = await Device.create(cloud);
    addTearDown(a.dispose);
    await a.sync.recordReadingSession(
      a.entry,
      sessionId: 'active-session',
      readingMilliseconds: 1000,
    );
    cloud.duringRequest = () async {
      cloud.duringRequest = null;
      await a.sync.recordReadingSession(
        a.entry,
        sessionId: 'active-session',
        readingMilliseconds: 3000,
      );
      await a.library.saveProgress(
        a.entry.id,
        const ReadingLocator(href: 'later.xhtml', progression: .9),
      );
    };
    await a.sync.syncNow();
    expect(a.sync.totalReadingMilliseconds, 3000);
    expect(a.sync.pendingCount, greaterThan(0));
    await a.sync.syncNow();
    expect(cloud.row['readingMilliseconds'], 3000);
    expect((cloud.row['progress'] as Map)['href'], 'later.xhtml');
    expect(a.sync.pendingCount, 0);
  });

  test(
    'pending uploads are kept local until canonical publication exists',
    () async {
      var pending = true;
      final cloud = Cloud();
      final a = await Device.create(cloud, pending: (_) => pending);
      addTearDown(a.dispose);
      await a.library.saveProgress(
        a.entry.id,
        const ReadingLocator(href: 'local.xhtml', progression: .1),
      );
      await a.sync.syncNow();
      expect(cloud.batches.last, isEmpty);
      expect(a.sync.pendingCount, greaterThan(0));
      pending = false;
      a.sync.uploadsChanged();
      await a.sync.syncNow();
      expect((cloud.row['progress'] as Map)['href'], 'local.xhtml');
      expect(a.sync.pendingCount, 0);
    },
  );

  test('a newer remote position wins without a live reader jumping', () async {
    final cloud = Cloud();
    final a = await Device.create(cloud);
    addTearDown(a.dispose);
    await a.library.saveProgress(
      a.entry.id,
      const ReadingLocator(href: 'here.xhtml', progression: .1),
    );
    await a.sync.syncNow();
    a.sync.beginReading(a.entry);
    cloud.row['progress'] = const ReadingLocator(
      href: 'elsewhere.xhtml',
      progression: .8,
    ).toJson();
    cloud.row['progressUpdatedAt'] = DateTime.now()
        .add(const Duration(seconds: 5))
        .toUtc()
        .toIso8601String();
    await a.sync.syncNow();
    expect(a.entry.progress!.locator.href, 'here.xhtml');
    a.sync.endReading();
    await a.sync.syncNow();
    expect(a.entry.progress!.locator.href, 'elsewhere.xhtml');
  });
}
