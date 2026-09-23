import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_readium/reader_widget.dart' show isReaderTap;
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/features/reader/reader_screen.dart';

/// Android text selection needs the native view to receive long presses. A tap
/// recognizer above the platform view held the gesture arena through them, so
/// the WebView never saw the press and nothing could be selected.
void main() {
  Widget host({required bool engineHandlesTaps, required VoidCallback onTap}) =>
      Directionality(
        textDirection: TextDirection.ltr,
        child: ReaderTapRouting(
          engineHandlesTaps: engineHandlesTaps,
          onTap: onTap,
          child: const SizedBox.expand(key: Key('book')),
        ),
      );

  testWidgets('engines that report taps get no competing tap recognizer', (
    tester,
  ) async {
    var taps = 0;
    await tester.pumpWidget(host(engineHandlesTaps: true, onTap: () => taps++));
    expect(find.byType(GestureDetector), findsNothing);
    await tester.tap(find.byKey(const Key('book')));
    await tester.longPress(find.byKey(const Key('book')));
    expect(taps, 0);
  });

  testWidgets('the built-in engine still toggles chrome on tap', (tester) async {
    var taps = 0;
    await tester.pumpWidget(
      host(engineHandlesTaps: false, onTap: () => taps++),
    );
    await tester.tap(find.byKey(const Key('book')));
    expect(taps, 1);
  });

  test('a long press is selection, not a chrome tap', () {
    expect(isReaderTap(const Duration(milliseconds: 120)), isTrue);
    expect(isReaderTap(kLongPressTimeout), isFalse);
    expect(isReaderTap(const Duration(milliseconds: 1500)), isFalse);
  });
}
