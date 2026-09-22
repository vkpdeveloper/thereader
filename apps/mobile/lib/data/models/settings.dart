import 'package:flutter/foundation.dart';

/// Which catalog the app talks to. Sample mode is bundled and clearly labelled;
/// API mode talks to the user's own Worker. Never silently swapped.
enum AppMode { sample, api }

@immutable
class AppSettings {
  const AppSettings({
    this.mode = AppMode.sample,
    this.apiBaseUrl = 'http://127.0.0.1:8787',
    this.preferredEngine = 'readium',
  });

  final AppMode mode;
  final String apiBaseUrl;

  /// Engine id to try first (`readium` or `dart`). If it is unavailable or
  /// fails to open a book, the next available engine is used and the reader
  /// says so.
  final String preferredEngine;

  AppSettings copyWith({AppMode? mode, String? apiBaseUrl, String? preferredEngine}) => AppSettings(
        mode: mode ?? this.mode,
        apiBaseUrl: apiBaseUrl ?? this.apiBaseUrl,
        preferredEngine: preferredEngine ?? this.preferredEngine,
      );

  Map<String, dynamic> toJson() =>
      {'mode': mode.name, 'apiBaseUrl': apiBaseUrl, 'preferredEngine': preferredEngine};

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
        mode: AppMode.values.byName(json['mode'] as String? ?? 'sample'),
        apiBaseUrl: json['apiBaseUrl'] as String? ?? 'http://127.0.0.1:8787',
        preferredEngine: json['preferredEngine'] as String? ?? 'readium',
      );
}

enum ReaderFont { serif, sans }

enum ReaderFlow { scrolled, paginated }

/// Typography and layout preferences for the reading surface. Applied by the
/// active engine; the Dart engine honours all of them.
@immutable
class ReaderPreferences {
  const ReaderPreferences({
    this.fontSize = 18,
    this.lineHeight = 1.6,
    this.font = ReaderFont.serif,
    this.flow = ReaderFlow.scrolled,
    this.marginScale = 1.0,
    this.justify = false,
    this.keepAwake = true,
  });

  final double fontSize;
  final double lineHeight;
  final ReaderFont font;
  final ReaderFlow flow;
  final double marginScale;
  final bool justify;
  final bool keepAwake;

  static const double minFontSize = 14;
  static const double maxFontSize = 28;

  ReaderPreferences copyWith({
    double? fontSize,
    double? lineHeight,
    ReaderFont? font,
    ReaderFlow? flow,
    double? marginScale,
    bool? justify,
    bool? keepAwake,
  }) =>
      ReaderPreferences(
        fontSize: (fontSize ?? this.fontSize).clamp(minFontSize, maxFontSize),
        lineHeight: lineHeight ?? this.lineHeight,
        font: font ?? this.font,
        flow: flow ?? this.flow,
        marginScale: marginScale ?? this.marginScale,
        justify: justify ?? this.justify,
        keepAwake: keepAwake ?? this.keepAwake,
      );

  Map<String, dynamic> toJson() => {
        'fontSize': fontSize,
        'lineHeight': lineHeight,
        'font': font.name,
        'flow': flow.name,
        'marginScale': marginScale,
        'justify': justify,
        'keepAwake': keepAwake,
      };

  factory ReaderPreferences.fromJson(Map<String, dynamic> json) => ReaderPreferences(
        fontSize: (json['fontSize'] as num?)?.toDouble() ?? 18,
        lineHeight: (json['lineHeight'] as num?)?.toDouble() ?? 1.6,
        font: ReaderFont.values.byName(json['font'] as String? ?? 'serif'),
        flow: ReaderFlow.values.byName(json['flow'] as String? ?? 'scrolled'),
        marginScale: (json['marginScale'] as num?)?.toDouble() ?? 1.0,
        justify: json['justify'] as bool? ?? false,
        keepAwake: json['keepAwake'] as bool? ?? true,
      );
}
