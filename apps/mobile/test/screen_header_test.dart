import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/app_theme.dart';
import 'package:thereader/features/shared/states.dart';

void main() {
  // The action's centre must sit at the title's optical middle (a fixed
  // em-distance above the baseline) whatever the title size, text scale or
  // action height.
  for (final (label, pick) in <(String, TextStyle? Function(TextTheme))>[
    ('displayLarge', (t) => t.displayLarge),
    ('displaySmall', (t) => t.displaySmall),
  ]) {
    for (final scale in [1.0, 1.3]) {
      for (final actionHeight in [44.0, 48.0]) {
        testWidgets('$label x$scale, ${actionHeight.toInt()}px action centres on the glyphs', (tester) async {
          final theme = AppTheme.dark;
          final style = pick(theme.textTheme)!;
          await tester.pumpWidget(MaterialApp(
            theme: theme,
            home: MediaQuery(
              data: MediaQueryData(textScaler: TextScaler.linear(scale)),
              child: Scaffold(
                body: ScreenHeader(
                  title: 'Library',
                  style: style,
                  trailing: SizedBox(key: const Key('action'), width: 48, height: actionHeight),
                ),
              ),
            ),
          ));

          // Read the laid-out paragraph's own baseline; outside layout this
          // is only allowed while the intrinsics debug flag is set.
          final paragraph = tester.renderObject<RenderBox>(find.text('Library'));
          RenderObject.debugCheckingIntrinsics = true;
          final baseline = tester.getTopLeft(find.text('Library')).dy +
              paragraph.getDistanceToBaseline(TextBaseline.alphabetic)!;
          RenderObject.debugCheckingIntrinsics = false;
          final actionCentre = tester.getCenter(find.byKey(const Key('action'))).dy;
          expect(actionCentre, closeTo(baseline - ScreenHeader.opticalCenter * style.fontSize! * scale, 0.01));
        });
      }
    }
  }
}
