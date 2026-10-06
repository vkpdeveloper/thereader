// Saves links through the library's "+" sheet at a human pace, for a screen
// recording of the real flow: type the link, wait while the phone fetches and
// extracts the page, read the article through its highlights, return to the
// library.
//
//   flutter test integration_test/article_recording_test.dart -d <device> \
//       --dart-define=THEREADER_ARTICLE_URLS=https://example.com/a,https://example.com/b \
//       --dart-define=THEREADER_RECORD_DIR=/abs/dir \
//       [--dart-define=THEREADER_RECORD_STOPS=4] \
//       [--dart-define=THEREADER_BUNDLED_CATALOG=true]
//
// Runs the real app with its real storage (add THEREADER_BUNDLED_CATALOG to
// keep the saved articles off the production API). `<dir>/ready` is written
// once the library is on screen, so a host script can start recording only
// then; `<dir>/events.txt` logs what happened and when (fetch, extraction and
// save times per article), `<dir>/http.txt` every request the app made.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/repositories/article_repository.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/features/library/library_screen.dart';
import 'package:thereader/main.dart' as app;

import 'recording_support.dart';

const urls = String.fromEnvironment('THEREADER_ARTICLE_URLS');

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Frames follow the display, so animations run in real time on video.
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('records saving and reading articles', (tester) async {
    final requests = RequestLog();
    HttpOverrides.global = requests;
    event('start');
    await app.main();
    event('launched');
    await hold(tester, 2500);
    await waitForRecorder(tester);
    event('recording');
    await hold(tester, 1500);

    final articles = AppScope.of(tester.element(find.byType(LibraryScreen))).articles!;
    // Phase changes of the save in progress, for the timing log.
    var phaseAt = 0;
    String? phase;
    final phases = <String, int>{};
    void onPhase() {
      final next = articles.adding.value?.phase.name;
      if (next == phase) return;
      if (phase != null) phases[phase!] = (phases[phase!] ?? 0) + elapsedMs - phaseAt;
      phase = next;
      phaseAt = elapsedMs;
    }

    articles.adding.addListener(onPhase);

    final list = urls.split(',').map((u) => u.trim()).where((u) => u.isNotEmpty).toList();
    for (final (i, url) in list.indexed) {
      event('add $i $url');
      await tester.tap(find.byTooltip('Save article from link'));
      await hold(tester, 900);
      await typeLikeAPerson(tester, find.byType(TextField), url);
      event('typed $i');
      await hold(tester, 700);
      phases.clear();
      final since = DateTime.now().millisecondsSinceEpoch;
      await tester.tap(find.text('Save article'));
      final start = elapsedMs;
      while (find.byType(ArticleScreen).evaluate().isEmpty && elapsedMs - start < 90000) {
        await hold(tester, 100);
        if (find.textContaining("Couldn't").evaluate().isNotEmpty) break;
      }
      final pageHost = Uri.parse(url).host;
      final fetched = requests.where(since, (u) => u.host == pageHost).take(1).join();
      if (find.byType(ArticleScreen).evaluate().isEmpty) {
        event('failed $i after ${elapsedMs - start}ms (phases ${_phases(phases)})');
        await hold(tester, 2500);
        Navigator.of(tester.element(find.byType(TextField))).pop();
        await hold(tester, 800);
        continue;
      }
      // The saved article opens from memory; wait until its blocks are on screen.
      while (find.descendant(of: find.byType(ArticleScreen), matching: find.byType(CustomScrollView)).evaluate().isEmpty &&
          elapsedMs - start < 120000) {
        await hold(tester, 50);
      }
      event('opened $i after ${elapsedMs - start}ms (${_phases(phases)}; page request: $fetched)');
      await hold(tester, 2200);
      await readArticle(tester, '$i');
      event('read $i');
      await hold(tester, 600);
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await hold(tester, 1400);
      event('back $i');
    }
    articles.adding.removeListener(onPhase);

    final articlesTab = find.text('Articles');
    if (articlesTab.evaluate().isNotEmpty) {
      await tester.tap(articlesTab.first);
      await hold(tester, 3000);
    }
    event('done');
  }, skip: urls.isEmpty);
}

String _phases(Map<String, int> phases) => [
      for (final p in ArticlePhase.values)
        if (phases[p.name] != null) '${p.name} ${phases[p.name]}ms',
    ].join(', ');
