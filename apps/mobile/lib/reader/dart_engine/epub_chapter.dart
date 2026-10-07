import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;

import 'garbled_math.dart';

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
  static final _artwork = [
    for (final name in ['svg', 'math']) (RegExp('<$name\\b', caseSensitive: false), RegExp('</$name\\s*>', caseSensitive: false)),
  ];
  static final _rawText = [
    for (final name in ['style', 'script'])
      (RegExp('<$name(?=[\\s/>])', caseSensitive: false), RegExp('</$name\\s*>', caseSensitive: false)),
  ];
  static final _colorAttrs = RegExp(
    r'''\s(?:style|color|bgcolor|text|link|vlink|alink)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)''',
    caseSensitive: false,
  );
  static final _styleAttr = RegExp(r'''\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')''', caseSensitive: false);
  static final _mathScriptType = RegExp(
    r'''type\s*=\s*["']math/tex(;\s*mode=display)?["']''',
    caseSensitive: false,
  );

  // Chapters are untrusted and arbitrarily long. Every scan below is linear:
  // no lazy `[\s\S]*?` search that each unclosed opener would rerun to the
  // end of the document (an 80 KB chapter of them froze the reader for 30 s).

  static String prepare(String xhtml) {
    var s = xhtml;
    final pdf = _looksLikePdfConversion(s);
    s = _body(s);
    s = _dropRawText(s);
    if (pdf || _needsDom(s)) s = _enhance(s, pdf: pdf);
    // Artwork keeps its own colours, as in the native readers.
    final out = StringBuffer();
    var at = 0;
    for (final run in _runs(s, _artwork).runs) {
      out
        ..write(_stripColours(s.substring(at, run.start)))
        ..write(s.substring(run.start, run.end));
      at = run.end;
    }
    out.write(_stripColours(s.substring(at)));
    return _glueFormulas(out.toString());
  }

  /// The content of the first `<body>`, as `<body[^>]*>([\s\S]*?)</body>`
  /// would find it.
  static String _body(String s) {
    final open = RegExp('<body', caseSensitive: false).firstMatch(s);
    if (open == null) return s;
    final start = s.indexOf('>', open.end);
    if (start < 0) return s;
    final close = RegExp('</body>', caseSensitive: false).allMatches(s, start + 1).firstOrNull;
    return close == null ? s : s.substring(start + 1, close.start);
  }

  /// Removes `<style>` and `<script>` elements; MathJax sources survive as
  /// spans the math builder understands. One left open runs to the end of
  /// the document, as an HTML parser reads it, and goes too.
  static String _dropRawText(String s) {
    final (:runs, :unclosed) = _runs(s, _rawText);
    final out = StringBuffer();
    var at = 0;
    for (final run in runs) {
      out.write(s.substring(at, run.start));
      at = run.end;
      if (run.kind != 1) continue;
      final tagEnd = s.indexOf('>', run.start) + 1;
      final closeStart = s.lastIndexOf('<', run.end - 1);
      if (tagEnd > closeStart) continue;
      final type = _mathScriptType.firstMatch(s.substring(run.start, tagEnd));
      if (type == null) continue;
      final source = s.substring(tagEnd, closeStart);
      final tex = _escape(_unescape(source.replaceAll(RegExp(r'^\s*<!\[CDATA\[|\]\]>\s*$'), '')));
      out.write('<span class="math ${type[1] == null ? 'inline' : 'display'}" data-tr-tex="script">$tex</span>');
    }
    out.write(s.substring(at, unclosed ?? s.length));
    return out.toString();
  }

  /// Leftmost, non-overlapping runs from an opener of one of [kinds] to the
  /// nearest closer of the same kind starting at least [gap] characters
  /// after it: what the lazy alternation `open[\s\S]*?close` (`+?` for a
  /// gap of 1) matches. Once an opener has no closer, no later opener of its
  /// kind has one either, so that kind is dropped rather than rescanned.
  /// [unclosed] is the first opener left without a closer after the last run.
  static ({List<({int start, int end, int kind})> runs, int? unclosed}) _runs(
    String s,
    List<(Pattern, Pattern)> kinds, {
    int gap = 0,
  }) {
    final runs = <({int start, int end, int kind})>[];
    final opens = List<Match?>.filled(kinds.length, null);
    final closes = List<Match?>.filled(kinds.length, null);
    final live = List.filled(kinds.length, true);
    var at = 0;
    while (true) {
      var best = -1;
      for (var k = 0; k < kinds.length; k++) {
        if (!live[k]) continue;
        var open = opens[k];
        if (open == null || open.start < at) open = opens[k] = kinds[k].$1.allMatches(s, at).firstOrNull;
        final from = open == null ? s.length + 1 : open.end + gap;
        var close = closes[k];
        if (from <= s.length && (close == null || close.start < from)) {
          close = closes[k] = kinds[k].$2.allMatches(s, from).firstOrNull;
        }
        if (open == null || close == null || close.start < from) {
          live[k] = false;
        } else if (best < 0 || open.start < opens[best]!.start) {
          best = k;
        }
      }
      if (best < 0) break;
      runs.add((start: opens[best]!.start, end: closes[best]!.end, kind: best));
      at = closes[best]!.end;
    }
    int? unclosed;
    for (final (open, _) in kinds) {
      final m = open.allMatches(s, at).firstOrNull;
      if (m != null && (unclosed == null || m.start < unclosed)) unclosed = m.start;
    }
    return (runs: runs, unclosed: unclosed);
  }

  /// Rewrites every start tag. Past the last `>` nothing can be a tag, and
  /// leaving that tail out keeps each `<` there from rescanning to the end.
  static String _stripColours(String text) {
    final end = text.lastIndexOf('>') + 1;
    return text.substring(0, end).replaceAllMapped(_tag, (m) => _rewriteStartTag(m[0]!)) + text.substring(end);
  }

  // Tag bodies are `[^<>]*`: each `<img` or `<span` scan stops at the next
  // tag, so many openers inside one long tag stay linear.
  static final _formulaThenText = RegExp(r'((?:<img\b[^<>]*\sdata-tr-em-h="[^"<>]*"[^<>]*>|</math>)(?:</span>)*)(?=[^\s<])');
  static final _textThenFormula = RegExp(r'(?<=[^\s>])((?:<span\b[^<>]*>)*(?:<img\b[^<>]*\sdata-tr-em-h=|<math\b))');

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
      s.contains('epub:switch') ||
      s.contains(r'$$') ||
      s.contains(r'\(') ||
      s.contains(r'\[') ||
      s.contains('data-tr-tex="script"');

  /// pdftohtml output, directly or through calibre: the generator says so,
  /// or calibre paragraphs carry numbered page anchors (`<a id="p112">`).
  static bool _looksLikePdfConversion(String xhtml) {
    final head = xhtml.length > 4000 ? xhtml.substring(0, 4000) : xhtml;
    if (RegExp(r'''<meta[^>]+content\s*=\s*["']pdftohtml''', caseSensitive: false).hasMatch(head)) return true;
    if (!xhtml.contains('class="calibre')) return false;
    return RegExp(r'<p[^<>]*>\s*<a id="p\d+"></a>').allMatches(xhtml).take(5).length >= 5;
  }

  static String _enhance(String body, {required bool pdf}) {
    final doc = html.parse('<!DOCTYPE html><html><body>$body</body></html>');
    final root = doc.body!;
    _resolveSwitches(root);
    _wrapDelimitedTex(root);
    _hideMathJaxOutput(root);
    if (pdf) {
      _unwrapInlineAroundBlocks(root);
      _hidePageFurniture(root);
      // Line by line, before lines join into paragraphs.
      if (GarbledMath.isGarbled(root.text)) GarbledMath.prepare(root);
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

  static const _literal = {'pre', 'code', 'script', 'math', 'textarea', 'kbd', 'samp'};

  /// `$$…$$`, `\[…\]` and `\(…\)`, the last one inline.
  static const _delimitedTex = [(r'$$', r'$$'), (r'\[', r'\]'), (r'\(', r'\)')];

  /// `$$…$$`, `\[…\]` and `\(…\)` in running text become math spans holding
  /// the very same text, as MathJax would have typeset them.
  static void _wrapDelimitedTex(dom.Element root) {
    void walk(dom.Node node) {
      for (final child in node.nodes.toList()) {
        if (child is dom.Element) {
          if (_literal.contains(child.localName) || child.classes.contains('math')) continue;
          walk(child);
        } else if (child is dom.Text) {
          final text = child.data;
          final matches = _runs(text, _delimitedTex, gap: 1).runs;
          if (matches.isEmpty) continue;
          var at = 0;
          for (final m in matches) {
            if (m.start > at) node.insertBefore(dom.Text(text.substring(at, m.start)), child);
            final span = dom.Element.tag('span')
              ..classes.addAll(['math', if (m.kind == 2) 'inline' else 'display'])
              ..append(dom.Text(text.substring(m.start, m.end)));
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
    final parents = {for (final source in root.querySelectorAll('[data-tr-tex="script"]')) ?source.parentNode};
    for (final parent in parents) {
      // Backwards from each source over the output just before it.
      var hiding = false;
      for (final sibling in _elementsOf(parent).reversed) {
        if (sibling.attributes['data-tr-tex'] == 'script') {
          hiding = true;
        } else if (hiding && (sibling.classes.any(_mathJaxOutput.hasMatch) || sibling.localName == 'mjx-container')) {
          sibling.attributes[EpubMarks.hidden] = '';
        } else {
          hiding = false;
        }
      }
    }
  }

  // package:html finds an element's sibling by searching its parent's list,
  // so walks over long runs of siblings index the parent's list once instead.
  static List<dom.Element> _elementsOf(dom.Node parent) => parent.nodes.whereType<dom.Element>().toList();

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

  static dom.Element? _nextParagraph(dom.Element e, Map<dom.Element, dom.Element> nextOf) {
    final next = nextOf[e];
    return next != null && next.localName == 'p' ? next : null;
  }

  /// Page numbers and running heads that pdftohtml kept as paragraphs right
  /// after each page anchor: `84 / CHAPTER 3 / Linear Maps` or
  /// `SECTION 3.D / Invertibility … / 85`. They are hidden, never deleted.
  static void _hidePageFurniture(dom.Element root) {
    final anchors = [
      for (final anchor in root.querySelectorAll('p > a[id]'))
        if (RegExp(r'^p\d+$').hasMatch(anchor.id) && anchor.nodes.isEmpty) anchor,
    ];
    final nextOf = <dom.Element, dom.Element>{};
    for (final parent in {for (final a in anchors) ?a.parent!.parentNode}) {
      final elements = _elementsOf(parent);
      for (var i = 0; i + 1 < elements.length; i++) {
        nextOf[elements[i]] = elements[i + 1];
      }
    }
    final seen = <dom.Element>{};
    for (final anchor in anchors) {
      final first = anchor.parent!;
      // Several anchors in one paragraph would measure its text once each.
      if (!seen.add(first)) continue;
      final second = _nextParagraph(first, nextOf);
      final third = second == null ? null : _nextParagraph(second, nextOf);
      final t = [first, second, third].map((p) => p == null ? '' : _text(p)).toList();
      final hide = <dom.Element>[];
      if (_pageNumber.hasMatch(t[0]) && _runningHead.hasMatch(t[1])) {
        hide.addAll([first, second!, if (third != null && t[2].length <= 80) third]);
      } else if (_runningHead.hasMatch(t[0]) && t[1].length <= 80 && _pageNumber.hasMatch(t[2])) {
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
    final parents = {for (final p in root.querySelectorAll('p')) ?p.parentNode};
    for (final parent in parents) {
      final siblings = parent.nodes;
      for (var index = 0; index < siblings.length; index++) {
        final a = siblings[index];
        if (a is! dom.Element || a.localName != 'p' || a.attributes.containsKey(EpubMarks.hidden)) continue;
        // Kept up to date as lines join (the end decides), not re-read from a
        // paragraph that grows with every line.
        var textA = _text(a);
        // Where the next line is looked for: lines joined so far stay behind,
        // hidden, and are not walked again.
        var next = index + 1;
        while (true) {
          if (textA.length < 20 || !_openEnd.hasMatch(textA)) break;
          // Skip hidden page furniture between the two halves.
          dom.Element? b;
          for (; next < siblings.length; next++) {
            final n = siblings[next];
            if (n is! dom.Element) continue;
            if (n.localName == 'p' && n.attributes.containsKey(EpubMarks.hidden)) continue;
            b = n;
            break;
          }
          if (b == null || b.localName != 'p' || b.className != a.className) break;
          final textB = _text(b);
          if (textB.isEmpty || !_lowerStart.hasMatch(textB)) break;
          final hyphen = _hyphenEnd.hasMatch(textA);
          final between = index + 1 < siblings.length ? siblings[index + 1] : null;
          if (!hyphen) {
            if (between is dom.Text && between.data.trim().isEmpty) {
              a.append(between); // leaves the list: what follows moves up one
              next--;
            } else {
              a.append(dom.Text(' '));
            }
          }
          for (final n in b.nodes.toList()) {
            a.append(n);
          }
          b.attributes[EpubMarks.hidden] = '';
          textA = hyphen ? '$textA$textB' : '$textA $textB';
          next++;
        }
      }
    }
  }
}
