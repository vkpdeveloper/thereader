// Records articles arriving from another device: a fresh install is pointed
// at an API through the real Settings screen, syncs, and opens a few of the
// articles saved there (by the web app) without fetching or extracting their
// pages: each document downloads once from the API, already structured.
//
//   flutter test integration_test/article_sync_recording_test.dart -d <device> \
//       --dart-define=THEREADER_SYNC_API=http://localhost:8787 \
//       --dart-define=THEREADER_SYNC_OPEN=gwern.net,distill.pub,ar.wikipedia.org \
//       --dart-define=THEREADER_RECORD_DIR=/abs/dir
//
// Run it on a fresh install. The API URL starts at a closed local port so the
// first launch reaches no server (not the default API) before Settings points
// it at THEREADER_SYNC_API; an empty URL would also do, but leaves an import
// error on the Settings screen. The
// test leaves it there, so uninstall the app afterwards (its articles would
// otherwise sync to the default API on the next launch). `<dir>/events.txt`
// logs open times and, per article, any request to the article's own site
// other than images; `<dir>/http.txt` lists every request.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/features/library/library_screen.dart';
import 'package:thereader/features/settings/settings_screen.dart';
import 'package:thereader/main.dart' as app;

import 'recording_support.dart';

const api = String.fromEnvironment('THEREADER_SYNC_API');
const open = String.fromEnvironment('THEREADER_SYNC_OPEN', defaultValue: 'gwern.net,distill.pub,ar.wikipedia.org');

final _image = RegExp(r'\.(png|jpe?g|gif|webp|svg|avif)$', caseSensitive: false);

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('records articles synced from the web', (tester) async {
    final requests = RequestLog();
    HttpOverrides.global = requests;
    final kv = await SharedPreferencesStore.open();
    if (await kv.read('settings.v1') == null) {
      await kv.write('settings.v1', jsonEncode({'apiBaseUrl': 'http://localhost:9'}));
    }
    event('start');
    await app.main();
    await hold(tester, 2500);
    await waitForRecorder(tester);
    event('recording');
    await hold(tester, 2000);

    final services = AppScope.of(tester.element(find.byType(LibraryScreen)));
    final articles = services.articles!;
    final sync = services.sync!;

    // Settings: type the API address, check it, sync.
    await tester.tap(find.text('Settings').last);
    await hold(tester, 1400);
    final field = find.byType(TextField).first;
    await tester.tap(field);
    await hold(tester, 600);
    await typeLikeAPerson(tester, field, api);
    await hold(tester, 600);
    await tester.tap(find.text('Save and check'));
    final checkStart = elapsedMs;
    while (find.textContaining('Connected').evaluate().isEmpty && elapsedMs - checkStart < 15000) {
      await hold(tester, 100);
    }
    event('checked ${find.textContaining('Connected').evaluate().isNotEmpty ? 'connected' : 'NOT connected'}');
    FocusManager.instance.primaryFocus?.unfocus();
    await hold(tester, 1500);
    final waitStart = elapsedMs;
    while (sync.isSyncing && elapsedMs - waitStart < 20000) {
      await hold(tester, 100);
    }
    // The cloud section is below the fold of a lazily built list: scroll to it.
    final syncNow = find.text('Sync now');
    final settingsList = tester
        .state<ScrollableState>(find.descendant(of: find.byType(SettingsScreen), matching: find.byType(Scrollable)).first)
        .position;
    while (syncNow.evaluate().isEmpty && settingsList.extentAfter > 1) {
      await settingsList.animateTo(
        (settingsList.pixels + settingsList.viewportDimension * 0.5).clamp(0.0, settingsList.maxScrollExtent),
        duration: const Duration(milliseconds: 900),
        curve: Curves.easeInOutCubic,
      );
      await hold(tester, 200);
    }
    final box = tester.renderObject<RenderBox>(syncNow);
    final bottom = box.localToGlobal(Offset(0, box.size.height)).dy;
    final screen = tester.view.physicalSize.height / tester.view.devicePixelRatio;
    if (bottom > screen - 140) {
      await settingsList.animateTo(
        (settingsList.pixels + bottom - screen + 220).clamp(0.0, settingsList.maxScrollExtent),
        duration: const Duration(milliseconds: 700),
        curve: Curves.easeInOutCubic,
      );
    }
    await hold(tester, 800);
    final before = articles.articles.length;
    final syncStart = elapsedMs;
    await tester.tap(syncNow);
    await hold(tester, 300);
    while ((sync.isSyncing || sync.lastSyncedAt == null) && elapsedMs - syncStart < 30000) {
      await hold(tester, 100);
    }
    event('synced in ${elapsedMs - syncStart}ms: ${articles.articles.length} article(s), ${articles.articles.length - before} new, '
        '${articles.articles.where((a) => a.stored).length} downloaded during sync, error ${sync.error}');
    await hold(tester, 1800);

    // The library, then every article.
    await tester.tap(find.text('Library').last);
    await hold(tester, 2200);
    await tester.tap(find.text('Articles').first);
    await hold(tester, 2600);

    for (final (i, site) in open.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).indexed) {
      final summary = articles.articles.where((a) => Uri.parse(a.url).host.endsWith(site)).firstOrNull;
      if (summary == null) {
        event('missing $i $site');
        continue;
      }
      event('add $i ${summary.url}');
      final tile = find.text(summary.title);
      await tester.ensureVisible(tile.first);
      await hold(tester, 900);
      final since = DateTime.now().millisecondsSinceEpoch;
      final wasStored = summary.stored;
      await tester.tap(tile.first);
      final start = elapsedMs;
      while (find.descendant(of: find.byType(ArticleScreen), matching: find.byType(CustomScrollView)).evaluate().isEmpty &&
          elapsedMs - start < 30000) {
        await hold(tester, 50);
      }
      final host = Uri.parse(summary.url).host;
      final pageRequests = requests.where(since, (u) => u.host == host && !_image.hasMatch(u.path)).toList();
      final apiRequests = requests.where(since, (u) => u.toString().startsWith(api)).map((u) => u.path).toList();
      event('opened $i after ${elapsedMs - start}ms (document ${wasStored ? 'already on the device' : 'downloaded on open'}; '
          'API requests $apiRequests; requests to $host other than images: ${pageRequests.length})');
      await hold(tester, 2200);
      await readArticle(tester, '$i');
      final pagesAfter = requests.where(since, (u) => u.host == host && !_image.hasMatch(u.path)).toList();
      event('read $i (requests to $host other than images while reading: $pagesAfter)');
      await hold(tester, 600);
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await hold(tester, 1400);
      event('back $i');
    }
    await hold(tester, 1500);
    event('done');
  }, skip: api.isEmpty);
}
