/// A compact, mutable copy of the parsed page, mirroring `tree.ts`. The DOM is
/// walked exactly once; every later stage (metadata, scoring, cleaning, block
/// conversion) works on these plain objects, so only [fromDom] differs from the
/// TypeScript engine.
library;

import 'js.dart';

sealed class VNode {
  VElement? parent;
}

final class VText extends VNode {
  VText(this.text);

  String text;

  /// Cached [visibleLength] of [text]; -1 until first asked.
  int _len = -1;
  int _commaCount = 0;
  bool _texMarks = false;

  int get length {
    if (_len < 0) _scan();
    return _len;
  }

  int get commas {
    if (_len < 0) _scan();
    return _commaCount;
  }

  /// Whether [text] holds a `$` or a `\` (every TeX delimiter starts with
  /// one), found in the pass that counts commas.
  bool get texMarks {
    if (_len < 0) _scan();
    return _texMarks;
  }

  void _scan() {
    _len = visibleLength(text);
    if (_len == 0) return;
    var n = 0;
    var tex = false;
    for (var i = 0; i < text.length; i++) {
      final c = text.codeUnitAt(i);
      if (c == 0x24 || c == 0x5c) {
        tex = true;
      } else if (_isComma(c)) {
        n++;
      }
    }
    _commaCount = n;
    _texMarks = tex;
  }
}

final class VElement extends VNode {
  VElement(this.tag, this.attrs) : className = attrs['class'] ?? '', id = attrs['id'] ?? '';

  String tag;
  Map<String, String> attrs;
  List<VNode> children = [];

  /// Lowercase class + id, for pattern matching (computed when first asked:
  /// most elements are never matched).
  late final String matchString = className.isEmpty && id.isEmpty ? ' ' : jsLower('$className $id');
  final String className;
  final String id;

  /// Visible text length (whitespace runs count as one), excluding `skip` descendants.
  int textLen = 0;

  /// Text length inside links.
  double linkLen = 0;

  /// Commas (any script) in the text.
  int commas = 0;

  /// Readability-style content score, valid while [scored].
  double score = 0;
  bool scored = false;

  /// Excluded from scoring and output (boilerplate, hidden).
  bool skip = false;

  /// Cached: has a block-level descendant (-1 unknown, 0 no, 1 yes).
  int blockState = -1;

  /// Cached: data table (-1 unknown, 0 layout, 1 data).
  int tableState = -1;

  /// Cached: footnote list container (-1 unknown, 0 no, 1 yes).
  int notesState = -1;

  /// Cached `isContentFrame` (-1 unknown, 0 no, 1 yes); the TypeScript engine recomputes it.
  int frameState = -1;

  /// Set by content normalization: has a block-level descendant.
  bool containsBlock = false;

  String? attr(String name) => attrs[name];

  bool hasClass(String name) {
    if (className.isEmpty || !className.contains(name)) return false;
    // `(' ' + className.replace(/\s+/g, ' ') + ' ').indexOf(' ' + name + ' ') >= 0`
    return hasToken(className, name);
  }

  void append(VNode node) {
    node.parent = this;
    children.add(node);
  }
}

class VDocument {
  VDocument({
    required this.root,
    required this.head,
    required this.body,
    required this.jsonLd,
    this.nextData,
    this.baseHref,
  });

  final VElement root;
  final VElement? head;
  final VElement body;

  /// Raw text of `<script type="application/ld+json">` blocks, in document order.
  final List<String> jsonLd;

  /// Raw text of a Next.js `__NEXT_DATA__` script, if present.
  final String? nextData;

  /// `<base href>`, when the page declares one.
  final String? baseHref;

  /// Reads the JSON form `packages/truffle/scripts/parity-dump.ts` writes: a
  /// text node is a string, an element `{t, a?, c?}`; `head` and `body` are
  /// child-index paths from the root.
  factory VDocument.fromJson(Map<String, dynamic> json) {
    VNode node(Object? value) {
      if (value is String) return VText(value);
      final map = value as Map<String, dynamic>;
      final attrs = <String, String>{};
      final a = map['a'] as Map<String, dynamic>?;
      if (a != null) {
        a.forEach((key, value) => attrs[key] = value as String);
      }
      final el = VElement(map['t'] as String, attrs);
      final c = map['c'] as List<dynamic>?;
      if (c != null) {
        for (final child in c) {
          el.append(node(child));
        }
      }
      return el;
    }

    final root = node(json['root']) as VElement;
    VElement? at(Object? path) {
      if (path == null) return null;
      var el = root;
      for (final i in path as List<dynamic>) {
        el = el.children[i as int] as VElement;
      }
      return el;
    }

    return VDocument(
      root: root,
      head: at(json['head']),
      body: at(json['body'])!,
      jsonLd: [for (final s in json['jsonLd'] as List<dynamic>) s as String],
      nextData: json['nextData'] as String?,
      baseHref: json['baseHref'] as String?,
    );
  }

  /// The JSON form [VDocument.fromJson] reads.
  Map<String, dynamic> toJson() {
    Object node(VNode n) {
      if (n is VText) return n.text;
      final el = n as VElement;
      return {
        't': el.tag,
        if (el.attrs.isNotEmpty) 'a': el.attrs,
        if (el.children.isNotEmpty) 'c': [for (final c in el.children) node(c)],
      };
    }

    List<int>? pathTo(VElement? target) {
      if (target == null) return null;
      final path = <int>[];
      for (var el = target; !identical(el, root); el = el.parent!) {
        if (el.parent == null) return null;
        path.insert(0, el.parent!.children.indexOf(el));
      }
      return path;
    }

    return {
      'root': node(root),
      'head': pathTo(head),
      'body': pathTo(body),
      'jsonLd': jsonLd,
      'nextData': nextData,
      'baseHref': baseHref,
    };
  }
}

// ------------------------------------------------------------------ helpers

/// Raw concatenated text of a subtree (skipped nodes excluded).
String rawText(VNode node) {
  if (node is VText) return node.text;
  final el = node as VElement;
  if (el.skip) return '';
  final children = el.children;
  if (children.isEmpty) return '';
  if (children.length == 1) {
    final only = children[0];
    if (only is VText) return only.text;
  }
  final out = StringBuffer();
  _rawText(el, out);
  return out.toString();
}

void _rawText(VElement el, StringBuffer out) {
  for (final child in el.children) {
    if (child is VText) {
      out.write(child.text);
    } else if (!(child as VElement).skip) {
      _rawText(child, out);
    }
  }
}

/// Text of a subtree with whitespace collapsed and trimmed.
String textOf(VNode node) => collapse(rawText(node));

/// `text.replace(/[\t\n\f\r ]+/g, ' ').trim()`.
String collapse(String text) => jsTrim(collapseHtmlSpace(text));

/// `text.split(separator)` for a group-free separator that opens with `\s*` or
/// `\s+`: such a match never starts inside a run of whitespace, only where the
/// run starts, so the separator is tried only there. Tried from every space of
/// a long run (no-break spaces survive `collapse`), it would rescan the rest of
/// the run each time.
List<String> splitAtRuns(String text, RegExp separator) {
  final parts = <String>[];
  var start = 0;
  for (var i = 0; i < text.length; i++) {
    if (i != start && isJsSpace(text.codeUnitAt(i - 1))) continue;
    final m = separator.matchAsPrefix(text, i);
    if (m == null || m.end == i) continue;
    parts.add(text.substring(start, i));
    start = m.end;
    i = start - 1;
  }
  parts.add(text.substring(start));
  return parts;
}

/// Length of [text] as rendered: whitespace runs count as one character,
/// edges trimmed.
int visibleLength(String text) {
  var n = 0;
  var space = true;
  for (var i = 0; i < text.length; i++) {
    final c = text.codeUnitAt(i);
    if (c == 32 || c == 10 || c == 9 || c == 13 || c == 12) {
      if (!space) {
        n++;
        space = true;
      }
    } else {
      n++;
      space = false;
    }
  }
  return space && n > 0 ? n - 1 : n;
}

int countCommas(String text) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    if (_isComma(text.codeUnitAt(i))) n++;
  }
  return n;
}

bool _isComma(int c) =>
    // , ، 、 ， ﹐ ﹑ ､ ⸲ ⸴ ⹁ ⹌ ⹎ ߸ ᠂ ᠈ ꓾ ꘍ ꛵ ︑
    c == 0x2c ||
    c == 0x60c ||
    c == 0x3001 ||
    c == 0xff0c ||
    c == 0xfe50 ||
    c == 0xfe51 ||
    c == 0xff64 ||
    c == 0x2e32 ||
    c == 0x2e34 ||
    c == 0x2e41 ||
    c == 0x2e4c ||
    c == 0x2e4e ||
    c == 0x7f8 ||
    c == 0x1802 ||
    c == 0x1808 ||
    c == 0xa4fe ||
    c == 0xa60d ||
    c == 0xa6f5 ||
    c == 0xfe11;

/// Depth-first pre-order walk over elements. Return false from [visit] to
/// skip children.
void walk(VElement el, bool Function(VElement el) visit) {
  if (!visit(el)) return;
  final children = el.children;
  for (var i = 0; i < children.length; i++) {
    final child = children[i];
    if (child is VElement) walk(child, visit);
  }
}

List<VElement> elements(VElement el, String tag) {
  final out = <VElement>[];
  walk(el, (e) {
    if (!identical(e, el) && e.tag == tag) out.add(e);
    return true;
  });
  return out;
}

VElement? firstElement(VElement el, bool Function(VElement e) test) {
  VElement? found;
  walk(el, (e) {
    if (found != null) return false;
    if (!identical(e, el) && test(e)) {
      found = e;
      return false;
    }
    return true;
  });
  return found;
}

VElement? closest(VElement? el, bool Function(VElement e) test) {
  for (var e = el; e != null; e = e.parent) {
    if (test(e)) return e;
  }
  return null;
}

void remove(VNode node) {
  final parent = node.parent;
  if (parent == null) return;
  final i = parent.children.indexOf(node);
  if (i >= 0) parent.children.removeAt(i);
  node.parent = null;
}

void replaceWith(VNode node, VNode replacement) {
  final parent = node.parent;
  if (parent == null) return;
  final i = parent.children.indexOf(node);
  if (i < 0) return;
  parent.children[i] = replacement;
  replacement.parent = parent;
  node.parent = null;
}

bool isAncestor(VElement ancestor, VNode node) {
  for (var p = node.parent; p != null; p = p.parent) {
    if (identical(p, ancestor)) return true;
  }
  return false;
}
