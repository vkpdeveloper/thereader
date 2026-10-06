import 'dart:ui' show Color;

import 'package:xml/xml.dart';

/// An article SVG made drawable by flutter_svg, which ignores `<style>`,
/// classes, `var()` and CSS system colours.
class PreparedSvg {
  const PreparedSvg({required this.source, required this.ink, required this.onLight});

  final String source;

  /// What `currentColor` and system text colours resolved to.
  final Color ink;

  /// The SVG draws dark ink on a transparent canvas and is shown on a light
  /// panel, as a browser would show it on a white page.
  final bool onLight;
}

/// Rewrites [source] so flutter_svg draws it the way a browser would: simple
/// stylesheet rules (tag, class and id selectors, descendant and child
/// combinators) become presentation attributes, `var()` and `light-dark()`
/// resolve, and system colours such as `canvastext` map to [ink] on [paper].
///
/// SVGs that declare a dark colour scheme are drawn dark, straight on the
/// page. Others that draw dark ink without a background of their own are
/// drawn light — [ink] and [paper] swap and [PreparedSvg.onLight] is set.
///
/// Returns null when the source isn't an SVG or draws nothing visible.
PreparedSvg? prepareSvg(String source, {required Color ink, required Color paper}) {
  final XmlDocument document;
  try {
    document = XmlDocument.parse(source);
  } on XmlException {
    return null;
  }
  final root = document.rootElement;
  if (root.localName != 'svg') return null;

  final styles = root.descendantElements.where((e) => e.localName == 'style').toList();
  final css = styles.map((e) => e.innerText).join('\n').replaceAll(_comment, '');
  final dark = _prefersDark.hasMatch(css) || _darkScheme.hasMatch(css) || _darkScheme.hasMatch(root.getAttribute('style') ?? '');
  final rules = _parseRules(css, dark: dark);
  for (final style in styles) {
    style.remove();
  }

  _cascade(root, const {}, rules, dark: dark);

  final paint = _Paint.scan(root);
  if (!paint.visible) return null;
  final onLight = !dark && paint.darkInk && !paint.ownBackground;
  final (useInk, usePaper) = onLight ? (paper, ink) : (ink, paper);
  _mapSystemColours(root, ink: useInk, paper: usePaper);
  return PreparedSvg(source: document.toXmlString(), ink: useInk, onLight: onLight);
}

final _comment = RegExp(r'/\*[\s\S]*?\*/');
final _prefersDark = RegExp(r'prefers-color-scheme\s*:\s*dark', caseSensitive: false);
final _darkScheme = RegExp(r'color-scheme\s*:[^;}]*\bdark\b', caseSensitive: false);

// ------------------------------------------------------------ stylesheet

class _Declaration {
  const _Declaration(this.property, this.value, {this.important = false});

  final String property;
  final String value;
  final bool important;
}

class _Rule {
  const _Rule(this.selectors, this.declarations, this.order);

  final List<_Selector> selectors;
  final List<_Declaration> declarations;
  final int order;
}

/// Top-level rules of [css]. `prefers-color-scheme` media blocks apply when
/// they match the scheme; other at-rules are dropped.
List<_Rule> _parseRules(String css, {required bool dark}) {
  final rules = <_Rule>[];
  void parse(String text) {
    var i = 0;
    while (i < text.length) {
      final open = text.indexOf('{', i);
      if (open < 0) return;
      final close = _matching(text, open, '{', '}');
      if (close < 0) return;
      final prelude = text.substring(i, open).trim();
      final body = text.substring(open + 1, close);
      i = close + 1;
      if (prelude.startsWith('@')) {
        final scheme = RegExp(r'prefers-color-scheme\s*:\s*(\w+)', caseSensitive: false).firstMatch(prelude);
        final only = prelude
            .replaceAll(RegExp(r'^@media\s+|\(prefers-color-scheme\s*:\s*\w+\)|\b(?:screen|all|and)\b', caseSensitive: false), '')
            .trim();
        if (scheme != null && only.isEmpty && (scheme.group(1)!.toLowerCase() == 'dark') == dark) parse(body);
        continue;
      }
      final selectors = [for (final s in prelude.split(',')) ?_Selector.parse(s.trim())];
      if (selectors.isEmpty) continue;
      rules.add(_Rule(selectors, _declarations(body), rules.length));
    }
  }

  parse(css);
  return rules;
}

List<_Declaration> _declarations(String block) {
  final out = <_Declaration>[];
  for (final part in block.split(';')) {
    final colon = part.indexOf(':');
    if (colon <= 0) continue;
    final property = part.substring(0, colon).trim();
    var value = part.substring(colon + 1).trim();
    final important = value.toLowerCase().endsWith('!important');
    if (important) value = value.substring(0, value.length - 10).trim();
    if (property.isEmpty || value.isEmpty) continue;
    out.add(_Declaration(property.startsWith('--') ? property : property.toLowerCase(), value, important: important));
  }
  return out;
}

int _matching(String text, int open, String opener, String closer) {
  var depth = 0;
  for (var i = open; i < text.length; i++) {
    if (text[i] == opener) depth++;
    if (text[i] == closer && --depth == 0) return i;
  }
  return -1;
}

/// One compound selector: `tag.class#id`, `*` or `:root`.
class _Compound {
  const _Compound({this.tag, this.classes = const [], this.id, this.root = false});

  final String? tag;
  final List<String> classes;
  final String? id;
  final bool root;

  static final _pattern = RegExp(r'^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$');

  static _Compound? parse(String text) {
    if (text == ':root') return const _Compound(root: true);
    final match = _pattern.firstMatch(text);
    if (match == null) return null;
    final tag = match.group(1);
    final classes = <String>[];
    String? id;
    for (final m in RegExp(r'([.#])([\w-]+)').allMatches(match.group(2)!)) {
      if (m.group(1) == '.') {
        classes.add(m.group(2)!);
      } else {
        id = m.group(2);
      }
    }
    return _Compound(tag: tag == '*' ? null : tag, classes: classes, id: id);
  }

  int get specificity => (id != null ? 100 : 0) + (classes.length + (root ? 1 : 0)) * 10 + (tag != null ? 1 : 0);

  bool matches(XmlElement element) {
    if (root) return element.parentElement == null;
    if (tag != null && element.localName.toLowerCase() != tag!.toLowerCase()) return false;
    if (id != null && element.getAttribute('id') != id) return false;
    if (classes.isEmpty) return true;
    final own = (element.getAttribute('class') ?? '').split(RegExp(r'\s+'));
    return classes.every(own.contains);
  }
}

/// Compounds joined by descendant (` `) or child (`>`) combinators.
class _Selector {
  const _Selector(this.parts, this.child);

  final List<_Compound> parts;

  /// `child[i]` joins `parts[i]` to `parts[i + 1]` with `>`.
  final List<bool> child;

  static _Selector? parse(String text) {
    final tokens = text.replaceAll('>', ' > ').trim().split(RegExp(r'\s+'));
    final parts = <_Compound>[];
    final child = <bool>[];
    var pendingChild = false;
    for (final token in tokens) {
      if (token.isEmpty) continue;
      if (token == '>') {
        if (parts.isEmpty || pendingChild) return null;
        pendingChild = true;
        continue;
      }
      final compound = _Compound.parse(token);
      if (compound == null) return null;
      if (parts.isNotEmpty) child.add(pendingChild);
      pendingChild = false;
      parts.add(compound);
    }
    if (parts.isEmpty || pendingChild) return null;
    return _Selector(parts, child);
  }

  int get specificity => parts.fold(0, (sum, p) => sum + p.specificity);

  bool matches(XmlElement element) => _match(parts.length - 1, element);

  bool _match(int index, XmlElement element) {
    if (!parts[index].matches(element)) return false;
    if (index == 0) return true;
    var ancestor = element.parentElement;
    if (child[index - 1]) return ancestor != null && _match(index - 1, ancestor);
    while (ancestor != null) {
      if (_match(index - 1, ancestor)) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }
}

// ------------------------------------------------------------ cascade

/// Applies [rules] and inline styles to [element] and its subtree as
/// presentation attributes, resolving `var()` against inherited custom
/// properties.
void _cascade(XmlElement element, Map<String, String> inherited, List<_Rule> rules, {required bool dark}) {
  final matched = <(int, int, _Declaration)>[];
  for (final rule in rules) {
    var best = -1;
    for (final selector in rule.selectors) {
      if (selector.specificity > best && selector.matches(element)) best = selector.specificity;
    }
    if (best < 0) continue;
    for (final d in rule.declarations) {
      matched.add((best, rule.order, d));
    }
  }
  matched.sort((a, b) => a.$1 != b.$1 ? a.$1.compareTo(b.$1) : a.$2.compareTo(b.$2));
  final inline = _declarations(element.getAttribute('style') ?? '');
  element.removeAttribute('style');
  final ordered = [
    for (final m in matched)
      if (!m.$3.important) m.$3,
    for (final d in inline)
      if (!d.important) d,
    for (final m in matched)
      if (m.$3.important) m.$3,
    for (final d in inline)
      if (d.important) d,
  ];

  final vars = Map.of(inherited);
  for (final d in ordered) {
    if (d.property.startsWith('--')) {
      vars[d.property] = d.value;
    } else if (d.property == 'font') {
      _font(d.value).forEach(element.setAttribute);
    } else {
      element.setAttribute(d.property, d.value);
    }
  }

  for (final attribute in element.attributes.toList()) {
    final value = attribute.value;
    if (!value.contains('(')) continue;
    final resolved = _resolve(value, vars, dark: dark, depth: 0);
    if (resolved == value) continue;
    if (resolved.trim().isEmpty) {
      element.attributes.remove(attribute);
    } else {
      attribute.value = resolved.trim();
    }
  }

  for (final child in element.childElements.toList()) {
    if (child.localName == 'script') continue;
    _cascade(child, vars, rules, dark: dark);
  }
}

/// `font: [style] [weight] size[/line-height] family` as longhands.
Map<String, String> _font(String value) {
  final match = RegExp(r'^(.*?)\b(\d*\.?\d+(?:px|pt|em|rem|%)?)(?:\s*/\s*\S+)?\s+(.+)$').firstMatch(value.trim());
  if (match == null) return const {};
  final out = <String, String>{'font-size': match.group(2)!, 'font-family': match.group(3)!.trim()};
  for (final word in match.group(1)!.trim().split(RegExp(r'\s+'))) {
    if (word == 'italic' || word == 'oblique') out['font-style'] = word;
    if (word == 'bold' || RegExp(r'^[1-9]00$').hasMatch(word)) out['font-weight'] = word;
  }
  return out;
}

/// [value] with `var()` and `light-dark()` substituted.
String _resolve(String value, Map<String, String> vars, {required bool dark, required int depth}) {
  if (depth > 8) return '';
  final out = StringBuffer();
  var i = 0;
  while (i < value.length) {
    final match = _function.allMatches(value, i).firstOrNull;
    if (match == null) {
      out.write(value.substring(i));
      break;
    }
    out.write(value.substring(i, match.start));
    final open = match.end - 1;
    final close = _matching(value, open, '(', ')');
    if (close < 0) {
      out.write(value.substring(match.start));
      break;
    }
    final inner = value.substring(open + 1, close);
    final comma = _topLevelComma(inner);
    final first = (comma < 0 ? inner : inner.substring(0, comma)).trim();
    final second = comma < 0 ? null : inner.substring(comma + 1).trim();
    if (match.group(1)!.toLowerCase() == 'var') {
      final declared = vars[first];
      final chosen = declared ?? second ?? '';
      out.write(_resolve(chosen, vars, dark: dark, depth: depth + 1));
    } else {
      out.write(_resolve(dark ? (second ?? first) : first, vars, dark: dark, depth: depth + 1));
    }
    i = close + 1;
  }
  return out.toString();
}

final _function = RegExp(r'\b(var|light-dark)\(', caseSensitive: false);

int _topLevelComma(String text) {
  var depth = 0;
  for (var i = 0; i < text.length; i++) {
    final c = text[i];
    if (c == '(') depth++;
    if (c == ')') depth--;
    if (c == ',' && depth == 0) return i;
  }
  return -1;
}

// ------------------------------------------------------------ colours

const _paintAttributes = {'fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'};

const _inkKeywords = {
  'canvastext',
  'windowtext',
  'buttontext',
  'fieldtext',
  'buttonborder',
  'marktext',
  'highlighttext',
  'selecteditemtext',
  'accentcolor',
  'accentcolortext',
  'linktext',
  'visitedtext',
  'activetext',
  'captiontext',
  'infotext',
  'menutext',
  'windowframe',
};
const _paperKeywords = {'canvas', 'window', 'field', 'buttonface', 'background', 'menu', 'infobackground', 'mark'};

void _mapSystemColours(XmlElement root, {required Color ink, required Color paper}) {
  final gray = Color.lerp(ink, paper, 0.45)!;
  for (final element in [root, ...root.descendantElements]) {
    for (final attribute in element.attributes) {
      if (!_paintAttributes.contains(attribute.localName)) continue;
      final value = attribute.value.trim().toLowerCase();
      if (!RegExp(r'^[a-z]+$').hasMatch(value)) continue;
      if (_inkKeywords.contains(value)) {
        attribute.value = _hex(ink);
      } else if (_paperKeywords.contains(value)) {
        attribute.value = _hex(paper);
      } else if (value == 'graytext') {
        attribute.value = _hex(gray);
      } else if (value != 'currentcolor') {
        // flutter_svg's named colours are case-sensitive; CSS keywords aren't.
        attribute.value = value;
      }
    }
  }
}

String _hex(Color c) => '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

/// Relative luminance of a CSS colour, or null when it isn't a plain colour
/// (`none`, `url()`, system colours, unknown names).
double? _luminance(String value) {
  final v = value.trim().toLowerCase();
  int? argb;
  if (v.startsWith('#')) {
    var hex = v.substring(1);
    if (hex.length == 3 || hex.length == 4) hex = hex.split('').map((c) => '$c$c').join();
    if (hex.length == 8) {
      if (int.tryParse(hex.substring(6), radix: 16) == 0) return null;
      hex = hex.substring(0, 6);
    }
    if (hex.length == 6) argb = int.tryParse(hex, radix: 16);
  } else if (v.startsWith('rgb')) {
    final n = RegExp(r'[\d.]+%?').allMatches(v).map((m) => m.group(0)!).toList();
    if (n.length < 3) return null;
    if (n.length > 3 && (double.tryParse(n[3].replaceAll('%', '')) ?? 1) == 0) return null;
    int channel(String s) =>
        s.endsWith('%') ? ((double.tryParse(s.substring(0, s.length - 1)) ?? 0) * 2.55).round() : (double.tryParse(s) ?? 0).round();
    argb = (channel(n[0]).clamp(0, 255) << 16) | (channel(n[1]).clamp(0, 255) << 8) | channel(n[2]).clamp(0, 255);
  } else {
    argb = _darkNames[v];
  }
  if (argb == null) return null;
  return Color(0xFF000000 | argb).computeLuminance();
}

/// Named colours too dark to read on black; other names count as light.
const _darkNames = {
  'black': 0x000000,
  'navy': 0x000080,
  'darkblue': 0x00008b,
  'mediumblue': 0x0000cd,
  'blue': 0x0000ff,
  'midnightblue': 0x191970,
  'darkslategray': 0x2f4f4f,
  'darkslategrey': 0x2f4f4f,
  'maroon': 0x800000,
  'darkred': 0x8b0000,
  'darkgreen': 0x006400,
  'indigo': 0x4b0082,
  'purple': 0x800080,
  'darkslateblue': 0x483d8b,
};

/// What a cascaded SVG paints, outside definitions.
class _Paint {
  bool visible = false;
  bool darkInk = false;
  bool ownBackground = false;
  bool _first = true;

  static const _shapes = {'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text'};
  static const _hidden = {
    'defs',
    'clipPath',
    'mask',
    'pattern',
    'marker',
    'symbol',
    'linearGradient',
    'radialGradient',
    'filter',
    'title',
    'desc',
    'metadata',
    'script',
    'style',
    'foreignObject',
  };

  static _Paint scan(XmlElement root) {
    final paint = _Paint();
    final viewBox = (root.getAttribute('viewBox') ?? '').split(RegExp(r'[\s,]+')).map(double.tryParse).toList();
    final size = viewBox.length == 4 && viewBox[2] != null && viewBox[3] != null
        ? (viewBox[2]!, viewBox[3]!)
        : (_length(root.getAttribute('width')), _length(root.getAttribute('height')));
    if ((size.$1 ?? 1) <= 0 || (size.$2 ?? 1) <= 0) return paint;
    paint._walk(root, const {'fill': 'black'}, size);
    return paint;
  }

  void _walk(XmlElement element, Map<String, String> inherited, (double?, double?) size) {
    final name = element.localName;
    if (_hidden.contains(name)) return;
    if (element.getAttribute('display') == 'none') return;
    final state = Map.of(inherited);
    for (final key in const ['fill', 'stroke', 'color', 'visibility']) {
      final v = element.getAttribute(key);
      if (v != null && v != 'inherit') state[key] = v;
    }
    final opacity = double.tryParse(element.getAttribute('opacity') ?? '');
    if (opacity != null && opacity <= 0) return;

    if (name == 'image' || name == 'use') {
      visible = true;
      _first = false;
    } else if (_shapes.contains(name) && state['visibility'] != 'hidden') {
      if (name == 'text' && element.innerText.trim().isEmpty) return;
      final fill = name == 'line' ? null : _colour(state['fill'], state);
      final stroke = _colour(state['stroke'], state);
      final paints = [?fill, ?stroke];
      if (paints.isNotEmpty) {
        visible = true;
        if (_first && name == 'rect' && fill != null && _covers(element, size)) {
          ownBackground = true;
        } else if (paints.any((p) => (_luminance(p) ?? 1) < 0.1)) {
          darkInk = true;
        }
        _first = false;
      }
      if (name == 'text') return;
    }
    for (final child in element.childElements) {
      _walk(child, state, size);
    }
  }

  /// A paint value that draws, with `currentColor` resolved, or null.
  static String? _colour(String? value, Map<String, String> state) {
    if (value == null) return null;
    final v = value.trim().toLowerCase();
    if (v == 'none' || v == 'transparent' || v.isEmpty) return null;
    if (v == 'currentcolor') {
      final color = state['color'];
      return color == null || color.toLowerCase() == 'currentcolor' ? 'canvastext' : color;
    }
    return v;
  }

  static bool _covers(XmlElement rect, (double?, double?) size) {
    bool full(String attribute, double? extent) {
      final raw = rect.getAttribute(attribute);
      if (raw == null) return false;
      if (raw.trim() == '100%') return true;
      final value = _length(raw);
      return value != null && extent != null && value >= extent * 0.95;
    }

    return (_length(rect.getAttribute('x')) ?? 0) <= 1 &&
        (_length(rect.getAttribute('y')) ?? 0) <= 1 &&
        full('width', size.$1) &&
        full('height', size.$2);
  }
}

double? _length(String? value) => value == null ? null : double.tryParse(value.trim().replaceAll(RegExp(r'px$'), ''));
