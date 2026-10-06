import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:thereader_extract/thereader_extract.dart';

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

  @override
  Widget build(BuildContext context) {
    _clear();
    final scope = ArticleScope.of(context);
    final children = [for (final node in widget.content) _span(node, scope)];
    return Text.rich(TextSpan(style: widget.style, children: children), textAlign: widget.textAlign);
  }

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
              child: Text(text, style: style.copyWith(height: 1.3)),
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
              onErrorFallback: (_) => Text(text, style: base.copyWith(fontStyle: FontStyle.italic)),
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
        child: Transform.translate(offset: Offset(0, up ? -size * 0.38 : size * 0.18), child: Text(text, style: style)),
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
