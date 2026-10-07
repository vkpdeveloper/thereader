import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:truffle/truffle.dart';

import '../../core/theme/app_colors.dart';
import '../../core/theme/highlight_colors.dart';
import '../../data/articles/article_anchors.dart';
import '../../data/models/highlight.dart';
import '../../data/repositories/highlight_repository.dart';
import 'article_text.dart';

/// Where an [ArticleText] sits: its top-level block, where its text starts
/// in the block's text, and how long it is.
typedef TextAnchor = ({int block, int base, int length});

/// The text of each top-level block as [ArticleText] draws it (what article
/// highlight offsets count), and where each [ArticleText] starts in it.
/// Only text set in paragraphs counts: list markers, code, math, images and
/// controls do not. Built from the model, so blocks that are not on screen
/// have their text too.
class ArticleTextModel {
  ArticleTextModel(Article article) : _blocks = article.blocks {
    for (var i = 0; i < _blocks.length; i++) {
      final out = StringBuffer();
      void add(List<Inline>? content) {
        if (content == null) return;
        final text = ArticleText.drawnText(content);
        _anchors[content] = (block: i, base: out.length, length: text.length);
        out.write(text);
      }

      // In the order BlockView draws them.
      void visit(Block block) {
        switch (block) {
          case HeadingBlock(:final content) || ParagraphBlock(:final content):
            add(content);
          case ListBlock(:final items):
            for (final item in items) {
              item.blocks.forEach(visit);
            }
          case QuoteBlock(:final blocks):
            blocks.forEach(visit);
          case FigureBlock(:final caption, :final credit):
            add(caption);
            add(credit);
          case VideoBlock(:final caption):
            add(caption);
          case AudioBlock(:final caption):
            add(caption);
          case TableBlock(:final caption, :final rows):
            add(caption);
            for (final row in rows) {
              for (final cell in row.cells) {
                add(cell.content);
              }
            }
          case DefinitionListBlock(:final items):
            for (final item in items) {
              add(item.term);
              item.details.forEach(visit);
            }
          case DetailsBlock(:final summary, :final blocks):
            add(summary);
            blocks.forEach(visit);
          case CalloutBlock(:final title, :final blocks):
            add(title);
            blocks.forEach(visit);
          case EmbedBlock(:final blocks?):
            blocks.forEach(visit);
          case FootnotesBlock(:final items):
            for (final note in items) {
              note.blocks.forEach(visit);
            }
          default:
            break;
        }
      }

      visit(_blocks[i]);
      _texts.add(out.isEmpty ? null : out.toString());
    }
  }

  final List<Block> _blocks;
  final List<String?> _texts = [];
  final Map<List<Inline>, TextAnchor> _anchors = Map.identity();

  int get count => _texts.length;

  /// A block's text, null when it has none.
  String? text(int index) => index >= 0 && index < _texts.length ? _texts[index] : null;

  TextAnchor? anchorOf(List<Inline> content) => _anchors[content];

  /// The heading of the section [block] is in, for lists.
  String? sectionTitle(int block) {
    for (var i = math.min(block, _blocks.length - 1); i >= 0; i--) {
      if (_blocks[i] case HeadingBlock(:final content)) {
        final title = inlineText(content).trim();
        return title.isEmpty ? null : title;
      }
    }
    return null;
  }
}

/// A highlighted stretch of one [ArticleText], in its drawn-text offsets.
@immutable
class HighlightPaint {
  const HighlightPaint({
    required this.id,
    required this.start,
    required this.end,
    required this.color,
    required this.noted,
    required this.active,
  });

  final String id;
  final int start;
  final int end;
  final HighlightColor color;

  /// Has a note: drawn with a dotted underline, as on the web.
  final bool noted;

  /// Just opened from the list: marked for a moment.
  final bool active;

  int get length => end - start;

  TextStyle apply(TextStyle style, AppColors colors) {
    final tint = HighlightColors.tint(color, colors);
    return style.copyWith(
      backgroundColor: active ? Color.alphaBlend(colors.ink.withValues(alpha: 0.14), tint) : tint,
      decoration: noted
          ? TextDecoration.combine([if (style.decoration != null) style.decoration!, TextDecoration.underline])
          : style.decoration,
      decorationStyle: noted ? TextDecorationStyle.dotted : style.decorationStyle,
      decorationColor: noted ? HighlightColors.swatch(color) : style.decorationColor,
      decorationThickness: noted ? 2 : style.decorationThickness,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is HighlightPaint &&
      other.id == id &&
      other.start == start &&
      other.end == end &&
      other.color == color &&
      other.noted == noted &&
      other.active == active;

  @override
  int get hashCode => Object.hash(id, start, end, color, noted, active);
}

/// What the screen needs from an [ArticleText] that is on screen.
abstract interface class HighlightableText {
  TextAnchor? get anchor;

  /// The selected part of its drawn text, or null.
  TextRange? get selected;

  /// The character at [offset] of its drawn text, in global coordinates.
  Rect? rectOf(int offset);
}

/// Highlights of one open article: finds each passage in the article as
/// drawn, tells each [ArticleText] what to paint, reads the selection from
/// the ones on screen, and makes new highlights. Edits go to the
/// [HighlightRepository], which saves them at once; sync sends them on its
/// next scheduled cycle.
class ArticleHighlights extends ChangeNotifier {
  ArticleHighlights({
    required this.repo,
    required this.articleId,
    required this.href,
    required this.model,
    required this.origin,
  }) {
    repo.addListener(_resolve);
    _resolve();
  }

  final HighlightRepository repo;
  final String articleId;
  final String href;
  final ArticleTextModel model;

  /// The API origin new highlights are recorded under.
  final String Function() origin;

  /// Called when a highlight is tapped in the text.
  ValueChanged<String>? onTap;

  final Set<HighlightableText> _texts = {};
  List<Highlight> _items = const [];
  Map<String, ArticleSpan> _spans = const {};
  Map<int, List<(Highlight, int, int)>> _byBlock = const {};

  /// Resolved spans by highlight id, kept while the highlight is unchanged:
  /// the store notifies on every edit and sync pull, books included.
  final Map<String, (DateTime, ArticleSpan?)> _resolved = {};
  String? _active;
  Timer? _activeTimer;
  bool _disposed = false;

  /// Live highlights of this article, in reading order.
  List<Highlight> get items => _items;

  /// Where a highlight is drawn; null when its passage is gone.
  ArticleSpan? spanOf(String id) => _spans[id];

  TextAnchor? anchorOf(List<Inline> content) => model.anchorOf(content);

  void register(HighlightableText text) => _texts.add(text);

  void unregister(HighlightableText text) => _texts.remove(text);

  void _resolve() {
    _items = repo.forArticle(articleId);
    final spans = <String, ArticleSpan>{};
    final byBlock = <int, List<(Highlight, int, int)>>{};
    for (final h in _items) {
      final cached = _resolved[h.id];
      final ArticleSpan? span;
      if (cached != null && cached.$1 == h.updatedAt) {
        span = cached.$2;
      } else {
        final loc = ArticleLocator.parse(h.locator);
        span = loc == null ? null : resolveLocator(loc, model.text, model.count);
        _resolved[h.id] = (h.updatedAt, span);
      }
      if (span == null) continue;
      spans[h.id] = span;
      for (var b = span.startBlock; b <= span.endBlock; b++) {
        final from = b == span.startBlock ? span.start : 0;
        final to = b == span.endBlock ? span.end : model.text(b)?.length ?? 0;
        if (to > from) (byBlock[b] ??= []).add((h, from, to));
      }
    }
    _spans = spans;
    _byBlock = byBlock;
    notifyListeners();
  }

  /// The highlights within one [ArticleText], in its own offsets.
  List<HighlightPaint> paintsFor(TextAnchor anchor) {
    final list = _byBlock[anchor.block];
    if (list == null) return const [];
    final out = <HighlightPaint>[];
    for (final (h, from, to) in list) {
      final start = math.max(from, anchor.base) - anchor.base;
      final end = math.min(to, anchor.base + anchor.length) - anchor.base;
      if (end <= start) continue;
      out.add(HighlightPaint(
        id: h.id,
        start: start,
        end: end,
        color: h.colorKey,
        noted: h.noteText != null,
        active: h.id == _active,
      ));
    }
    return out;
  }

  /// The passage selected now, from the texts on screen; null when the
  /// selection holds no article text.
  ArticleSpan? selection() {
    (int, int)? start, end;
    int compare((int, int) a, (int, int) b) => a.$1 != b.$1 ? a.$1 - b.$1 : a.$2 - b.$2;
    for (final text in _texts) {
      final anchor = text.anchor;
      final range = anchor == null ? null : text.selected;
      if (anchor == null || range == null) continue;
      final a = (anchor.block, anchor.base + range.start);
      final b = (anchor.block, anchor.base + range.end);
      if (start == null || compare(a, start) < 0) start = a;
      if (end == null || compare(b, end) > 0) end = b;
    }
    if (start == null || end == null) return null;
    return normalizeSpan(ArticleSpan(start.$1, start.$2, end.$1, end.$2), model.text, model.count);
  }

  /// Highlights [span] in [color]; a note can follow with [HighlightRepository.setNote].
  Future<Highlight> create(ArticleSpan span, HighlightColor color) {
    final locator = describeSpan(
      span,
      model.text,
      model.count,
      articleId: articleId,
      href: href,
      title: model.sectionTitle(span.startBlock),
    );
    return repo.create(
      bookId: ArticleAnchors.bookIdFor(articleId),
      sha256: ArticleAnchors.sha256,
      origin: origin(),
      locator: locator.toJson(),
      text: locator.highlight ?? spanText(span, model.text),
      color: color.name,
    );
  }

  void tapped(String id) => onTap?.call(id);

  /// Marks a highlight for a moment, after a jump to it.
  void flash(String id) {
    _activeTimer?.cancel();
    _active = id;
    notifyListeners();
    _activeTimer = Timer(const Duration(milliseconds: 1600), () {
      _active = null;
      if (!_disposed) notifyListeners();
    });
  }

  /// The text on screen holding [offset] of [block], if it is built.
  HighlightableText? textAt(int block, int offset) {
    HighlightableText? found;
    for (final text in _texts) {
      final a = text.anchor;
      if (a == null || a.length == 0 || a.block != block || offset < a.base || offset > a.base + a.length) continue;
      if (found == null || offset < a.base + a.length) found = text;
    }
    return found;
  }

  @override
  void dispose() {
    _disposed = true;
    _activeTimer?.cancel();
    repo.removeListener(_resolve);
    super.dispose();
  }
}
