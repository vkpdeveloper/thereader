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

const _tagMark = {
  'b': Mark.bold, 'strong': Mark.bold, 'i': Mark.italic, 'em': Mark.italic, 'cite': Mark.italic, 'dfn': Mark.italic, //
  'var': Mark.italic, 'u': Mark.underline, 'ins': Mark.underline, 's': Mark.strike, 'del': Mark.strike,
  'strike': Mark.strike, 'code': Mark.code, 'tt': Mark.code, 'samp': Mark.code, 'kbd': Mark.kbd, 'sub': Mark.sub,
  'sup': Mark.sup, 'mark': Mark.highlight, 'small': Mark.small,
};

const _inlineTags = {
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', //
  'img', 'ins', 'kbd', 'label', 'mark', 'math', 'math-tex', 'nobr', 'noscript', 'picture', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'svg', 'time', 'tt', 'u', 'var', 'wbr', 'input', 'meta',
  'link', 'source', 'track',
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
  r'(?:^|[\s_-])(?:code-?block-?title|code-?title|filename|file-name|codeblock-header|code-header|code-block-header|rehype-code-title|remark-code-title|highlight-title)(?:$|[\s_-])|codeBlockTitle',
);
final _gutter = ClassPattern(
  r'(?:^|[\s_-])(?:line-?numbers?(?:-rows)?|linenos?|lineno|linenodiv|gutter|ln-num|hljs-ln-n|hljs-ln-numbers|rouge-gutter|blob-num|lnt|code-line-number|react-syntax-highlighter-line-number|line-num|linenumber|line-number-cell)(?:$|[\s_-])',
);
final _lineElement = ClassPattern(
  r'(?:^|[\s_-])(?:line|code-line|cm-line|ec-line|token-line|highlight-line|view-line|line-content)(?:$|[\s_-])',
);
final _pullQuote = ClassPattern(
  r'(?:^|[\s_-])(?:pullquote|pull-quote|wp-block-pullquote|pull_quote|blockquote--pull)(?:$|[\s_-])',
);
final _zeroWidth = RegExp('[​﻿⁠]');
final _footnoteClass = ClassPattern(r'(?:^|\s)footnote(?:\s|$)');
final _footnoteNumber = ClassPattern(r'footnote-number');
final _footnoteContent = ClassPattern(r'footnote-content');
final _mathFallback = ClassPattern(r'mwe-math-fallback-image');
final _imageLink = RegExp(r'\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])', caseSensitive: false);
final _labelBrackets = RegExp(r'^\[|\]$');
final _backArrow = RegExp(r'^[↩↑^]');
final _permalinkText = RegExp(r'^[#¶§🔗]?$');
final _linkScheme = RegExp(r'^(?:https?|mailto|tel):', caseSensitive: false);
final _bold = RegExp(r'font-weight\s*:\s*(?:bold|[6-9]00)', caseSensitive: false);
final _italic = RegExp(r'font-style\s*:\s*italic', caseSensitive: false);
final _texWrapper = RegExp(r'^\{\\(?:displaystyle|textstyle|scriptstyle)\s*([\s\S]*)\}$');

bool _hasZeroWidth(String s) {
  for (var i = 0; i < s.length; i++) {
    final c = s.codeUnitAt(i);
    if (c == 0x200b || c == 0xfeff || c == 0x2060) return true;
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

  void text(String value, _Ctx ctx) {
    if (value.isEmpty) return;
    final text = _hasZeroWidth(value) ? value.replaceAll(_zeroWidth, '') : value;
    if (text.isEmpty) return;
    if (breaks > 0 && _onlyHtmlSpace(text)) return;
    breaks = 0;
    nodes.add(TextRun(text, marks: ctx.marks.isNotEmpty ? _sortMarks(ctx.marks) : null, href: ctx.href));
  }

  void lineBreak() {
    breaks++;
    if (breaks >= 2 && out != null) {
      flush();
      breaks = 2;
      return;
    }
    nodes.add(const LineBreak());
  }

  void push(Inline node) {
    breaks = 0;
    nodes.add(node);
  }

  /// Paragraph mode: emits the collected paragraph (or a display formula) and starts a new one.
  void flush() {
    final out = this.out;
    if (out == null) return;
    final content = normalizeInlines(nodes);
    nodes = [];
    breaks = 0;
    if (content.isEmpty) return;
    final first = content[0];
    if (content.length == 1 && first is InlineMath && identical(converter.lastDisplayMath, first)) {
      final block = MathBlock(text: first.text);
      if (first.tex != null) block.tex = first.tex;
      if (first.mathml != null) block.mathml = first.mathml;
      out.add(block);
      return;
    }
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

bool _isInline(VElement el) => _inlineTags.contains(el.tag) && !_hasBlock(el);

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
  String? _pendingCodeTitle;
  Inline? lastDisplayMath;

  List<Block> convert(List<VElement> roots) {
    for (final root in roots) {
      _scanFootnotes(root);
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
    return out;
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
        if (blocks.isNotEmpty) items.add(Footnote(id: item.id, label: _notes[item.id]!, blocks: blocks));
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
        final block = mediaFromFrame(el.attrs['src'] ?? el.attrs['data-src'] ?? '', el.attrs['title']);
        if (block != null) out.add(block);
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
      final title = textOf(el);
      if (title.isNotEmpty && title.length < 120) _pendingCodeTitle = title;
      return;
    }
    if (_isFootnoteContainer(el)) {
      _footnotes(el, out);
      return;
    }
    if (_substackFootnote(el, out)) return;
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
    if (_caption(el, out, b)) return;
    final tag = el.tag;
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
        final href = ctx.href;
        if (href != null && image.href == null && href != image.src && _imageLink.hasMatch(href)) image.href = href;
        out.add(FigureBlock(images: [image]));
        return;
      case 'math':
      case 'math-tex':
        final node = _mathInline(el);
        if (node == null) return;
        if (el.attrs['display'] == 'block' || el.attrs['mode'] == 'display') lastDisplayMath = node;
        b.push(node);
        return;
      case 'noscript':
        return;
      case 'a':
        final href = el.attrs['href'];
        if (href != null && charCodeAt(href, 0) == 35) {
          final id = _decodeFragment(href.substring(1));
          if (_notes.containsKey(id)) {
            final label = jsTrim(collapse(rawText(el)).replaceAll(_labelBrackets, ''));
            b.push(FootnoteRef(id: id, label: label.isNotEmpty ? label : _notes[id]!));
            return;
          }
          final linkText = collapse(rawText(el));
          if (_backlink.hasMatch(el.matchString) || _backArrow.hasMatch(linkText)) return;
          // Permalink glyphs go; a permalink wrapping the heading's own words keeps them.
          if (_permalinkText.hasMatch(linkText)) return;
          // Other in-page links read as plain text.
          _inlineChildren(el, b, ctx, out);
          return;
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
          visit(e, ctx);
        }
        if (_blockTags.contains(tag)) b.lineBreak();
      }
    }

    visit(el, _emptyCtx);
    return b.result();
  }

  // ---------------------------------------------------------------- headings, lists, quotes

  void _heading(VElement el, List<Block> out) {
    final content = inlineOnly(el);
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
        children(e, blocks);
        if (blocks.isEmpty) continue;
        final item = ListItem(blocks: blocks);
        final box = firstElement(e, (x) => x.tag == 'input' && jsLower(x.attrs['type'] ?? '') == 'checkbox');
        if (box != null) item.checked = box.attrs['checked'] != null;
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
    final list = ListBlock(ordered: el.tag == 'ol', items: items);
    final start = _intAttr(el, 'start');
    if (el.tag == 'ol' && start != null && start != 1) list.start = start;
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

  static final _authorWithDate = RegExp(r'^[—–-]\s*(.+?)(?:\s*\((@\w+)\))?\s+[A-Z][a-z]+ \d{1,2}, \d{4}$');
  static final _authorLine = RegExp(r'^[—–-]\s*(.+)$');

  void _embed(VElement el, String provider, List<Block> out) {
    String? url;
    final links = <String>[];
    walk(el, (e) {
      final href = e.attrs['href'];
      if (e.tag == 'a' && href != null) {
        final abs = resolveUrl(href, base);
        if (abs != null) links.add(abs);
      }
      return true;
    });
    if (provider == 'twitter') {
      final tweets = links.where(tweet.hasMatch).toList();
      url = tweets.isEmpty ? null : tweets.last;
    }
    url ??=
        el.attrs['data-instgrm-permalink'] ??
        el.attrs['cite'] ??
        el.attrs['data-bluesky-uri'] ??
        el.attrs['data-href'] ??
        (links.isEmpty ? null : links.last);
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
    r'(?:^|[\s_-])(?:admonition-title|callout-title|alert-title|markdown-alert-title|admonitionHeading|notecard-title|title|heading)(?:$|[\s_-])|admonitionHeading',
  );

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
    if (title != null && title.isNotEmpty) block.title = title;
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
    if (blocks.isEmpty && summary.isEmpty) return;
    out.add(DetailsBlock(summary: summary, blocks: blocks));
  }

  // ---------------------------------------------------------------- code

  void _code(VElement el, List<Block> out) {
    // Some sites wrap prose in <pre>; a pre full of block markup is not code.
    if (_hasDescendant(el, 'p') && _hasDescendant(el, 'p', 1) && !_hasDescendant(el, 'code')) {
      children(el, out);
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
    walk(el, (e) {
      if (e.skip || identical(e, captionEl)) return false;
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
          final block = mediaFromFrame(e.attrs['src'] ?? e.attrs['data-src'] ?? '', e.attrs['title']);
          if (block != null) media.add(block);
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

    if (images.isEmpty && media.isEmpty || other) {
      // Code listings, tables and quotes in a <figure>: convert the content, keep the caption as text.
      if (cap != null) cap.skip = true;
      final before = out.length;
      children(el, out);
      if (cap != null) cap.skip = false;
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

bool _isNoteItem(VElement el) {
  if (el.id.isEmpty) return false;
  return el.tag == 'li' ||
      el.attrs['role'] == 'doc-footnote' ||
      el.attrs['role'] == 'doc-endnote' ||
      (el.tag != 'a' && (el.hasClass('footnote') || el.hasClass('footnote-item')));
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
      if (e.tag == 'button' || e.tag == 'svg' || e.tag == 'input') continue;
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
  final text = collapse(rawText(el));
  final node = InlineMath(text: tex ?? text);
  if (tex != null) node.tex = tex;
  if (mathml != null && mathml.isNotEmpty) node.mathml = mathml;
  if (node.text.isEmpty && node.mathml == null) return null;
  return node;
}
