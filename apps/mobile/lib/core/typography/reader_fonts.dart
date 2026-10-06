import 'package:flutter/foundation.dart';

import '../../data/models/settings.dart';

/// One bundled font file. Weights are the variable axis range of the file.
@immutable
class ReaderFontFace {
  const ReaderFontFace({required this.asset, this.italic = false, this.minWeight = 100, this.maxWeight = 900});

  /// Flutter asset key, e.g. `assets/fonts/Literata.ttf`.
  final String asset;
  final bool italic;
  final int minWeight;
  final int maxWeight;

  Map<String, Object> toJson() => {
        'asset': asset,
        'style': italic ? 'italic' : 'normal',
        'minWeight': minWeight,
        'maxWeight': maxWeight,
      };
}

/// A reading typeface offered in the picker. Bundled families ship their
/// files offline (see `docs/reader-typography.md`); system families use the
/// platform's generic serif or sans-serif and have no [faces].
@immutable
class ReaderFontFamily {
  const ReaderFontFamily({
    required this.id,
    required this.label,
    required this.fontClass,
    required this.description,
    this.cssFamily,
    this.faces = const [],
    this.recommended = false,
  });

  /// Stable id persisted as [ReaderPreferences.fontFamilyId]. Never rename.
  final String id;
  final String label;

  /// Written as the legacy `font` so older builds fall back to the same class.
  final ReaderFont fontClass;
  final String description;

  /// Family name used in CSS and as the Flutter `fontFamily`, matching the
  /// pubspec family. No spaces, so native CSS never needs quoting. Null for
  /// system families.
  final String? cssFamily;
  final List<ReaderFontFace> faces;
  final bool recommended;

  bool get isBundled => cssFamily != null;

  /// CSS generic for [fontClass], also the native fallback alternate.
  String get genericFamily => fontClass == ReaderFont.serif ? 'serif' : 'sans-serif';

  /// Value for Readium's `fontFamily` preference.
  String get readiumFamily => cssFamily ?? genericFamily;

  /// Flutter `fontFamily` for previews and the Dart engine. System families
  /// name the platform generic explicitly: a null family would inherit the
  /// app's Inter and silently misrepresent "System sans".
  String get flutterFamily => cssFamily ?? (fontClass == ReaderFont.serif ? 'serif' : 'sans-serif');

  /// Resolves the generics on iOS, where Flutter does not know `serif` or
  /// `sans-serif` (Android maps both natively to Noto Serif / Roboto).
  List<String>? get flutterFallback => isBundled
      ? null
      : fontClass == ReaderFont.serif
          ? const ['Times New Roman', 'Georgia']
          : const ['CupertinoSystemText', 'Roboto'];

  /// Wire description for the native navigators' font declarations.
  Map<String, Object> toNativeJson() => {
        'name': cssFamily!,
        'fallback': genericFamily,
        'faces': [for (final f in faces) f.toJson()],
      };
}

abstract final class ReaderFonts {
  static const systemSerif = ReaderFontFamily(
    id: 'system-serif',
    label: 'System serif',
    fontClass: ReaderFont.serif,
    description: "Your device's built-in serif.",
  );

  static const systemSans = ReaderFontFamily(
    id: 'system-sans',
    label: 'System sans',
    fontClass: ReaderFont.sans,
    description: "Your device's built-in sans-serif.",
  );

  /// The default reading face. Static Regular and Bold, each with an italic.
  static const libron = ReaderFontFamily(
    id: 'libron',
    label: 'Libron',
    cssFamily: 'Libron',
    fontClass: ReaderFont.serif,
    recommended: true,
    description: 'Calm, neutral book serif with small caps, made for reading.',
    faces: [
      ReaderFontFace(asset: 'assets/fonts/Libron-Regular.ttf', minWeight: 400, maxWeight: 400),
      ReaderFontFace(asset: 'assets/fonts/Libron-Italic.ttf', italic: true, minWeight: 400, maxWeight: 400),
      ReaderFontFace(asset: 'assets/fonts/Libron-Bold.ttf', minWeight: 700, maxWeight: 700),
      ReaderFontFace(asset: 'assets/fonts/Libron-BoldItalic.ttf', italic: true, minWeight: 700, maxWeight: 700),
    ],
  );

  static const literata = ReaderFontFamily(
    id: 'literata',
    label: 'Literata',
    cssFamily: 'Literata',
    fontClass: ReaderFont.serif,
    description: 'Book serif drawn for long reading on screens.',
    faces: [
      ReaderFontFace(asset: 'assets/fonts/Literata.ttf', minWeight: 200, maxWeight: 900),
      ReaderFontFace(asset: 'assets/fonts/Literata-Italic.ttf', italic: true, minWeight: 200, maxWeight: 900),
    ],
  );

  static const sourceSerif = ReaderFontFamily(
    id: 'source-serif-4',
    label: 'Source Serif 4',
    cssFamily: 'SourceSerif4',
    fontClass: ReaderFont.serif,
    description: 'Crisp transitional serif with optical sizes.',
    faces: [
      ReaderFontFace(asset: 'assets/fonts/SourceSerif4.ttf', minWeight: 200, maxWeight: 900),
      ReaderFontFace(asset: 'assets/fonts/SourceSerif4-Italic.ttf', italic: true, minWeight: 200, maxWeight: 900),
    ],
  );

  static const atkinson = ReaderFontFamily(
    id: 'atkinson-hyperlegible-next',
    label: 'Atkinson Hyperlegible',
    cssFamily: 'AtkinsonHyperlegibleNext',
    fontClass: ReaderFont.sans,
    description: 'Sans with distinct shapes for look-alike letters such as I, l and 1.',
    faces: [
      ReaderFontFace(asset: 'assets/fonts/AtkinsonHyperlegibleNext.ttf', minWeight: 200, maxWeight: 800),
      ReaderFontFace(asset: 'assets/fonts/AtkinsonHyperlegibleNext-Italic.ttf', italic: true, minWeight: 200, maxWeight: 800),
    ],
  );

  /// Lexend has no upstream italic; italic text is slanted by the renderer.
  static const lexend = ReaderFontFamily(
    id: 'lexend',
    label: 'Lexend',
    cssFamily: 'Lexend',
    fontClass: ReaderFont.sans,
    description: 'Wide, open sans with roomy letter spacing.',
    faces: [ReaderFontFace(asset: 'assets/fonts/Lexend.ttf', minWeight: 100, maxWeight: 900)],
  );

  static const inter = ReaderFontFamily(
    id: 'inter',
    label: 'Inter',
    cssFamily: 'Inter',
    fontClass: ReaderFont.sans,
    description: 'Neutral sans, the same face as the app interface.',
    faces: [
      ReaderFontFace(asset: 'assets/fonts/Inter.ttf', minWeight: 100, maxWeight: 900),
      ReaderFontFace(asset: 'assets/fonts/Inter-Italic.ttf', italic: true, minWeight: 100, maxWeight: 900),
    ],
  );

  /// Picker order.
  static const List<ReaderFontFamily> all = [libron, literata, sourceSerif, atkinson, lexend, inter, systemSerif, systemSans];

  static List<ReaderFontFamily> get bundled => [for (final f in all) if (f.isBundled) f];

  static ReaderFontFamily? byId(String? id) {
    for (final f in all) {
      if (f.id == id) return f;
    }
    return null;
  }

  /// The family to render. A known id applies only while its class matches
  /// the stored `font`; otherwise (no id, unknown id, or an older build
  /// changed the class) serif renders Libron, the default, and sans the
  /// system sans. An explicit `system-serif` choice is kept.
  static ReaderFontFamily resolve(ReaderPreferences p) {
    final chosen = byId(p.fontFamilyId);
    if (chosen != null && chosen.fontClass == p.font) return chosen;
    return p.font == ReaderFont.serif ? libron : systemSans;
  }

  /// Preferences after choosing [family]: the id is always written, even
  /// for system families, so a stale id from an earlier choice cannot linger.
  static ReaderPreferences select(ReaderPreferences p, ReaderFontFamily family) =>
      p.copyWith(font: family.fontClass, fontFamilyId: family.id);
}
