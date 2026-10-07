// Records article highlights and notes: a fresh install syncs an article
// highlighted on the web, shows that passage and its note, then highlights a
// passage of its own from the selection toolbar, writes a note on it, lists
// both and syncs them back.
//
//   flutter test integration_test/article_highlights_recording_test.dart -d <device> \
//       --dart-define=THEREADER_SYNC_API=http://127.0.0.1:8797 \
//       --dart-define=THEREADER_HIGHLIGHT_FROM=value --dart-define=THEREADER_HIGHLIGHT_TO=uncertain \
//       --dart-define=THEREADER_RECORD_DIR=/abs/dir
//
// The API URL is saved before the first launch, so a fresh install talks to
// THEREADER_SYNC_API only. Uninstall the app afterwards: its articles and
// highlights would otherwise sync to the default API on the next launch.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/app_scope.dart';
import 'package:thereader/data/storage/key_value_store.dart';
import 'package:thereader/features/articles/article_screen.dart';
import 'package:thereader/features/library/library_screen.dart';
import 'package:thereader/features/reader/highlight_sheets.dart';
import 'package:thereader/main.dart' as app;

import 'recording_support.dart';

const api = String.fromEnvironment('THEREADER_SYNC_API');
const from = String.fromEnvironment('THEREADER_HIGHLIGHT_FROM', defaultValue: 'value');
const to = String.fromEnvironment('THEREADER_HIGHLIGHT_TO', defaultValue: 'uncertain');
const note = String.fromEnvironment('THEREADER_HIGHLIGHT_NOTE', defaultValue: 'Written on the phone: compare with Dehaene.');

/// The paragraph drawing [glyphs] and where they are drawn, in global coordinates.
(RenderParagraph, Rect)? glyphs(WidgetTester tester, String glyphs, {String? after}) {
  for (final p in tester.renderObjectList<RenderParagraph>(find.byType(RichText))) {
    final text = p.text.toPlainText(includeSemanticsLabels: false);
    final start = after == null ? 0 : text.indexOf(after);
    if (start < 0) continue;
    final at = text.indexOf(glyphs, start);
    if (at < 0 || !p.attached) continue;
    final box = p.getBoxesForSelection(TextSelection(baseOffset: at, extentOffset: at + glyphs.length)).first;
    return (p, MatrixUtils.transformRect(p.getTransformTo(null), box.toRect()));
  }
  return null;
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('records article highlights and notes', (tester) async {
    final kv = await SharedPreferencesStore.open();
    if (await kv.read('settings.v1') == null) {
      await kv.write('settings.v1', jsonEncode({'apiBaseUrl': api}));
    }
    await app.main();
    await hold(tester, 2500);
    final services = AppScope.of(tester.element(find.byType(LibraryScreen)));
    final articles = services.articles!;
    final highlights = services.highlights!;
    // Pull the article and its web highlight before the camera rolls.
    for (var i = 0; i < 5 && articles.articles.isEmpty; i++) {
      await services.sync!.syncNow();
      await hold(tester, 500);
    }
    final summary = articles.articles.first;
    event('synced: ${articles.articles.length} article(s), '
        '${highlights.forArticle(summary.id).map((h) => '"${h.text}" (${h.color}, note "${h.note}")').toList()}');
    await waitForRecorder(tester);
    event('recording');
    await hold(tester, 1500);

    await tester.tap(find.text('Articles').first);
    await hold(tester, 1500);
    await tester.tap(find.text(summary.title).first);
    final start = elapsedMs;
    while (find.byType(ArticleScreen).evaluate().isEmpty || find.byTooltip('Highlights').evaluate().isEmpty) {
      if (elapsedMs - start > 20000) throw StateError('article did not open');
      await hold(tester, 100);
    }
    event('opened');
    await hold(tester, 2200);

    // The passage highlighted on the web, with its note, from the list.
    await tester.tap(find.byTooltip('Highlights'));
    await hold(tester, 2600);
    final web = highlights.forArticle(summary.id).first;
    await tester.tap(find.text(web.text).last);
    await hold(tester, 2800);
    event('jumped to the web highlight');
    final shown = glyphs(tester, web.text.substring(0, 12));
    if (shown != null) {
      await tester.tapAt(shown.$2.center);
      await hold(tester, 2600);
      Navigator.of(tester.element(find.text('Delete'))).pop();
      await hold(tester, 1000);
    }

    // Select a passage of our own with a long press and drag.
    final first = glyphs(tester, from);
    if (first == null) throw StateError('"$from" is not on screen');
    final ctx = find.byType(RichText).evaluate().firstWhere((e) => identical(e.renderObject, first.$1));
    await Scrollable.ensureVisible(ctx, alignment: 0.45, duration: const Duration(milliseconds: 900), curve: Curves.easeInOutCubic);
    await hold(tester, 1200);
    final a = glyphs(tester, from)!.$2;
    final b = glyphs(tester, to, after: from)!.$2;
    final gesture = await tester.startGesture(a.center);
    await hold(tester, 750);
    for (var i = 1; i <= 12; i++) {
      await gesture.moveTo(Offset.lerp(a.center, b.center, i / 12)!);
      await hold(tester, 40);
    }
    await gesture.up();
    await hold(tester, 1800);
    event('selected; toolbar ${find.text('Note').evaluate().isNotEmpty ? 'shown' : 'MISSING'}');
    // Yellow (the default) comes first, then green.
    await tester.tap(find.descendant(of: find.byType(HighlightSelectionToolbar), matching: find.byType(InkResponse)).at(1));
    await hold(tester, 1800);

    // Write a note on it.
    await tester.tapAt(glyphs(tester, from)!.$2.center);
    await hold(tester, 1600);
    await tester.tap(find.text('Note'));
    await hold(tester, 1200);
    await typeLikeAPerson(tester, find.byType(TextField), note);
    await hold(tester, 900);
    await tester.tap(find.text('Save'));
    await hold(tester, 2400);

    // Both passages, in reading order, with their notes. A small scroll back
    // brings the floating bar in.
    await tester.timedDrag(find.byType(CustomScrollView), const Offset(0, 90), const Duration(milliseconds: 500));
    await hold(tester, 1500);
    for (var i = 0; i < 3 && find.text('HIGHLIGHTS').evaluate().isEmpty; i++) {
      await tester.tap(find.byTooltip('Highlights'), warnIfMissed: false);
      await hold(tester, 1200);
    }
    await hold(tester, 3000);
    event('listed: ${highlights.forArticle(summary.id).map((h) => '"${h.text}" (${h.color}, note "${h.note}")').toList()}');
    if (find.text('HIGHLIGHTS').evaluate().isNotEmpty) Navigator.of(tester.element(find.text('HIGHLIGHTS'))).pop();
    await hold(tester, 1200);

    await services.sync!.syncNow();
    event('synced back: error ${services.sync!.error}, pending ${services.sync!.pendingCount}');
    await hold(tester, 1500);
    event('done');
  });
}
