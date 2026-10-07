import 'package:xml/xml.dart';

/// SVG formulas for the Dart engine, the native port of the content
/// enhancer's SVG ink rule (`apps/web/src/reader/enhance/svg.ts`): a
/// formula-like SVG whose paint is only black, greys and `none` has its dark
/// paint switched to `currentColor`, which the view resolves to the reading
/// ink. Illustrations (colour, gradients, embedded images, a light
/// background of their own) keep their paint.
abstract final class EpubSvg {
  /// More elements than this is artwork, not a formula.
  static const maxElements = 4000;

  /// Longest SVG source parsed.
  static const maxLength = 400000;

  static const _paintAttrs = ['fill', 'stroke', 'color'];
  static final _colourful = RegExp(r'gradient|pattern|image|foreignobject|filter|mask', caseSensitive: false);
  static const _named = <String, (int, int, int)>{
    'black': (0, 0, 0), 'white': (255, 255, 255), 'gray': (128, 128, 128), 'grey': (128, 128, 128),
    'dimgray': (105, 105, 105), 'dimgrey': (105, 105, 105), 'darkgray': (169, 169, 169), 'darkgrey': (169, 169, 169),
    'silver': (192, 192, 192), 'lightgray': (211, 211, 211), 'lightgrey': (211, 211, 211), 'gainsboro': (220, 220, 220),
    'whitesmoke': (245, 245, 245),
  };

  /// `none`, `dark`, `light` or `colour`, as the web rule classifies paint.
  static String paintOf(String value) {
    final v = value.trim().toLowerCase();
    if (v.isEmpty || const {'none', 'transparent', 'currentcolor', 'inherit', 'context-stroke', 'context-fill'}.contains(v)) {
      return 'none';
    }
    var rgb = _named[v];
    final hex = RegExp(r'^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$').firstMatch(v);
    if (rgb == null && hex != null) {
      final h = hex[1]!.length <= 4 ? hex[1]!.substring(0, 3).split('').map((c) => '$c$c').join() : hex[1]!.substring(0, 6);
      rgb = (int.parse(h.substring(0, 2), radix: 16), int.parse(h.substring(2, 4), radix: 16), int.parse(h.substring(4, 6), radix: 16));
    }
    final fn = RegExp(r'^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)').firstMatch(v);
    if (rgb == null && fn != null) {
      int c(int i) => (fn[i + 1]!.isNotEmpty ? double.parse(fn[i]!) * 255 / 100 : double.parse(fn[i]!)).round();
      rgb = (c(1), c(3), c(5));
    }
    if (rgb == null) return 'colour';
    final (r, g, b) = rgb;
    final spread = [r, g, b].reduce((a, x) => a > x ? a : x) - [r, g, b].reduce((a, x) => a < x ? a : x);
    final lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (spread > 40) return 'colour';
    return lum < 0.45 ? 'dark' : lum > 0.8 ? 'light' : 'colour';
  }

  static List<(String, String)> _stylePaints(String style) => [
        for (final decl in style.split(';'))
          if (decl.contains(':') && _paintAttrs.contains(decl.substring(0, decl.indexOf(':')).trim().toLowerCase()))
            (
              decl.substring(0, decl.indexOf(':')).trim().toLowerCase(),
              decl.substring(decl.indexOf(':') + 1).replaceAll(RegExp('!important', caseSensitive: false), '').trim(),
            ),
      ];

  /// The parsed SVG, or null when [source] is not one (or too big to be a formula).
  static XmlElement? parse(String source) {
    if (source.length > maxLength) return null;
    try {
      final root = XmlDocument.parse(source).rootElement;
      return root.localName == 'svg' ? root : null;
    } on Object {
      return null;
    }
  }

  /// [svg] with its dark paint as `currentColor`, or null when it is not a
  /// monochrome drawing (colour, gradients, images, a light background, a
  /// class stylesheet that sets paint) or too large.
  static String? inked(XmlElement svg) {
    final all = [svg, ...svg.descendantElements];
    if (all.length > maxElements) return null;
    final dark = <(XmlElement, String, bool)>[];
    for (final el in all) {
      final name = el.localName.toLowerCase();
      if (_colourful.hasMatch(name)) return null;
      if (name == 'style') {
        if (RegExp(r'\b(fill|stroke|color)\s*:', caseSensitive: false).hasMatch(el.innerText)) return null;
        continue;
      }
      final paints = <(String, String, bool)>[
        for (final a in _paintAttrs)
          if (el.getAttribute(a) case final v?) (a, v, false),
        for (final (a, v) in _stylePaints(el.getAttribute('style') ?? '')) (a, v, true),
      ];
      for (final (a, v, style) in paints) {
        final paint = paintOf(v);
        if (paint == 'colour' || paint == 'light') return null;
        if (paint == 'dark') dark.add((el, a, style));
      }
    }
    final copy = svg.copy();
    final copies = [copy, ...copy.descendantElements];
    final index = {for (var i = 0; i < all.length; i++) all[i]: i};
    for (final (el, name, style) in dark) {
      final target = copies[index[el]!];
      if (!style) {
        target.setAttribute(name, 'currentColor');
      } else {
        final css = target.getAttribute('style') ?? '';
        target.setAttribute(
          'style',
          css.split(';').map((d) => d.contains(':') && d.substring(0, d.indexOf(':')).trim().toLowerCase() == name ? '$name:currentColor' : d).join(';'),
        );
      }
    }
    // Unpainted shapes are black by default.
    if (copy.getAttribute('fill') == null && !_stylePaints(copy.getAttribute('style') ?? '').any((p) => p.$1 == 'fill')) {
      copy.setAttribute('fill', 'currentColor');
    }
    return copy.toXmlString();
  }

  /// A width or height attribute in logical pixels for a text size [em]
  /// (`2.1ex`, `1.4em`, `40`, `40px`); null when absent or relative.
  static double? length(String? value, double em) {
    final m = RegExp(r'^\s*([\d.]+)\s*(em|ex|px|pt)?\s*$').firstMatch(value ?? '');
    final n = m == null ? null : double.tryParse(m[1]!);
    if (n == null || n <= 0) return null;
    return switch (m![2]) { 'em' => n * em, 'ex' => n * em * 0.45, 'pt' => n * 4 / 3, _ => n };
  }

  /// Sized like text or drawn by a TeX-to-SVG converter.
  static bool looksLikeFormula(XmlElement svg, {required bool mathContext}) {
    if (mathContext) return true;
    if (svg.descendantElements.any((e) => e.getAttribute('data-mml-node') != null || e.getAttribute('data-c') != null)) return true;
    final textSized = RegExp(r'^\s*-?[\d.]+\s*(em|ex)\s*$', caseSensitive: false);
    return textSized.hasMatch(svg.getAttribute('width') ?? '') ||
        textSized.hasMatch(svg.getAttribute('height') ?? '') ||
        RegExp('vertical-align', caseSensitive: false).hasMatch(svg.getAttribute('style') ?? '');
  }
}
