import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:truffle/truffle.dart';

import '../../core/theme/highlight_colors.dart';
import '../../data/models/highlight.dart';
import 'article_media.dart';
import 'article_style.dart';

/// Rich text for inline content. Owns the tap recognizers of its links so
/// they are disposed with it.
class ArticleText extends StatefulWidget {
  const ArticleText(this.content, {super.key, required this.style, this.textAlign});

  final List<Inline> content;
  final TextStyle style;
  final TextAlign? textAlign;

  @override
  State<ArticleText> createState() => _ArticleTextState();
}

class _ArticleTextState extends State<ArticleText> {
  final List<TapGestureRecognizer> _recognizers = [];

  void _clear() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    _clear();
    super.dispose();
  }

  /// Closing punctuation that must stay on the line of what it follows.
  static final _closing = RegExp(r'^[.,;:!?%)\]}»”’…。、，．：；！？）］｝」』〕〉》】〗〙〛]+');
  static final _numeric = RegExp(r'^[0-9]+$');
  static final _trailingSpace = RegExp(r'\s$');
  static const _superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';

  @override
  Widget build(BuildContext context) {
    _clear();
    final scope = ArticleScope.of(context);
    final content = widget.content;
    final children = <InlineSpan>[];
    for (var i = 0; i < content.length; i++) {
      final node = content[i];
      final previous = i > 0 ? content[i - 1] : null;
      if (node case FootnoteRef(:final id, :final label) when _numeric.hasMatch(label)) {
        final glued = previous is TextRun && !previous.text.contains(_trailingSpace);
        children.add(_noteMark(id, label, glued, scope));
        continue;
      }
      final span = _span(node, scope);
      // The line may break on either side of an inline widget whatever its
      // neighbours, so punctuation that closes it travels inside it rather
      // than starting the next line.
      final next = i + 1 < content.length ? content[i + 1] : null;
      final closing = span is WidgetSpan && next is TextRun ? _closing.firstMatch(next.text)?.group(0) : null;
      if (closing == null || next is! TextRun) {
        children.add(span);
        continue;
      }
      children.add(_withTrailing(span as WidgetSpan, _span(TextRun(closing, marks: next.marks, href: next.href), scope)));
      if (next.text.length > closing.length) {
        children.add(_span(TextRun(next.text.substring(closing.length), marks: next.marks, href: next.href), scope));
      }
      i++;
    }
    return Text.rich(TextSpan(style: widget.style, children: children), textAlign: widget.textAlign);
  }

  /// A numbered note reference as raised figures in the text itself, so it
  /// breaks like text: a word joiner keeps it on the line of the word it
  /// marks, and the punctuation after it never starts a line.
  InlineSpan _noteMark(String id, String label, bool glued, ArticleScope scope) {
    final recognizer = TapGestureRecognizer()..onTap = () => scope.onFootnote(id);
    _recognizers.add(recognizer);
    final figures = String.fromCharCodes(label.codeUnits.map((c) => _superscripts.codeUnitAt(c - 0x30)));
    return TextSpan(
      text: '${glued ? '\u2060' : ''}$figures',
      semanticsLabel: 'Note $label',
      recognizer: recognizer,
      style: widget.style.copyWith(color: scope.style.colors.primary, fontWeight: FontWeight.w700),
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
      case TextRun(:final text, :final href):
        var style = _marked(node, base, scope);
        TapGestureRecognizer? recognizer;
        if (href != null) {
          style = style.copyWith(
            color: colors.primary,
            decoration: TextDecoration.combine([if (style.decoration != null) style.decoration!, TextDecoration.underline]),
            decorationColor: colors.primary.withValues(alpha: 0.4),
          );
          recognizer = TapGestureRecognizer()..onTap = () => scope.onLink(href);
          _recognizers.add(recognizer);
        }
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
