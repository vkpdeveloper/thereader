// Drives the bundled-fixture flow and pauses in the reader so an external
// screen recorder can capture the mobile typography. Run with:
//
//   flutter test integration_test/typography_audit_test.dart -d <device> \
//       --dart-define=THEREADER_BUNDLED_CATALOG=true

import 'package:flutter/material.dart';
import 'package:flutter_readium/flutter_readium.dart' show ReadiumReaderWidget;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:thereader/main.dart' as app;
import 'package:thereader/core/typography/reader_fonts.dart';

Future<void> pause(WidgetTester tester, [int seconds = 3]) async {
  await tester.pumpAndSettle();
  await tester.pump(Duration(seconds: seconds));
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('typography audit capture', (tester) async {
    await app.main();
    await pause(tester, 3);

    // Browse -> The Quiet Hour.
    await tester.tap(find.text('Browse'));
    await pause(tester, 3);
    await tester.tap(find.byWidgetPredicate((w) => w is Text && w.data == 'The Quiet Hour' && w.maxLines == 1));
    await pause(tester, 3);

    // Download and wait for the read button.
    await tester.tap(find.textContaining('Download ·'));
    await pause(tester, 8);
    await tester.tap(find.text('Read'));
    await pause(tester, 8);
    expect(find.byType(ReadiumReaderWidget), findsOneWidget);

    // Reveal chrome and open the typography sheet.
    await tester.tapAt(tester.getCenter(find.byType(ReadiumReaderWidget)));
    await pause(tester, 2);
    await tester.tap(find.byTooltip('Typography'));
    await pause(tester, 3);

    // Cycle through a few fonts and close.
    await tester.tap(find.text(ReaderFonts.systemSerif.label));
    await pause(tester, 2);
    await tester.tap(find.text(ReaderFonts.atkinson.label));
    await pause(tester, 2);
    await tester.tap(find.text(ReaderFonts.systemSerif.label).last);
    await pause(tester, 2);
    await tester.tapAt(const Offset(200, 40));
    await pause(tester, 2);

    // Close the book.
    await tester.tap(find.byTooltip('Close book'));
    await pause(tester, 3);
  });
}
