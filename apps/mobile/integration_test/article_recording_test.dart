// Saves links through the library's "+" sheet at a human pace, for a screen
// recording of the real flow: type the link, wait for extraction, read each
// article top to bottom, return to the library.
//
//   flutter test integration_test/article_recording_test.dart -d <device> \
//       --dart-define=THEREADER_ARTICLE_URLS=https://example.com/a,https://example.com/b \
//       --dart-define=THEREADER_RECORD_DIR=/abs/dir \
//       [--dart-define=THEREADER_RECORD_SCREENS=10]
//
// Runs the real app with its real storage. `<dir>/ready` is written once the
// library is on screen, so a host script can start recording only then;
// `<dir>/events.txt` logs what happened and when.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/main.dart' as app;

const urls = String.fromEnvironment('THEREADER_ARTICLE_URLS');
const recordDir = String.fromEnvironment('THEREADER_RECORD_DIR');
const screens = int.fromEnvironment('THEREADER_RECORD_SCREENS', defaultValue: 10);

final _clock = Stopwatch()..start();

void event(String line) {
  debugPrint('[recording] $line');
  if (recordDir.isNotEmpty) {
    File('$recordDir/events.txt').writeAsStringSync('${_clock.elapsedMilliseconds}ms $line\n', mode: FileMode.append);
  }
}

Future<void> hold(WidgetTester tester, int ms) => tester.pump(Duration(milliseconds: ms));

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  // Frames follow the display, so animations run in real time on video.
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('records saving and reading articles', (tester) async {
    event('start');
    await app.main();
    event('launched');
    await hold(tester, 2500);
    if (recordDir.isNotEmpty) {
      File('$recordDir/ready').writeAsStringSync('${DateTime.now().toIso8601String()}\n');
      // Give the host a moment to start the recorder.
      for (var i = 0; i < 50 && !File('$recordDir/recording').existsSync(); i++) {
        await hold(tester, 100);
      }
    }
    event('recording');
    await hold(tester, 1500);

    final list = urls.split(',').map((u) => u.trim()).where((u) => u.isNotEmpty).toList();
    for (final (i, url) in list.indexed) {
      event('add $i $url');
      await tester.tap(find.byTooltip('Save article from link'));
      event('sheet $i');
      await hold(tester, 900);
      final field = find.byType(TextField);
      for (var n = 1; n <= url.length; n += 2) {
        tester.testTextInput.enterText(url.substring(0, n.clamp(0, url.length)));
        await hold(tester, 35);
      }
      await tester.enterText(field, url);
      event('typed $i');
      await hold(tester, 700);
      await tester.tap(find.text('Save article'));
      final start = _clock.elapsedMilliseconds;
      while (find.byType(ArticleScreen).evaluate().isEmpty && _clock.elapsedMilliseconds - start < 90000) {
        await hold(tester, 200);
        if (find.textContaining("Couldn't").evaluate().isNotEmpty) break;
      }
      if (find.byType(ArticleScreen).evaluate().isEmpty) {
        event('failed $i after ${_clock.elapsedMilliseconds - start}ms');
        await hold(tester, 2500);
        Navigator.of(tester.element(find.byType(TextField))).pop();
        await hold(tester, 800);
        continue;
      }
      event('opened $i after ${_clock.elapsedMilliseconds - start}ms');
      await hold(tester, 2500);

      final position = tester
          .state<ScrollableState>(
            find.descendant(of: find.byType(ArticleScreen), matching: find.byType(Scrollable)).first,
          )
          .position;
      for (var s = 0; s < screens && position.extentAfter > 1; s++) {
        final target = (position.pixels + position.viewportDimension * 0.55).clamp(0.0, position.maxScrollExtent);
        await position.animateTo(target, duration: const Duration(milliseconds: 1400), curve: Curves.easeInOutCubic);
        await hold(tester, 1600);
      }
      event('read $i');
      await hold(tester, 800);
      Navigator.of(tester.element(find.byType(ArticleScreen))).pop();
      await hold(tester, 1500);
    }

    final articlesTab = find.text('Articles');
    if (articlesTab.evaluate().isNotEmpty) {
      await tester.tap(articlesTab.first);
      await hold(tester, 3000);
    }
    event('done');
  }, skip: urls.isEmpty);
}
