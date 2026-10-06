/// DOM to blocks (`blocks.ts`): converts the article's root elements into the
/// document model, with whitespace normalized the way a browser renders it.
library;

import 'dart:math' as math;

import 'content.dart';
import 'js.dart';
import 'languages.dart';
import 'match.dart';
import 'media.dart';
import 'model.dart';
import 'tree.dart';
import 'url.dart';

/// $$…$$ display TeX: the delimiters of [_texMatches] that start with a dollar.
final _texDollars = RegExp(r'\$\$([^$]+?)\$\$');

/// The same plus $…$ inline, for pages that show they use TeX (never "$5 and $10").
final _texDollarsAny = RegExp(r'\$\$([^$]+?)\$\$|\$([^\s$\d](?:[^$\n]{0,300}?[^\s$\\])?)\$(?![\d\w])');

class _TexMatch {
  _TexMatch(this.start, this.end, this.texStart, this.texEnd, this.display);
  final int start;
  final int end;

  /// Where the formula between the delimiters starts and ends.
  final int texStart;
  final int texEnd;
  final bool display;
}

/// `text.indexOf(needle, from)` for a `from` that never decreases: each part of the text is searched once.
int Function(int from) _seeker(String text, String needle) {
  var at = -2;
  return (from) {
    if (at == -2 || (at >= 0 && at < from)) at = from > text.length ? -1 : text.indexOf(needle, from);
    return at;
  };
}

/// TeX left for MathJax/KaTeX, in order: $$…$$ and \[…\] display, \(…\) inline, and with [dollars]
/// also $…$ inline. What `\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|…` finds, in
/// linear time: that regex scans to the end of the text from every unclosed `\[`, so the backslash
/// pairs are found with `indexOf` instead.
Iterable<_TexMatch> _texMatches(String text, bool dollars) sync* {
  final pattern = dollars ? _texDollarsAny : _texDollars;
  final pairs = [
    (open: _seeker(text, r'\['), close: _seeker(text, r'\]'), display: true),
    (open: _seeker(text, r'\('), close: _seeker(text, r'\)'), display: false),
  ];
  // The first dollar match at or after `from` (null: none), once searched.
  var searched = false;
  RegExpMatch? dollar;
  var from = 0;
  for (;;) {
    if (!searched || (dollar != null && dollar.start < from)) {
      final matches = pattern.allMatches(text, from).iterator;
      dollar = matches.moveNext() ? matches.current : null;
      searched = true;
    }
    _TexMatch? first;
    if (dollar != null) {
      final display = text.startsWith(r'$$', dollar.start);
      final delimiter = display ? 2 : 1;
      first = _TexMatch(dollar.start, dollar.end, dollar.start + delimiter, dollar.end - delimiter, display);
    }
    for (final pair in pairs) {
      final open = pair.open(from);
      if (open < 0 || (first != null && open > first.start)) continue;
      // `[\s\S]+?`: the first closing delimiter after at least one character. None means none for later openers either.
      final close = pair.close(open + 3);
      if (close >= 0) first = _TexMatch(open, close + 2, open + 2, close, pair.display);
    }
    if (first == null) return;
    yield first;
    from = first.end;
  }
}

const _tagMark = {
  'b': Mark.bold, 'strong': Mark.bold, 'i': Mark.italic, 'em': Mark.italic, 'cite': Mark.italic, 'dfn': Mark.italic, //
  'var': Mark.italic, 'u': Mark.underline, 'ins': Mark.underline, 's': Mark.strike, 'del': Mark.strike,
  'strike': Mark.strike, 'code': Mark.code, 'tt': Mark.code, 'samp': Mark.code, 'kbd': Mark.kbd, 'sub': Mark.sub,
  'sup': Mark.sup, 'mark': Mark.highlight, 'small': Mark.small,
};

const _inlineTags = {
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', //
  'img', 'ins', 'kbd', 'label', 'mark', 'math', 'math-tex', 'nobr', 'noscript', 'picture', 'q', 'rb', 'rp', 'rt', 'rtc',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'svg',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
  'input',
  'meta', 'link', 'source', 'track',
};

const _blockTags = {
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dd', 'dir', 'div', 'dl', 'dt', //
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'iframe', 'video', 'audio', 'summary',
  'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'xmp', 'listing', 'plaintext',
};

final _backlink = ClassPattern(
  r'(?:^|[\s_-])(?:footnote-backref|reversefootnote|footnote-back|footnote-return|mw-cite-backlink|backlink|fn-back|footnote-backlink|data-footnote-backref)(?:$|[\s_-])',
);
final _permalink = ClassPattern(
  r'(?:^|[\s_-])(?:anchor|headerlink|hash-link|permalink|heading-link|anchorjs-link|header-anchor|heading-anchor|anchor-link|deep-link|direct-link|autolink|section-link|copy-link)(?:$|[\s_-])',
);
final _captionClass = ClassPattern(
  r'(?:^|[\s_-])(?:caption|wp-caption-text|figcaption|image-caption|photo-caption|img-caption|media-caption|caption-text|imagecaption|figure-caption|credit|image-credit|photo-credit)(?:$|[\s_-])',
);

/// Any element whose class names it a caption or credit (`InlineImage-imageEmbedCaption`, `newsCaption`, `photo-credit`).
final _captionLike = ClassPattern(r'caption|credit', caseSensitive: false);
final _credit = ClassPattern(r'credit', caseSensitive: false);

final _creditClass = ClassPattern(
  r'(?:^|[\s_-])(?:credit|credits|copyright|attribution|photographer|image-credit|photo-credit|source|byline)(?:$|[\s_-])',
);
final _figureLike = ClassPattern(
  r'(?:^|[\s_-])(?:wp-caption|wp-block-image|image-block|figure|photo|media-image|article-image|inline-image|image-container|image-wrapper|img-wrapper|picture)(?:$|[\s_-])',
);
final _codeTitle = ClassPattern(
  r'(?:^|[\s_-])(?:code-?block-?title|code-?title|filename|file-name|codeblock-header|code-header|code-block-header|rehype-code-title|remark-code-title|highlight-title)(?:$|[\s_-])|codeblocktitle',
);
final _gutter = ClassPattern(
  r'(?:^|[\s_-])(?:line-?numbers?(?:-rows)?|linenos?|lineno|linenodiv|gutter|ln-num|hljs-ln-n|hljs-ln-numbers|rouge-gutter|blob-num|lnt|code-line-number|react-syntax-highlighter-line-number|line-num|linenumber|line-number-cell)(?:$|[\s_-])',
);

/// Toolbars and labels that code highlighters put inside <pre> (language name, copy button).
final _codeChrome = ClassPattern(
  r'(?:^|[\s_-])(?:code-toolbar|toolbar|code-language|code-lang|lang-label|language-label|language-tag|copy-button|copy-code|clipboard)(?:$|[\s_-])',
);
final _lineElement = ClassPattern(
  r'(?:^|[\s_-])(?:line|code-line|cm-line|ec-line|token-line|highlight-line|view-line|line-content)(?:$|[\s_-])',
);
final _absolute = RegExp(r'position\s*:\s*absolute', caseSensitive: false);
final _pullQuote = ClassPattern(
  r'(?:^|[\s_-])(?:pullquote|pull-quote|wp-block-pullquote|pull_quote|blockquote--pull)(?:$|[\s_-])',
);

/// Zero-width characters, and private-use code points (icon-font glyphs that show as boxes without their font).
final _zeroWidth = RegExp('[\u200b\ufeff\u2060\ue000-\uf8ff]');
final _footnoteClass = ClassPattern(r'(?:^|\s)footnote(?:\s|$)');
final _footnoteNumber = ClassPattern(r'footnote-number');
final _footnoteContent = ClassPattern(r'footnote-content');
final _mathFallback = ClassPattern(r'mwe-math-fallback-image');
final _imageLink = RegExp(r'\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])', caseSensitive: false);
final _httpLink = RegExp(r'^https?:', caseSensitive: false);
final _labelBrackets = RegExp(r'^\[|\]$');
final _backArrow = RegExp(r'^[↩↑^]');
final _permalinkText = RegExp(r'^[#¶§🔗]?$', unicode: true);
final _linkScheme = RegExp(r'^(?:https?|mailto|tel):', caseSensitive: false);
final _bold = RegExp(r'font-weight\s*:\s*(?:bold|[6-9]00)', caseSensitive: false);
final _italic = RegExp(r'font-style\s*:\s*italic', caseSensitive: false);
final _texWrapper = RegExp(r'^\{\\(?:displaystyle|textstyle|scriptstyle)\s*([\s\S]*)\}$');

bool _hasZeroWidth(String s) {
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    if (c == 0x200b || c == 0xfeff || c == 0x2060 || (c >= 0xe000 && c <= 0xf8ff)) return true;
  }
  return false;
}

/// True when [s] has only `[\t\n\f\r ]` characters.
bool _onlyHtmlSpace(String s) {
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    if (c != 32 && c != 10 && c != 9 && c != 13 && c != 12) return false;
  }
  return true;
}

/// `s.replace(/\s+$/, '')`.
String _trimEndJs(String s) {
  var end = s.length;
  while (end > 0 && isJsSpace(s.codeUnitAt(end - 1))) {
    end--;
  }
  return end == s.length ? s : s.substring(0, end);
}

class _Ctx {
  const _Ctx(this.marks, this.href);

  final List<Mark> marks;
  final String? href;
}

const _emptyCtx = _Ctx([], null);

/// Builds inline content with whitespace normalized the way a browser renders it.
class _InlineBuilder {
  _InlineBuilder(this.converter, this.out);

  final Converter converter;

  /// Paragraph mode: a double break ends the paragraph.
  final List<Block>? out;
  List<Inline> nodes = [];

  /// Consecutive line breaks with nothing visible between them.
  int breaks = 0;

  /// Id of an anchor that opens the current paragraph ("[<a name="f1n">1</a>] ...").
  String? anchor;

  /// An element starts or ends here: text on either side comes from different elements.
  bool edge = false;

  void text(String value, _Ctx ctx) {
    if (value.isEmpty) return;
    final text = _hasZeroWidth(value) ? value.replaceAll(_zeroWidth, '') : value;
    if (text.isEmpty) return;
    if (converter.tex &&
        (text.contains(r'$') || text.contains(r'\')) &&
        !ctx.marks.contains(Mark.code) &&
        _texRuns(text, ctx)) {
      return;
    }
    _plain(text, ctx);
  }

  void _plain(String text, _Ctx ctx) {
    if (edge) {
      edge = false;
      // Two elements shown as separate lines ("…Western Australia.<small>Photograph: …"): never one glued word.
      final last = nodes.isEmpty ? null : nodes.last;
      if (last is TextRun &&
          _endsSentence(last.text) &&
          _capital.hasMatch(text) &&
          !ctx.marks.contains(Mark.code) &&
          !last.has(Mark.code)) {
        nodes[nodes.length - 1] = TextRun('${last.text} ', marks: last.marks, href: last.href);
      }
    }
    if (breaks > 0 && _onlyHtmlSpace(text)) return;
    breaks = 0;
    nodes.add(TextRun(text, marks: ctx.marks.isNotEmpty ? _sortMarks(ctx.marks) : null, href: ctx.href));
  }

  /// Splits TeX written for a client-side renderer out of [text] as math; false when there is none.
  /// The text around the formulas (which holds no formula) is added as is.
  bool _texRuns(String text, _Ctx ctx) {
    var at = 0;
    for (final m in _texMatches(text, converter.dollars)) {
      if (m.start > at) _plain(text.substring(at, m.start), ctx);
      final tex = jsTrim(text.substring(m.texStart, m.texEnd));
      if (tex.isNotEmpty) {
        final node = InlineMath(tex: tex, text: tex);
        if (m.display) converter.displayMath.add(node);
        push(node);
      }
      at = m.end;
    }
    if (at == 0) return false;
    if (at < text.length) _plain(text.substring(at), ctx);
    return true;
  }

  void lineBreak() {
    edge = false;
    breaks++;
    if (breaks >= 2 && out != null) {
      flush();
      breaks = 2;
      return;
    }
    nodes.add(const LineBreak());
  }

  void push(Inline node) {
    edge = false;
    breaks = 0;
    // Display math is a block of its own: the sentence around it continues in the next paragraph.
    final out = this.out;
    if (node is InlineMath && out != null && converter.displayMath.contains(node)) {
      flush();
      out.add(MathBlock(tex: node.tex, mathml: node.mathml, text: node.text));
      return;
    }
    nodes.add(node);
  }

  /// Paragraph mode: emits the collected paragraph (or an anchored note) and starts a new one.
  void flush() {
    final out = this.out;
    if (out == null) return;
    final content = normalizeInlines(nodes);
    final anchor = this.anchor;
    nodes = [];
    breaks = 0;
    this.anchor = null;
    if (content.isEmpty) return;
    if (anchor != null && converter.anchoredNote(anchor, content, out)) return;
    out.add(ParagraphBlock(content));
  }

  List<Inline> result() => normalizeInlines(nodes);
}

List<Mark> _sortMarks(List<Mark> marks) => [
  for (final m in Mark.values)
    if (marks.contains(m)) m,
];

bool _sameMarks(List<Mark>? a, List<Mark>? b) {
  final am = a ?? const <Mark>[];
  final bm = b ?? const <Mark>[];
  if (am.length != bm.length) return false;
  for (var i = 0; i < am.length; i++) {
    if (am[i] != bm[i]) return false;
  }
  return true;
}

/// A text run being merged by [normalizeInlines] (runs are immutable).
class _Run {
  _Run(String text, this.marks, this.href) {
    buffer.write(text);
  }

  final StringBuffer buffer = StringBuffer();
  final List<Mark>? marks;
  final String? href;

  /// Last code unit written, -1 when empty.
  int last = -1;
}

/// Collapses whitespace across runs, trims around breaks and block edges, merges equal runs.
List<Inline> normalizeInlines(List<Inline> nodes) {
  // Entries are `_Run` (text being merged) or any other `Inline`.
  final out = <Object>[];
  var spaceBefore = true;
  for (final node in nodes) {
    if (node is TextRun) {
      var text = collapseHtmlSpace(node.text);
      if (spaceBefore && charCodeAt(text, 0) == 32) text = text.substring(1);
      if (text.isEmpty) continue;
      spaceBefore = text.codeUnitAt(text.length - 1) == 32;
      final last = out.isEmpty ? null : out.last;
      if (last is _Run && last.href == node.href && _sameMarks(last.marks, node.marks)) {
        last.buffer.write(text);
      } else {
        out.add(_Run(text, node.marks, node.href));
      }
    } else if (node is LineBreak) {
      _trimEnd(out);
      if (out.isEmpty || out.last is LineBreak) continue;
      out.add(node);
      spaceBefore = true;
    } else {
      out.add(node);
      spaceBefore = false;
    }
  }
  _trimEnd(out);
  while (out.isNotEmpty && out.last is LineBreak) {
    out.removeLast();
    _trimEnd(out);
  }
  // A run of only spaces between two breaks or at the start carries nothing.
  final result = <Inline>[];
  for (final entry in out) {
    if (entry is _Run) {
      final text = entry.buffer.toString();
      if (text.isNotEmpty) result.add(TextRun(text, marks: entry.marks, href: entry.href));
    } else {
      result.add(entry as Inline);
    }
  }
  return result;
}

void _trimEnd(List<Object> out) {
  while (out.isNotEmpty) {
    final last = out.last;
    if (last is! _Run) return;
    final text = last.buffer.toString();
    var end = text.length;
    while (end > 0 && text.codeUnitAt(end - 1) == 32) {
      end--;
    }
    if (end > 0) {
      if (end < text.length) {
        last.buffer
          ..clear()
          ..write(text.substring(0, end));
      }
      return;
    }
    out.removeLast();
  }
}

bool _hasBlock(VElement el) {
  if (el.blockState >= 0) return el.blockState == 1;
  var found = false;
  for (final child in el.children) {
    if (child is VElement && !child.skip && (_blockTags.contains(child.tag) || _hasBlock(child))) {
      found = true;
      break;
    }
  }
  el.blockState = found ? 1 : 0;
  return found;
}

bool _isInline(VElement el) {
  if (_inlineTags.contains(el.tag)) return !_hasBlock(el);
  // Custom elements holding only phrasing (<dt-math>, <d-cite>) sit inside the sentence; video placeholders do not.
  return el.tag.indexOf('-') > 0 && !_hasBlock(el) && lazyVideo(el) == null;
}

final _displayWrapper = ClassPattern(
  r'(?:^|[\s_-])(?:katex-display|math-display|display-math|mathjax_display|mwe-math-element-block|math-block|equation)(?:$|[\s_-])',
);

/// A formula set on its own line: by its own attributes or its renderer's wrapper (KaTeX, MathJax, Wikipedia, Distill).
bool _isDisplayMath(VElement el) {
  if (el.attrs['display'] == 'block' || el.attrs['mode'] == 'display') return true;
  var p = el.parent;
  for (var depth = 0; depth < 4 && p != null; depth++, p = p.parent) {
    if (_displayWrapper.hasMatch(p.matchString) || p.attrs['display'] == 'true' && p.tag == 'mjx-container') {
      return true;
    }
    if (p.tag.endsWith('-math') && p.attrs['block'] != null) return true;
  }
  return false;
}

/// The still of a video file drawn right after it (its poster, for browsers that do not play video): that video already shows it.
bool _isStillOf(Block? prev, ArticleImage image) =>
    prev is VideoBlock && prev.provider == 'file' && prev.poster == image.src;

int? _intAttr(VElement el, String name) {
  final v = el.attrs[name];
  if (v == null) return null;
  final n = jsParseInt(v);
  return n.isFinite ? n.toInt() : null;
}

String? _texFrom(String? value) {
  if (value == null) return null;
  var tex = jsTrim(value);
  final m = _texWrapper.firstMatch(tex);
  if (m != null) tex = jsTrim(m.group(1)!);
  return tex.isNotEmpty ? tex : null;
}

InlineImage _inlineImage(ArticleImage image) {
  final node = InlineImage(src: image.src, alt: image.alt);
  if (image.width != null) node.width = image.width;
  if (image.height != null) node.height = image.height;
  return node;
}

class Converter {
  Converter(this.base);

  final String base;

  /// Footnote item ids found in the article, with their labels.
  final Map<String, String> _notes = {};

  /// Footnote items, and (built on first use) their text with the label stripped, to recognise inline copies.
  final List<VElement> _noteItems = [];
  Set<String>? _noteTexts;
  String? _pendingCodeTitle;

  /// Notes written inline at their reference (LaTeXML, sidenotes), listed after the text.
  final List<Footnote> _inlineNotes = [];
  bool _inNote = false;

  /// In-page "[n]" links not yet matched to a note: target id -> label.
  final Map<String, String> _pendingRefs = {};

  /// Provisional refs with the link text they replace if no note turns up.
  final Map<Inline, String> _provisional = Map.identity();
  final Set<String> _resolved = {};

  /// The <li> each item of an ordered list after a provisional ref came from, to find a ref's anchor in.
  final Map<ListItem, VElement> _itemSources = Map.identity();

  /// Label of the first reference to each listed note.
  final Map<String, String> _refLabels = {};

  /// Math nodes typeset as display (block) formulas.
  final Set<Inline> displayMath = Set.identity();

  /// The text holds TeX delimiters (`$$`, `\[`, `\(`), so it is parsed as math; [dollars] adds $…$ inline.
  bool tex = false;
  bool dollars = false;

  List<Block> convert(List<VElement> roots) {
    for (final root in roots) {
      _scanFootnotes(root);
    }
    for (final root in roots) {
      _scanTex(root);
    }
    final out = <Block>[];
    for (final root in roots) {
      if (root.skip) continue;
      if (_isInline(root) || root.tag == 'p') {
        children(root, out);
      } else {
        block(root, out);
      }
    }
    if (_inlineNotes.isNotEmpty) out.add(FootnotesBlock(_inlineNotes));
    if (_provisional.isNotEmpty) _resolveRefs(out);
    return out;
  }

  bool _isNoteCopy(VElement el) {
    final texts = _noteTexts ??= {for (final item in _noteItems) _noteKey(rawText(item))};
    return texts.contains(_noteKey(rawText(el)));
  }

  /// A paragraph opened by the anchor a "[n]" link points at is that note (Paul Graham style "Notes").
  bool anchoredNote(String id, List<Inline> content, List<Block>? out) {
    final label = _pendingRefs[id];
    if (out == null || label == null || _resolved.contains(id)) return false;
    final blocks = <Block>[ParagraphBlock(content)];
    _stripNoteLabel(blocks, label);
    if (blocks.isEmpty) return false;
    _resolved.add(id);
    final note = Footnote(id: id, label: label, blocks: blocks);
    final last = out.isEmpty ? null : out.last;
    if (last is FootnotesBlock) {
      last.items.add(note);
    } else {
      out.add(FootnotesBlock([note]));
    }
    return true;
  }

  /// Settles provisional refs: an id-less ordered list closing the article with
  /// one item per unresolved label 1..n is their notes; any ref still without a
  /// note reverts to its link text.
  void _resolveRefs(List<Block> out) {
    final pending = <(String, String)>[];
    final open = <String>[];
    _pendingRefs.forEach((id, label) {
      if (_resolved.contains(id)) return;
      pending.add((id, label));
      if (!open.contains(label)) open.add(label);
    });
    final tail = math.max(0, out.length - 3);
    for (var i = out.length - 1; i >= tail && open.isNotEmpty; i--) {
      final list = out[i];
      if (list is! ListBlock || !list.ordered || (list.start ?? 1) != 1 || list.items.length != open.length) continue;
      if (!open.every((label) => jsNumber(label) >= 1 && jsNumber(label) <= open.length)) break;
      // Each ref takes the item holding its own anchor, else the item its number names, unless another ref uses that
      // number too (two anchors, one item: which one it belongs to is unknown).
      int itemOf(String id, String label) {
        final k = list.items.indexWhere((item) {
          final li = _itemSources[item];
          return li != null && (li.id == id || firstElement(li, (e) => e.id == id || e.attrs['name'] == id) != null);
        });
        if (k >= 0) return k;
        return pending.any((p) => p.$2 == label && p.$1 != id) ? -1 : jsNumber(label).toInt() - 1;
      }

      final index = [for (final (id, label) in pending) itemOf(id, label)];
      if (!List.generate(list.items.length, (k) => k).every(index.contains)) break;
      final items = <Footnote>[];
      for (var j = 0; j < pending.length; j++) {
        if (index[j] < 0) continue;
        final (id, label) = pending[j];
        _resolved.add(id);
        items.add(Footnote(id: id, label: label, blocks: list.items[index[j]].blocks));
      }
      out[i] = FootnotesBlock(items);
      break;
    }
    // Paragraphs between two runs of anchored notes continue the note before them.
    for (var i = 0; i < out.length; i++) {
      final notes = out[i];
      if (notes is! FootnotesBlock) continue;
      var j = i + 1;
      while (j < out.length && j - i <= 4 && out[j] is ParagraphBlock) {
        j++;
      }
      final next = j < out.length ? out[j] : null;
      if (j == i + 1 || next is! FootnotesBlock) continue;
      notes.items.last.blocks.addAll(out.sublist(i + 1, j));
      notes.items.addAll(next.items);
      out.removeRange(i + 1, j + 1);
      i--;
    }
    _eachInlines(out, (content) {
      var changed = false;
      for (var k = 0; k < content.length; k++) {
        final node = content[k];
        if (node is! FootnoteRef) continue;
        final text = _provisional[node];
        if (text != null && !_resolved.contains(node.id)) {
          content[k] = TextRun(text);
          changed = true;
          continue;
        }
        // "[" ref "]": the brackets are the reference's own decoration.
        final prev = k > 0 ? content[k - 1] : null;
        final next = k + 1 < content.length ? content[k + 1] : null;
        if (prev is TextRun && next is TextRun && prev.text.endsWith('[') && next.text.startsWith(']')) {
          content[k - 1] = TextRun(prev.text.substring(0, prev.text.length - 1), marks: prev.marks, href: prev.href);
          content[k + 1] = TextRun(next.text.substring(1), marks: next.marks, href: next.href);
          changed = true;
        }
      }
      if (!changed) return;
      final normalized = normalizeInlines(content);
      content
        ..clear()
        ..addAll(normalized);
    });
  }

  // ---------------------------------------------------------------- TeX

  /// Display delimiters ($$, \[) or \( anywhere in the prose mean the page renders TeX client-side.
  void _scanTex(VElement root) {
    void visit(VElement el) {
      if (tex || el.skip || el.tag == 'pre' || el.tag == 'code' || el.tag == 'math' || el.tag == 'math-tex') return;
      for (final child in el.children) {
        if (child is VElement) {
          visit(child);
        } else if ((child as VText).texMarks) {
          final text = child.text;
          if (text.contains(r'$$') || text.contains(r'\(') || text.contains(r'\[')) {
            if (_texMatches(text, false).isNotEmpty) tex = true;
          }
        }
        if (tex) return;
      }
    }

    visit(root);
    dollars = tex;
  }

  // ---------------------------------------------------------------- footnotes

  void _scanFootnotes(VElement root) {
    var counter = _notes.length;
    walk(root, (el) {
      if (el.skip) return false;
      final isContainer = el.tag != 'a' && isFootnotes(el);
      if (isContainer) {
        walk(el, (item) {
          if (item.skip) return false;
          if (!identical(item, el) && _isNoteItem(item)) {
            counter++;
            _notes[item.id] = '$counter';
            _noteItems.add(item);
            return false;
          }
          return true;
        });
        return false;
      }
      // Substack-style notes: <div class="footnote"><a class="footnote-number" id="footnote-1">1</a>...
      if (_footnoteClass.hasMatch(el.className)) {
        final number = firstElement(el, (e) => _footnoteNumber.hasMatch(e.matchString) && e.id.isNotEmpty);
        if (number != null) {
          counter++;
          final label = collapse(rawText(number));
          _notes[number.id] = label.isNotEmpty ? label : '$counter';
          return false;
        }
        if (el.id.isNotEmpty) {
          counter++;
          _notes[el.id] = '$counter';
          return false;
        }
      }
      return true;
    });
  }

  bool _isFootnoteContainer(VElement el) {
    if (el.tag == 'a' || _notes.isEmpty) return false;
    return isFootnotes(el);
  }

  void _footnotes(VElement el, List<Block> out) {
    final items = <Footnote>[];
    walk(el, (item) {
      if (item.skip) return false;
      if (!identical(item, el) && _isNoteItem(item) && _notes.containsKey(item.id)) {
        // Sphinx and docutils put the number in a label span; it is the item's label, not text.
        final label = firstElement(item, (e) => e.hasClass('label') || e.hasClass('fn-label'));
        if (label != null) label.skip = true;
        final blocks = <Block>[];
        children(item, blocks);
        // The number the text shows for this note, else its position.
        final shown = _refLabels[item.id] ?? _notes[item.id]!;
        _stripNoteLabel(blocks, shown);
        if (blocks.isNotEmpty) items.add(Footnote(id: item.id, label: shown, blocks: blocks));
        return false;
      }
      return true;
    });
    if (items.isNotEmpty) {
      out.add(FootnotesBlock(items));
    } else {
      children(el, out);
    }
  }

  bool _substackFootnote(VElement el, List<Block> out) {
    if (!_footnoteClass.hasMatch(el.className)) return false;
    final number = firstElement(el, (e) => _footnoteNumber.hasMatch(e.matchString) && e.id.isNotEmpty);
    final id = number != null ? number.id : el.id;
    if (id.isEmpty || !_notes.containsKey(id)) return false;
    final content = firstElement(el, (e) => _footnoteContent.hasMatch(e.matchString)) ?? el;
    if (number != null) number.skip = true;
    final blocks = <Block>[];
    children(content, blocks);
    if (blocks.isEmpty) return true;
    final last = out.isEmpty ? null : out.last;
    final note = Footnote(id: id, label: _notes[id]!, blocks: blocks);
    if (last is FootnotesBlock) {
      last.items.add(note);
    } else {
      out.add(FootnotesBlock([note]));
    }
    return true;
  }

  // ---------------------------------------------------------------- blocks

  /// Converts a container's children: phrasing runs become paragraphs, blocks convert in place.
  void children(VElement el, List<Block> out) {
    final lone = _loneCode(el);
    if (lone != null) {
      _code(lone, out);
      return;
    }
    final inline = _InlineBuilder(this, out);
    const ctx = _emptyCtx;
    final kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      final child = kids[i];
      if (child is VText) {
        inline.text(child.text, ctx);
      } else if ((child as VElement).skip) {
        continue;
      } else if (_caption(child, out, inline)) {
        continue;
      } else if (_isInline(child)) {
        _inline(child, inline, ctx, out);
      } else {
        inline.flush();
        final before = out.length;
        block(child, out);
        if (out.length > before) _attachCaption(out, kids, i);
      }
    }
    inline.flush();
  }

  /// Caption and credit elements outside <figure>: attached to the image just
  /// emitted, dropped when no image precedes them (the image was a script-only
  /// gallery or a placeholder, so the caption describes nothing on the page).
  bool _caption(VElement el, List<Block> out, _InlineBuilder? inline) {
    if (el.tag == 'img' || el.tag == 'figure' || el.tag == 'picture' || el.tag == 'a') return false;
    if (!_captionLike.hasMatch(el.className) ||
        el.textLen > 400 ||
        _hasDescendant(el, 'img') ||
        _hasDescendant(el, 'p', 1) && el.textLen > 200) {
      return false;
    }
    if (inline != null && inline.nodes.isNotEmpty) {
      // Mid-sentence spans are not captions unless an image was just emitted.
      final last = out.isEmpty ? null : out.last;
      if (last is! FigureBlock) return false;
    }
    if (inline != null) inline.flush();
    final last = out.isEmpty ? null : out.last;
    if (last is FigureBlock) {
      final content = inlineOnly(el);
      if (content.isNotEmpty) {
        if (last.caption == null && !_credit.hasMatch(el.className)) {
          last.caption = content;
        } else if (last.credit == null && _inlineTextOf(content) != _inlineTextOf(last.caption ?? const [])) {
          last.credit = content;
        }
      }
    }
    return true;
  }

  /// A caption element right after an uncaptioned image belongs to it.
  void _attachCaption(List<Block> out, List<VNode> kids, int index) {
    final last = out.last;
    if (last is! FigureBlock || last.caption != null) return;
    for (var j = index + 1; j < kids.length; j++) {
      final next = kids[j];
      if (next is VText) {
        if (!isBlank(next.text)) return;
        continue;
      }
      final e = next as VElement;
      if (e.skip) continue;
      if (_captionClass.hasMatch(e.matchString) && e.tag != 'img' && collapse(rawText(e)).length < 500) {
        final caption = inlineOnly(e);
        if (caption.isNotEmpty) last.caption = caption;
        e.skip = true;
      }
      return;
    }
  }

  void block(VElement el, List<Block> out) {
    if (el.skip) return;
    switch (el.tag) {
      case 'p':
        children(el, out);
        return;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        _heading(el, out);
        return;
      case 'ul':
      case 'ol':
      case 'menu':
      case 'dir':
        _list(el, out);
        return;
      case 'dl':
        _definitions(el, out);
        return;
      case 'blockquote':
        _quote(el, out);
        return;
      case 'pre':
      case 'xmp':
      case 'listing':
      case 'plaintext':
        _code(el, out);
        return;
      case 'figure':
        _figure(el, out);
        return;
      case 'table':
        _table(el, out);
        return;
      case 'hr':
        out.add(const RuleBlock());
        return;
      case 'details':
        _details(el, out);
        return;
      case 'img':
      case 'picture':
        _standaloneImage(el, out);
        return;
      case 'iframe':
        final block = frameBlock(el, base);
        if (block != null) out.add(block is CodeBlock ? _codeBlock(block.code, 'plaintext') : block);
        return;
      case 'video':
      case 'audio':
        final block = mediaFromElement(el, base);
        if (block != null) out.add(block);
        return;
      case 'math':
      case 'math-tex':
        _mathBlock(el, out);
        return;
      case 'noscript':
        _noscript(el, out);
        return;
      case 'svg':
      case 'input':
      case 'meta':
      case 'link':
      case 'title':
      case 'source':
      case 'track':
      case 'colgroup':
      case 'col':
      case 'br':
      case 'summary':
      case 'figcaption':
        return;
      case 'li':
      case 'dd':
      case 'dt':
      case 'td':
      case 'th':
      case 'tr':
      case 'tbody':
      case 'thead':
      case 'tfoot':
      case 'caption':
        children(el, out);
        return;
    }
    _container(el, out);
  }

  void _container(VElement el, List<Block> out) {
    if (_codeTitle.hasMatch(el.matchString) && el.textLen < 120 && !_hasDescendant(el, 'pre')) {
      final title = _plainLabel(el);
      if (title.isNotEmpty && title.length < 120) _pendingCodeTitle = title;
      return;
    }
    if (_isFootnoteContainer(el)) {
      _footnotes(el, out);
      return;
    }
    if (_substackFootnote(el, out)) return;
    // Margin or hover copies of notes that the footnote list also has.
    if (_noteItems.isNotEmpty && _noteCopyClass.hasMatch(el.matchString) && el.textLen < 3000 && _isNoteCopy(el)) {
      return;
    }
    final video = lazyVideo(el);
    if (video != null) {
      out.add(video);
      return;
    }
    final social = socialProvider(el);
    if (social != null) {
      _embed(el, social, out);
      return;
    }
    if (_isCodeTable(el)) {
      _codeTable(el, out);
      return;
    }
    if (el.tag != 'body' && isCallout(el) && el.textLen > 0 && el.textLen < 3000) {
      _callout(el, out);
      return;
    }
    if (_figureLike.hasMatch(el.matchString) &&
        el.textLen < 600 &&
        _hasDescendant(el, 'img') &&
        !_hasDescendant(el, 'p', 2)) {
      _figure(el, out);
      return;
    }
    children(el, out);
  }

  // ---------------------------------------------------------------- inline

  void _inline(VElement el, _InlineBuilder b, _Ctx ctx, List<Block> out) {
    if (el.skip) return;
    b.edge = true;
    _inlineElement(el, b, ctx, out);
    b.edge = true;
  }

  void _inlineElement(VElement el, _InlineBuilder b, _Ctx ctx, List<Block> out) {
    if (_caption(el, out, b)) return;
    final tag = el.tag;
    if (tag != 'a' &&
        !_inNote &&
        el.matchString.contains('note') &&
        _inlineNoteClass.hasMatch(el.matchString) &&
        _inlineNote(el, b)) {
      return;
    }
    if (_notes.isNotEmpty && tag != 'a') {
      // Script-driven references: <span class="foot-ref" data-footnote="footnote-esb">5</span>.
      final target =
          el.attrs['data-footnote'] ?? el.attrs['data-footnote-id'] ?? el.attrs['data-fn'] ?? el.attrs['data-note'];
      if (target != null && _notes.containsKey(target)) {
        final text = jsTrim(collapse(rawText(el)).replaceAll(_labelBrackets, ''));
        final label = text.isNotEmpty ? text : _notes[target]!;
        _refLabels.putIfAbsent(target, () => label);
        b.push(FootnoteRef(id: target, label: label));
        return;
      }
    }
    switch (tag) {
      case 'br':
        b.lineBreak();
        return;
      case 'wbr':
      case 'input':
      case 'meta':
      case 'link':
      case 'source':
      case 'track':
      case 'svg':
      case 'rp':
        return;
      case 'img':
      case 'picture':
        final img = tag == 'picture' ? firstElement(el, (e) => e.tag == 'img') : el;
        if (img == null || _mathFallback.hasMatch(img.className)) return;
        final image = imageFrom(img, base) ?? _noscriptImage(img);
        if (image == null || isDecorativeImage(img, image, base)) return;
        if (isSmallImage(img, image)) {
          b.push(_inlineImage(image));
          return;
        }
        b.flush();
        if (_isStillOf(out.lastOrNull, image)) return;
        final href = ctx.href;
        // A linked full-size file; `mailto:`/`tel:` stay on text.
        if (href != null &&
            image.href == null &&
            href != image.src &&
            _httpLink.hasMatch(href) &&
            _imageLink.hasMatch(href)) {
          image.href = href;
        }
        out.add(FigureBlock(images: [image]));
        return;
      case 'math':
      case 'math-tex':
        final node = _mathInline(el);
        if (node == null) return;
        if (_isDisplayMath(el)) displayMath.add(node);
        b.push(node);
        return;
      case 'noscript':
        return;
      case 'a':
        final href = el.attrs['href'];
        if (href != null && charCodeAt(href, 0) == 35) {
          final id = _decodeFragment(href.substring(1));
          if (_notes.containsKey(id)) {
            final text = jsTrim(collapse(rawText(el)).replaceAll(_labelBrackets, ''));
            final label = text.isNotEmpty ? text : _notes[id]!;
            _refLabels.putIfAbsent(id, () => label);
            b.push(FootnoteRef(id: id, label: label));
            return;
          }
          final linkText = collapse(rawText(el));
          if (_backlink.hasMatch(el.matchString) || _backArrow.hasMatch(linkText)) return;
          // Permalink glyphs go; a permalink wrapping the heading's own words keeps them.
          if (_permalinkText.hasMatch(linkText)) return;
          // "[1]" pointing at a plain anchor: a note reference until proven otherwise (see `_resolveRefs`).
          final number = _bracketNumber.firstMatch(linkText);
          if (number != null && id.isNotEmpty && !_inNote) {
            final ref = FootnoteRef(id: id, label: number[1]!);
            _provisional[ref] = linkText;
            _pendingRefs.putIfAbsent(id, () => number[1]!);
            b.push(ref);
            return;
          }
          // Other in-page links read as plain text.
          _inlineChildren(el, b, ctx, out);
          return;
        }
        // <a id="introduction">Introduction</a> outside a heading: a section anchor whose label is shown only to screen readers or the TOC.
        if (href == null &&
            el.id.isNotEmpty &&
            _slug(collapse(rawText(el))) == jsLower(el.id) &&
            _closestHeading(el) == null) {
          return;
        }
        if (href == null &&
            b.nodes.length <= 1 &&
            jsTrim(_inlineTextOf(b.nodes)).replaceFirst(_openBracket, '').isEmpty) {
          final anchor = el.attrs['name'] ?? el.id;
          if (anchor.isNotEmpty && _pendingRefs.containsKey(anchor)) b.anchor = anchor;
        }
        if (_permalink.hasMatch(el.matchString) && _permalinkText.hasMatch(collapse(rawText(el)))) return;
        final resolved = href == null ? null : resolveUrl(href, base);
        final linkCtx = resolved != null && _linkScheme.hasMatch(resolved) ? _Ctx(ctx.marks, resolved) : ctx;
        _inlineChildren(el, b, linkCtx, out);
        return;
      case 'q':
        b.text('“', ctx);
        _inlineChildren(el, b, ctx, out);
        b.text('”', ctx);
        return;
      case 'sup':
      case 'sub':
        final ref = firstElement(el, (e) {
          if (e.tag != 'a') return false;
          final href = e.attrs['href'] ?? '';
          return charCodeAt(href, 0) == 35 && _notes.containsKey(_decodeFragment(href.substring(1)));
        });
        if (ref != null) {
          _inlineChildren(el, b, ctx, out);
          return;
        }
      case 'span':
      case 'font':
        if (tag == 'span' && _isAlternative(el)) return;
        final style = el.attrs['style'];
        if (style != null) {
          final marks = List.of(ctx.marks);
          if (_bold.hasMatch(style)) marks.add(Mark.bold);
          if (_italic.hasMatch(style)) marks.add(Mark.italic);
          if (marks.length != ctx.marks.length) {
            _inlineChildren(el, b, _Ctx(marks, ctx.href), out);
            return;
          }
        }
    }
    final mark = _tagMark[tag];
    if (mark != null && !ctx.marks.contains(mark)) {
      _inlineChildren(el, b, _Ctx([...ctx.marks, mark], ctx.href), out);
      return;
    }
    _inlineChildren(el, b, ctx, out);
  }

  /// A note written where it is referenced: <span class="ltx_note ltx_role_footnote"><sup>1</sup>
  /// <span class="ltx_note_content">...</span></span>. Becomes a ref, and the note goes to the end.
  bool _inlineNote(VElement el, _InlineBuilder b) {
    final text = collapse(rawText(el));
    final mark = firstElement(el, (e) => e.tag == 'sup' || _noteMarkClass.hasMatch(e.matchString));
    final label = mark != null ? collapse(rawText(mark)).replaceAll(_labelBrackets, '') : '';
    // A bare marker ("1", "[2]") is a reference, not a note.
    if (text.length <= label.length + 3 || label.length > 4) return false;
    final content = firstElement(el, (e) => _noteContentClass.hasMatch(e.matchString)) ?? el;
    // The marker is hidden while the note is read, and only un-hidden if it was shown before (cleaning may have removed it).
    final hide = mark != null && !mark.skip && !_isAncestorOf(mark, content);
    if (hide) mark.skip = true;
    final blocks = <Block>[];
    _inNote = true;
    final inline = inlineOnly(content);
    _inNote = false;
    if (hide) mark.skip = false;
    if (inline.isEmpty) return false;
    blocks.add(ParagraphBlock(inline));
    final n = _inlineNotes.length + 1;
    final noteLabel = label.isNotEmpty ? label : '$n';
    _stripNoteLabel(blocks, noteLabel);
    if (blocks.isEmpty) return false;
    var id = el.id.isNotEmpty ? el.id : 'note-$n';
    if (_notes.containsKey(id)) id = 'inline-$id';
    _inlineNotes.add(Footnote(id: id, label: noteLabel, blocks: blocks));
    b.push(FootnoteRef(id: id, label: noteLabel));
    return true;
  }

  void _inlineChildren(VElement el, _InlineBuilder b, _Ctx ctx, List<Block> out) {
    for (final child in el.children) {
      if (child is VText) {
        b.text(child.text, ctx);
      } else if (!(child as VElement).skip) {
        if (_isInline(child)) {
          _inline(child, b, ctx, out);
        } else {
          b.flush();
          block(child, out);
        }
      }
    }
  }

  /// Inline content of an element, flattening any blocks inside it (headings, captions, cells, terms).
  List<Inline> inlineOnly(VElement el) {
    final b = _InlineBuilder(this, null);
    final sink = <Block>[];
    void visit(VElement node, _Ctx ctx) {
      for (final child in node.children) {
        if (child is VText) {
          b.text(child.text, ctx);
          continue;
        }
        final e = child as VElement;
        if (e.skip) continue;
        final tag = e.tag;
        if (tag == 'img' || tag == 'picture') {
          final img = tag == 'picture' ? firstElement(e, (x) => x.tag == 'img') : e;
          if (img == null || _mathFallback.hasMatch(img.className)) continue;
          final image = imageFrom(img, base);
          if (image != null && !isDecorativeImage(img, image, base) && isSmallImage(img, image)) {
            b.push(_inlineImage(image));
          }
          continue;
        }
        if (tag == 'br') {
          b.lineBreak();
          continue;
        }
        if (tag == 'math' || tag == 'math-tex') {
          final m = _mathInline(e);
          if (m != null) b.push(m);
          continue;
        }
        if (tag == 'svg' ||
            tag == 'input' ||
            tag == 'noscript' ||
            tag == 'iframe' ||
            tag == 'video' ||
            tag == 'audio' ||
            tag == 'button') {
          continue;
        }
        if (_blockTags.contains(tag) && b.nodes.isNotEmpty) b.lineBreak();
        if (_inlineTags.contains(tag)) {
          _inline(e, b, ctx, sink);
        } else {
          b.edge = true;
          visit(e, ctx);
          b.edge = true;
        }
        if (_blockTags.contains(tag)) b.lineBreak();
      }
    }

    visit(el, _emptyCtx);
    return b.result();
  }

  // ---------------------------------------------------------------- headings, lists, quotes

  void _heading(VElement el, List<Block> out) {
    // Wordless links to a fragment (the heading's permalink icon) are not part of the heading.
    final icons = <VElement>[];
    walk(el, (e) {
      if (e.tag == 'a' && !e.skip && (e.attrs['href'] ?? '').contains('#') && _isWordless(rawText(e))) {
        icons.add(e);
        e.skip = true;
        return false;
      }
      return true;
    });
    final content = inlineOnly(el);
    for (final icon in icons) {
      icon.skip = false;
    }
    if (content.isEmpty) return;
    final level = el.tag.codeUnitAt(1) - 0x30;
    final block = HeadingBlock(level: level, content: content);
    var anchor = el.id;
    if (anchor.isEmpty) {
      final a = firstElement(el, (e) => e.id.isNotEmpty || (e.tag == 'a' && e.attrs['name'] != null));
      if (a != null) anchor = a.id.isNotEmpty ? a.id : a.attrs['name']!;
    }
    if (anchor.isNotEmpty) block.anchor = anchor;
    out.add(block);
  }

  void _list(VElement el, List<Block> out) {
    final items = <ListItem>[];
    final ordered = el.tag == 'ol';
    final start = _intAttr(el, 'start');
    var number = start ?? 1;
    for (final child in el.children) {
      if (child is VText) {
        if (!isBlank(child.text)) {
          items.add(
            ListItem(
              blocks: [
                ParagraphBlock(normalizeInlines([TextRun(child.text)])),
              ],
            ),
          );
        }
        continue;
      }
      final e = child as VElement;
      if (e.skip) continue;
      final blocks = <Block>[];
      if (e.tag == 'li') {
        number = _intAttr(e, 'value') ?? number;
        // LaTeXML writes the marker as text before the item's paragraphs: <span class="ltx_tag ltx_tag_item">•</span>.
        final label = _itemLabel(e);
        if (label != null) label.skip = true;
        children(e, blocks);
        if (label != null) {
          label.skip = false;
          _prependLabel(blocks, collapse(rawText(label)));
        }
        _stripItemMarker(blocks, ordered ? number : null);
        number++;
        if (blocks.isEmpty) continue;
        final item = ListItem(blocks: blocks);
        final box = firstElement(e, (x) => x.tag == 'input' && jsLower(x.attrs['type'] ?? '') == 'checkbox');
        if (box != null) item.checked = box.attrs['checked'] != null;
        if (_pendingRefs.isNotEmpty && el.tag == 'ol') _itemSources[item] = e;
        items.add(item);
      } else {
        block(e, blocks);
        if (blocks.isEmpty) continue;
        final prev = items.isEmpty ? null : items.last;
        if ((e.tag == 'ul' || e.tag == 'ol') && prev != null) {
          prev.blocks.addAll(blocks);
        } else {
          items.add(ListItem(blocks: blocks));
        }
      }
    }
    if (items.isEmpty) return;
    if (items.length > 1 && items.every((i) => i.blocks.length == 1 && i.blocks[0] is FigureBlock)) {
      final images = <ArticleImage>[];
      for (final item in items) {
        for (final image in (item.blocks[0] as FigureBlock).images) {
          if (!images.any((x) => x.src == image.src)) images.add(image);
        }
      }
      final first = items[0].blocks[0] as FigureBlock;
      final gallery = FigureBlock(images: images);
      if (first.caption != null && items.length == 1) gallery.caption = first.caption;
      out.add(gallery);
      return;
    }
    final list = ListBlock(ordered: ordered, items: items);
    if (ordered && start != null && start != 1) list.start = start;
    out.add(list);
  }

  void _definitions(VElement el, List<Block> out) {
    final items = <Definition>[];
    Definition? current;
    void visit(VElement parent) {
      for (final child in parent.children) {
        if (child is! VElement || child.skip) continue;
        if (child.tag == 'dt') {
          final definition = Definition(term: inlineOnly(child), details: []);
          current = definition;
          items.add(definition);
        } else if (child.tag == 'dd') {
          var definition = current;
          if (definition == null) {
            definition = Definition(term: [], details: []);
            current = definition;
            items.add(definition);
          }
          children(child, definition.details);
        } else if (child.tag == 'div') {
          visit(child);
        }
      }
    }

    visit(el);
    final kept = items.where((d) => d.term.isNotEmpty || d.details.isNotEmpty).toList();
    if (kept.isNotEmpty) out.add(DefinitionListBlock(kept));
  }

  void _quote(VElement el, List<Block> out) {
    final social = socialProvider(el);
    if (social != null) {
      _embed(el, social, out);
      return;
    }
    VElement? citeEl;
    for (final child in el.children) {
      if (child is VElement && !child.skip && (child.tag == 'footer' || child.tag == 'cite')) citeEl = child;
    }
    final blocks = <Block>[];
    if (citeEl != null) citeEl.skip = true;
    children(el, blocks);
    if (citeEl != null) citeEl.skip = false;
    if (blocks.isEmpty) return;
    final block = QuoteBlock(blocks: blocks);
    if (citeEl != null) {
      final cite = inlineOnly(citeEl);
      if (cite.isNotEmpty) block.cite = cite;
    }
    if (_pullQuote.hasMatch(el.matchString) || el.parent != null && _pullQuote.hasMatch(el.parent!.matchString)) {
      block.pull = true;
    }
    out.add(block);
  }

  // The name starts and ends on a non-space: a long run of spaces is not retried at every split between dash,
  // name, handle and date.
  static final _authorWithDate = RegExp(r'^[—–-]\s*(\S(?:.*?\S)?)(?:\s*\((@\w+)\))?\s+[A-Z][a-z]+ \d{1,2}, \d{4}$');
  static final _authorLine = RegExp(r'^[—–-]\s*(?!\s)(.+)$');

  void _embed(VElement el, String provider, List<Block> out) {
    String? url;
    final links = <String>[];
    walk(el, (e) {
      final href = e.attrs['href'];
      if (e.tag == 'a' && href != null) {
        final abs = resolveHttp(href, base);
        if (abs != null) links.add(abs);
      }
      return true;
    });
    if (provider == 'twitter') {
      final tweets = links.where(tweet.hasMatch).toList();
      url = tweets.isEmpty ? null : tweets.last;
    }
    for (final key in const ['data-instgrm-permalink', 'cite', 'data-bluesky-uri', 'data-href']) {
      final value = el.attrs[key];
      url ??= value != null ? resolveHttp(value, base) : null;
    }
    url ??= links.isEmpty ? null : links.last;
    final blocks = <Block>[];
    children(el, blocks);
    String? author;
    final last = blocks.isEmpty ? null : blocks.last;
    if (last is ParagraphBlock) {
      final text = last.content.map((n) => n is TextRun ? n.text : '').join();
      final dated = _authorWithDate.firstMatch(text);
      final m = dated ?? _authorLine.firstMatch(text);
      if (m != null) {
        final handle = dated?.group(2);
        author = handle != null ? '${m.group(1)} ($handle)' : m.group(1)!;
        blocks.removeLast();
      }
    }
    if (url == null) {
      out.addAll(blocks);
      return;
    }
    final block = EmbedBlock(provider: provider, url: url);
    if (author != null) block.author = author;
    if (blocks.isNotEmpty) block.blocks = blocks;
    out.add(block);
  }

  static final _danger = RegExp(r'danger|error|critical');
  static final _warning = RegExp(r'warning|caution|attention|important');
  static final _tip = RegExp(r'tip|hint|success');
  static final _info = RegExp(r'info|notice');
  static final _note = RegExp(r'note|admonition|callout|notecard');
  static final _calloutTitle = ClassPattern(
    r'(?:^|[\s_-])(?:admonition-title|callout-title|alert-title|markdown-alert-title|admonitionheading|notecard-title|title|heading)(?:$|[\s_-])|admonitionheading',
  );
  static final _subheading = RegExp(r'^h[2-6]$');

  void _callout(VElement el, List<Block> out) {
    final m = el.matchString;
    final variant = _danger.hasMatch(m)
        ? CalloutVariant.danger
        : _warning.hasMatch(m)
        ? CalloutVariant.warning
        : _tip.hasMatch(m)
        ? CalloutVariant.tip
        : _info.hasMatch(m)
        ? CalloutVariant.info
        : _note.hasMatch(m)
        ? CalloutVariant.note
        : null;
    VElement? titleEl;
    walk(el, (e) {
      if (titleEl != null || identical(e, el)) return titleEl == null;
      if (_calloutTitle.hasMatch(e.matchString) && e.textLen < 100) {
        titleEl = e;
        return false;
      }
      return e.tag == 'div' || e.tag == 'p';
    });
    // A short heading opening the box ("Note") is its title (whitespace and skipped elements before it don't count).
    if (titleEl == null) {
      for (final child in el.children) {
        if (child is VText) {
          if (!isBlank(child.text)) break;
          continue;
        }
        child as VElement;
        if (child.skip) continue;
        if (_subheading.hasMatch(child.tag) && child.textLen < 60) titleEl = child;
        break;
      }
    }
    final title = titleEl == null ? null : inlineOnly(titleEl!);
    titleEl?.skip = true;
    final blocks = <Block>[];
    children(el, blocks);
    titleEl?.skip = false;
    if (blocks.isEmpty) {
      if (title != null && title.isNotEmpty) out.add(ParagraphBlock(title));
      return;
    }
    final block = CalloutBlock(variant: variant, blocks: blocks);
    // A title that only names the variant ("note", "Warning") repeats what the renderer already shows.
    if (title != null &&
        title.isNotEmpty &&
        !(variant != null && jsLower(jsTrim(_inlineTextOf(title))) == variant.name)) {
      block.title = title;
    }
    out.add(block);
  }

  void _details(VElement el, List<Block> out) {
    VElement? summaryEl;
    for (final child in el.children) {
      if (child is VElement && child.tag == 'summary' && summaryEl == null) summaryEl = child;
    }
    final summary = summaryEl != null ? inlineOnly(summaryEl) : <Inline>[];
    final blocks = <Block>[];
    children(el, blocks);
    // A disclosure whose body was all chrome (badges, widgets) is chrome too.
    if (blocks.isEmpty) return;
    out.add(DetailsBlock(summary: summary, blocks: blocks));
  }

  // ---------------------------------------------------------------- code

  void _code(VElement el, List<Block> out) {
    // Some sites wrap prose in <pre>; a pre full of block markup is not code.
    if (_hasDescendant(el, 'p') && _hasDescendant(el, 'p', 1) && !_hasDescendant(el, 'code')) {
      children(el, out);
      return;
    }
    // One listing in several flavours (<code class="language-mjs"> and <code class="language-cjs">): one block each.
    final flavours = <VElement>[];
    for (final child in el.children) {
      if (child is VElement && !child.skip && child.tag == 'code') flavours.add(child);
    }
    if (flavours.length > 1) {
      for (final flavour in flavours) {
        final text = codeText(flavour);
        if (!isBlank(text)) out.add(_codeBlock(text, codeLanguage(flavour)));
      }
      return;
    }
    final code = codeText(el);
    if (isBlank(code)) return;
    out.add(_codeBlock(code, codeLanguage(el)));
  }

  Block _codeBlock(String code, String? marked) {
    final block = CodeBlock(code: code, language: null);
    if (marked != null && marked != 'plaintext') {
      block.language = marked;
      block.languageSource = LanguageSource.markup;
    } else if (marked == null) {
      final detected = detectLanguage(code);
      if (detected != null) {
        block.language = detected;
        block.languageSource = LanguageSource.detected;
      }
    }
    if (_pendingCodeTitle != null) {
      block.title = _pendingCodeTitle;
      _pendingCodeTitle = null;
    }
    return block;
  }

  static final _codeCell = ClassPattern(r'(?:^|[\s_-])(?:code|blob-code|hljs-ln-code|lntd|line-content)(?:$|[\s_-])');
  static final _edgeNewlines = RegExp(r'^\n+');
  static final _finalNewline = RegExp(r'\n$');

  void _codeTable(VElement el, List<Block> out) {
    final lines = <String>[];
    VElement? preCode;
    walk(el, (e) {
      if (preCode != null) return false;
      if (e.tag == 'td' && _codeCell.hasMatch(e.matchString) && !_gutter.hasMatch(e.matchString)) {
        final pre = firstElement(e, (x) => x.tag == 'pre');
        if (pre != null && e.parent != null && _countTag(el, 'tr') <= 2) {
          preCode = pre;
          return false;
        }
        lines.add(codeText(e).replaceFirst(_finalNewline, ''));
        return false;
      }
      return true;
    });
    if (preCode != null) {
      _code(preCode!, out);
      return;
    }
    // `.replace(/^\n+|\s+$/g, '')`
    final code = _trimEndJs(lines.join('\n').replaceFirst(_edgeNewlines, ''));
    if (code.isEmpty) {
      children(el, out);
      return;
    }
    String? lang;
    for (VElement? p = el; p != null && lang == null; p = p.parent) {
      lang = languageFromClass(p.className) ?? normalizeLanguage(p.attrs['data-lang'] ?? p.attrs['data-language']);
    }
    out.add(_codeBlock(code, lang));
  }

  // ---------------------------------------------------------------- media

  ArticleImage? _noscriptImage(VElement img) {
    final parent = img.parent;
    if (parent == null) return null;
    final i = parent.children.indexOf(img);
    for (var j = i + 1; j < parent.children.length && j <= i + 3; j++) {
      final sibling = parent.children[j];
      if (sibling is VElement && sibling.tag == 'noscript') {
        final inner = firstElement(sibling, (e) => e.tag == 'img');
        if (inner != null) {
          sibling.skip = true;
          return imageFrom(inner, base);
        }
      }
    }
    return null;
  }

  void _noscript(VElement el, List<Block> out) {
    // Lazy-load fallbacks: only used when the lazy image right before it produced nothing.
    final img = firstElement(el, (e) => e.tag == 'img');
    if (img == null) return;
    final parent = el.parent;
    if (parent != null) {
      final i = parent.children.indexOf(el);
      for (var j = i - 1; j >= 0; j--) {
        final prev = parent.children[j];
        if (prev is VText) {
          if (!isBlank(prev.text)) break;
          continue;
        }
        final p = prev as VElement;
        if (p.tag == 'img' || p.tag == 'picture' || _hasDescendant(p, 'img')) {
          final prevImg = p.tag == 'img' ? p : firstElement(p, (e) => e.tag == 'img');
          if (prevImg != null && imageFrom(prevImg, base) != null) return;
        }
        break;
      }
    }
    _standaloneImage(img, out);
  }

  void _standaloneImage(VElement el, List<Block> out) {
    final img = el.tag == 'picture' ? firstElement(el, (e) => e.tag == 'img') : el;
    if (img == null || _mathFallback.hasMatch(img.className)) return;
    final image = imageFrom(img, base) ?? _noscriptImage(img);
    if (image == null || isDecorativeImage(img, image, base)) return;
    if (_isStillOf(out.lastOrNull, image)) return;
    if (isSmallImage(img, image)) {
      out.add(ParagraphBlock([_inlineImage(image)]));
      return;
    }
    out.add(FigureBlock(images: [image]));
  }

  void _figure(VElement el, List<Block> out) {
    VElement? captionEl;
    walk(el, (e) {
      if (captionEl != null || e.skip) return false;
      if (!identical(e, el) &&
          (e.tag == 'figcaption' || (_captionClass.hasMatch(e.matchString) && e.tag != 'img' && e.tag != 'figure'))) {
        captionEl = e;
        return false;
      }
      return true;
    });
    final images = <ArticleImage>[];
    final media = <Block>[];
    var other = false;
    // Short texts positioned over a figure with nothing else to show: the labels of a graphic drawn by script.
    final overlays = <VElement>[];
    walk(el, (e) {
      if (e.skip || identical(e, captionEl)) return false;
      if (!identical(e, el) && e.textLen > 0 && e.textLen < 100 && _absolute.hasMatch(e.attrs['style'] ?? '')) {
        overlays.add(e);
      }
      switch (e.tag) {
        case 'img':
          if (_mathFallback.hasMatch(e.className)) return false;
          final image = imageFrom(e, base) ?? _noscriptImage(e);
          if (image != null && !isDecorativeImage(e, image, base) && !images.any((i) => i.src == image.src)) {
            images.add(image);
          }
          return false;
        case 'noscript':
          return false;
        case 'iframe':
          final block = frameBlock(e, base);
          if (block != null) media.add(block is CodeBlock ? _codeBlock(block.code, 'plaintext') : block);
          return false;
        case 'video':
        case 'audio':
          final block = mediaFromElement(e, base);
          if (block != null) media.add(block);
          return false;
        case 'pre':
        case 'table':
        case 'blockquote':
        case 'math':
        case 'ul':
        case 'ol':
          other = true;
          return false;
      }
      if (!identical(e, el)) {
        final video = lazyVideo(e);
        if (video != null) {
          media.add(video);
          return false;
        }
      }
      return true;
    });

    var caption = <Inline>[];
    var credit = <Inline>[];
    final cap = captionEl;
    if (cap != null) {
      final creditEl = firstElement(cap, (e) => _creditClass.hasMatch(e.matchString));
      if (creditEl != null) {
        credit = inlineOnly(creditEl);
        creditEl.skip = true;
      }
      caption = inlineOnly(cap);
      if (creditEl != null) creditEl.skip = false;
    }

    // A video file's still drawn as an image (the poster, for browsers that do not play it): one video, not a figure and a video.
    final file = media.length == 1 ? media[0] : null;
    if (file is VideoBlock && file.provider == 'file' && !other) {
      if (file.poster == null && images.length == 1) file.poster = images[0].src;
      images.removeWhere((i) => i.src == file.poster);
    }

    if (images.isEmpty && media.isEmpty || other) {
      // Code listings, tables and quotes in a <figure>: convert the content, keep the caption as text.
      if (cap != null) cap.skip = true;
      if (!other) {
        for (final overlay in overlays) {
          overlay.skip = true;
        }
      }
      final before = out.length;
      children(el, out);
      if (cap != null) cap.skip = false;
      if (!other) {
        for (final overlay in overlays) {
          overlay.skip = false;
        }
      }
      final first = before < out.length ? out[before] : null;
      if (caption.isNotEmpty) {
        final single = out.length == before + 1;
        if (first is TableBlock && single && first.caption == null) {
          first.caption = caption;
        } else if (first is QuoteBlock && single && first.cite == null) {
          first.cite = caption;
        } else if (first is CodeBlock && single && first.title == null && caption.length == 1) {
          first.title = _inlineTextOf(caption);
        } else {
          out.add(ParagraphBlock(caption));
        }
      }
      return;
    }
    if (images.isEmpty) {
      final block = media[0];
      if (caption.isNotEmpty) {
        if (block is VideoBlock) {
          block.caption = caption;
        } else if (block is AudioBlock) {
          block.caption = caption;
        }
      }
      out.addAll(media);
      return;
    }
    if (credit.isEmpty && caption.isNotEmpty) (caption, credit) = _splitCredit(caption);
    final figure = FigureBlock(images: images);
    if (caption.isNotEmpty) figure.caption = caption;
    if (credit.isNotEmpty) figure.credit = credit;
    out.add(figure);
    out.addAll(media);
  }

  void _mathBlock(VElement el, List<Block> out) {
    final node = _mathInline(el);
    if (node == null) return;
    final block = MathBlock(text: node.text);
    if (node.tex != null) block.tex = node.tex;
    if (node.mathml != null) block.mathml = node.mathml;
    out.add(block);
  }

  // ---------------------------------------------------------------- tables

  static final _textAlign = RegExp(r'text-align\s*:\s*(left|center|right)', caseSensitive: false);

  void _table(VElement el, List<Block> out) {
    if (_isCodeTable(el)) {
      _codeTable(el, out);
      return;
    }
    if (!isDataTableCached(el)) {
      for (final row in _tableRows(el)) {
        for (final cell in row.cells) {
          children(cell, out);
        }
      }
      for (final child in el.children) {
        if (child is VElement && child.tag == 'caption' && !child.skip) children(child, out);
      }
      return;
    }
    final rows = <TableRowData>[];
    var headerRows = 0;
    var counting = true;
    for (final row in _tableRows(el)) {
      final cells = <TableCellData>[];
      var allHeader = true;
      for (final cellEl in row.cells) {
        final cell = TableCellData(content: inlineOnly(cellEl));
        final header = cellEl.tag == 'th' || row.head;
        if (header) {
          cell.header = true;
        } else {
          allHeader = false;
        }
        final colspan = _intAttr(cellEl, 'colspan');
        final rowspan = _intAttr(cellEl, 'rowspan');
        if (colspan != null && colspan > 1) cell.colspan = math.min(colspan, 100);
        if (rowspan != null && rowspan > 1) cell.rowspan = math.min(rowspan, 1000);
        final align = jsLower(
          cellEl.attrs['align'] ?? _textAlign.firstMatch(cellEl.attrs['style'] ?? '')?.group(1) ?? '',
        );
        if (align == 'left') {
          cell.align = CellAlign.left;
        } else if (align == 'center') {
          cell.align = CellAlign.center;
        } else if (align == 'right') {
          cell.align = CellAlign.right;
        }
        cells.add(cell);
      }
      if (cells.isEmpty) continue;
      if (cells.every((c) => c.content.isEmpty) && cells.isNotEmpty && rows.isNotEmpty) continue;
      rows.add(TableRowData(cells));
      if (counting && allHeader) {
        headerRows++;
      } else {
        counting = false;
      }
    }
    if (rows.isEmpty) return;
    final block = TableBlock(rows: rows);
    VElement? captionEl;
    for (final c in el.children) {
      if (c is VElement && c.tag == 'caption' && !c.skip) {
        captionEl = c;
        break;
      }
    }
    if (captionEl != null) {
      final caption = inlineOnly(captionEl);
      if (caption.isNotEmpty) block.caption = caption;
    }
    if (headerRows > 0 && headerRows < rows.length) {
      block.headerRows = headerRows;
    } else if (headerRows > 0 && headerRows == rows.length && rows.length > 1) {
      block.headerRows = 1;
    }
    out.add(block);
  }
}

/// Calls [visit] with every inline array in [blocks], nested blocks included.
void _eachInlines(List<Block> blocks, void Function(List<Inline> content) visit) {
  for (final b in blocks) {
    switch (b) {
      case ParagraphBlock(:final content):
      case HeadingBlock(:final content):
        visit(content);
      case ListBlock(:final items):
        for (final item in items) {
          _eachInlines(item.blocks, visit);
        }
      case QuoteBlock(:final blocks, :final cite):
        _eachInlines(blocks, visit);
        if (cite != null) visit(cite);
      case CalloutBlock(:final blocks, :final title):
        _eachInlines(blocks, visit);
        if (title != null) visit(title);
      case DetailsBlock(:final summary, :final blocks):
        visit(summary);
        _eachInlines(blocks, visit);
      case DefinitionListBlock(:final items):
        for (final item in items) {
          visit(item.term);
          _eachInlines(item.details, visit);
        }
      case TableBlock(:final rows, :final caption):
        for (final row in rows) {
          for (final cell in row.cells) {
            visit(cell.content);
          }
        }
        if (caption != null) visit(caption);
      case FigureBlock(:final caption, :final credit):
        if (caption != null) visit(caption);
        if (credit != null) visit(credit);
      case FootnotesBlock(:final items):
        for (final item in items) {
          _eachInlines(item.blocks, visit);
        }
      case EmbedBlock(:final blocks):
        if (blocks != null) _eachInlines(blocks, visit);
      default:
        break;
    }
  }
}

final _inlineNoteClass = ClassPattern(r'(?:^|[\s_-])(?:footnote|sidenote|marginnote|ltx_note)(?:$|[\s_-])');
final _noteCopyClass = ClassPattern(r'footnote|sidenote|marginnote');
final _noteMarkClass = ClassPattern(r'(?:^|[\s_-])(?:note-?mark|sidenote-number|footnote-number)(?:$|[\s_-])');
final _noteContentClass = ClassPattern(
  r'(?:^|[\s_-])(?:note-?content|note-?text|note-?body|footnote-?content|sidenote-?content)(?:$|[\s_-])',
);
final _bracketNumber = RegExp(r'^\[?(\d{1,3})\]?$');
final _openBracket = RegExp(r'^[[(]$');

bool _isAncestorOf(VElement ancestor, VElement node) {
  for (var p = node.parent; p != null; p = p.parent) {
    if (identical(p, ancestor)) return true;
  }
  return false;
}

final _noteItemClass = ClassPattern(r'(?:^|[\s_-])(?:footnote|endnote)(?:$|[\s_-])');

/// `text.replace(ZERO_WIDTH, '').trim().length === 0`.
bool _isWordless(String text) => isBlank(_hasZeroWidth(text) ? text.replaceAll(_zeroWidth, '') : text);

/// Text of a label without the widgets inside it (a language picker's label, options and "No results").
String _plainLabel(VElement el) {
  final out = StringBuffer();
  void visit(VElement node) {
    for (final child in node.children) {
      if (child is VText) {
        out.write(child.text);
      } else if (!(child as VElement).skip && !_isWidget(child)) {
        visit(child);
      }
    }
  }

  visit(el);
  return collapse(out.toString());
}

bool _isWidget(VElement el) {
  if (el.tag == 'label' ||
      el.tag == 'button' ||
      el.tag == 'select' ||
      el.tag == 'input' ||
      el.attrs['aria-haspopup'] != null) {
    return true;
  }
  final role = el.attrs['role'];
  return role != null && role != 'none' && role != 'presentation' && role != 'heading';
}

final _classWords = RegExp(r'[\s_-]+');
final _leadingNumber = RegExp(r'^\s*([\d.,]+)');

/// The second of two glued spans whose classes differ in one word ("imperial_word" /
/// "metric_word") and that state the same number: unit alternatives a script or
/// stylesheet switches between ("60 mph" | "60 km/h").
bool _isAlternative(VElement el) {
  final parent = el.parent;
  if (parent == null || el.className.isEmpty || el.textLen == 0 || el.textLen > 40) return false;
  final i = parent.children.indexOf(el);
  final prev = i > 0 ? parent.children[i - 1] : null;
  if (prev is! VElement || prev.tag != 'span' || prev.skip || prev.textLen == 0 || prev.textLen > 40) return false;
  final a = jsSplit(jsLower(prev.className), _classWords);
  final b = jsSplit(jsLower(el.className), _classWords);
  if (a.length != b.length || a.length < 2) return false;
  var differ = 0;
  for (var k = 0; k < a.length; k++) {
    if (a[k] != b[k]) differ++;
  }
  if (differ != 1) return false;
  // The same quantity in another unit: both open with the same number.
  final x = _leadingNumber.firstMatch(rawText(prev));
  final y = _leadingNumber.firstMatch(rawText(el));
  return x != null && y != null && x[1] == y[1];
}

/// `text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')`.
String _slug(String text) => lettersAndNumbers(jsLower(text)).join('-');

final _headingTag = RegExp(r'^h[1-6]$');

VElement? _closestHeading(VElement el) {
  for (var p = el.parent; p != null; p = p.parent) {
    if (_headingTag.hasMatch(p.tag)) return p;
  }
  return null;
}

/// A multi-line <code> that is all its container holds is a listing even
/// without <pre> (`figure.code-block > code`, styled with white-space: pre).
VElement? _loneCode(VElement el) {
  var any = false;
  for (final child in el.children) {
    if (child is VElement && child.tag == 'code') {
      any = true;
      break;
    }
  }
  if (!any) return null;
  VElement? code;
  for (final child in el.children) {
    if (child is VText) {
      if (!isBlank(child.text)) return null;
      continue;
    }
    final e = child as VElement;
    if (e.skip) continue;
    if (code != null || e.tag != 'code') {
      // Empty decorations (a language tag, a copy button) do not count.
      if (e.tag != 'img' && e.textLen < 20 && _isWordless(rawText(e)) && !_hasDescendant(e, 'img')) continue;
      return null;
    }
    code = e;
  }
  if (code == null) return null;
  final text = jsTrim(rawText(code));
  // One line is a listing too when the wrapper says so (a figure, a language, a code-block class).
  return text.indexOf('\n') > 0 ||
          el.tag == 'figure' ||
          el.attrs['data-lang'] != null ||
          _codeWrapper.hasMatch(el.matchString)
      ? code
      : null;
}

final _codeWrapper = ClassPattern(
  r'(?:^|[\s_-])(?:code-?block|highlight|codehilite|sourcecode|code-snippet)(?:$|[\s_-])',
);

bool _isNoteItem(VElement el) {
  if (el.id.isEmpty) return false;
  return el.tag == 'li' ||
      el.attrs['role'] == 'doc-footnote' ||
      el.attrs['role'] == 'doc-endnote' ||
      (el.tag != 'a' && _noteItemClass.hasMatch(jsLower(el.className)));
}

final _noteKeyLabel = RegExp(r'^\[?\d{1,3}\]?[:.)]?\s*');

/// Note text compared across copies: whitespace collapsed, a leading "5:" / "[5]" label dropped.
String _noteKey(String text) => collapse(text).replaceFirst(_noteKeyLabel, '');

final _noteLabelPrefix = RegExp(r'^\s*\[?(\d{1,3})\]?[:.)]?(?:\s+|$)');

/// A note that repeats its own number ("5: We can't resist...", "<sup>1</sup> 1 https://...") loses it; the label is drawn.
void _stripNoteLabel(List<Block> blocks, String label) {
  if (blocks.isEmpty) return;
  final first = blocks[0];
  if (first is! ParagraphBlock) return;
  final content = first.content;
  while (content.isNotEmpty) {
    final run = content[0];
    if (run is! TextRun) break;
    final m = _noteLabelPrefix.firstMatch(run.text);
    if (m == null || m[1] != label) break;
    final rest = run.text.substring(m.end);
    if (rest.isNotEmpty) {
      content[0] = TextRun(rest, marks: run.marks, href: run.href);
      break;
    }
    content.removeAt(0);
  }
  if (content.isEmpty) blocks.removeAt(0);
}

/// The marker an item opens with as an element of its own (LaTeXML's `ltx_tag_item`), or null.
VElement? _itemLabel(VElement li) {
  for (final child in li.children) {
    if (child is VText) {
      if (!isBlank(child.text)) return null;
      continue;
    }
    final e = child as VElement;
    return !e.skip && e.hasClass('ltx_tag_item') ? e : null;
  }
  return null;
}

/// An item's label read into its first line: "(a) The encoder…", not "(a)" over the paragraph.
void _prependLabel(List<Block> blocks, String label) {
  if (label.isEmpty) return;
  final first = blocks.isEmpty ? null : blocks[0];
  if (first is ParagraphBlock) {
    first.content = normalizeInlines([TextRun('$label '), ...first.content]);
  } else {
    blocks.insert(0, ParagraphBlock([TextRun(label)]));
  }
}

/// Bullets that never start a word; dashes, stars and dots only count with a space after them.
final _bulletMarker = RegExp(r'^\s*(?:[•◦▪▫●○■□‣⁃∙►▸]\s*|[-–*·](?:\s+|$))');
final _numberMarker = RegExp(r'^\s*(?:(\d{1,4})[.)]|\((\d{1,4})\))(?:\s+|$)');

/// A marker the page typed into an item ("• Point", "3. Step", LaTeXML's tags) repeats the one the list draws and
/// goes; an ordered item keeps a number that is not its own.
void _stripItemMarker(List<Block> blocks, int? number) {
  if (blocks.isEmpty) return;
  final first = blocks[0];
  if (first is! ParagraphBlock) return;
  final content = first.content;
  if (content.isEmpty) return;
  final run = content[0];
  if (run is! TextRun) return;
  final m = (number == null ? _bulletMarker : _numberMarker).firstMatch(run.text);
  if (m == null || (number != null && int.parse(m[1] ?? m[2]!) != number)) return;
  final rest = run.text.substring(m.end);
  if (rest.isEmpty) {
    content.removeAt(0);
  } else {
    content[0] = TextRun(rest, marks: run.marks, href: run.href);
  }
  if (content.isNotEmpty) {
    final next = content[0];
    if (next is TextRun) {
      final text = jsTrimStart(next.text);
      if (text.isEmpty) {
        content.removeAt(0);
      } else if (text.length != next.text.length) {
        content[0] = TextRun(text, marks: next.marks, href: next.href);
      }
    }
  }
  if (content.isEmpty) blocks.removeAt(0);
}

final _capital = RegExp(r'^\p{Lu}', unicode: true);

/// Words ending a sentence: ".", "!" or "?", maybe inside closing quotes or brackets, after a space somewhere
/// (`asyncio.` before `TaskGroup` is one name) and not an ellipsis ("Credit...").
bool _endsSentence(String text) {
  var i = text.length - 1;
  while (i >= 0 && '"\')]”’»'.contains(text[i])) {
    i--;
  }
  if (i < 0) return false;
  final c = text[i];
  if (c != '.' && c != '!' && c != '?') return false;
  if (c == '.' && i > 0 && text[i - 1] == '.') return false;
  return text.lastIndexOf(' ', i) >= 0;
}

/// "Photograph: …" as a run of its own (`<small>`) or the words after a sentence.
final _creditLead = RegExp(
  r'(?:^\s*|[.!?…”’")]\s+)((?:Photograph|Photo|Image|Picture|Illustration|Credit|Source|Graphic)s?\s*:\s*\S)',
);
final _sentenceAfter = RegExp(r'[.!?]\s+\p{Lu}', unicode: true);

/// A short credit closing a caption, split off: (caption, credit); the caption is unchanged when there is none.
(List<Inline>, List<Inline>) _splitCredit(List<Inline> caption) {
  for (var i = 0; i < caption.length; i++) {
    final run = caption[i];
    if (run is! TextRun) continue;
    final m = _creditLead.firstMatch(run.text);
    if (m == null) continue;
    final at = m.end - m[1]!.length;
    final rest = <Inline>[TextRun(run.text.substring(at), marks: run.marks, href: run.href), ...caption.sublist(i + 1)];
    final restText = _inlineTextOf(rest);
    if (restText.length > 120 || _sentenceAfter.hasMatch(restText)) break;
    // Marks every credit run shares are its wrapper's (`<small>`), not the credit's.
    List<Mark>? shared;
    for (final n in rest) {
      if (n is TextRun) {
        shared = shared == null
            ? (n.marks ?? const [])
            : [
                for (final x in shared)
                  if (n.marks != null && n.marks!.contains(x)) x,
              ];
      }
    }
    Inline unshared(Inline n) {
      if (n is! TextRun || shared == null || shared.isEmpty) return n;
      final marks = [
        for (final x in n.marks!)
          if (!shared.contains(x)) x,
      ];
      return TextRun(n.text, marks: marks.isNotEmpty ? marks : null, href: n.href);
    }

    final credit = [for (final n in rest) unshared(n)];
    final before = normalizeInlines([
      ...caption.sublist(0, i),
      TextRun(run.text.substring(0, at), marks: run.marks, href: run.href),
    ]);
    // "Image: Jose Mourinho, left, …" alone is the caption, labelled.
    if (before.isEmpty) break;
    return (before, normalizeInlines(credit));
  }
  return (caption, const <Inline>[]);
}

String _inlineTextOf(List<Inline> content) {
  final s = StringBuffer();
  for (final n in content) {
    if (n is TextRun) s.write(n.text);
  }
  return s.toString();
}

String _decodeFragment(String value) => jsDecodeUriComponent(value) ?? value;

bool _hasDescendant(VElement el, String tag, [int maxDepth = 64]) {
  bool visit(VElement node, int depth) {
    if (depth > maxDepth) return false;
    for (final child in node.children) {
      if (child is! VElement || child.skip) continue;
      if (child.tag == tag || visit(child, depth + 1)) return true;
    }
    return false;
  }

  return visit(el, 1);
}

int _countTag(VElement el, String tag) {
  var n = 0;
  walk(el, (e) {
    if (!identical(e, el) && e.tag == tag) n++;
    return true;
  });
  return n;
}

class _RowInfo {
  _RowInfo(this.cells, this.head);

  final List<VElement> cells;
  final bool head;
}

List<_RowInfo> _tableRows(VElement table) {
  final rows = <_RowInfo>[];
  void visit(VElement el, bool head) {
    for (final child in el.children) {
      if (child is! VElement || child.skip) continue;
      if (child.tag == 'tr') {
        final cells = <VElement>[];
        for (final c in child.children) {
          if (c is VElement && !c.skip && (c.tag == 'td' || c.tag == 'th')) cells.add(c);
        }
        rows.add(_RowInfo(cells, head));
      } else if (child.tag == 'thead' || child.tag == 'tbody' || child.tag == 'tfoot') {
        visit(child, child.tag == 'thead');
      }
    }
  }

  visit(table, false);
  return rows;
}

final _codeTableClass = ClassPattern(
  r'(?:^|[\s_-])(?:highlight|hljs-ln|rouge-table|code-table|lntable|codehilitetable|highlighttable|js-file-line-container|blob-code-table|chroma)(?:$|[\s_-])',
);
final _codeLineCell = ClassPattern(r'(?:^|[\s_-])(?:blob-code|hljs-ln-code|code-line|line-content)(?:$|[\s_-])');
final _codeClass = ClassPattern(r'(?:^|\s)code(?:\s|$)');

bool _isCodeTable(VElement el) {
  if (el.tag != 'table' && el.tag != 'div') return false;
  if (el.tag == 'table' && _codeTableClass.hasMatch(el.matchString)) return true;
  if (el.tag != 'table') return false;
  var code = false;
  walk(el, (e) {
    if (code) return false;
    if (e.tag == 'td' && _codeLineCell.hasMatch(e.matchString)) {
      code = true;
    } else if (e.tag == 'td' && _codeClass.hasMatch(e.className) && _hasDescendant(e, 'pre')) {
      code = true;
    }
    return !code;
  });
  return code;
}

final _carriageReturns = RegExp(r'\r\n?');
final _leadingBlankLines = RegExp(r'^(?:[ \t]*\n)+');

/// Verbatim code: <br> as newlines, line-per-element markup joined, gutters dropped.
String codeText(VElement el) {
  final out = StringBuffer();
  var last = -1;
  void write(String s) {
    if (s.isEmpty) return;
    out.write(s);
    last = s.codeUnitAt(s.length - 1);
  }

  void visit(VElement node) {
    final kids = node.children;
    for (var i = 0; i < kids.length; i++) {
      final child = kids[i];
      if (child is VText) {
        write(child.text);
        continue;
      }
      final e = child as VElement;
      if (e.tag == 'br') {
        write('\n');
        continue;
      }
      if (_gutter.hasMatch(e.matchString) || e.attrs['data-line-number'] != null && isBlank(rawText(e))) continue;
      if (e.tag == 'button' || e.tag == 'svg' || e.tag == 'input' || _codeChrome.hasMatch(e.matchString)) continue;
      final line =
          e.tag == 'div' || e.tag == 'p' || e.tag == 'tr' || e.tag == 'li' || _lineElement.hasMatch(e.matchString);
      visit(e);
      if (line && out.isNotEmpty && last != 10) {
        final next = i + 1 < kids.length ? kids[i + 1] : null;
        if (!(next is VText && charCodeAt(next.text, 0) == 10)) write('\n');
      }
    }
  }

  visit(el);
  return _trimEndJs(
    out
        .toString()
        .replaceAll(_carriageReturns, '\n')
        .replaceAll(' ', ' ')
        .replaceAll(_zeroWidth, '')
        .replaceFirst(_leadingBlankLines, ''),
  );
}

/// Language from markup on the block, its <code> child, or wrappers up to three levels.
String? codeLanguage(VElement pre) {
  String? fromEl(VElement e) =>
      normalizeLanguage(
        e.attrs['data-lang'] ??
            e.attrs['data-language'] ??
            e.attrs['data-code-language'] ??
            e.attrs['data-snippet-lang'] ??
            e.attrs['data-syntax'] ??
            e.attrs['lang'],
      ) ??
      languageFromClass(e.className);
  var lang = fromEl(pre);
  if (lang != null) return lang;
  final code = firstElement(pre, (e) => e.tag == 'code');
  if (code != null) {
    lang = fromEl(code);
    if (lang != null) return lang;
  }
  var p = pre.parent;
  for (var depth = 0; depth < 3 && p != null; depth++, p = p.parent) {
    lang =
        normalizeLanguage(p.attrs['data-lang'] ?? p.attrs['data-language'] ?? p.attrs['data-code-language']) ??
        languageFromClass(p.className);
    if (lang != null) return lang;
  }
  return null;
}

InlineMath? _mathInline(VElement el) {
  if (el.tag == 'math-tex') {
    final tex = _texFrom(rawText(el));
    if (tex == null) return null;
    return InlineMath(tex: tex, text: tex);
  }
  final tex = _texFrom(el.attrs['data-tex'] ?? el.attrs['alttext']);
  final mathml = el.attrs['data-xml'];
  final text = tex ?? collapse(rawText(el));
  if (text.isEmpty && (mathml == null || mathml.isEmpty)) return null;
  return InlineMath(tex: tex, mathml: mathml != null && mathml.isNotEmpty ? mathml : null, text: text);
}
