import 'package:html/dom.dart' as dom;

import 'garbled_table.dart';

/// Math that a PDF-to-HTML converter extracted from TeX fonts without Unicode
/// maps (pdftohtml, usually through calibre): the operator font gives `D` for
/// =, `C` for + and `2` for ∈, Greek italics come out as spacing accents that
/// NFC fused onto the next letter (`Ď` is "β ="), and glyphs at control-code
/// positions (minus, λ, ≤ …) were dropped, leaving a wider gap.
///
/// A port of the web enhancer's decoder (apps/web/src/reader/enhance/garbled.ts);
/// the two share their glyph table and must read lines the same way. Each line
/// is split into prose and formulas by operand/operator alternation, and each
/// formula becomes TeX. Linear in the text, capped, never throws.
abstract final class GarbledMath {
  /// Longest line decoded; PDF lines are short, a longer "line" is not one.
  static const maxLine = 4000;

  /// Text sampled for the gate.
  static const _maxSample = 400000;

  /// Blocks decoded per chapter, and formulas made.
  static const _maxBlocks = 40000;
  static const _maxRuns = 40000;

  /// Marks the span holding a decoded formula's original text; the value is the TeX.
  static const texAttr = 'data-tr-garbled';

  static final _signatures = [
    RegExp(r'(?:^|\s)[A-Za-z0-9/] D [A-Za-z0-9.]'),
    RegExp(r'(?:^|\s)[A-Za-z0-9/] C [A-Za-z0-9.]'),
    RegExp(r' 2 [RCFUVW](?:[\s;,.:]|$)'),
    RegExp('[˛ˇ]'),
    RegExp(r'(?:^|\s)f[0-9a-z.]\S{0,40}g(?:[\s;,.:]|$)'),
    RegExp(r'(?:^|\s)h[a-z]; '),
  ];
  static final _realMath = RegExp('[=+∈∉≤≥≠∑∫∂√∞⊆⊂∪∩→αβγλ]');

  /// Whether the text of a PDF conversion has its math garbled this way:
  /// many signature patterns and few real math symbols.
  static bool isGarbled(String text) {
    final sample = text.length > _maxSample ? text.substring(0, _maxSample) : text;
    if (sample.length < 200) return false;
    var garbled = 0;
    for (final re in _signatures) {
      garbled += re.allMatches(sample).length;
    }
    final real = _realMath.allMatches(sample).length;
    return garbled >= 8 && garbled >= 3 * real && garbled * 2000 >= sample.length;
  }

  static const _lineBlocks = {
    'p', 'li', 'dd', 'dt', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'figcaption',
  };
  static const _blocks = {
    'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
  };
  static const _italic = {'i', 'em', 'var', 'cite', 'dfn'};
  static const _protected = {'pre', 'code', 'math', 'script', 'style', 'textarea'};

  /// Wraps each decoded formula's original nodes in `span.math` carrying its
  /// TeX in [texAttr]; the builder renders the TeX and falls back to the
  /// original text when it does not parse. Returns the formulas made.
  static int prepare(dom.Element root) {
    var blocks = 0;
    var made = 0;
    for (final block in root.querySelectorAll(_lineBlocks.join(','))) {
      if (block.attributes.containsKey('data-tr-hidden')) continue;
      if (block.children.any((c) => _blocks.contains(c.localName))) continue;
      if (_isProtected(block)) continue;
      if (++blocks > _maxBlocks || made > _maxRuns) break;
      try {
        made += _decodeBlock(block);
      } catch (_) {
        // A line that fails keeps its original text.
      }
    }
    return made;
  }

  static bool _isProtected(dom.Element e) {
    dom.Element? cur = e;
    for (var i = 0; cur != null && i < 64; i++, cur = cur.parent) {
      if (_protected.contains(cur.localName) || cur.attributes.containsKey(texAttr)) return true;
    }
    return false;
  }

  static int _decodeBlock(dom.Element block) {
    final nodes = <(dom.Text, int)>[];
    final pieces = <GarbledPiece>[];
    var offset = 0;
    void walk(dom.Node node, bool italic) {
      for (final child in node.nodes) {
        if (child is dom.Text) {
          nodes.add((child, offset));
          pieces.add(GarbledPiece(child.data, italic: italic));
          offset += child.data.length;
        } else if (child is dom.Element) {
          if (_protected.contains(child.localName) || child.attributes.containsKey(texAttr)) continue;
          walk(child, italic || _italic.contains(child.localName));
        }
      }
    }

    walk(block, false);
    if (offset == 0 || offset > maxLine) return 0;
    final runs = decodeLine(pieces);
    if (runs.isEmpty) return 0;
    final whole = pieces.map((p) => p.text).join();
    var made = 0;
    for (var r = runs.length - 1; r >= 0; r--) {
      final run = runs[r];
      var end = run.end;
      var tex = run.tex;
      final before = whole.substring(0, run.start);
      final after = whole.substring(run.end);
      final display = runs.length == 1 && before.trim().isEmpty && RegExp(r'^[\s.,;:]*$').hasMatch(after) && run.end - run.start >= 6;
      if (display) {
        final punct = after.trim();
        if (punct.isNotEmpty) {
          end = run.end + after.indexOf(punct) + punct.length;
          tex += '\\text{$punct}';
        }
      } else {
        final punct = RegExp(r'^[.,;:]+(?=\s|$)').firstMatch(after)?[0];
        if (punct != null && (r == runs.length - 1 || runs[r + 1].start > run.end + punct.length)) {
          end = run.end + punct.length;
          tex += '\\text{$punct}';
        }
      }
      if (_wrap(block, nodes, run.start, end, forFlutterMath(tex), display)) made++;
    }
    return made;
  }

  static final _operatorName = RegExp(r'\\operatorname\{([a-zA-Z]+)\}');

  /// flutter_math_fork does not parse one `\operatorname` right after another ("dim null T").
  static String forFlutterMath(String tex) => tex.replaceAllMapped(_operatorName, (m) => '\\mathop{\\mathrm{${m[1]}}}');

  static bool _wrap(dom.Element block, List<(dom.Text, int)> nodes, int start, int end, String tex, bool display) {
    (dom.Text, int)? locate(int at, bool isEnd) {
      for (final (node, from) in nodes) {
        final len = node.data.length;
        if (isEnd ? at > from && at <= from + len : at >= from && at < from + len) return (node, at - from);
      }
      return null;
    }

    final from = locate(start, false);
    final to = locate(end, true);
    if (from == null || to == null) return false;
    dom.Node? top(dom.Node n) {
      dom.Node? cur = n;
      while (cur != null && cur.parentNode != block) {
        cur = cur.parentNode;
      }
      return cur;
    }

    final first = top(from.$1);
    final last = top(to.$1);
    if (first == null || last == null) return false;
    // Inline elements may be covered only whole: what lies outside the formula in one must be blank.
    if (first != from.$1) {
      final texts = _texts(first);
      final i = texts.indexOf(from.$1);
      if (i < 0 || texts.take(i).any((t) => t.data.trim().isNotEmpty) || from.$1.data.substring(0, from.$2).trim().isNotEmpty) {
        return false;
      }
    }
    if (last != to.$1) {
      final texts = _texts(last);
      final i = texts.indexOf(to.$1);
      if (i < 0 || texts.skip(i + 1).any((t) => t.data.trim().isNotEmpty) || to.$1.data.substring(to.$2).trim().isNotEmpty) {
        return false;
      }
    }
    // Split the end first: the start's offsets refer to the unsplit node when both are the same.
    dom.Node endNode = last;
    if (last == to.$1 && to.$2 < to.$1.data.length) {
      final node = to.$1;
      block.nodes.insert(block.nodes.indexOf(node) + 1, dom.Text(node.data.substring(to.$2)));
      node.data = node.data.substring(0, to.$2);
    }
    dom.Node startNode = first;
    if (first == from.$1 && from.$2 > 0) {
      final node = from.$1;
      final tail = dom.Text(node.data.substring(from.$2));
      block.nodes.insert(block.nodes.indexOf(node) + 1, tail);
      node.data = node.data.substring(0, from.$2);
      startNode = tail;
      if (endNode == node) endNode = tail;
    }
    final span = dom.Element.tag('span')
      ..classes.addAll(['math', display ? 'display' : 'inline'])
      ..attributes[texAttr] = tex;
    block.insertBefore(span, startNode);
    final siblings = block.nodes;
    final moving = <dom.Node>[];
    for (var i = siblings.indexOf(startNode); i >= 0 && i < siblings.length; i++) {
      moving.add(siblings[i]);
      if (siblings[i] == endNode) break;
    }
    for (final n in moving) {
      span.append(n);
    }
    return true;
  }

  static List<dom.Text> _texts(dom.Node n) {
    final out = <dom.Text>[];
    void walk(dom.Node node) {
      for (final c in node.nodes) {
        if (c is dom.Text) {
          out.add(c);
        } else {
          walk(c);
        }
      }
    }

    if (n is dom.Text) return [n];
    walk(n);
    return out;
  }

  /// Formulas in one PDF line. Pieces are the line's text nodes in order.
  static List<GarbledRun> decodeLine(List<GarbledPiece> pieces) {
    try {
      final length = pieces.fold<int>(0, (sum, p) => sum + p.text.length);
      if (length == 0 || length > maxLine) return const [];
      final words = _lex(pieces);
      final out = <GarbledRun>[];
      for (final (a, b) in _findRuns(words)) {
        final atoms = [for (var w = a; w <= b; w++) ...words[w].atoms];
        // Sentence punctuation after the formula stays text.
        var last = atoms.length;
        while (last > 0 &&
            RegExp(r'^[.,;:?)]$').hasMatch(atoms[last - 1].s) &&
            !(atoms[last - 1].s == '?' && last >= 2 && atoms[last - 1].gap > 0 && b < words.length - 1)) {
          last--;
        }
        if (last == 0) continue;
        final body = atoms.sublist(0, last);
        // Pieces of big delimiters on lines of their own.
        if (words.length == 1 && body.length == 1 && RegExp(r'^[ˆ˝˛ˇ]$').hasMatch(body[0].s) && RegExp(r'^\s*\S\s*$').hasMatch(words[0].text)) {
          continue;
        }
        // An operator ending the run had its operand dropped only if a wider gap follows ("λ + 0 = λ and").
        final droppedAfter = last == atoms.length && b + 1 < words.length && words[b + 1].atoms.isNotEmpty && words[b + 1].atoms[0].gap >= 2;
        final decoded = _Formula(body, lastOfLine: b == words.length - 1, droppedAfter: droppedAfter).read();
        if (decoded == null) continue;
        out.add(GarbledRun(body.first.at, body.last.end, decoded.$1, decoded.$2));
      }
      return out;
    } catch (_) {
      return const [];
    }
  }
}

/// One piece of a line's text; italic pieces come from `<i>`/`<em>`.
class GarbledPiece {
  const GarbledPiece(this.text, {this.italic = false});

  final String text;
  final bool italic;
}

/// A decoded formula: `[start, end)` into the concatenated piece texts.
class GarbledRun {
  const GarbledRun(this.start, this.end, this.tex, this.plain);

  final int start;
  final int end;
  final String tex;

  /// Linear Unicode reading (tests and accessibility).
  final String plain;
}

// ---------------------------------------------------------------- lexing

class _Atom {
  _Atom(this.s, this.at, this.end, this.gap, this.italic, {this.text});

  final String s;
  final int at;
  final int end;

  /// Whitespace before the atom, adjusted for italic boundaries; 0 when glued.
  final int gap;
  final bool italic;

  /// A prose word an accent was fused onto ("ąnd").
  final String? text;

  _Atom copy({String? s, int? end}) => _Atom(s ?? this.s, at, end ?? this.end, gap, italic, text: text);
}

enum _Cls { prose, math, weak, func, unknown }

class _Word {
  _Word(this.atoms, this.text, this.cls, this.strong);

  final List<_Atom> atoms;
  final String text;
  _Cls cls;
  final bool strong;
}

final _fused = GarbledTable.fused;
final _symbols = GarbledTable.symbols;
final _letterOps = GarbledTable.letterOps;
final _words = GarbledTable.words.split(' ').toSet();
final _indexable = GarbledTable.commonOverride.split(' ').toSet();
final _accents = {for (final v in _fused.values) v.$1};

final _letterRe = RegExp(r'^[A-Za-z]$');
bool _isLetter(String c) => _letterRe.hasMatch(c);
bool _isDigit(String c) => c.length == 1 && c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57;
final _space = RegExp(r'\s');

typedef _Char = ({String c, int at, bool italic});

List<_Word> _lex(List<GarbledPiece> pieces) {
  final chars = <_Char>[];
  final edges = <int>{};
  var offset = 0;
  var wasItalic = false;
  for (final p in pieces) {
    if (p.italic != wasItalic) edges.add(chars.length);
    wasItalic = p.italic;
    for (var i = 0; i < p.text.length; i++) {
      chars.add((c: p.text[i], at: offset + i, italic: p.italic));
    }
    offset += p.text.length;
  }
  if (wasItalic) edges.add(chars.length);
  final words = <_Word>[];
  var i = 0;
  while (i < chars.length) {
    // Whitespace before the word; converters add one space at a font change.
    var gap = 0;
    var edge = edges.contains(i);
    while (i < chars.length && _space.hasMatch(chars[i].c)) {
      gap++;
      i++;
      if (edges.contains(i)) edge = true;
    }
    if (i >= chars.length) break;
    if (edge && gap > 0) gap--;
    final start = i;
    while (i < chars.length && !_space.hasMatch(chars[i].c)) {
      i++;
    }
    words.add(_makeWord(chars.sublist(start, i), words.isEmpty ? 1 : gap));
  }
  return words;
}

_Word _makeWord(List<_Char> chars, int gap) {
  final raw = chars.map((c) => c.c).join();
  // Fused accents: "Ď" is β followed by "=", "ąnd" is α followed by "and".
  final expanded = <_Char>[];
  for (var k = 0; k < chars.length; k++) {
    // A letter that is a glyph of its own (Š is the factorial sign) is not split.
    final split = _symbols.containsKey(chars[k].c) ? null : _fused[chars[k].c];
    if (split != null && _fusedAccent(raw, k, split.$2)) {
      expanded
        ..add((c: split.$1, at: chars[k].at, italic: chars[k].italic))
        ..add((c: split.$2, at: chars[k].at, italic: chars[k].italic));
    } else {
      expanded.add(chars[k]);
    }
  }
  final text = expanded.map((c) => c.c).join();
  final rest = text.substring(1);
  if (expanded.length > chars.length &&
      _accents.contains(text[0]) &&
      RegExp(r'^[A-Za-z]{2,}[.,;:]?$').hasMatch(rest) &&
      _words.contains(rest.replaceAll(RegExp(r'[.,;:]$'), '').toLowerCase())) {
    // "ąnd": α, then the word "and" the accent was fused onto.
    final first = chars.first;
    return _Word(
      [
        _Atom(text[0], first.at, first.at + 1, gap, first.italic),
        _Atom('text', first.at, chars.last.at + 1, 0, first.italic, text: rest),
      ],
      text,
      _Cls.math,
      true,
    );
  }
  final atoms = [
    for (var k = 0; k < expanded.length; k++) _Atom(expanded[k].c, expanded[k].at, expanded[k].at + 1, k == 0 ? gap : 0, expanded[k].italic),
  ];
  final (cls, strong) = _classify(text);
  return _Word(_mergeAtoms(atoms, cls), text, cls, strong);
}

bool _fusedAccent(String word, int k, String base) {
  final before = word.substring(0, k);
  final after = word.substring(k + 1);
  if (RegExp(r'[A-Za-z]$').hasMatch(before) && !RegExp(r'[˛ˇˆ˚]$').hasMatch(before)) {
    // Inside a run of letters: only an operator glued into a formula ("˛Ď").
    return 'DCW'.contains(base) && !RegExp('^[a-z]').hasMatch(after);
  }
  if ('DCW'.contains(base)) return !RegExp('^[a-z]').hasMatch(after);
  // At a word start: the base begins a common word ("ąnd", "îs") or is a lone variable ("û").
  if (before.isNotEmpty && !RegExp(r'[˛ˇˆ˚.(]$').hasMatch(before)) return false;
  final rest = (base + after).replaceAll(RegExp(r'[.,;:]+$'), '');
  return _words.contains(rest.toLowerCase()) || _letterRe.hasMatch(rest);
}

/// Groups function names and `:::` into single atoms.
List<_Atom> _mergeAtoms(List<_Atom> atoms, _Cls cls) {
  if (cls == _Cls.prose) return atoms;
  final out = <_Atom>[];
  for (var k = 0; k < atoms.length; k++) {
    final a = atoms[k];
    if (_isLetter(a.s) && (k == 0 || !_isLetter(atoms[k - 1].s) || RegExp('^[hjk]\$').hasMatch(atoms[k - 1].s))) {
      final run = StringBuffer();
      for (var m = k; m < atoms.length && _isLetter(atoms[m].s) && run.length < 8; m++) {
        run.write(atoms[m].s);
      }
      final letters = run.toString();
      var name = '';
      for (var len = letters.length < 5 ? letters.length : 5; len >= 2; len--) {
        final cand = letters.substring(0, len);
        if (GarbledTable.functions.contains(cand) && (letters.length - len <= 2 || !RegExp('^[a-z]').hasMatch(letters.substring(len)))) {
          name = cand;
          break;
        }
      }
      if (name.isNotEmpty) {
        out.add(a.copy(s: name, end: atoms[k + name.length - 1].end));
        k += name.length - 1;
        continue;
      }
    }
    if (a.s == ':' && k + 2 < atoms.length && atoms[k + 1].s == ':' && atoms[k + 2].s == ':') {
      out.add(a.copy(s: ':::', end: atoms[k + 2].end));
      k += 2;
      continue;
    }
    out.add(a);
  }
  return out;
}

final _garble = RegExp(r'[˛ˇˆ¿¤¨˚\\ıŠŒ…]');
final _operatorWord = RegExp(r'^[DCW2![<>]$');
final _functionDot = RegExp(r'^([A-Za-z]|[a-z]{2,5})\.[A-Za-z0-9]{1,3}[.,;:]?$');

(_Cls, bool) _classify(String text) {
  final core = text.replaceAll(RegExp(r'^[(“"]+'), '').replaceAll(RegExp(r'[.,;:?!)”"’]+$'), '');
  bool has(String re, String s) => RegExp(re).hasMatch(s);
  if (has(r'^[<>]$', text)) return (_Cls.weak, false);
  if (has(r'^[RCF][nm\d](;[nm\d])?[.,;:]?$', text)) return (_Cls.math, true);
  if (core.isEmpty || core == '/') return (has(r'^[./;]+$', text) ? _Cls.math : _Cls.weak, text.contains('/'));
  if (_garble.hasMatch(text) || has(r"^'[\w;:./]*$", text)) return (_Cls.math, true);
  if (has(r'^[A-Za-z]+$', core)) {
    final lower = core.toLowerCase();
    if (core.length == 1) return (_Cls.weak, false);
    if (GarbledTable.functions.contains(core)) return (_Cls.func, false);
    if (has(r'^[jkh](det|dim|trace|Re|Im)$', core)) return (_Cls.math, true);
    if (has(r'^[kj][A-Za-z]{1,2}[kj]$', core) || has(r'^[RCF][nm]$', core)) return (_Cls.math, true);
    if (_words.contains(lower) && !(core.length > 1 && has(r'^[A-Z][A-Z]$', core))) return (_Cls.prose, false);
    // "ui": an operand and the closing ⟨ ⟩ bracket.
    if (has(r'^[A-Za-z][jkmn]?i$', core)) return (_Cls.math, false);
    // Letters with indices run together: "anen" is a_n e_n, "enien" e_n⟩e_n, "kukk" ‖u‖‖.
    if (has(r'^([a-z][jkmn])+$', core) || has(r'^[a-z][jkmn]i[a-z][jkmn]$', core) || has(r'^k[a-z]kk?$', core)) return (_Cls.math, true);
    if (core.length >= 4) return (_Cls.prose, false);
    if (has(r'^(f[a-z0-9]$|h[A-Za-z]|[kj][A-Z])', core) || has(r'[a-zA-Z]g$', core) || has(r'^[A-Z][A-Z]$', core)) return (_Cls.math, false);
    return (_Cls.unknown, false);
  }
  // Letters with digits, dots and slashes: "u1;", "R3", ".a", "f0g", "nC1", "kuk2".
  if (has(r'^\.[A-Za-z0-9.]', text) || has(r'[A-Za-z0-9]/[.,;:]*$', text) || has(r'^[\w;.]*/\.?[\w;.]*$', text) && !has('[A-Za-z]{4}', text)) {
    return (_Cls.math, true);
  }
  if (_functionDot.hasMatch(text) &&
      !has(r'^[a-z]\.[a-z]\.?$', text) &&
      (text[1] == '.' || GarbledTable.functions.contains(text.substring(0, text.indexOf('.'))))) {
    return (_Cls.math, true);
  }
  // Function applications run together: "p.x/q.x/".
  if (has(r'^([A-Za-z]\.[A-Za-z0-9]{1,3}/){2,}', text)) return (_Cls.math, true);
  if (has(r'^\?[/.;,]', text) || has(r'^[\w.]*=[A-Za-z0-9.]+[.,;:]?$', text)) return (_Cls.math, true);
  if (has(r'^[A-Za-z]{1,3}\d{1,2}$', core) || has(r'^f\S*g$', core) || has(r'^[kj]\S+[kj]\d?$', core)) return (_Cls.math, true);
  if (has(r'^\d+$', core)) return (_Cls.weak, false);
  if (has(r'^[\w;=]+$', core) && has(r'\d', core) && has('[A-Za-z;=]', core)) return (_Cls.math, true);
  if (has(r'^[\w;=.:/]+$', core)) return (_Cls.unknown, false);
  return (_Cls.prose, false);
}

// ---------------------------------------------------------------- runs

List<(int, int)> _findRuns(List<_Word> words) {
  // Undecided words lean towards a math neighbour.
  bool near(int j) => j >= 0 && j < words.length && (words[j].cls == _Cls.math || words[j].strong || _operatorWord.hasMatch(words[j].text));
  for (var k = 0; k < words.length; k++) {
    if (words[k].cls != _Cls.unknown) continue;
    words[k].cls = near(k - 1) || near(k + 1) ? _Cls.weak : _Cls.prose;
  }
  // Common words that are also a letter with an index, inside a list ("a1; : : : ; an").
  for (var k = 1; k < words.length; k++) {
    final w = words[k];
    final prev = words[k - 1];
    if (w.cls == _Cls.prose &&
        _indexable.contains(w.text.replaceAll(RegExp(r'[.,;:]+$'), '')) &&
        (prev.text.endsWith(';') && prev.cls != _Cls.prose || RegExp(r'^[CD]$').hasMatch(prev.text))) {
      w.cls = _Cls.weak;
    }
  }
  final runs = <(int, int)>[];
  var k = 0;
  bool article(_Word w) => RegExp(r'^(a|A|I)$').hasMatch(w.text);
  while (k < words.length) {
    if (words[k].cls == _Cls.prose) {
      k++;
      continue;
    }
    var end = k;
    // A text colon ends a formula; the operator font's colon is W.
    while (end < words.length && words[end].cls != _Cls.prose) {
      end++;
      if (RegExp(r'[^:]:$').hasMatch(words[end - 1].text)) break;
    }
    var a = k;
    var b = end - 1;
    bool operatorAt(int j) => j >= a && j <= b && (_operatorWord.hasMatch(words[j].text) || RegExp(r'^[¤¨˚\\[!]$').hasMatch(words[j].text));
    while (a <= b && article(words[a]) && !operatorAt(a + 1) && !(a < b && words[a + 1].atoms[0].gap >= 2)) {
      a++;
    }
    while (b >= a && (article(words[b]) || words[b].cls == _Cls.func) && !operatorAt(b - 1)) {
      b--;
    }
    if (a <= b && _hasSignal(words, a, b)) runs.add((a, b));
    k = end;
  }
  return runs;
}

bool _hasSignal(List<_Word> words, int a, int b) {
  var angle = false;
  var comma = false;
  for (var j = a; j <= b; j++) {
    final w = words[j];
    if (w.strong) return true;
    // An inner product: "h" … ";" … "i".
    if (w.text.startsWith('h') && w.cls != _Cls.prose) angle = true;
    if (angle && w.text.endsWith(';')) comma = true;
    if (comma && w.text.endsWith('i')) return true;
    // A display's continuation line: "D h T v; v i".
    if (j == a && RegExp(r'^[DC]$').hasMatch(w.text) && b - a >= 2) return true;
    // ‖v‖ or |z| spelled out: "k v k".
    if (j + 2 <= b && RegExp(r'^[kj]$').hasMatch(w.text) && words[j + 2].text.startsWith(w.text) && words[j + 1].text.length == 1) return true;
    if (!_operatorWord.hasMatch(w.text)) continue;
    if (j > a && j < b && (w.text != '2' || _operandish(words[j - 1]) && _operandish(words[j + 1]))) return true;
    // Beside a dropped glyph's gap: "C 0 D  and".
    final nextGap = j + 1 < words.length && words[j + 1].atoms.isNotEmpty ? words[j + 1].atoms[0].gap : 0;
    if ((j > a && _operandish(words[j - 1]) || j < b && _operandish(words[j + 1])) && (w.atoms[0].gap >= 2 || nextGap >= 2)) return true;
  }
  return false;
}

bool _operandish(_Word w) =>
    w.cls != _Cls.prose && !_operatorWord.hasMatch(w.text) && w.text.isNotEmpty && RegExp("[A-Za-z0-9˛ˇˆ'¿.]").hasMatch(w.text[0]);

// ---------------------------------------------------------------- formulas

/// What a dropped binary glyph most likely was (− in 63% of resolvable cases on the
/// book this was written for) and a dropped operand (λ); see the web decoder.
const _droppedBinary = ('-', '−');
const _droppedOperand = (r'\lambda', 'λ');

/// An ordinary ⋯, so the operators beside it keep their binary spacing.
const _cdots = r'\mathord{\cdots}';
final _indexLetter = RegExp(r'^[jkmn]$');

enum _Role { x, op, open, close, fn }

class _Part {
  _Part(this.tex, this.plain, this.role);

  String tex;
  String plain;
  final _Role role;
  bool sub = false;
  bool sup = false;
}

const _sup = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', 'n': 'ⁿ', 'm': 'ᵐ',
  'k': 'ᵏ', 'j': 'ʲ', '−': '⁻', '+': '⁺', 'T': 'ᵀ', '′': '′', '⊥': '⊥',
};
const _sub = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', 'n': 'ₙ', 'm': 'ₘ',
  'k': 'ₖ', 'j': 'ⱼ', '+': '₊', '−': '₋', 'i': 'ᵢ',
};

/// One left-to-right pass over a formula's atoms: `expect` is true where an
/// operand belongs, which decides between the readings of `C`, `D`, `W`, `2`,
/// `.` and `;`. The web decoder's `formula`, line for line.
class _Formula {
  _Formula(this.atoms, {required this.lastOfLine, required this.droppedAfter}) : n = atoms.length;

  final List<_Atom> atoms;
  final bool lastOfLine;
  final bool droppedAfter;
  final int n;
  final parts = <_Part>[];
  final stack = <String>[];
  var expect = true;
  var jump = 0;

  static const _pairWindow = 48;

  _Atom? _a(int k) => k >= 0 && k < n ? atoms[k] : null;
  bool _glued(int k) => k < n && atoms[k].gap == 0;
  _Part? get _last => parts.isEmpty ? null : parts.last;
  String? _kind(String s) => _symbols[s]?.$1;
  void _push(String tex, String plain, _Role role) => parts.add(_Part(tex, plain, role));
  void _dropped() => _push(_droppedOperand.$1, _droppedOperand.$2, _Role.x);

  void _script(bool sub, String tex, String plain) {
    final base = _last;
    if (base == null) {
      _push(tex, plain, _Role.x);
      return;
    }
    if (sub ? base.sub : base.sup) {
      base.tex = '{${base.tex}}';
      base.sub = base.sup = false;
    }
    base.tex += '${sub ? '_' : '^'}{$tex}';
    final table = sub ? _sub : _sup;
    final chars = plain.split('');
    base.plain += chars.every(table.containsKey) ? chars.map((c) => table[c]).join() : '${sub ? '_' : '^'}($plain)';
    if (sub) {
      base.sub = true;
    } else {
      base.sup = true;
    }
  }

  bool _startsOperand(int k) {
    final a = _a(k);
    if (a == null) return false;
    if (a.s == '.' || a.s == 'Œ' || _isDigit(a.s) || GarbledTable.functions.contains(a.s) || a.s == ':::') return true;
    if (_symbols.containsKey(a.s)) return _kind(a.s) == 'var';
    if (a.s == 'D' || a.s == 'W') {
      // A letter unless it stands between operands (not recursive: hostile input repeats them).
      final next = _a(k + 1);
      if (next == null || next.gap == 0) return true;
      return !(_isLetter(next.s) || _isDigit(next.s) || next.s == '.' || next.s == 'f' || _kind(next.s) == 'var');
    }
    return _isLetter(a.s);
  }

  bool _opLetter(int k) {
    final a = _a(k);
    if (a == null || !_letterOps.containsKey(a.s) || a.gap == 0 || k + 1 >= n || atoms[k + 1].gap == 0) return false;
    return _startsOperand(k + 1) || atoms[k + 1].s == 'h' || (atoms[k + 1].gap >= 3 && atoms[k + 1].s == a.s);
  }

  int _ahead(int k, String s, {bool needComma = false}) {
    var comma = !needComma;
    for (var m = k + 1; m < n && m <= k + _pairWindow; m++) {
      if (atoms[m].s == ';') comma = true;
      if (atoms[m].s == s && m > k + 1 && comma) {
        final prev = atoms[m - 1].s;
        if (_isLetter(prev) || _isDigit(prev) || prev == '/' || _kind(prev) == 'var' || prev == 'g' || prev == 'k' || prev == 'j') return m;
      }
    }
    return -1;
  }

  (String, String) _letter(_Atom a, bool field) {
    if (field && GarbledTable.fields.contains(a.s)) return ('\\mathbf{${a.s}}', a.s);
    if (a.italic && GarbledTable.calligraphic.contains(a.s)) return ('\\mathcal{${a.s}}', a.s);
    return (a.s, a.s);
  }

  (String, String)? read() {
    for (var k = 0; k < n; k = k + 1 > jump ? k + 1 : jump) {
      jump = 0;
      if (!_step(k)) return null;
    }
    // A relation ending the line continues on the next one.
    final last = _last;
    if (expect && droppedAfter && last != null && last.role == _Role.op && last.tex != ',' && last.tex != r'\sum') _dropped();
    // Œ0; 1: the closing bracket was dropped.
    if (stack.contains('[')) _closeInterval();
    final tex = parts.map((p) => p.tex).where((t) => t.isNotEmpty).join(' ');
    final plain = parts.map((p) => p.plain).join();
    return tex.isEmpty ? null : (tex, plain);
  }

  /// One atom; false when the formula does not read as one.
  bool _step(int k) {
    final a = atoms[k];
    final s = a.s;

    if (s == 'text') {
      // The prose word an accent was fused onto ends this formula.
      final space = k < n - 1 ? ' ' : '';
      _push('\\text{ ${a.text}$space}', ' ${a.text}$space', _Role.op);
      expect = true;
      return true;
    }

    // A dropped glyph left a wider gap.
    if (a.gap >= 2 && k > 0) {
      final kind = _kind(s);
      final same = atoms[k - 1].s == s && (_letterOps.containsKey(s) || kind == 'bin' || kind == 'rel');
      if (same) {
        _push(_cdots, '⋯', _Role.x);
        expect = false;
      } else if (!expect &&
          (_startsOperand(k) || s == 'h' || s == 'k' || s == 'j' || s == 'f') &&
          !(s == '2' && k + 1 < n && atoms[k + 1].gap > 0 && _startsOperand(k + 1))) {
        final prev = _last?.tex ?? '';
        if (a.gap >= 4) {
          _push(_cdots, '⋯', _Role.x);
        } else if (RegExp(r'^\d+$').hasMatch(prev) && (_isDigit(s) || s == '.') || prev == ')' && _isDigit(s)) {
          _push(r'\cdot', '·', _Role.op);
        } else {
          _push(_droppedBinary.$1, _droppedBinary.$2, _Role.op);
        }
        expect = true;
      } else if (expect && _last?.role == _Role.op) {
        // ";  2 C": an operand was dropped.
        _dropped();
        expect = false;
      }
    }
    if (k == 0 && (s == ';' || a.gap >= 2 && (_letterOps.containsKey(s) || s == '2' || _symbols.containsKey(s) && _kind(s) != 'var') && k + 1 < n)) {
      // The run opens on an operator: its left operand was dropped ("for all  2 C").
      _dropped();
      expect = false;
    }

    // Operators spelled with letters, by position.
    final op = _letterOps[s];
    if (op != null && !(_glued(k + 1) && _isLetter(atoms[k + 1].s) && expect)) {
      final (_, tex, plain) = op;
      if (!expect) {
        if (s == 'C' && a.gap == 0 && k == n - 1 && _last?.role == _Role.close) {
          // (AB)C: a matrix C after a product.
          _push('C', 'C', _Role.x);
          return true;
        }
        if (s == 'C' && a.gap == 0 && _last?.role == _Role.x && RegExp('^[A-Z]\$').hasMatch(atoms[k - 1].s) && !(_glued(k + 1) && _startsOperand(k + 1))) {
          // T_C, the complexification.
          _script(true, r'\mathbf{C}', 'C');
          return true;
        }
        _push(tex, plain, _Role.op);
        expect = true;
        return true;
      }
      if (s == 'C' && !_glued(k + 1) && k + 1 < n && _startsOperand(k + 1) && !(k == 0 && n == 1)) {
        // "C 0 D" opening a line: + with its left operand dropped, or ℂ before more math.
        if (k == 0 || _last?.role == _Role.op || _last?.role == _Role.open) {
          if (k > 0) {
            _push(r'\mathbf{C}', 'C', _Role.x);
            expect = false;
            return true;
          }
          _dropped();
          _push(tex, plain, _Role.op);
          return true;
        }
      }
      if (s == 'D' && n > 1 && !_glued(k + 1) && !_opLetter(k + 1)) {
        // A continuation line of a display ("D 8 C 10i"), or = after a dropped operand.
        if (k > 0) _dropped();
        _push(tex, plain, _Role.op);
        expect = true;
        return true;
      }
      if (s == 'C' && k > 0 && !_glued(k + 1) && _startsOperand(k + 1) && RegExp(r'^[+\-(]$|^\\cdot$').hasMatch(_last?.tex ?? '')) {
        _dropped();
        _push(tex, plain, _Role.op);
        expect = true;
        return true;
      }
      if (s == 'C') {
        _push(r'\mathbf{C}', 'C', _Role.x);
        expect = false;
        _fieldScripts(k);
        return true;
      }
      // D or W as a letter.
    }

    if (_isLetter(s)) return _letterStep(k, a, s);

    if (GarbledTable.functions.contains(s)) {
      _push('\\operatorname{$s}', s, _Role.fn);
      expect = true;
      return true;
    }

    if (_isDigit(s)) return _digitStep(k, a, s);

    final symbol = _symbols[s];
    if (symbol != null) {
      final (kind, tex, plain) = symbol;
      if (kind == 'var') {
        _push(tex, plain, _Role.x);
        expect = false;
      } else if (kind == 'post') {
        _push(tex, plain, _Role.close);
        expect = false;
      } else if (s == '…' && expect) {
        // Opening a line or after an operator, the ellipsis is the ⋯ of a long sum; between operands it is ∉.
        _push(_cdots, '⋯', _Role.x);
        expect = false;
      } else {
        if (expect && k > 0 && _last?.role == _Role.op) _dropped();
        _push(tex, plain, _Role.op);
        expect = true;
      }
      return true;
    }

    switch (s) {
      case '.':
        if (k + 1 < n && atoms[k + 1].gap <= 1) {
          _push('(', '(', _Role.open);
          stack.add('(');
          expect = true;
          return true;
        }
        return k == n - 1;
      case '/':
        if (expect && _last?.role == _Role.op) _dropped();
        if (stack.isNotEmpty && stack.last == '(') stack.removeLast();
        _push(')', ')', _Role.close);
        expect = false;
        _closeScripts(k);
        return true;
      case ';' || ',':
        _push(',', ',', _Role.op);
        expect = true;
        return true;
      case ':::':
        _push(r'\ldots', '…', _Role.x);
        expect = false;
        return true;
      case ':':
        if (k + 2 < n && atoms[k + 1].s == ':' && atoms[k + 2].s == ':' && atoms[k + 1].gap <= 1 && atoms[k + 2].gap <= 1) {
          _push(r'\ldots', '…', _Role.x);
          expect = false;
          jump = k + 3;
          return true;
        }
        if (k == n - 1) return true;
        _push(':', ':', _Role.op);
        expect = true;
        return true;
      case 'Œ':
        _push('[', '[', _Role.open);
        stack.add('[');
        expect = true;
        return true;
      case '?':
        if (!expect && !lastOfLine) {
          _script(false, r'\perp', '⊥');
          return true;
        }
        return k == n - 1;
    }
    return false;
  }

  bool _letterStep(int k, _Atom a, String s) {
    final top = stack.isEmpty ? null : stack.last;
    if (s == 'f' && _glued(k + 1) && (_ahead(k, 'g') > 0 || atoms[k + 1].s == '.' && _ahead(k, 'W') > 0)) {
      if (!expect) _push('', '', _Role.op);
      _push(r'\{', '{', _Role.open);
      stack.add('{');
      expect = true;
      return true;
    }
    if (s == 'g' && !expect && top == '{') {
      stack.removeLast();
      _push(r'\}', '}', _Role.close);
      expect = false;
      _closeScripts(k);
      return true;
    }
    if (s == 'h' && k + 1 < n && _ahead(k, 'i', needComma: true) > 0) {
      _push(r'\langle', '⟨', _Role.open);
      stack.add('<');
      expect = true;
      return true;
    }
    if (s == 'i' && !expect && top == '<') {
      stack.removeLast();
      _push(r'\rangle', '⟩', _Role.close);
      expect = false;
      _closeScripts(k);
      return true;
    }
    if (s == 'i' &&
        !expect &&
        a.gap == 0 &&
        stack.isEmpty &&
        (k + 1 >= n || atoms[k + 1].gap > 0) &&
        parts.any((p) => p.tex == ',') &&
        ((_last?.sub ?? false) || _isDigit(atoms[k - 1].s))) {
      // "ej ; eki D 0": the ⟨ was on the previous line.
      _push(r'\rangle', '⟩', _Role.close);
      expect = false;
      return true;
    }
    if (!expect &&
        a.gap == 1 &&
        RegExp('^[A-Z]\$').hasMatch(_a(k - 1)?.s ?? '') &&
        _indexLetter.hasMatch(s) &&
        !(_glued(k + 1) && _isLetter(atoms[k + 1].s) && atoms[k + 1].s != 'C')) {
      // T k: a power of an operator.
      _superscriptGroup(k);
      return true;
    }
    if ((s == 'k' || s == 'j') && !expect && top == s) {
      stack.removeLast();
      _push(s == 'k' ? r'\|' : '|', s == 'k' ? '‖' : '|', _Role.close);
      expect = false;
      _closeScripts(k);
      return true;
    }
    if ((s == 'k' || s == 'j') &&
        (a.gap > 0 || expect || _last?.role == _Role.close || (_a(k + 1)?.gap ?? 0) > 0) &&
        k + 1 < n &&
        !_isDigit(atoms[k + 1].s) &&
        (s == 'k' || _glued(k + 1)) &&
        (_startsOperand(k + 1) || atoms[k + 1].s == 'h') &&
        _ahead(k, s) > 0) {
      if (!expect && _last?.role != _Role.close) _push('', '', _Role.op);
      _push(s == 'k' ? r'\|' : '|', s == 'k' ? '‖' : '|', _Role.open);
      stack.add(s);
      expect = true;
      return true;
    }
    if (s == 'j' && !expect && a.gap > 0 && _glued(k + 1) && RegExp('^[A-Z]\$').hasMatch(atoms[k + 1].s)) {
      // T jU: the restriction T|_U.
      _push('|', '|', _Role.close);
      _script(true, atoms[k + 1].s, atoms[k + 1].s);
      jump = k + 2;
      expect = false;
      return true;
    }
    if (s == 'N' &&
        _glued(k + 1) &&
        (a.gap > 0 || k == 0) &&
        !_indexLetter.hasMatch(atoms[k + 1].s) &&
        (_isLetter(atoms[k + 1].s) || _kind(atoms[k + 1].s) == 'var')) {
      if (atoms[k + 1].s == 'h') {
        _push('\\bar{${_droppedOperand.$1}}', '${_droppedOperand.$2}̄', _Role.x);
        expect = false;
        return true;
      }
      final next = atoms[k + 1];
      final symbol = _symbols[next.s];
      final (tex, plain) = symbol != null ? (symbol.$2, symbol.$3) : _letter(next, false);
      _push('\\overline{$tex}', '$plain̄', _Role.x);
      expect = false;
      jump = k + 2;
      return true;
    }
    if (s == 'X' && expect && k + 1 < n && atoms[k + 1].gap > 0 && _startsOperand(k + 1) && (k == 0 || _last?.role == _Role.op)) {
      _push(r'\sum', '∑', _Role.op);
      return true;
    }
    if (!expect && a.gap == 0) {
      // Glued to an operand: an index, or a product.
      final prev = atoms[k - 1].s;
      final listIndex = s == 'i' && _a(k + 1)?.s == ';' && _glued(k + 1) && _glued(k + 2);
      if ((_indexLetter.hasMatch(s) || listIndex) && (_isLetter(prev) || _kind(prev) == 'var') && !_indexLetter.hasMatch(prev)) {
        _subscriptGroup(k);
        return true;
      }
    }
    final field = GarbledTable.fields.contains(s) &&
        !(_glued(k + 1) && _isLetter(atoms[k + 1].s) && !RegExp(r'^[jkmnSgi]$').hasMatch(atoms[k + 1].s) && !GarbledTable.fields.contains(atoms[k + 1].s)) &&
        !(k > 0 && a.gap == 0 && _isLetter(atoms[k - 1].s));
    final (tex, plain) = _letter(a, field);
    _push(tex, plain, _Role.x);
    expect = false;
    if (field) _fieldScripts(k);
    return true;
  }

  bool _digitStep(int k, _Atom a, String s) {
    if (s == '2' &&
        !expect &&
        a.gap > 0 &&
        k + 1 < n &&
        (_startsOperand(k + 1) || atoms[k + 1].s == 'f' || atoms[k + 1].s == 'h') &&
        atoms[k + 1].gap > 0 &&
        !_opLetter(k + 1)) {
      _push(r'\in', '∈', _Role.op);
      expect = true;
      return true;
    }
    var number = s;
    var m = k + 1;
    while (m < n && atoms[m].gap == 0 && _isDigit(atoms[m].s)) {
      number += atoms[m++].s;
    }
    if (!expect && a.gap == 0) {
      // u1, A1;k: an index.
      final prev = atoms[k - 1].s;
      if (RegExp(r'^[23]$').hasMatch(number) && RegExp(r'^[nm]$').hasMatch(prev) && _last?.tex == prev) {
        // n2: dimensions are squared, not indexed.
        _script(false, number, number);
        jump = m;
        return true;
      }
      if (RegExp(r'^0{1,3}$').hasMatch(number) && (RegExp(r'^[fgpq]$').hasMatch(prev) || number == '0' && RegExp(r'^[A-Z]$').hasMatch(prev)) && _last?.tex == prev) {
        // p0, S0: p′ and S′ (the prime glyph is the symbol font's 0).
        _script(false, r'\prime' * number.length, '′' * number.length);
        jump = m;
        return true;
      }
      if (prev == '/' || prev == 'k' && _last?.role == _Role.close || prev == 'j' && _last?.role == _Role.close || prev == 'g') {
        _script(false, number, number);
        jump = m;
        return true;
      }
      _subscriptGroup(k);
      return true;
    }
    if (!expect && a.gap == 1 && !(m < n && atoms[m].gap > 0 && _startsOperand(m) && !_opLetter(m))) {
      // T 1, V 0, i 2: a raised script whose minus or prime was dropped.
      final prev = atoms[k - 1];
      if (number == '0' && RegExp(r'^[A-Zfgpq]$').hasMatch(prev.s)) {
        _script(false, r'\prime', '′');
      } else if (number == '1' && RegExp(r'^[A-Z]$').hasMatch(prev.s)) {
        _script(false, '-1', '−1');
      } else {
        _script(false, number, number);
      }
      jump = m;
      expect = false;
      return true;
    }
    if (!expect && _last?.role == _Role.x) _push('', '', _Role.op);
    _push(number, number, _Role.x);
    expect = false;
    jump = m;
    return true;
  }

  /// Scripts glued after ℝ, ℂ, 𝔽: R3, Rn, Fm;n, FS.
  void _fieldScripts(int k) {
    var m = k + 1;
    final tex = StringBuffer();
    final plain = StringBuffer();
    while (m < n && atoms[m].gap == 0) {
      final c = atoms[m].s;
      if (_isDigit(c) || _indexLetter.hasMatch(c) || c == 'S' || GarbledTable.fields.contains(c)) {
        tex.write(GarbledTable.fields.contains(c) ? '\\mathbf{$c}' : c);
        plain.write(c);
      } else if (c == ';' && m + 1 < n && atoms[m + 1].gap == 0 && RegExp(r'^[\dA-Za-z]$').hasMatch(atoms[m + 1].s)) {
        tex.write(',');
        plain.write(',');
      } else {
        break;
      }
      m++;
    }
    if (tex.isNotEmpty) {
      _script(false, tex.toString(), plain.toString());
      jump = m;
    }
  }

  /// u1, A1;k, vnC1: the index after an operand, through glued commas and plus signs.
  void _subscriptGroup(int k) {
    var m = k;
    final tex = StringBuffer();
    final plain = StringBuffer();
    while (m < n && (m == k || atoms[m].gap == 0)) {
      final c = atoms[m].s;
      if ((c == 'k' || c == 'j') && m > k && stack.isNotEmpty && stack.last == c) break;
      if (_isDigit(c) || _indexLetter.hasMatch(c) || (c == 'i' && m == k)) {
        // "am1": a_{m−1}, its minus dropped.
        if (c == '1' && m > k && _indexLetter.hasMatch(atoms[m - 1].s) && _a(m + 1)?.s != 'C') {
          tex.write('-');
          plain.write('−');
        }
        tex.write(c);
        plain.write(c);
      } else if ((c == ';' || c == 'C') && m + 1 < n && atoms[m + 1].gap == 0 && RegExp(r'^[\dijkmn]$').hasMatch(atoms[m + 1].s) && tex.isNotEmpty) {
        tex.write(c == ';' ? ',' : '+');
        plain.write(c == ';' ? ',' : '+');
      } else {
        break;
      }
      m++;
    }
    _script(true, tex.toString(), plain.toString());
    jump = m;
  }

  /// T k, T kC1: a power.
  void _superscriptGroup(int k) {
    var m = k;
    final tex = StringBuffer();
    final plain = StringBuffer();
    while (m < n && (m == k || atoms[m].gap == 0)) {
      final c = atoms[m].s;
      if (_isDigit(c) || _indexLetter.hasMatch(c)) {
        if (c == '1' && m > k && _indexLetter.hasMatch(atoms[m - 1].s) && _a(m + 1)?.s != 'C') {
          tex.write('-');
          plain.write('−');
        }
        tex.write(c);
        plain.write(c);
      } else if (c == 'C' && m + 1 < n && atoms[m + 1].gap == 0 && RegExp(r'^[\djkmn]$').hasMatch(atoms[m + 1].s)) {
        tex.write('+');
        plain.write('+');
      } else {
        break;
      }
      m++;
    }
    _script(false, tex.toString(), plain.toString());
    jump = m;
  }

  /// A power glued after a closing delimiter: (…)2, ‖v‖2.
  void _closeScripts(int k) {
    var m = k + 1;
    final tex = StringBuffer();
    final delimiter = _last?.tex == r'\|' || _last?.tex == '|';
    while (m < n &&
        atoms[m].gap == 0 &&
        (_isDigit(atoms[m].s) || _indexLetter.hasMatch(atoms[m].s) && !delimiter && !stack.contains(atoms[m].s))) {
      tex.write(atoms[m++].s);
    }
    final t = tex.toString();
    if (RegExp(r'^0+$').hasMatch(t) && _last?.tex == ')') {
      // P(R)0: the dual space, primed.
      _script(false, r'\prime' * t.length, '′' * t.length);
      jump = m;
    } else if (t.isNotEmpty) {
      // ⟨u, v⟩1 is an inner product's name; (…)2 and ‖v‖2 are powers.
      _script(_last?.tex == r'\rangle', t, t);
      jump = m;
    }
  }

  void _closeInterval() {
    final open = parts.indexWhere((p) => p.tex == '[');
    var commas = 0;
    for (var k = open + 1; k < parts.length; k++) {
      if (parts[k].tex == ',') commas++;
      if (commas == 1 && parts[k].role == _Role.x && (k + 1 >= parts.length || parts[k + 1].role != _Role.x)) {
        parts.insert(k + 1, _Part(']', ']', _Role.close));
        return;
      }
    }
  }
}
