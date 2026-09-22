// Drives the full sample-mode flow on a real device/simulator:
// library (empty) -> browse -> detail -> download+verify -> reader -> typography.
// Pauses let an external screenshot loop capture each state.
//
//   flutter test integration_test/walkthrough_test.dart -d <device>
import 'package:flutter/material.dart';
import 'package:flutter_readium/flutter_readium.dart' show ReadiumReaderWidget;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/main.dart' as app;

/// Set with `--dart-define=THEREADER_ENGINE=dart` to exercise the built-in
/// engine; by default the preferred engine (Readium on native) is used.
const String forcedEngine = String.fromEnvironment('THEREADER_ENGINE');

Future<void> pause(WidgetTester tester, [int seconds = 3]) async {
  await tester.pumpAndSettle();
  await tester.pump(Duration(seconds: seconds));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('sample mode walkthrough', (tester) async {
    await app.main();
    await pause(tester, 3);

    await tester.tap(find.text('Browse'));
    await pause(tester, 3);

    await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data == 'The Quiet Hour' && w.maxLines == 1));
    await pause(tester, 3);

    await tester.tap(find.textContaining('Download ·'));
    await pause(tester, 3);
    expect(find.text('Downloaded and verified. '), findsOneWidget);

    await tester.tap(find.text('Read'));
    await pause(tester, 6);
    expect(find.textContaining("Couldn't open"), findsNothing);
    if (forcedEngine == 'dart') {
      expect(find.textContaining('There is an hour before the house wakes', findRichText: true), findsOneWidget);
    } else {
      expect(find.byType(ReadiumReaderWidget), findsOneWidget);
    }

    // Reveal chrome, open typography.
    await tester.tapAt(tester.getCenter(find.byType(Scaffold).last));
    await pause(tester, 2);
    await tester.tap(find.byTooltip('Typography'));
    await pause(tester, 3);
    await tester.tap(find.text('Sans'));
    await pause(tester, 3);
    await tester.tap(find.text('Serif'));
    await pause(tester, 1);
    // Close the sheet and the book.
    await tester.tapAt(const Offset(200, 120));
    await pause(tester, 2);
    await tester.tap(find.byTooltip('Contents'));
    await pause(tester, 3);
    await tester.tap(find.text('The Shape of a Page'));
    await pause(tester, 3);
    // Chrome is still revealed after the contents sheet closes.
    await tester.tap(find.byTooltip('Close book'));
    await pause(tester, 4);

    // Closing returns to the book page; back to the library, which now shows
    // the continue-reading entry and the grid.
    await tester.tap(find.byType(BackButton));
    await pause(tester, 2);
    await tester.tap(find.text('Library'));
    await pause(tester, 4);
    expect(find.text('CONTINUE READING'), findsOneWidget);
    await tester.tap(find.text('Settings'));
    await pause(tester, 4);
  });
}
