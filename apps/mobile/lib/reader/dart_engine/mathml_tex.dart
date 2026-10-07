import 'package:html/dom.dart' as dom;

/// Presentation MathML to TeX for flutter_math_fork, covering what EPUBs
/// actually ship: tokens, rows, scripts, fractions, radicals, accents and
/// under/over limits, tables, fences and styles. Anything unknown renders its
/// children, so the output degrades to readable text rather than failing.
abstract final class MathmlTex {
  /// TeX for a `<math>` element: its TeX annotation when it carries one,
  /// else a conversion of the presentation markup.
  static String of(dom.Element math) => annotation(math) ?? convert(math);

  /// The `application/x-tex` annotation of a `<semantics>` block, if any.
  static String? annotation(dom.Element math) {
    for (final e in math.querySelectorAll('*')) {
      if (_name(e) != 'annotation') continue;
      final encoding = (e.attributes['encoding'] ?? '').toLowerCase();
      if (encoding.contains('tex')) {
        final tex = e.text.trim();
        if (tex.isNotEmpty) return tex;
      }
    }
    return null;
  }

  /// Whether the formula is display (block) math.
  static bool isDisplay(dom.Element math) =>
      math.attributes['display'] == 'block' || math.attributes['mode'] == 'display';

  static String convert(dom.Element element) => _node(element).trim();

  static String _name(dom.Element e) => (e.localName ?? '').split(':').last.toLowerCase();

  static List<dom.Element> _elements(dom.Element e) => e.children;

  static String _join(Iterable<String> parts) => parts.where((p) => p.isNotEmpty).join(' ');

  static String _group(dom.Element? e) => e == null ? '{}' : '{${_node(e)}}';

  static String _node(dom.Element e) {
    final kids = _elements(e);
    switch (_name(e)) {
      case 'math' || 'mstyle' || 'mpadded' || 'merror' || 'mrow':
        final style = e.attributes['displaystyle'];
        final prefix = style == 'true' ? r'\displaystyle ' : style == 'false' ? r'\textstyle ' : '';
        final body = _row(kids);
        if (_name(e) == 'mstyle' || prefix.isNotEmpty) return '{$prefix$body}';
        return body;
      case 'semantics':
        return kids.isEmpty ? '' : _node(kids.first);
      case 'annotation' || 'annotation-xml' || 'none' || 'mprescripts':
        return '';
      case 'mi':
        return _identifier(e);
      case 'mn':
        return _variant(e.attributes['mathvariant'], _symbols(e.text.trim()));
      case 'mo':
        return _operator(e);
      case 'mtext':
        return _text(e.text);
      case 'ms':
        return _text('"${e.text}"');
      case 'mglyph':
        return _text(e.attributes['alt'] ?? '');
      case 'mspace':
        return _space(e.attributes['width']);
      case 'mphantom':
        return '\\phantom{${_row(kids)}}';
      case 'msub':
        return '${_base(kids, 0)}_${_group(_at(kids, 1))}';
      case 'msup':
        return '${_base(kids, 0)}^${_sup(_at(kids, 1))}';
      case 'msubsup':
        return '${_base(kids, 0)}_${_group(_at(kids, 1))}^${_sup(_at(kids, 2))}';
      case 'mfrac':
        final num = _group(_at(kids, 0));
        final den = _group(_at(kids, 1));
        final thickness = (e.attributes['linethickness'] ?? '').trim();
        if (RegExp(r'^0(\.0*)?([a-z]+)?$').hasMatch(thickness)) return '\\genfrac{}{}{0pt}{}$num$den';
        if (e.attributes['bevelled'] == 'true') return '$num/$den';
        return '\\frac$num$den';
      case 'msqrt':
        return '\\sqrt{${_row(kids)}}';
      case 'mroot':
        final index = _at(kids, 1);
        return '\\sqrt[${index == null ? '' : _node(index)}]${_group(_at(kids, 0))}';
      case 'mover':
        return _over(e, kids);
      case 'munder':
        return _under(e, kids);
      case 'munderover':
        final base = _at(kids, 0);
        if (base != null && _isLargeOperator(base)) return '${_node(base)}_${_group(_at(kids, 1))}^${_group(_at(kids, 2))}';
        return '\\overset${_group(_at(kids, 2))}{\\underset${_group(_at(kids, 1))}${_group(base)}}';
      case 'mtable':
        return _table(e);
      case 'mtr' || 'mlabeledtr' || 'mtd':
        return _row(kids);
      case 'mfenced':
        return _fenced(e, kids);
      case 'menclose':
        final notation = e.attributes['notation'] ?? 'longdiv';
        final body = _row(kids);
        if (notation.contains('box')) return '\\boxed{$body}';
        if (notation.contains('strike')) return '\\cancel{$body}';
        if (notation.contains('radical')) return '\\sqrt{$body}';
        if (notation.contains('top')) return '\\overline{$body}';
        if (notation.contains('bottom')) return '\\underline{$body}';
        return body;
      case 'mmultiscripts':
        return _multiscripts(kids);
      case 'maction':
        return kids.isEmpty ? '' : _node(kids.first);
      default:
        return _row(kids);
    }
  }

  static dom.Element? _at(List<dom.Element> kids, int i) => i < kids.length ? kids[i] : null;

  static const _opens = {'(': '(', '[': '[', '{': r'\{', '|': '|', '‖': r'\|', '⟨': r'\langle', '〈': r'\langle', '⌊': r'\lfloor', '⌈': r'\lceil'};
  static const _closes = {')': ')', ']': ']', '}': r'\}', '|': '|', '‖': r'\|', '⟩': r'\rangle', '〉': r'\rangle', '⌋': r'\rfloor', '⌉': r'\rceil'};

  /// A row; an outer pair of fences grows with what it encloses.
  static String _row(List<dom.Element> kids) {
    if (kids.length >= 3) {
      final first = kids.first;
      final last = kids.last;
      final open = _name(first) == 'mo' ? _opens[first.text.trim()] : null;
      final close = _name(last) == 'mo' ? _closes[last.text.trim()] : null;
      if (open != null && close != null && first.attributes['stretchy'] != 'false') {
        return '\\left$open ${_join(kids.sublist(1, kids.length - 1).map(_node))} \\right$close';
      }
    }
    return _join(kids.map(_node));
  }

  static String _fenced(dom.Element e, List<dom.Element> kids) {
    String delim(String? s, Map<String, String> map, String fallback) {
      final v = (s ?? fallback).trim();
      return v.isEmpty ? '.' : map[v] ?? _symbols(v);
    }

    final open = delim(e.attributes['open'], _opens, '(');
    final close = delim(e.attributes['close'], _closes, ')');
    final separators = (e.attributes['separators'] ?? ',').replaceAll(RegExp(r'\s'), '');
    final parts = <String>[];
    for (var i = 0; i < kids.length; i++) {
      if (i > 0 && separators.isNotEmpty) parts.add(_symbols(separators[(i - 1).clamp(0, separators.length - 1)]));
      parts.add(_node(kids[i]));
    }
    return '\\left$open ${_join(parts)} \\right$close';
  }

  /// A script base: single tokens stay bare so large operators keep their
  /// limits; anything composite is grouped.
  static String _base(List<dom.Element> kids, int i) {
    final e = _at(kids, i);
    if (e == null) return '{}';
    final name = _name(e);
    if ((name == 'mi' || name == 'mn' || name == 'mo') && e.text.trim().runes.length <= 1) return _node(e);
    if (_isLargeOperator(e)) return _node(e);
    return '{${_node(e)}}';
  }

  static String _sup(dom.Element? e) {
    if (e != null && _name(e) == 'mo') {
      final t = e.text.trim();
      if (t == '′' || t == "'") return r'{\prime}';
      if (t == '″') return r'{\prime\prime}';
    }
    return _group(e);
  }

  static const _largeOps = {'∑', '∏', '∐', '⋃', '⋂', '⨁', '⨂', '⨀', '⋁', '⋀', '∫', '∬', '∭', '∮', 'lim', 'max', 'min', 'sup', 'inf', 'lim sup', 'lim inf'};

  static bool _isLargeOperator(dom.Element e) {
    final name = _name(e);
    if (name != 'mo' && name != 'mi') return false;
    return _largeOps.contains(e.text.trim());
  }

  static const _accents = {
    '^': r'\hat', 'ˆ': r'\hat', '̂': r'\hat', '¯': r'\overline', '‾': r'\overline', '_': r'\overline', '̅': r'\overline',
    '→': r'\vec', '⃗': r'\vec', '~': r'\tilde', '˜': r'\tilde', '̃': r'\tilde', '˙': r'\dot', '̇': r'\dot', '.': r'\dot',
    '¨': r'\ddot', '̈': r'\ddot', 'ˇ': r'\check', '˘': r'\breve', '´': r'\acute', '`': r'\grave',
    '⏞': r'\overbrace', '︷': r'\overbrace', '←': r'\overleftarrow', '↔': r'\overleftrightarrow',
  };
  static const _wide = {r'\hat': r'\widehat', r'\tilde': r'\widetilde', r'\vec': r'\overrightarrow'};

  static String _over(dom.Element e, List<dom.Element> kids) {
    final base = _at(kids, 0);
    final over = _at(kids, 1);
    if (over != null && _name(over) == 'mo') {
      var accent = _accents[over.text.trim()];
      if (accent != null) {
        final body = base == null ? '' : _node(base);
        final short = base != null && base.text.trim().runes.length <= 1;
        if (!short) accent = _wide[accent] ?? accent;
        return '$accent{$body}';
      }
    }
    if (base != null && _isLargeOperator(base)) return '${_node(base)}^${_group(over)}';
    return '\\overset${_group(over)}${_group(base)}';
  }

  static String _under(dom.Element e, List<dom.Element> kids) {
    final base = _at(kids, 0);
    final under = _at(kids, 1);
    if (under != null && _name(under) == 'mo') {
      final t = under.text.trim();
      if (t == '_' || t == '̲' || t == '¯' || t == '‾') return '\\underline{${base == null ? '' : _node(base)}}';
      if (t == '⏟' || t == '︸') return '\\underbrace{${base == null ? '' : _node(base)}}';
    }
    if (base != null && _isLargeOperator(base)) return '${_node(base)}_${_group(under)}';
    return '\\underset${_group(under)}${_group(base)}';
  }

  static String _table(dom.Element table) {
    final rows = <String>[];
    var columns = 0;
    for (final tr in _elements(table)) {
      final name = _name(tr);
      if (name != 'mtr' && name != 'mlabeledtr') continue;
      var cells = _elements(tr).where((c) => _name(c) == 'mtd').toList();
      if (name == 'mlabeledtr' && cells.isNotEmpty) cells = cells.sublist(1);
      if (cells.length > columns) columns = cells.length;
      rows.add(cells.map((c) => _row(_elements(c))).join(' & '));
    }
    final body = rows.join(r' \\ ');
    final align = (table.attributes['columnalign'] ?? '').trim().split(RegExp(r'\s+')).where((a) => a.isNotEmpty).toList();
    if (align.isNotEmpty && columns > 0) {
      final spec = [for (var i = 0; i < columns; i++) align[i.clamp(0, align.length - 1)]]
          .map((a) => a.startsWith('l') ? 'l' : a.startsWith('r') ? 'r' : 'c')
          .join();
      return '\\begin{array}{$spec} $body \\end{array}';
    }
    return '\\begin{matrix} $body \\end{matrix}';
  }

  static String _multiscripts(List<dom.Element> kids) {
    if (kids.isEmpty) return '';
    final base = _node(kids.first);
    final post = <dom.Element>[];
    final pre = <dom.Element>[];
    var target = post;
    for (final k in kids.skip(1)) {
      if (_name(k) == 'mprescripts') {
        target = pre;
        continue;
      }
      target.add(k);
    }
    String scripts(List<dom.Element> list) {
      final subs = <String>[];
      final sups = <String>[];
      for (var i = 0; i + 1 < list.length; i += 2) {
        subs.add(_node(list[i]));
        sups.add(_node(list[i + 1]));
      }
      final sub = _join(subs);
      final sup = _join(sups);
      return '${sub.isEmpty ? '' : '_{$sub}'}${sup.isEmpty ? '' : '^{$sup}'}';
    }

    final before = scripts(pre);
    return '${before.isEmpty ? '' : '{}$before'}{$base}${scripts(post)}';
  }

  static String _space(String? width) {
    final m = RegExp(r'^([\d.]+)\s*(em|ex|px|pt)?$').firstMatch((width ?? '').trim());
    if (m == null) return width == null ? '' : r'\ ';
    var em = double.tryParse(m[1]!) ?? 0;
    if (m[2] == 'ex') em *= 0.43;
    if (m[2] == 'px' || m[2] == 'pt') em /= 16;
    if (em >= 1.8) return r'\qquad';
    if (em >= 0.9) return r'\quad';
    if (em >= 0.4) return r'\enspace';
    if (em >= 0.25) return r'\;';
    if (em >= 0.2) return r'\:';
    if (em > 0) return r'\,';
    return '';
  }

  static const _functions = {
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth', 'arcsin', 'arccos', 'arctan', 'log', 'ln',
    'lg', 'exp', 'det', 'dim', 'ker', 'lim', 'max', 'min', 'sup', 'inf', 'arg', 'deg', 'gcd', 'hom', 'Pr', 'liminf', 'limsup',
  };

  static String _identifier(dom.Element e) {
    final text = e.text.trim();
    if (text.isEmpty) return '';
    final variant = e.attributes['mathvariant'];
    final length = text.runes.length;
    if (length > 1 && (variant == null || variant == 'normal') && _functions.contains(text)) return '\\$text';
    final body = _symbols(text);
    if (length > 1 && RegExp(r'^[A-Za-z0-9]+$').hasMatch(text)) {
      // Multi-letter identifiers are upright unless told otherwise.
      return _variant(variant ?? 'normal', body);
    }
    return _variant(variant, body);
  }

  static String _variant(String? variant, String body) {
    if (body.isEmpty) return body;
    final command = switch (variant) {
      'normal' => r'\mathrm',
      'bold' => r'\mathbf',
      'italic' => null,
      'bold-italic' => r'\boldsymbol',
      'double-struck' => r'\mathbb',
      'script' || 'bold-script' => r'\mathcal',
      'fraktur' || 'bold-fraktur' => r'\mathfrak',
      'sans-serif' || 'bold-sans-serif' || 'sans-serif-italic' || 'sans-serif-bold-italic' => r'\mathsf',
      'monospace' => r'\mathtt',
      _ => null,
    };
    return command == null ? body : '$command{$body}';
  }

  static String _operator(dom.Element e) {
    final text = e.text.trim();
    if (text.isEmpty) return '';
    if (text.runes.length > 1 && RegExp(r'^[A-Za-z]+$').hasMatch(text)) {
      return _functions.contains(text) ? '\\$text' : '\\operatorname{$text}';
    }
    return _symbols(text);
  }

  static String _text(String raw) {
    final text = raw.replaceAll(RegExp(r'\s+'), ' ');
    if (text.trim().isEmpty) return text.isEmpty ? '' : r'\ ';
    final escaped = text
        .replaceAll(r'\', '/')
        .replaceAllMapped(RegExp(r'[{}#$%&_]'), (m) => '\\${m[0]}')
        .replaceAll('^', '')
        .replaceAll('~', ' ');
    return '\\text{$escaped}';
  }

  /// Unicode and TeX-special characters to TeX, character by character.
  static String _symbols(String text) {
    final out = StringBuffer();
    for (final rune in text.runes) {
      final ch = String.fromCharCode(rune);
      final mapped = _symbolMap[ch] ?? _alphanumeric(rune);
      if (mapped != null) {
        out.write(mapped);
        // Keep a following letter from fusing with a command name.
        if (mapped.startsWith(r'\') && RegExp(r'[A-Za-z]$').hasMatch(mapped)) out.write(' ');
      } else {
        out.write(ch);
      }
    }
    return out.toString().trim();
  }

  /// Mathematical Alphanumeric Symbols (U+1D400 block) as styled letters.
  static String? _alphanumeric(int rune) {
    const blocks = [
      (0x1D400, r'\mathbf'), (0x1D434, ''), (0x1D468, r'\boldsymbol'), (0x1D49C, r'\mathcal'), (0x1D4D0, r'\mathcal'),
      (0x1D504, r'\mathfrak'), (0x1D538, r'\mathbb'), (0x1D56C, r'\mathfrak'), (0x1D5A0, r'\mathsf'), (0x1D5D4, r'\mathsf'),
      (0x1D608, r'\mathsf'), (0x1D63C, r'\mathsf'), (0x1D670, r'\mathtt'),
    ];
    for (final (start, command) in blocks) {
      final i = rune - start;
      if (i < 0 || i >= 52) continue;
      final letter = String.fromCharCode(i < 26 ? 0x41 + i : 0x61 + i - 26);
      return command.isEmpty ? letter : '$command{$letter}';
    }
    if (rune >= 0x1D7CE && rune <= 0x1D7FF) {
      final i = (rune - 0x1D7CE) % 10;
      final command = rune < 0x1D7D8 ? r'\mathbf' : rune < 0x1D7E2 ? r'\mathbb' : r'\mathsf';
      return '$command{$i}';
    }
    return null;
  }

  static const _symbolMap = <String, String>{
    // TeX specials.
    '\\': r'\backslash', '{': r'\{', '}': r'\}', '#': r'\#', r'$': r'\$', '%': r'\%', '&': r'\&', '_': r'\_', '~': r'\sim',
    '^': r'\hat{}',
    // Invisible operators and spacing.
    '⁡': '', '⁢': '', '⁣': '', '⁤': '', '​': '', ' ': r'\ ', ' ': r'\,', ' ': r'\;',
    ' ': r'\quad',
    // Greek.
    'α': r'\alpha', 'β': r'\beta', 'γ': r'\gamma', 'δ': r'\delta', 'ϵ': r'\epsilon', 'ε': r'\varepsilon', 'ζ': r'\zeta',
    'η': r'\eta', 'θ': r'\theta', 'ϑ': r'\vartheta', 'ι': r'\iota', 'κ': r'\kappa', 'λ': r'\lambda', 'μ': r'\mu', 'ν': r'\nu',
    'ξ': r'\xi', 'π': r'\pi', 'ϖ': r'\varpi', 'ρ': r'\rho', 'ϱ': r'\varrho', 'σ': r'\sigma', 'ς': r'\varsigma', 'τ': r'\tau',
    'υ': r'\upsilon', 'ϕ': r'\phi', 'φ': r'\varphi', 'χ': r'\chi', 'ψ': r'\psi', 'ω': r'\omega', 'Γ': r'\Gamma',
    'Δ': r'\Delta', 'Θ': r'\Theta', 'Λ': r'\Lambda', 'Ξ': r'\Xi', 'Π': r'\Pi', 'Σ': r'\Sigma', 'Υ': r'\Upsilon',
    'Φ': r'\Phi', 'Ψ': r'\Psi', 'Ω': r'\Omega', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
    'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Χ': 'X', 'ο': 'o',
    // Letterlike.
    'ℝ': r'\mathbb{R}', 'ℂ': r'\mathbb{C}', 'ℕ': r'\mathbb{N}', 'ℤ': r'\mathbb{Z}', 'ℚ': r'\mathbb{Q}', 'ℙ': r'\mathbb{P}',
    'ℍ': r'\mathbb{H}', 'ℓ': r'\ell', 'ℏ': r'\hbar', 'ℜ': r'\Re', 'ℑ': r'\Im', 'ℵ': r'\aleph', '℘': r'\wp', 'ı': r'\imath',
    'ȷ': r'\jmath', 'ℒ': r'\mathcal{L}', 'ℱ': r'\mathcal{F}', 'ℋ': r'\mathcal{H}', 'ℬ': r'\mathcal{B}', 'ℰ': r'\mathcal{E}',
    'ℳ': r'\mathcal{M}', 'ℛ': r'\mathcal{R}', 'ℐ': r'\mathcal{I}',
    // Operators and relations.
    '−': '-', '∗': r'\ast', '×': r'\times', '÷': r'\div', '·': r'\cdot', '⋅': r'\cdot', '∘': r'\circ', '∙': r'\bullet',
    '±': r'\pm', '∓': r'\mp', '⊕': r'\oplus', '⊗': r'\otimes', '⊙': r'\odot', '⊖': r'\ominus', '†': r'\dagger',
    '∧': r'\wedge', '∨': r'\vee', '¬': r'\neg', '∩': r'\cap', '∪': r'\cup', '∖': r'\setminus', '⊎': r'\uplus',
    '∈': r'\in', '∉': r'\notin', '∋': r'\ni', '⊂': r'\subset', '⊃': r'\supset', '⊆': r'\subseteq', '⊇': r'\supseteq',
    '⊊': r'\subsetneq', '⊋': r'\supsetneq', '≤': r'\le', '≥': r'\ge', '≦': r'\leqq', '≧': r'\geqq', '≠': r'\ne',
    '≈': r'\approx', '≡': r'\equiv', '≅': r'\cong', '∼': r'\sim', '≃': r'\simeq', '∝': r'\propto', '≪': r'\ll',
    '≫': r'\gg', '≺': r'\prec', '≻': r'\succ', '⊥': r'\perp', '∥': r'\parallel', '∣': r'\mid', '∤': r'\nmid',
    '≔': r'\coloneqq', '≐': r'\doteq', '⊢': r'\vdash', '⊨': r'\models', '∴': r'\therefore', '∵': r'\because',
    // Arrows.
    '→': r'\to', '←': r'\leftarrow', '↔': r'\leftrightarrow', '⇒': r'\Rightarrow', '⇐': r'\Leftarrow',
    '⇔': r'\Leftrightarrow', '↦': r'\mapsto', '⟶': r'\longrightarrow', '⟵': r'\longleftarrow', '⟹': r'\Longrightarrow',
    '⟺': r'\Longleftrightarrow', '↑': r'\uparrow', '↓': r'\downarrow', '↗': r'\nearrow', '↘': r'\searrow',
    '↪': r'\hookrightarrow', '⇀': r'\rightharpoonup', '⇌': r'\rightleftharpoons',
    // Big operators and misc.
    '∑': r'\sum', '∏': r'\prod', '∐': r'\coprod', '⋃': r'\bigcup', '⋂': r'\bigcap', '⨁': r'\bigoplus', '⨂': r'\bigotimes',
    '⋁': r'\bigvee', '⋀': r'\bigwedge', '∫': r'\int', '∬': r'\iint', '∭': r'\iiint', '∮': r'\oint', '∂': r'\partial',
    '∇': r'\nabla', '∞': r'\infty', '∀': r'\forall', '∃': r'\exists', '∄': r'\nexists', '∅': r'\emptyset',
    '√': r'\surd', '∠': r'\angle', '△': r'\triangle', '□': r'\square', '◻': r'\square', '∎': r'\blacksquare',
    '…': r'\ldots', '⋯': r'\cdots', '⋮': r'\vdots', '⋱': r'\ddots', '′': r'\prime', '″': r'\prime\prime',
    '⟨': r'\langle', '⟩': r'\rangle', '〈': r'\langle', '〉': r'\rangle', '⌊': r'\lfloor', '⌋': r'\rfloor',
    '⌈': r'\lceil', '⌉': r'\rceil', '‖': r'\|', '°': r'^{\circ}', '♯': r'\sharp', '♭': r'\flat', '♮': r'\natural',
  };
}
