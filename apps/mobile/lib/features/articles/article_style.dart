import 'package:flutter/material.dart';
import 'package:truffle/truffle.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/tokens.dart';
import '../../core/typography/reader_fonts.dart';
import '../../data/models/settings.dart';
import 'article_highlights.dart';

/// Reading typography for articles, derived from the reader preferences so an
/// article looks like a book in the same theme, face, size and measure.
@immutable
class ArticleStyle {
  ArticleStyle({
    required this.colors,
    required this.family,
    required this.fontSize,
    required this.lineHeight,
    required this.justify,
    required this.gutter,
    required this.ink,
    this.italic = false,
  });

  factory ArticleStyle.of(ReaderPreferences prefs, AppColors colors) => ArticleStyle(
        colors: colors,
        family: ReaderFonts.resolve(prefs),
        fontSize: prefs.fontSize,
        lineHeight: prefs.lineHeight,
        justify: prefs.justify,
        gutter: (Space.gutter + 8) * prefs.marginScale,
        ink: colors.ink,
      );

  /// This style at [scale] times the size, optionally italic or recoloured:
  /// notes and embeds read smaller, quotes in muted italics.
  ArticleStyle derive({double scale = 1, bool? italic, Color? ink}) => ArticleStyle(
        colors: colors,
        family: family,
        fontSize: fontSize * scale,
        lineHeight: lineHeight,
        justify: justify,
        gutter: gutter,
        ink: ink ?? this.ink,
        italic: italic ?? this.italic,
      );

  final AppColors colors;
  final ReaderFontFamily family;
  final double fontSize;
  final double lineHeight;
  final bool justify;

  /// Body text colour.
  final Color ink;
  final bool italic;

  /// Horizontal page margin.
  final double gutter;

  /// Longest comfortable line on wide screens.
  static const double measure = 680;

  late final TextStyle body = TextStyle(
    fontFamily: family.flutterFamily,
    fontFamilyFallback: family.flutterFallback,
    fontSize: fontSize,
    height: lineHeight,
    color: ink,
    fontWeight: FontWeight.w400,
    fontStyle: italic ? FontStyle.italic : FontStyle.normal,
  );

  late final TextStyle mono = TextStyle(
    fontFamily: 'monospace',
    fontFamilyFallback: const ['Menlo', 'SF Mono', 'Courier New', 'Roboto Mono'],
    fontSize: (fontSize * 0.8).clamp(12.0, 17.0),
    height: 1.5,
    color: colors.ink,
  );

  /// Captions, credits and cites: the interface face, small and muted.
  late final TextStyle caption = TextStyle(
    fontFamily: Fonts.sans,
    fontSize: (fontSize * 0.74).clamp(12.0, 17.0),
    height: 1.45,
    color: colors.muted,
  );

  TextAlign get align => justify ? TextAlign.justify : TextAlign.start;

  /// Space between top-level blocks.
  double get gap => fontSize * 1.1;

  /// Space between blocks nested in lists, quotes and callouts.
  double get innerGap => fontSize * 0.6;

  TextStyle heading(int level) => body.copyWith(
        fontSize: fontSize * switch (level) { 2 => 1.42, 3 => 1.2, 4 => 1.08, _ => 1.0 },
        fontWeight: level <= 3 ? FontWeight.w700 : FontWeight.w600,
        height: 1.25,
        color: level == 6 ? colors.muted : ink,
      );

  @override
  bool operator ==(Object other) =>
      other is ArticleStyle &&
      other.colors == colors &&
      other.family.id == family.id &&
      other.fontSize == fontSize &&
      other.lineHeight == lineHeight &&
      other.justify == justify &&
      other.gutter == gutter &&
      other.ink == ink &&
      other.italic == italic;

  @override
  int get hashCode => Object.hash(colors, family.id, fontSize, lineHeight, justify, gutter, ink, italic);
}

/// Everything a block needs from the screen: typography and the actions that
/// leave the text (links, footnotes, the image viewer).
class ArticleScope extends InheritedWidget {
  const ArticleScope({
    super.key,
    required this.style,
    required this.onLink,
    required this.onFootnote,
    required this.onFootnoteBack,
    required this.onImages,
    required this.footnoteKey,
    this.highlights,
    required super.child,
  });

  final ArticleStyle style;
  final ValueChanged<String> onLink;
  final ValueChanged<String> onFootnote;
  final VoidCallback onFootnoteBack;
  final void Function(List<ArticleImage> images, int index) onImages;
  final GlobalKey Function(String id) footnoteKey;

  /// The article's highlights; null where there are none (no store).
  final ArticleHighlights? highlights;

  static ArticleScope of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<ArticleScope>()!;

  /// [child] drawn in [style] with the same actions.
  Widget restyled(ArticleStyle style, Widget child) => ArticleScope(
        style: style,
        onLink: onLink,
        onFootnote: onFootnote,
        onFootnoteBack: onFootnoteBack,
        onImages: onImages,
        footnoteKey: footnoteKey,
        highlights: highlights,
        child: child,
      );

  @override
  bool updateShouldNotify(ArticleScope oldWidget) =>
      style != oldWidget.style || !identical(highlights, oldWidget.highlights);
}
