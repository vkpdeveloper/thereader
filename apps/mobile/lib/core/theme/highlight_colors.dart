import 'dart:math' as math;
import 'dart:ui';

import '../../data/models/highlight.dart';
import 'app_colors.dart';

/// Resolves semantic highlight keys against a theme.
///
/// [swatch] is the vivid hue used in UI controls. [tint] is what the page
/// paints behind text: the hue blended onto the theme's paper, as strong as
/// possible while body ink keeps WCAG AA (4.5:1) against it. The tint is
/// opaque because native WebViews blend alpha inconsistently.
abstract final class HighlightColors {
  static const Map<HighlightColor, Color> _hues = {
    HighlightColor.yellow: Color(0xFFF5C518),
    HighlightColor.green: Color(0xFF4ADE80),
    HighlightColor.blue: Color(0xFF60A5FA),
    HighlightColor.pink: Color(0xFFF472B6),
    HighlightColor.purple: Color(0xFFA78BFA),
  };

  static const double _maxAlpha = 0.38;
  static const double minContrast = 4.5;

  static Color swatch(HighlightColor key) => _hues[key]!;

  static final Map<(Color, Color, HighlightColor), Color> _cache = {};

  static Color tint(HighlightColor key, AppColors colors) =>
      _cache.putIfAbsent((colors.paper, colors.ink, key), () {
        final hue = _hues[key]!;
        for (var a = _maxAlpha; a > 0; a -= 0.02) {
          final c = Color.lerp(colors.paper, hue, a)!.withAlpha(0xFF);
          if (contrast(colors.ink, c) >= minContrast) return c;
        }
        return colors.paper;
      });

  /// WCAG 2 contrast ratio.
  static double contrast(Color a, Color b) {
    final la = a.computeLuminance();
    final lb = b.computeLuminance();
    return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
  }
}
