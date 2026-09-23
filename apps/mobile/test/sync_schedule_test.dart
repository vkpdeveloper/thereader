import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
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

/// Counts `/v1/sync` requests and the changes each one carried.
class Server {
  final List<List<dynamic>> syncs = [];
  bool offline = false;
  Completer<void>? hold;
  int inFlight = 0;
  int maxInFlight = 0;

  ApiClient client(String url) =>
      ApiClient(baseUrl: url, client: MockClient(_handle));

  Future<http.Response> _handle(http.Request request) async {
    if (request.url.path.startsWith('/v1/books/')) {
      return http.Response(jsonEncode({'book': book.toJson()}), 200);
    }
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      syncs.add(jsonDecode(request.body)['changes'] as List);
      await hold?.future;
      if (offline) throw http.ClientException('Offline');
      return http.Response(jsonEncode({'books': [], 'preferences': null}), 200);
    } finally {
      inFlight--;
    }
  }
}

class Harness {
  Harness(this.async, this.server, this.library, this.sync);
  final FakeAsync async;
  final Server server;
  final LibraryRepository library;
  final SyncRepository sync;
  int get requests => server.syncs.length;
  LibraryEntry get entry => library.entries.single;

  static Harness start(FakeAsync async, Server server) {
    final start = DateTime.utc(2026, 9, 23, 12);
    final store = MemoryKeyValueStore();
    final library = LibraryRepository(
      store: store,
      bookStore: MemoryBookStore(),
    );
    final settings = SettingsRepository(store);
    late SyncRepository sync;
    () async {
      await library.load();
      await settings.load();
      await library.importLocal(book: book, origin: origin, path: 'l.epub');
      sync = SyncRepository(
        store: store,
        library: library,
        settings: settings,
        clientFactory: server.client,
        now: () => start.add(async.elapsed),
      );
      await sync.load();
    }();
    async.flushMicrotasks();
    return Harness(async, server, library, sync);
  }

  void elapse(Duration d) => async.elapse(d);

  void turnPage(double progression) {
    library.saveProgress(
      entry.id,
      ReadingLocator(href: 'c.xhtml', progression: progression),
    );
    async.flushMicrotasks();
  }

  void lifecycle(AppLifecycleState state) {
    sync.didChangeAppLifecycleState(state);
    async.flushMicrotasks();
  }

  void dispose() {
    sync.dispose();
    async.flushMicrotasks();
  }
}

void runScheduled(
  void Function(Harness h) body, {
  void Function(Server server)? configure,
}) {
  fakeAsync((async) {
    // Created inside the fake zone so completers resume under its microtasks.
    final server = Server();
    configure?.call(server);
    final h = Harness.start(async, server);
    body(h);
    h.dispose();
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('start syncs once; local changes wait for the next cycle', () {
    runScheduled((h) {
      expect(h.requests, 1, reason: 'one sync on start');
      for (var i = 1; i <= 20; i++) {
        h.turnPage(i / 100);
        h.elapse(const Duration(seconds: 5));
      }
      expect(h.sync.pendingCount, greaterThan(0));
      expect(h.requests, 1, reason: 'no request per local change');
      h.elapse(SyncRepository.syncInterval);
      expect(h.requests, 2);
      final progress = h.server.syncs.last.where(
        (c) => (c as Map)['kind'] == 'progress',
      );
      expect(progress.single['payload']['progression'], .2);
      expect(h.sync.pendingCount, 0);
    });
  });

  test('foreground polls once per interval', () {
    runScheduled((h) {
      h.elapse(const Duration(minutes: 20));
      expect(h.requests, 1 + 10);
      expect(SyncRepository.syncInterval, const Duration(minutes: 2));
    });
  });

  test('background stops polling and flushes queued changes once', () {
    runScheduled((h) {
      h.elapse(const Duration(seconds: 30));
      h.turnPage(.5);
      h.lifecycle(AppLifecycleState.inactive);
      h.lifecycle(AppLifecycleState.hidden);
      h.lifecycle(AppLifecycleState.paused);
      h.elapse(const Duration(seconds: 2));
      expect(h.requests, 2, reason: 'best-effort flush');
      expect(
        h.server.syncs.last.map((c) => (c as Map)['kind']),
        contains('progress'),
      );
      h.elapse(const Duration(hours: 1));
      expect(h.requests, 2, reason: 'no polling while backgrounded');
      h.lifecycle(AppLifecycleState.resumed);
      expect(h.requests, 3, reason: 'resume pulls once');
      h.elapse(SyncRepository.syncInterval);
      expect(h.requests, 4);
    });
  });

  test('background with nothing queued sends nothing', () {
    runScheduled((h) {
      h.lifecycle(AppLifecycleState.paused);
      h.elapse(const Duration(minutes: 30));
      expect(h.requests, 1);
    });
  });

  test('a quick resume does not sync again', () {
    runScheduled((h) {
      h.elapse(const Duration(seconds: 10));
      h.lifecycle(AppLifecycleState.inactive);
      h.lifecycle(AppLifecycleState.resumed);
      expect(h.requests, 1);
      h.elapse(SyncRepository.syncInterval);
      expect(h.requests, 2);
    });
  });

  test('closing the reader flushes queued reading once', () {
    runScheduled((h) {
      h.elapse(const Duration(seconds: 30));
      h.sync.beginReading(h.entry);
      h.elapse(const Duration(seconds: 50));
      // Stopwatch time is real, not fake; record the session directly.
      unawaited(
        h.sync.recordReadingSession(
          h.entry,
          sessionId: 'session',
          readingMilliseconds: 50000,
        ),
      );
      h.turnPage(.3);
      expect(h.requests, 1);
      h.sync.endReading();
      h.elapse(const Duration(seconds: 2));
      expect(h.requests, 2);
      final kinds = h.server.syncs.last.map((c) => (c as Map)['kind']);
      expect(kinds, containsAll(['progress', 'session']));
      h.elapse(const Duration(seconds: 60));
      expect(h.requests, 2);
    });
  });

  test('failures back off exponentially up to the cap, then recover', () {
    runScheduled((h) {
      final server = h.server;
      // Attempts at 0, +4, +8, +15, +15 minutes.
      h.elapse(const Duration(minutes: 3, seconds: 59));
      expect(h.requests, 1);
      h.elapse(const Duration(seconds: 1));
      expect(h.requests, 2);
      h.elapse(const Duration(minutes: 8));
      expect(h.requests, 3);
      h.elapse(const Duration(minutes: 15));
      expect(h.requests, 4);
      h.elapse(const Duration(minutes: 15));
      expect(h.requests, 5);
      expect(h.sync.error, isNotNull);
      server.offline = false;
      h.elapse(const Duration(minutes: 15));
      expect(h.requests, 6);
      expect(h.sync.error, isNull);
      h.elapse(SyncRepository.syncInterval);
      expect(h.requests, 7, reason: 'cadence restored after success');
    }, configure: (server) => server.offline = true);
  });

  test('manual sync is immediate and restarts the cadence', () {
    runScheduled((h) {
      h.elapse(const Duration(seconds: 90));
      h.turnPage(.4);
      unawaited(h.sync.syncNow());
      h.async.flushMicrotasks();
      expect(h.requests, 2);
      expect(h.sync.pendingCount, 0);
      h.elapse(const Duration(seconds: 119));
      expect(h.requests, 2);
      h.elapse(const Duration(seconds: 1));
      expect(h.requests, 3);
    });
  });

  test('syncs never overlap; requests during one join it', () {
    runScheduled((h) {
      final server = h.server;
      expect(h.sync.isSyncing, isTrue);
      for (var i = 0; i < 5; i++) {
        unawaited(h.sync.syncNow());
      }
      h.lifecycle(AppLifecycleState.paused);
      h.lifecycle(AppLifecycleState.resumed);
      // Past the flush settle delay, inside the 15 s client timeout.
      h.elapse(const Duration(seconds: 10));
      expect(h.requests, 1);
      expect(server.maxInFlight, 1);
      server.hold!.complete();
      server.hold = null;
      h.async.flushMicrotasks();
      expect(h.sync.isSyncing, isFalse);
      h.elapse(SyncRepository.syncInterval);
      expect(h.requests, 2);
      expect(server.maxInFlight, 1);
    }, configure: (server) => server.hold = Completer<void>());
  });
}
