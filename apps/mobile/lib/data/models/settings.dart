import 'package:flutter/foundation.dart';

/// Connection and engine settings. The app always talks to a Reader API; there
/// is no bundled catalog mode in shipping builds. Fixture catalogs exist only
/// for tests and are injected at the composition root, never chosen here.
@immutable
class AppSettings {
  const AppSettings({
    this.apiBaseUrl = defaultApiBaseUrl,
    this.preferredEngine = 'readium',
  });

  static const defaultApiBaseUrl = 'https://reader.ordinity.com';

  /// Default written by builds that still had a sample mode. Records that
  /// carried it only because sample mode was active adopt the production URL.
  static const _legacyLocalApiBaseUrl = 'http://127.0.0.1:8787';

  final String apiBaseUrl;

  /// Engine id to try first (`readium` or `dart`). If it is unavailable or
  /// fails to open a book, the next available engine is used and the reader
  /// says so.
  final String preferredEngine;

  AppSettings copyWith({String? apiBaseUrl, String? preferredEngine}) => AppSettings(
        apiBaseUrl: apiBaseUrl ?? this.apiBaseUrl,
        preferredEngine: preferredEngine ?? this.preferredEngine,
      );

  Map<String, dynamic> toJson() => {'apiBaseUrl': apiBaseUrl, 'preferredEngine': preferredEngine};

  /// A saved custom URL is always preserved. The legacy `mode` field is read
  /// once for migration: sample-mode installs that never chose an API move to
  /// the production default; API-mode installs keep whatever they had.
  factory AppSettings.fromJson(Map<String, dynamic> json) {
    final legacyMode = json['mode'] as String?;
    var url = json['apiBaseUrl'] as String? ?? defaultApiBaseUrl;
    if (legacyMode == 'sample' && url == _legacyLocalApiBaseUrl) url = defaultApiBaseUrl;
    return AppSettings(
      apiBaseUrl: url,
      preferredEngine: json['preferredEngine'] as String? ?? 'readium',
    );
  }
}

/// Broad typeface class. Always stored as `font` so builds that predate
/// [ReaderPreferences.fontFamilyId] still render a sensible fallback; it must
/// never gain values, because older builds parse it strictly.
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
    this.themeId,
    this.fontFamilyId,
    this.highlightColor,
  });

  final double fontSize;
  final double lineHeight;
  final ReaderFont font;
  final ReaderFlow flow;
  final double marginScale;
  final bool justify;
  final bool keepAwake;

  /// Colour preset id (`default`, `dracula`, ...). Null means no choice has
  /// been made and the Default preset applies. Unknown ids are kept as
  /// written so a newer build's choice survives a downgrade to an older
  /// build, which simply renders Default for them.
  final String? themeId;

  /// Reading typeface id from `readerFontFamilies` (`literata`,
  /// `system-sans`, ...). Null means no specific choice: [font] alone decides.
  /// Unknown ids are kept, like [themeId]. The id only applies while its
  /// class matches [font]; an older build that changes [font] cannot clear
  /// the id, so a mismatch means the older build's class choice wins.
  final String? fontFamilyId;

  /// Default highlight colour key (`yellow`, `green`, ...). Null means
  /// yellow. Unknown keys are kept, like [themeId].
  final String? highlightColor;

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
    String? themeId,
    String? fontFamilyId,
    String? highlightColor,
  }) =>
      ReaderPreferences(
        fontSize: (fontSize ?? this.fontSize).clamp(minFontSize, maxFontSize),
        lineHeight: lineHeight ?? this.lineHeight,
        font: font ?? this.font,
        flow: flow ?? this.flow,
        marginScale: marginScale ?? this.marginScale,
        justify: justify ?? this.justify,
        keepAwake: keepAwake ?? this.keepAwake,
        themeId: themeId ?? this.themeId,
        fontFamilyId: fontFamilyId ?? this.fontFamilyId,
        highlightColor: highlightColor ?? this.highlightColor,
      );

  Map<String, dynamic> toJson() => {
        'fontSize': fontSize,
        'lineHeight': lineHeight,
        'font': font.name,
        'flow': flow.name,
        'marginScale': marginScale,
        'justify': justify,
        'keepAwake': keepAwake,
        if (themeId != null) 'themeId': themeId,
        if (fontFamilyId != null) 'fontFamilyId': fontFamilyId,
        if (highlightColor != null) 'highlightColor': highlightColor,
      };

  factory ReaderPreferences.fromJson(Map<String, dynamic> json) => ReaderPreferences(
        fontSize: (json['fontSize'] as num?)?.toDouble() ?? 18,
        lineHeight: (json['lineHeight'] as num?)?.toDouble() ?? 1.6,
        font: _byName(ReaderFont.values, json['font'], ReaderFont.serif),
        flow: _byName(ReaderFlow.values, json['flow'], ReaderFlow.scrolled),
        marginScale: (json['marginScale'] as num?)?.toDouble() ?? 1.0,
        justify: json['justify'] as bool? ?? false,
        keepAwake: json['keepAwake'] as bool? ?? true,
        themeId: json['themeId'] as String?,
        fontFamilyId: json['fontFamilyId'] is String ? json['fontFamilyId'] as String : null,
        highlightColor: json['highlightColor'] is String ? json['highlightColor'] as String : null,
      );

  /// Unknown or malformed values fall back instead of throwing, so a value
  /// written by a future build cannot make preferences unreadable.
  static T _byName<T extends Enum>(List<T> values, Object? name, T fallback) {
    for (final v in values) {
      if (v.name == name) return v;
    }
    return fallback;
  }
}
