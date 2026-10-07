import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:truffle/truffle.dart';

import '../../core/theme/highlight_colors.dart';
import '../../data/models/highlight.dart';
import 'article_highlights.dart';
import 'article_media.dart';
import 'article_style.dart';

/// Rich text for inline content. Owns the tap recognizers of its links so
/// they are disposed with it.
///
/// Inside an article with highlights, it paints the passages that fall in
/// its text and reports what is selected in it, both in the coordinates of
/// [drawnText]: the text drawn in the paragraph itself, without inline
/// widgets (images, math, raised or keyboard text).
class ArticleText extends StatefulWidget {
  const ArticleText(this.content, {super.key, required this.style, this.textAlign});

  final List<Inline> content;
  final TextStyle style;
  final TextAlign? textAlign;

  /// The text [ArticleText] draws in the paragraph for [content], which
  /// block texts for highlights are made of.
  static String drawnText(List<Inline> content) {
    final out = StringBuffer();
    for (final part in _plan(content)) {
      final text = part.text;
      if (text != null) out.write(text);
    }
    return out.toString();
  }

  @override
  State<ArticleText> createState() => _ArticleTextState();
}

/// One piece of a paragraph: text in the paragraph itself, or an inline
/// widget (whose [text] is null). [text] is what the piece adds to its
/// block's text; [plain] is what it adds to the paragraph's own text.
sealed class _Part {
  const _Part();

  String? get text;

  String get plain => text ?? '\uFFFC';
}

/// A numbered note reference as raised figures in the text. Its block text
/// is the label, as the web app reads it, without the word joiner.
final class _NoteMark extends _Part {
  const _NoteMark(this.id, this.label, {required this.glued});

  final String id;
  final String label;
  final bool glued;

  static const _superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';

  @override
  String get text => label;

  @override
  String get plain =>
      '${glued ? '\u2060' : ''}${String.fromCharCodes(label.codeUnits.map((c) => _superscripts.codeUnitAt(c - 0x30)))}';
}

final class _Node extends _Part {
  const _Node(this.node);

  final Inline node;

  @override
  String? get text => switch (node) {
        TextRun run when !run.has(Mark.sup) && !run.has(Mark.sub) && !run.has(Mark.kbd) => run.text,
        LineBreak() => '\n',
        InlineMath(:final tex, :final text) when tex == null => text,
        _ => null,
      };
}

/// An inline widget with the closing punctuation that follows it.
final class _Joined extends _Part {
  const _Joined(this.node, this.closing);

  final Inline node;
  final TextRun closing;

  @override
  String? get text => null;
}

/// A part's place in the paragraph's plain text and in the block text;
/// [lead] characters at its start are not block text (a note's word joiner).
typedef _Segment = ({int plain, int plainLength, int drawn, int drawnLength, int lead});

/// Closing punctuation that must stay on the line of what it follows.
final _closing = RegExp(r'^[.,;:!?%)\]}»”’…。、，．：；！？）］｝」』〕〉》】〗〙〛]+');
final _numeric = RegExp(r'^[0-9]+$');
final _trailingSpace = RegExp(r'\s$');

/// Whether [node] is drawn as an inline widget rather than text (numbered
/// note references never get here).
bool _isWidget(Inline node) => _Node(node).text == null;

/// How [content] is drawn, part by part.
List<_Part> _plan(List<Inline> content) {
  final parts = <_Part>[];
  for (var i = 0; i < content.length; i++) {
    final node = content[i];
    final previous = i > 0 ? content[i - 1] : null;
    if (node case FootnoteRef(:final id, :final label) when _numeric.hasMatch(label)) {
      final glued = previous is TextRun && !previous.text.contains(_trailingSpace);
      parts.add(_NoteMark(id, label, glued: glued));
      continue;
    }
    // The line may break on either side of an inline widget whatever its
    // neighbours, so punctuation that closes it travels inside it rather
    // than starting the next line.
    final next = i + 1 < content.length ? content[i + 1] : null;
    final closing = _isWidget(node) && next is TextRun ? _closing.firstMatch(next.text)?.group(0) : null;
    if (closing == null || next is! TextRun) {
      parts.add(_Node(node));
      continue;
    }
    parts.add(_Joined(node, TextRun(closing, marks: next.marks, href: next.href)));
    if (next.text.length > closing.length) {
      parts.add(_Node(TextRun(next.text.substring(closing.length), marks: next.marks, href: next.href)));
    }
    i++;
  }
  return parts;
}

class _ArticleTextState extends State<ArticleText> implements HighlightableText {
  final List<GestureRecognizer> _recognizers = [];
  ArticleHighlights? _highlights;
  _ParagraphSelection? _selection;

  /// Where this text sits in its top-level block, when it can be highlighted.
  TextAnchor? _anchor;
  List<HighlightPaint> _paints = const [];

  /// How the paragraph's plain text lines up with its block text.
  List<_Segment> _segments = const [];

  void _clear() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final highlights = ArticleScope.of(context).highlights;
    if (!identical(highlights, _highlights)) {
      _detach();
      _highlights = highlights;
      _attach();
    }
  }

  @override
  void didUpdateWidget(ArticleText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.content, widget.content)) {
      _detach();
      _attach();
    }
  }

  void _attach() {
    final highlights = _highlights;
    _anchor = highlights?.anchorOf(widget.content);
    if (highlights == null || _anchor == null) {
      _paints = const [];
      return;
    }
    _selection ??= _ParagraphSelection();
    highlights.addListener(_onHighlights);
    highlights.register(this);
    _paints = highlights.paintsFor(_anchor!);
  }

  void _detach() {
    _highlights?.removeListener(_onHighlights);
    _highlights?.unregister(this);
  }

  void _onHighlights() {
    final anchor = _anchor;
    if (anchor == null || !mounted) return;
    final next = _highlights!.paintsFor(anchor);
    if (!listEquals(next, _paints)) setState(() => _paints = next);
  }

  @override
  TextAnchor? get anchor => _anchor;

  @override
  TextRange? get selected {
    final range = _selection?.selected(_paragraph());
    if (range == null) return null;
    return TextRange(start: _drawnOffset(range.start), end: _drawnOffset(range.end));
  }

  @override
  Rect? rectOf(int offset) {
    final paragraph = _paragraph();
    if (paragraph == null || !paragraph.hasSize) return null;
    final at = _plainOffset(offset);
    final boxes = paragraph.getBoxesForSelection(TextSelection(baseOffset: at, extentOffset: at + 1));
    final local = boxes.isEmpty ? Offset.zero & Size(paragraph.size.width, 1) : boxes.first.toRect();
    return MatrixUtils.transformRect(paragraph.getTransformTo(null), local);
  }

  final GlobalKey _paragraphKey = GlobalKey();

  RenderParagraph? _paragraph() {
    final paragraph = _paragraphKey.currentContext?.findRenderObject();
    return paragraph is RenderParagraph && paragraph.attached ? paragraph : null;
  }

  /// A paragraph offset as an offset into [ArticleText.drawnText]; inside
  /// an inline widget it lands before it.
  int _drawnOffset(int plain) {
    for (final s in _segments) {
      if (plain > s.plain + s.plainLength) continue;
      return s.drawn + (plain - s.plain - s.lead).clamp(0, s.drawnLength);
    }
    return _segments.isEmpty ? 0 : _segments.last.drawn + _segments.last.drawnLength;
  }

  /// The inverse of [_drawnOffset].
  int _plainOffset(int drawn) {
    for (final s in _segments) {
      if (drawn >= s.drawn && drawn < s.drawn + s.drawnLength) return s.plain + s.lead + drawn - s.drawn;
    }
    return _segments.isEmpty ? 0 : _segments.last.plain + _segments.last.plainLength;
  }

  @override
  void dispose() {
    _detach();
    _selection?.dispose();
    _clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _clear();
    final scope = ArticleScope.of(context);
    final children = <InlineSpan>[];
    final segments = <_Segment>[];
    var at = 0, plainAt = 0;
    for (final part in _plan(widget.content)) {
      switch (part) {
        case _NoteMark():
          children.add(_noteMark(part, at, scope));
        case _Node(:final node):
          final text = part.text;
          children.add(text == null ? _span(node, scope) : _textSpan(node, text, at, scope));
        case _Joined(:final node, :final closing):
          children.add(_withTrailing(_span(node, scope) as WidgetSpan, _span(closing, scope)));
      }
      final text = part.text?.length ?? 0, plain = part.plain.length;
      segments.add((plain: plainAt, plainLength: plain, drawn: at, drawnLength: text, lead: part is _NoteMark && part.glued ? 1 : 0));
      at += text;
      plainAt += plain;
    }
    final root = TextSpan(style: widget.style, children: children);
    final selection = _selection;
    if (selection == null || _anchor == null) return Text.rich(root, textAlign: widget.textAlign);
    assert(root.toPlainText(includeSemanticsLabels: false).length == plainAt);
    _segments = segments;
    return SelectionContainer(delegate: selection, child: _richText(root, selection));
  }

  /// What [Text.rich] draws, but with the paragraph's selectable pieces
  /// registered with [registrar] itself: [Text] puts them in a container of
  /// its own, whose offsets count the text of inline widgets too.
  Widget _richText(TextSpan root, SelectionRegistrar registrar) {
    final defaults = DefaultTextStyle.of(context);
    var style = defaults.style;
    if (MediaQuery.boldTextOf(context)) style = style.merge(const TextStyle(fontWeight: FontWeight.bold));
    return RichText(
      key: _paragraphKey,
      text: TextSpan(style: style, children: [root]),
      textAlign: widget.textAlign ?? defaults.textAlign ?? TextAlign.start,
      softWrap: defaults.softWrap,
      overflow: style.overflow ?? defaults.overflow,
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: defaults.maxLines,
      textWidthBasis: defaults.textWidthBasis,
      textHeightBehavior: defaults.textHeightBehavior ?? DefaultTextHeightBehavior.maybeOf(context),
      selectionRegistrar: registrar,
      selectionColor: DefaultSelectionStyle.of(context).selectionColor ?? DefaultSelectionStyle.defaultColor,
    );
  }

  /// [text] drawn from [at] in the paragraph, split where highlights start
  /// and end. A highlighted piece taps to its highlight unless it is a link.
  List<InlineSpan> _painted(String text, int at, TextStyle style, GestureRecognizer? recognizer) {
    final paints = _paints.where((p) => p.start < at + text.length && p.end > at).toList();
    if (paints.isEmpty) return [TextSpan(text: text, style: style, recognizer: recognizer)];
    final cuts = <int>{0, text.length};
    for (final p in paints) {
      cuts
        ..add((p.start - at).clamp(0, text.length))
        ..add((p.end - at).clamp(0, text.length));
    }
    final points = cuts.toList()..sort();
    final out = <InlineSpan>[];
    final colors = ArticleScope.of(context).style.colors;
    for (var i = 0; i + 1 < points.length; i++) {
      final from = points[i], to = points[i + 1];
      if (from == to) continue;
      HighlightPaint? paint;
      for (final p in paints) {
        if (p.start <= at + from && p.end >= at + to && (paint == null || p.length < paint.length)) paint = p;
      }
      final piece = text.substring(from, to);
      if (paint == null) {
        out.add(TextSpan(text: piece, style: style, recognizer: recognizer));
        continue;
      }
      out.add(TextSpan(
        text: piece,
        style: paint.apply(style, colors),
        recognizer: recognizer ?? _tapFor(paint.id),
      ));
    }
    return out;
  }

  GestureRecognizer _tapFor(String id) {
    final recognizer = TapGestureRecognizer()..onTap = () => _highlights?.tapped(id);
    _recognizers.add(recognizer);
    return recognizer;
  }

  /// A numbered note reference as raised figures in the text itself, so it
  /// breaks like text: a word joiner keeps it on the line of the word it
  /// marks, and the punctuation after it never starts a line.
  InlineSpan _noteMark(_NoteMark mark, int at, ArticleScope scope) {
    final recognizer = TapGestureRecognizer()..onTap = () => scope.onFootnote(mark.id);
    _recognizers.add(recognizer);
    var style = widget.style.copyWith(color: scope.style.colors.primary, fontWeight: FontWeight.w700);
    for (final p in _paints) {
      if (p.start <= at && p.end > at) style = p.apply(style, scope.style.colors);
    }
    return TextSpan(
      text: mark.plain,
      semanticsLabel: 'Note ${mark.label}',
      recognizer: recognizer,
      style: style,
    );
  }
  /// A part drawn as [text] in the paragraph itself.
  InlineSpan _textSpan(Inline node, String text, int at, ArticleScope scope) {
    var style = widget.style;
    GestureRecognizer? recognizer;
    switch (node) {
      case TextRun():
        (style, recognizer) = _run(node, scope);
      case InlineMath():
        style = style.copyWith(fontStyle: FontStyle.italic);
      case LineBreak():
        return const TextSpan(text: '\n');
      default:
        break;
    }
    final spans = _painted(text, at, style, recognizer);
    return spans.length == 1 ? spans.first : TextSpan(children: spans);
  }

  /// A run's style with its marks, and for a link, its colour and tap.
  (TextStyle, GestureRecognizer?) _run(TextRun run, ArticleScope scope) {
    final style = _marked(run, widget.style, scope);
    final href = run.href;
    if (href == null) return (style, null);
    final colors = scope.style.colors;
    final recognizer = TapGestureRecognizer()..onTap = () => scope.onLink(href);
    _recognizers.add(recognizer);
    return (
      style.copyWith(
        color: colors.primary,
        decoration: TextDecoration.combine([if (style.decoration != null) style.decoration!, TextDecoration.underline]),
        decorationColor: colors.primary.withValues(alpha: 0.4),
      ),
      recognizer,
    );
  }

  /// [span] followed by [trailing] as one unbreakable inline.
  WidgetSpan _withTrailing(WidgetSpan span, InlineSpan trailing) => WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: Text.rich(
          TextSpan(
            style: widget.style,
            children: [WidgetSpan(alignment: span.alignment, baseline: span.baseline, child: span.child), trailing],
          ),
          // The enclosing paragraph already scales its inline widgets.
          textScaler: TextScaler.noScaling,
          softWrap: false,
        ),
      );

  InlineSpan _span(Inline node, ArticleScope scope) {
    final colors = scope.style.colors;
    final base = widget.style;
    final size = base.fontSize ?? scope.style.fontSize;
    switch (node) {
      case TextRun(:final text):
        final (style, recognizer) = _run(node, scope);
        if (node.has(Mark.sup) || node.has(Mark.sub)) {
          return _shifted(text, style.copyWith(fontSize: size * 0.72), up: node.has(Mark.sup), size: size);
        }
        if (node.has(Mark.kbd)) {
          return WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              decoration: BoxDecoration(
                color: colors.element,
                border: Border.all(color: colors.borderActive.withValues(alpha: 0.6)),
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(text, style: style.copyWith(height: 1.3), textScaler: TextScaler.noScaling),
            ),
          );
        }
        return TextSpan(text: text, style: style, recognizer: recognizer);
      case LineBreak():
        return const TextSpan(text: '\n');
      case InlineImage(:final src, :final alt, :final width, :final height):
        final h = (height?.toDouble() ?? size).clamp(1.0, size * 3);
        final w = width != null && height != null && height > 0 ? h * width / height : h;
        return WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Semantics(
            label: alt,
            image: true,
            child: NetworkPicture(src: src, width: w, height: h, fit: BoxFit.contain),
          ),
        );
      case InlineMath(:final tex, :final text):
        if (tex == null) return TextSpan(text: text, style: base.copyWith(fontStyle: FontStyle.italic));
        // A formula wider than the line scrolls sideways instead of overflowing.
        return WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Math.tex(
              tex,
              mathStyle: MathStyle.text,
              textStyle: base.copyWith(height: 1),
              textScaleFactor: 1,
              onErrorFallback: (_) =>
                  Text(text, style: base.copyWith(fontStyle: FontStyle.italic), textScaler: TextScaler.noScaling),
            ),
          ),
        );
      case FootnoteRef(:final id, :final label):
        return WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: Semantics(
            button: true,
            label: 'Note $label',
            excludeSemantics: true,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => scope.onFootnote(id),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Transform.translate(
                  offset: Offset(0, -size * 0.38),
                  child: Text(
                    label,
                    style: base.copyWith(fontSize: size * 0.68, color: colors.primary, fontWeight: FontWeight.w700),
                    textScaler: TextScaler.noScaling,
                  ),
                ),
              ),
            ),
          ),
        );
    }
  }

  WidgetSpan _shifted(String text, TextStyle style, {required bool up, required double size}) => WidgetSpan(
        alignment: PlaceholderAlignment.baseline,
        baseline: TextBaseline.alphabetic,
        child: Transform.translate(
          offset: Offset(0, up ? -size * 0.38 : size * 0.18),
          child: Text(text, style: style, textScaler: TextScaler.noScaling),
        ),
      );

  static TextStyle _marked(TextRun run, TextStyle base, ArticleScope scope) {
    final marks = run.marks;
    if (marks == null || marks.isEmpty) return base;
    final colors = scope.style.colors;
    final size = base.fontSize ?? scope.style.fontSize;
    var style = base;
    final decorations = <TextDecoration>[];
    for (final mark in marks) {
      switch (mark) {
        case Mark.bold:
          style = style.copyWith(fontWeight: FontWeight.w700);
        case Mark.italic:
          style = style.copyWith(fontStyle: FontStyle.italic);
        case Mark.underline:
          decorations.add(TextDecoration.underline);
        case Mark.strike:
          decorations.add(TextDecoration.lineThrough);
        case Mark.code:
        case Mark.kbd:
          style = style.merge(scope.style.mono).copyWith(
                fontSize: size * 0.86,
                height: base.height,
                backgroundColor: mark == Mark.code ? colors.element : null,
              );
        case Mark.highlight:
          style = style.copyWith(backgroundColor: HighlightColors.tint(HighlightColor.yellow, colors));
        case Mark.small:
          style = style.copyWith(fontSize: size * 0.85);
        case Mark.sub:
        case Mark.sup:
          break;
      }
    }
    if (decorations.isNotEmpty) {
      style = style.copyWith(decoration: TextDecoration.combine(decorations), decorationColor: style.color);
    }
    return style;
  }
}

/// Watches the selection in one paragraph. Flutter's own range for a
/// selection container counts offsets wrongly in paragraphs with inline
/// widgets, so this reads the paragraph's fragments directly: their
/// selections are offsets into the paragraph's whole plain text.
class _ParagraphSelection extends StaticSelectionContainerDelegate {
  /// The selected part of [paragraph]'s plain text, or null when none (an
  /// inline widget's own text does not count).
  TextRange? selected(RenderParagraph? paragraph) {
    if (paragraph == null) return null;
    int? start, end;
    for (final selectable in selectables) {
      if (!paragraph.selectableBelongsToParagraph(selectable)) continue;
      final range = selectable.getSelection();
      if (range == null || range.startOffset == range.endOffset) continue;
      final a = math.min(range.startOffset, range.endOffset);
      final b = math.max(range.startOffset, range.endOffset);
      start = start == null ? a : math.min(start, a);
      end = end == null ? b : math.max(end, b);
    }
    return start == null ? null : TextRange(start: start, end: end!);
  }
}
