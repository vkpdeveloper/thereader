import 'package:flutter/material.dart';

import 'tokens.dart';

/// The app's colour roles as a scoped, reactive [ThemeExtension].
///
/// Read them with `AppColors.of(context)` (or `context.colors`). Every role
/// name matches the historical [Palette] constant of the same name, so
/// migrating a call site is `Palette.fg` → `context.colors.fg`. The Default
/// preset is bit-for-bit the [Palette] constants.
///
/// [paper] and [ink] are the reading surface: the canvas and body text that
/// both the Dart engine and native Readium paint. They are separate roles so a
/// preset may give the reader a different surface from the app chrome.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.bg,
    required this.panel,
    required this.element,
    required this.border,
    required this.borderActive,
    required this.fg,
    required this.muted,
    required this.subtle,
    required this.blue,
    required this.purple,
    required this.green,
    required this.orange,
    required this.pink,
    required this.cyan,
    Color? paper,
    Color? ink,
  })  : paper = paper ?? bg,
        ink = ink ?? fg;

  /// Exactly the historical Vercel-dark [Palette] constants.
  static const AppColors defaults = AppColors(
    bg: Palette.bg,
    panel: Palette.panel,
    element: Palette.element,
    border: Palette.border,
    borderActive: Palette.borderActive,
    fg: Palette.fg,
    muted: Palette.muted,
    subtle: Palette.subtle,
    blue: Palette.blue,
    purple: Palette.purple,
    green: Palette.green,
    orange: Palette.orange,
    pink: Palette.pink,
    cyan: Palette.cyan,
  );

  /// Page background and app chrome.
  final Color bg;

  /// Raised surfaces: sheets, dialogs, panels, inputs.
  final Color panel;

  /// Interactive fills: buttons, tracks, segmented selection.
  final Color element;

  /// Hairlines and dividers.
  final Color border;

  /// Focused / active hairlines.
  final Color borderActive;

  /// Primary text and icons.
  final Color fg;

  /// Secondary text.
  final Color muted;

  /// Tertiary text and inactive glyphs.
  final Color subtle;

  final Color blue;
  final Color purple;
  final Color green;
  final Color orange;
  final Color pink;
  final Color cyan;

  /// Reading canvas.
  final Color paper;

  /// Reading body text.
  final Color ink;

  /// Semantic aliases, matching [Palette].
  Color get primary => blue;
  Color get success => green;
  Color get warning => orange;
  Color get error => pink;

  /// Accent set for generated art (cover plates pick one by seed). Order is
  /// stable so a book keeps its accent slot across presets.
  List<Color> get accents => [blue, purple, green, orange, cyan, pink];

  /// Nearest [AppColors] in scope; falls back to [defaults] outside a
  /// themed [MaterialApp] (tests that build widgets bare).
  static AppColors of(BuildContext context) =>
      Theme.of(context).extension<AppColors>() ?? defaults;

  @override
  AppColors copyWith({
    Color? bg,
    Color? panel,
    Color? element,
    Color? border,
    Color? borderActive,
    Color? fg,
    Color? muted,
    Color? subtle,
    Color? blue,
    Color? purple,
    Color? green,
    Color? orange,
    Color? pink,
    Color? cyan,
    Color? paper,
    Color? ink,
  }) =>
      AppColors(
        bg: bg ?? this.bg,
        panel: panel ?? this.panel,
        element: element ?? this.element,
        border: border ?? this.border,
        borderActive: borderActive ?? this.borderActive,
        fg: fg ?? this.fg,
        muted: muted ?? this.muted,
        subtle: subtle ?? this.subtle,
        blue: blue ?? this.blue,
        purple: purple ?? this.purple,
        green: green ?? this.green,
        orange: orange ?? this.orange,
        pink: pink ?? this.pink,
        cyan: cyan ?? this.cyan,
        paper: paper ?? this.paper,
        ink: ink ?? this.ink,
      );

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) {
    if (other is! AppColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return AppColors(
      bg: l(bg, other.bg),
      panel: l(panel, other.panel),
      element: l(element, other.element),
      border: l(border, other.border),
      borderActive: l(borderActive, other.borderActive),
      fg: l(fg, other.fg),
      muted: l(muted, other.muted),
      subtle: l(subtle, other.subtle),
      blue: l(blue, other.blue),
      purple: l(purple, other.purple),
      green: l(green, other.green),
      orange: l(orange, other.orange),
      pink: l(pink, other.pink),
      cyan: l(cyan, other.cyan),
      paper: l(paper, other.paper),
      ink: l(ink, other.ink),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is AppColors &&
      other.bg == bg &&
      other.panel == panel &&
      other.element == element &&
      other.border == border &&
      other.borderActive == borderActive &&
      other.fg == fg &&
      other.muted == muted &&
      other.subtle == subtle &&
      other.blue == blue &&
      other.purple == purple &&
      other.green == green &&
      other.orange == orange &&
      other.pink == pink &&
      other.cyan == cyan &&
      other.paper == paper &&
      other.ink == ink;

  @override
  int get hashCode => Object.hash(bg, panel, element, border, borderActive, fg, muted, subtle,
      blue, purple, green, orange, pink, cyan, paper, ink);
}

extension AppColorsContext on BuildContext {
  /// Shorthand for [AppColors.of].
  AppColors get colors => AppColors.of(this);
}

/// CSS `#rrggbb` form for WebView / native colour preferences.
extension AppColorCss on Color {
  String toCssHex() {
    String h(double c) => (c * 255).round().clamp(0, 255).toRadixString(16).padLeft(2, '0');
    return '#${h(r)}${h(g)}${h(b)}';
  }
}
