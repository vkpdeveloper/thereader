import 'package:flutter/material.dart';

import 'app_colors.dart';

/// A named colour preset. All presets are dark; there is no light theme.
/// Sources and role mapping for each palette are documented in
/// `docs/theme-presets.md`.
@immutable
class ThemePreset {
  const ThemePreset({required this.id, required this.name, required this.colors});

  /// Stable identifier persisted in [ReaderPreferences.themeId] and validated
  /// by the API. Never rename.
  final String id;
  final String name;
  final AppColors colors;

  static const String defaultId = 'default';

  /// Exact Vercel-dark palette; selected when no preference is saved.
  static const ThemePreset fallback = ThemePreset(
    id: defaultId,
    name: 'Default',
    colors: AppColors.defaults,
  );

  /// Dracula, https://draculatheme.com/contribute (MIT). `panel` uses the
  /// official VS Code theme's darker sidebar background.
  static const ThemePreset dracula = ThemePreset(
    id: 'dracula',
    name: 'Dracula',
    colors: AppColors(
      bg: Color(0xFF282A36),
      panel: Color(0xFF21222C),
      element: Color(0xFF44475A),
      border: Color(0xFF44475A),
      borderActive: Color(0xFF6272A4),
      fg: Color(0xFFF8F8F2),
      muted: Color(0xFFBFC7D5),
      subtle: Color(0xFF6272A4),
      blue: Color(0xFF8BE9FD),
      purple: Color(0xFFBD93F9),
      green: Color(0xFF50FA7B),
      orange: Color(0xFFFFB86C),
      pink: Color(0xFFFF79C6),
      cyan: Color(0xFF8BE9FD),
    ),
  );

  /// Nord, https://www.nordtheme.com/docs/colors-and-palettes (MIT).
  static const ThemePreset nord = ThemePreset(
    id: 'nord',
    name: 'Nord',
    colors: AppColors(
      bg: Color(0xFF2E3440),
      panel: Color(0xFF3B4252),
      element: Color(0xFF434C5E),
      border: Color(0xFF434C5E),
      borderActive: Color(0xFF4C566A),
      fg: Color(0xFFECEFF4),
      muted: Color(0xFFD8DEE9),
      subtle: Color(0xFF7B88A1),
      blue: Color(0xFF88C0D0),
      purple: Color(0xFFB48EAD),
      green: Color(0xFFA3BE8C),
      orange: Color(0xFFD08770),
      pink: Color(0xFFBF616A),
      cyan: Color(0xFF8FBCBB),
    ),
  );

  /// Tokyo Night, https://github.com/tokyo-night/tokyo-night-vscode-theme (MIT).
  static const ThemePreset tokyoNight = ThemePreset(
    id: 'tokyo-night',
    name: 'Tokyo Night',
    colors: AppColors(
      bg: Color(0xFF1A1B26),
      panel: Color(0xFF16161E),
      element: Color(0xFF292E42),
      border: Color(0xFF232433),
      borderActive: Color(0xFF414868),
      fg: Color(0xFFC0CAF5),
      muted: Color(0xFFA9B1D6),
      subtle: Color(0xFF565F89),
      blue: Color(0xFF7AA2F7),
      purple: Color(0xFFBB9AF7),
      green: Color(0xFF9ECE6A),
      orange: Color(0xFFFF9E64),
      pink: Color(0xFFF7768E),
      cyan: Color(0xFF7DCFFF),
    ),
  );

  /// Catppuccin Mocha, https://catppuccin.com/palette (MIT).
  static const ThemePreset catppuccinMocha = ThemePreset(
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    colors: AppColors(
      bg: Color(0xFF1E1E2E),
      panel: Color(0xFF181825),
      element: Color(0xFF313244),
      border: Color(0xFF313244),
      borderActive: Color(0xFF585B70),
      fg: Color(0xFFCDD6F4),
      muted: Color(0xFFA6ADC8),
      subtle: Color(0xFF6C7086),
      blue: Color(0xFF89B4FA),
      purple: Color(0xFFCBA6F7),
      green: Color(0xFFA6E3A1),
      orange: Color(0xFFFAB387),
      pink: Color(0xFFF38BA8),
      cyan: Color(0xFF89DCEB),
    ),
  );

  /// Gruvbox dark (medium contrast), https://github.com/morhetz/gruvbox (MIT).
  static const ThemePreset gruvbox = ThemePreset(
    id: 'gruvbox',
    name: 'Gruvbox',
    colors: AppColors(
      bg: Color(0xFF282828),
      panel: Color(0xFF1D2021),
      element: Color(0xFF3C3836),
      border: Color(0xFF3C3836),
      borderActive: Color(0xFF665C54),
      fg: Color(0xFFEBDBB2),
      muted: Color(0xFFA89984),
      subtle: Color(0xFF928374),
      blue: Color(0xFF83A598),
      purple: Color(0xFFD3869B),
      green: Color(0xFFB8BB26),
      orange: Color(0xFFFE8019),
      pink: Color(0xFFFB4934),
      cyan: Color(0xFF8EC07C),
    ),
  );

  /// Display order in Settings. Default first.
  static const List<ThemePreset> all = [
    fallback,
    dracula,
    nord,
    tokyoNight,
    catppuccinMocha,
    gruvbox,
  ];

  /// Resolves a saved id; unknown or absent ids fall back to Default so a
  /// preference written by a newer build never breaks an older one.
  static ThemePreset byId(String? id) {
    for (final p in all) {
      if (p.id == id) return p;
    }
    return fallback;
  }

  static bool isKnown(String? id) => id != null && all.any((p) => p.id == id);
}
