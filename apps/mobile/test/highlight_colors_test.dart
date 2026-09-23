import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/core/theme/highlight_colors.dart';
import 'package:thereader/core/theme/theme_presets.dart';
import 'package:thereader/data/models/highlight.dart';

void main() {
  test('ink keeps AA contrast on every theme × highlight colour', () {
    for (final preset in ThemePreset.all) {
      for (final key in HighlightColor.values) {
        final tint = HighlightColors.tint(key, preset.colors);
        final ratio = HighlightColors.contrast(preset.colors.ink, tint);
        expect(
          ratio,
          greaterThanOrEqualTo(4.5),
          reason: '${preset.id}/${key.name} is ${ratio.toStringAsFixed(2)}',
        );
        expect(tint.a, 1.0, reason: 'tints must be opaque');
        // Visibly tinted, not just the paper again.
        expect(tint, isNot(preset.colors.paper), reason: '${preset.id}/${key.name}');
      }
    }
  });

  test('unknown colour keys fall back to yellow', () {
    expect(HighlightColor.parse('teal'), HighlightColor.yellow);
    expect(HighlightColor.parse(null), HighlightColor.yellow);
    expect(HighlightColor.parse('pink'), HighlightColor.pink);
  });
}
