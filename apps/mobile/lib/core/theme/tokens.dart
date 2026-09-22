import 'package:flutter/widgets.dart';

/// Centralised design tokens. The app is always dark; there is no light theme.
/// Palette follows the user's Vercel-dark specification exactly.
abstract final class Palette {
  static const Color bg = Color(0xFF000000);
  static const Color panel = Color(0xFF101010);
  static const Color element = Color(0xFF1F1F1F);
  static const Color border = Color(0xFF1F1F1F);
  static const Color borderActive = Color(0xFF676767);
  static const Color fg = Color(0xFFEDEDED);
  static const Color muted = Color(0xFFA1A1A1);
  static const Color subtle = Color(0xFF676767);

  static const Color blue = Color(0xFF52A8FF);
  static const Color purple = Color(0xFFC472FB);
  static const Color green = Color(0xFF62C073);
  static const Color orange = Color(0xFFFF9907);
  static const Color pink = Color(0xFFF75F8F);
  static const Color cyan = Color(0xFF1DA9B0);

  /// Semantic aliases.
  static const Color primary = blue;
  static const Color success = green;
  static const Color warning = orange;
  static const Color error = pink;
}

abstract final class Space {
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
  static const double xxl = 48;

  /// Horizontal page gutter.
  static const double gutter = 20;
}

abstract final class Radii {
  static const Radius sm = Radius.circular(6);
  static const Radius md = Radius.circular(10);
  static const Radius lg = Radius.circular(14);
}

abstract final class Fonts {
  static const String serif = 'Literata';
  static const String sans = 'Inter';
}

abstract final class Motion {
  static const Duration fast = Duration(milliseconds: 140);
  static const Duration base = Duration(milliseconds: 220);
  static const Duration slow = Duration(milliseconds: 360);
  static const Curve curve = Curves.easeOutCubic;

  /// Returns [Duration.zero] when the platform requests reduced motion.
  static Duration of(BuildContext context, Duration d) =>
      MediaQuery.maybeDisableAnimationsOf(context) == true ? Duration.zero : d;
}
