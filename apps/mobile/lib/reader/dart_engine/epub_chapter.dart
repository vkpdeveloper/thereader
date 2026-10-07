import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;

/// Markers the preparation pass leaves for the view's builders. They are
/// data attributes, so the colour stripping below never touches them.
abstract final class EpubMarks {
  /// Hidden, not removed: publisher `display:none`, page furniture.
  static const hidden = 'data-tr-hidden';

  /// Equation image height and baseline shift in em, from its inline style.
  static const emHeight = 'data-tr-em-h';
  static const emShift = 'data-tr-em-va';
}

/// Turns a spine document into the HTML the Dart engine renders: body only,
/// publisher colours gone, and the structural repairs of the shared content
/// enhancer (see `apps/web/src/reader/enhance/`) done natively, since this
/// engine cannot run its JavaScript. Ordinary prose books skip the DOM pass.
abstract final class EpubChapter {
  static final _tag = RegExp(r'<[A-Za-z][^>]*>');
  static final _artwork = RegExp(r'<(svg|math)\b[\s\S]*?</\1>', caseSensitive: false);
  static final _colorAttrs = RegExp(
    r'''\s(?:style|color|bgcolor|text|link|vlink|alink)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)''',
    caseSensitive: false,
  );
  static final _styleAttr = RegExp(r'''\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')''', caseSensitive: false);
  static final _mathScript = RegExp(
    r'''<script\b[^>]*type\s*=\s*["']math/tex(;\s*mode=display)?["'][^>]*>([\s\S]*?)</script>''',
    caseSensitive: false,
  );

  static String prepare(String xhtml) {
    var s = xhtml;
    final pdf = _looksLikePdfConversion(s);
    final body = RegExp(r'<body[^>]*>([\s\S]*?)</body>', caseSensitive: false).firstMatch(s);
    if (body != null) s = body.group(1)!;
    s = s.replaceAll(RegExp(r'<style[\s\S]*?</style>', caseSensitive: false), '');
    // MathJax sources survive as spans the math builder understands.
    s = s.replaceAllMapped(_mathScript, (m) {
      final tex = _escape(_unescape(m[2]!.replaceAll(RegExp(r'^\s*<!\[CDATA\[|\]\]>\s*$'), '')));
      return '<span class="math ${m[1] == null ? 'inline' : 'display'}" data-tr-tex="script">$tex</span>';
    });
    s = s.replaceAll(RegExp(r'<script[\s\S]*?</script>', caseSensitive: false), '');
    if (pdf || _needsDom(s)) s = _enhance(s, pdf: pdf);
    // Artwork keeps its own colours, as in the native readers.
    s = s.splitMapJoin(
      _artwork,
      onNonMatch: (text) => text.replaceAllMapped(_tag, (m) => _rewriteStartTag(m[0]!)),
    );
    return _glueFormulas(s);
  }

  static final _formulaThenText = RegExp(r'((?:<img\b[^>]*\sdata-tr-em-h="[^"]*"[^>]*>|</math>)(?:</span>)*)(?=[^\s<])');
  static final _textThenFormula = RegExp(r'(?<=[^\s>])((?:<span\b[^>]*>)*(?:<img\b[^>]*\sdata-tr-em-h=|<math\b))');

  /// A formula and the punctuation or suffix touching it ("$n$-dimensional",
  /// "($x$)") stay on one line: a word joiner goes between them, as nothing
  /// else stops the line breaker from splitting at an inline widget.
  static String _glueFormulas(String s) => s
      .replaceAllMapped(_formulaThenText, (m) => '${m[1]}\u2060')
      .replaceAllMapped(_textThenFormula, (m) => '\u2060${m[1]}');

  /// Drops colour sources from a start tag, keeping what its inline style
  /// says about visibility and equation sizing as markers.
  static String _rewriteStartTag(String tag) {
    final marks = <String>[];
    final style = _styleAttr.firstMatch(tag);
    if (style != null) {
      final css = (style[1] ?? style[2] ?? '').toLowerCase();
      if (RegExp(r'(^|;)\s*display\s*:\s*none').hasMatch(css)) marks.add(EpubMarks.hidden);
      if (tag.toLowerCase().startsWith('<img')) {
        final h = RegExp(r'(?:^|;)\s*height\s*:\s*([\d.]+)em').firstMatch(css);
        final va = RegExp(r'vertical-align\s*:\s*(-?[\d.]+)em').firstMatch(css);
        if (h != null) marks.add('${EpubMarks.emHeight}="${h[1]}"');
        if (h != null && va != null) marks.add('${EpubMarks.emShift}="${va[1]}"');
      }
    }
    final stripped = tag.replaceAll(_colorAttrs, '');
    if (marks.isEmpty) return stripped;
    final end = stripped.endsWith('/>') ? stripped.length - 2 : stripped.length - 1;
    return '${stripped.substring(0, end).trimRight()} ${marks.join(' ')}${stripped.substring(end)}';
  }

  static String _unescape(String s) =>
      s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');

  static String _escape(String s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  static bool _needsDom(String s) =>
      s.contains('epub:switch') || s.contains(r'$$') || s.contains('data-tr-tex="script"');

  /// pdftohtml output, directly or through calibre: the generator says so,
  /// or calibre paragraphs carry numbered page anchors (`<a id="p112">`).
  static bool _looksLikePdfConversion(String xhtml) {
    final head = xhtml.length > 4000 ? xhtml.substring(0, 4000) : xhtml;
    if (RegExp(r'''<meta[^>]+content\s*=\s*["']pdftohtml''', caseSensitive: false).hasMatch(head)) return true;
    if (!xhtml.contains('class="calibre')) return false;
    return RegExp(r'<p[^>]*>\s*<a id="p\d+"></a>').allMatches(xhtml).take(5).length >= 5;
  }

  static String _enhance(String body, {required bool pdf}) {
    final doc = html.parse('<!DOCTYPE html><html><body>$body</body></html>');
    final root = doc.body!;
    _resolveSwitches(root);
    _wrapDisplayDollars(root);
    _hideMathJaxOutput(root);
    if (pdf) {
      _unwrapInlineAroundBlocks(root);
      _hidePageFurniture(root);
      _joinBrokenLines(root);
    }
    return root.innerHtml;
  }

  /// `epub:switch` → its MathML case when there is one, else the default.
  static void _resolveSwitches(dom.Element root) {
    // Selectors cannot name prefixed tags, so walk the tree.
    final switches = <dom.Element>[];
    void collect(dom.Element e) {
      for (final c in e.children) {
        if (c.localName == 'epub:switch') {
          switches.add(c);
        } else {
          collect(c);
        }
      }
    }

    collect(root);
    for (final sw in switches) {
      dom.Element? chosen;
      for (final c in sw.children) {
        if (c.localName == 'epub:case' && (c.attributes['required-namespace'] ?? '').contains('MathML')) {
          chosen = c;
          break;
        }
      }
      chosen ??= sw.children.where((c) => c.localName == 'epub:default').firstOrNull;
      final parent = sw.parentNode;
      if (parent == null) continue;
      if (chosen != null) {
        for (final n in chosen.nodes.toList()) {
          parent.insertBefore(n, sw);
        }
      }
      sw.remove();
    }
  }

  static const _rawText = {'pre', 'code', 'script', 'math', 'textarea', 'kbd', 'samp'};

  /// `$$…$$` in running text becomes a display-math span holding the very
  /// same text.
  static void _wrapDisplayDollars(dom.Element root) {
    final pattern = RegExp(r'\$\$([\s\S]+?)\$\$');
    void walk(dom.Node node) {
      for (final child in node.nodes.toList()) {
        if (child is dom.Element) {
          if (_rawText.contains(child.localName) || child.classes.contains('math')) continue;
          walk(child);
        } else if (child is dom.Text && child.data.contains(r'$$')) {
          final text = child.data;
          final matches = pattern.allMatches(text).toList();
          if (matches.isEmpty) continue;
          var at = 0;
          for (final m in matches) {
            if (m.start > at) node.insertBefore(dom.Text(text.substring(at, m.start)), child);
            final span = dom.Element.tag('span')
              ..classes.addAll(['math', 'display'])
              ..append(dom.Text(m[0]!));
            node.insertBefore(span, child);
            at = m.end;
          }
          if (at < text.length) node.insertBefore(dom.Text(text.substring(at)), child);
          child.remove();
        }
      }
    }

    walk(root);
  }

  static final _mathJaxOutput = RegExp(r'^(MathJax(_Preview|_Display|_CHTML|_SVG|_SVG_Display)?|MJX_Assistive_MathML)$');

  /// Where MathJax sources were kept (`script[type=math/tex]`), the publisher's
  /// pre-rendered output and previews next to them would duplicate them.
  static void _hideMathJaxOutput(dom.Element root) {
    for (final source in root.querySelectorAll('[data-tr-tex="script"]')) {
      var sibling = source.previousElementSibling;
      while (sibling != null && (sibling.classes.any(_mathJaxOutput.hasMatch) || sibling.localName == 'mjx-container')) {
        sibling.attributes[EpubMarks.hidden] = '';
        sibling = sibling.previousElementSibling;
      }
    }
  }

  static const _inline = {'i', 'b', 'em', 'strong', 'span', 'u', 'font', 'small', 'big', 'tt', 'cite', 's', 'sub', 'sup'};
  static const _block = {
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'table', 'blockquote', 'pre', 'section',
    'figure', 'hr', 'article', 'aside', 'header', 'footer', 'nav', 'center',
  };

  /// `<i><p>…</p><p>…</p></i>` styles a whole book italic. Inline wrappers of
  /// blocks are unwrapped in place; their children keep their order.
  static void _unwrapInlineAroundBlocks(dom.Element root) {
    for (final e in root.querySelectorAll(_inline.join(',')).toList()) {
      if (!e.children.any((c) => _block.contains(c.localName))) continue;
      final parent = e.parentNode;
      if (parent == null) continue;
      for (final n in e.nodes.toList()) {
        parent.insertBefore(n, e);
      }
      e.remove();
    }
  }

  static final _pageNumber = RegExp(r'^(\d{1,4}|[ivxlcdm]{1,7})$', caseSensitive: false);
  static final _runningHead = RegExp(r'^(CHAPTER|Chapter|SECTION|Section|PART|Part|APPENDIX|Appendix)\s+[\dA-Z]+(\.[\dA-Z]+)*$');

  static String _text(dom.Element e) => e.text.replaceAll(RegExp(r'\s+'), ' ').trim();

  static dom.Element? _nextParagraph(dom.Element e) {
    final next = e.nextElementSibling;
    return next != null && next.localName == 'p' ? next : null;
  }

  /// Page numbers and running heads that pdftohtml kept as paragraphs right
  /// after each page anchor: `84 / CHAPTER 3 / Linear Maps` or
  /// `SECTION 3.D / Invertibility … / 85`. They are hidden, never deleted.
  static void _hidePageFurniture(dom.Element root) {
    for (final anchor in root.querySelectorAll('p > a[id]').toList()) {
      if (!RegExp(r'^p\d+$').hasMatch(anchor.id) || anchor.nodes.isNotEmpty) continue;
      final first = anchor.parent!;
      final second = _nextParagraph(first);
      final third = second == null ? null : _nextParagraph(second);
      final t = [first, second, third].map((p) => p == null ? '' : _text(p)).toList();
      final hide = <dom.Element>[];
      if (_pageNumber.hasMatch(t[0]) && _runningHead.hasMatch(t[1])) {
        hide.addAll([first, second!, if (third != null && t[2].length <= 80) third]);
      } else if (_runningHead.hasMatch(t[0]) && _pageNumber.hasMatch(t[2])) {
        hide.addAll([first, second!, third!]);
      } else if (_runningHead.hasMatch(t[0]) && _pageNumber.hasMatch(t[1])) {
        hide.addAll([first, second!]);
      } else if (_pageNumber.hasMatch(t[0])) {
        hide.add(first);
      }
      for (final p in hide) {
        p.attributes[EpubMarks.hidden] = '';
      }
    }
  }

  static final _openEnd = RegExp(r'[a-z,\-‐–]$');
  static final _hyphenEnd = RegExp(r'[A-Za-z][\-‐]$');
  static final _lowerStart = RegExp(r'^[a-z]');

  /// Every PDF line is its own paragraph. A line that stops mid-sentence
  /// (ends in a lowercase letter, comma or hyphen) continues into the next
  /// one when that starts lowercase; the following line's nodes move into it.
  static void _joinBrokenLines(dom.Element root) {
    for (final a in root.querySelectorAll('p').toList()) {
      if (a.parentNode == null || a.attributes.containsKey(EpubMarks.hidden)) continue;
      while (true) {
        final textA = _text(a);
        if (textA.length < 20 || !_openEnd.hasMatch(textA)) break;
        // Skip hidden page furniture between the two halves.
        var b = a.nextElementSibling;
        while (b != null && b.localName == 'p' && b.attributes.containsKey(EpubMarks.hidden)) {
          b = b.nextElementSibling;
        }
        if (b == null || b.localName != 'p' || b.className != a.className) break;
        final textB = _text(b);
        if (textB.isEmpty || !_lowerStart.hasMatch(textB)) break;
        final hyphen = _hyphenEnd.hasMatch(textA);
        final siblings = a.parentNode!.nodes;
        final index = siblings.indexOf(a);
        final between = index + 1 < siblings.length ? siblings[index + 1] : null;
        if (!hyphen) a.append(between is dom.Text && between.data.trim().isEmpty ? between : dom.Text(' '));
        for (final n in b.nodes.toList()) {
          a.append(n);
        }
        b.attributes[EpubMarks.hidden] = '';
      }
    }
  }
}
