import 'dart:math' as math;

/// Highlights in saved articles, as the web app writes them
/// (apps/web/src/lib/articleAnchors.ts; docs/cloud-sync.md, "Article
/// highlights"). They are ordinary highlights pinned to the article instead
/// of an EPUB edition: `bookId` is `article-<article id>` and `sha256` 64
/// zeros, so no book ever lists them.
///
/// A passage is anchored to the article's top-level blocks: the first and
/// last block and UTF-16 offsets into each block's text, plus the quote with
/// some context in the Readium `text` shape. Block texts differ a little
/// between apps (what counts as reader chrome), so a client trusts the
/// offsets only while the text there is still the quote, and otherwise finds
/// the quote near where it was. Everything here works on block texts.
abstract final class ArticleAnchors {
  /// The edition every article highlight uses; the article is in `bookId`.
  static final String sha256 = '0' * 64;

  static final _bookId = RegExp(r'^article-([a-f0-9]{32})$');

  /// Characters of context kept on each side of the quote.
  static const context = 32;

  /// Blocks searched on each side of the recorded ones before the whole article.
  static const near = 6;

  /// Joins block texts in quotes and searches.
  static const separator = '\n';

  static const maxQuote = 4000;

  static String bookIdFor(String articleId) => 'article-$articleId';

  /// The article a synced highlight belongs to, or null for a book highlight.
  static String? articleIdOf({required String bookId, required String sha256}) {
    if (sha256 != ArticleAnchors.sha256) return null;
    return _bookId.firstMatch(bookId)?.group(1);
  }
}

/// Text of one top-level block as the reader draws it, or null when the
/// block has no text (an image, a rule).
typedef BlockText = String? Function(int index);

/// A passage: from [start] in block [startBlock] to [end] in block [endBlock].
class ArticleSpan {
  const ArticleSpan(this.startBlock, this.start, this.endBlock, this.end);

  final int startBlock;
  final int start;
  final int endBlock;
  final int end;

  @override
  bool operator ==(Object other) =>
      other is ArticleSpan &&
      other.startBlock == startBlock &&
      other.start == start &&
      other.endBlock == endBlock &&
      other.end == end;

  @override
  int get hashCode => Object.hash(startBlock, start, endBlock, end);

  @override
  String toString() => 'ArticleSpan($startBlock:$start–$endBlock:$end)';
}

/// The synced locator of an article highlight.
class ArticleLocator {
  const ArticleLocator({
    required this.href,
    required this.articleId,
    required this.block,
    required this.start,
    required this.endBlock,
    required this.end,
    this.title,
    required this.progression,
    this.before,
    this.highlight,
    this.after,
  });

  /// The article's URL; the API requires a non-empty `href`.
  final String href;
  final String articleId;
  final int block;
  final int start;
  final int endBlock;
  final int end;

  /// The section heading above the passage, for lists.
  final String? title;

  /// Share of the article before the passage, for ordering.
  final double progression;
  final String? before;
  final String? highlight;
  final String? after;

  /// Reads a stored locator; null when it is not a usable article locator.
  static ArticleLocator? parse(Map<String, dynamic> raw) {
    if (raw['type'] != 'article' || raw['href'] is! String || raw['articleId'] is! String) return null;
    bool isInt(Object? v) => v is int && v >= 0;
    final block = raw['block'], start = raw['start'], end = raw['end'];
    final endBlock = raw['endBlock'] ?? block;
    if (!isInt(block) || !isInt(start) || !isInt(endBlock) || !isInt(end) || (endBlock as int) < (block as int)) {
      return null;
    }
    final loc = raw['locations'];
    final total = loc is Map ? loc['totalProgression'] : null;
    final text = raw['text'];
    String? str(Object? v) => v is String ? v : null;
    return ArticleLocator(
      href: raw['href'] as String,
      articleId: raw['articleId'] as String,
      block: block,
      start: start as int,
      endBlock: endBlock,
      end: end as int,
      title: str(raw['title']),
      progression: total is num ? total.toDouble() : 0,
      before: text is Map ? str(text['before']) : null,
      highlight: text is Map ? str(text['highlight']) : null,
      after: text is Map ? str(text['after']) : null,
    );
  }

  Map<String, dynamic> toJson() => {
    'type': 'article',
    'href': href,
    'articleId': articleId,
    'block': block,
    'start': start,
    'endBlock': endBlock,
    'end': end,
    if (title != null) 'title': title,
    'locations': {'progression': progression, 'totalProgression': progression},
    'text': {'before': ?before, 'highlight': ?highlight, 'after': ?after},
  };

  ArticleSpan get span => ArticleSpan(block, start, endBlock, end);
}

/// Moves a span's ends off blocks without text and off block edges (a
/// selection that starts at the very end of one block starts in the next),
/// so equal passages always get equal spans. Null when nothing is left.
ArticleSpan? normalizeSpan(ArticleSpan span, BlockText text, int count) {
  var ArticleSpan(:startBlock, :start, :endBlock, :end) = span;
  for (;;) {
    final t = startBlock < count ? text(startBlock) : null;
    if (t != null && t.isNotEmpty && start < t.length) break;
    if (++startBlock >= count) return null;
    start = 0;
  }
  if (endBlock >= count) {
    endBlock = count - 1;
    end = text(endBlock)?.length ?? 0;
  }
  for (;;) {
    final t = text(endBlock);
    if (t != null && t.isNotEmpty && end > 0) {
      end = math.min(end, t.length);
      break;
    }
    if (--endBlock < 0) return null;
    end = text(endBlock)?.length ?? 0;
  }
  if (endBlock < startBlock || (endBlock == startBlock && end <= start)) return null;
  return ArticleSpan(startBlock, start, endBlock, end);
}

/// The passage's text, blocks joined by a line break.
String spanText(ArticleSpan span, BlockText text) {
  String slice(String? t, int from, [int? to]) {
    final s = t ?? '';
    final a = from.clamp(0, s.length);
    return s.substring(a, (to ?? s.length).clamp(a, s.length));
  }

  if (span.startBlock == span.endBlock) return slice(text(span.startBlock), span.start, span.end);
  final parts = <String>[slice(text(span.startBlock), span.start)];
  for (var i = span.startBlock + 1; i < span.endBlock; i++) {
    final t = text(i);
    if (t != null && t.isNotEmpty) parts.add(t);
  }
  parts.add(slice(text(span.endBlock), 0, span.end));
  return parts.join(ArticleAnchors.separator);
}

/// Up to [n] characters before a point, reaching into earlier blocks.
String _before(int block, int offset, BlockText text, int n) {
  final own = text(block) ?? '';
  final to = offset.clamp(0, own.length);
  var out = own.substring(math.min(math.max(0, offset - n), to), to);
  for (var i = block - 1; i >= 0 && out.length < n; i--) {
    final t = text(i);
    if (t != null && t.isNotEmpty) {
      out = t.substring(math.max(0, t.length - (n - out.length - 1))) + ArticleAnchors.separator + out;
    }
  }
  return out.length > n ? out.substring(out.length - n) : out;
}

/// Up to [n] characters after a point, reaching into later blocks.
String _after(int block, int offset, BlockText text, int count, int n) {
  final own = text(block) ?? '';
  final from = offset.clamp(0, own.length);
  var out = own.substring(from, math.min(own.length, from + n));
  for (var i = block + 1; i < count && out.length < n; i++) {
    final t = text(i);
    if (t != null && t.isNotEmpty) {
      out = out + ArticleAnchors.separator + t.substring(0, math.max(0, math.min(t.length, n - out.length - 1)));
    }
  }
  return out.length > n ? out.substring(0, n) : out;
}

/// The locator for a normalized span: offsets, the quote (at most
/// [maxQuote] characters; a longer passage is cut to that length first)
/// with context, and its share of the article for ordering.
ArticleLocator describeSpan(
  ArticleSpan span,
  BlockText text,
  int count, {
  required String articleId,
  required String href,
  String? title,
  int maxQuote = ArticleAnchors.maxQuote,
}) {
  var s = span;
  var quote = spanText(s, text);
  if (quote.length > maxQuote) {
    s = _endAfter(s, maxQuote, text);
    quote = spanText(s, text);
  }
  final len = text(s.startBlock)?.length ?? 1;
  final progression = ((s.startBlock + s.start / math.max(1, len)) / math.max(1, count)).clamp(0.0, 1.0);
  return ArticleLocator(
    href: href,
    articleId: articleId,
    block: s.startBlock,
    start: s.start,
    endBlock: s.endBlock,
    end: s.end,
    title: title == null || title.isEmpty ? null : title,
    progression: progression,
    before: _before(s.startBlock, s.start, text, ArticleAnchors.context),
    highlight: quote,
    after: _after(s.endBlock, s.end, text, count, ArticleAnchors.context),
  );
}

/// The span cut to its first [length] quote characters.
ArticleSpan _endAfter(ArticleSpan span, int length, BlockText text) {
  var left = length;
  var block = span.startBlock;
  var from = span.start;
  for (;;) {
    final t = text(block) ?? '';
    final stop = block == span.endBlock ? span.end : t.length;
    if (t.isNotEmpty && stop - from >= left) return ArticleSpan(span.startBlock, span.start, block, from + left);
    if (t.isNotEmpty) left -= stop - from + ArticleAnchors.separator.length;
    if (left <= 0 || block >= span.endBlock) return ArticleSpan(span.startBlock, span.start, block, stop);
    block++;
    from = 0;
  }
}

int _suffixMatch(String a, String b) {
  var n = 0;
  while (n < a.length && n < b.length && a.codeUnitAt(a.length - 1 - n) == b.codeUnitAt(b.length - 1 - n)) {
    n++;
  }
  return n;
}

int _prefixMatch(String a, String b) {
  var n = 0;
  while (n < a.length && n < b.length && a.codeUnitAt(n) == b.codeUnitAt(n)) {
    n++;
  }
  return n;
}

typedef _Segment = ({int block, int at, int length});

/// The best occurrence of the quote among blocks [from]..[to]: the one whose
/// context matches most, then the nearest to where it was. With [strict], an
/// occurrence only counts when its context agrees or it is the only one.
ArticleSpan? _search(ArticleLocator loc, String quote, int from, int to, BlockText text, bool strict) {
  final segments = <_Segment>[];
  final all = StringBuffer();
  for (var i = from; i <= to; i++) {
    final t = text(i);
    if (t == null || t.isEmpty) continue;
    if (segments.isNotEmpty) all.write(ArticleAnchors.separator);
    segments.add((block: i, at: all.length, length: t.length));
    all.write(t);
  }
  if (segments.isEmpty) return null;
  final joined = all.toString();
  final wantBefore = loc.before ?? '';
  final wantAfter = loc.after ?? '';
  // Where the passage was, in this string's coordinates, for the distance tiebreak.
  final home = segments.where((s) => s.block >= loc.block).firstOrNull;
  final expected = home == null ? joined.length : home.at + (home.block == loc.block ? loc.start : 0);
  ({int at, int score, int distance})? best;
  var found = 0;
  for (var at = joined.indexOf(quote); at >= 0 && found < 1000; at = joined.indexOf(quote, at + 1)) {
    found++;
    final end = at + quote.length;
    final score = _suffixMatch(joined.substring(math.max(0, at - wantBefore.length), at), wantBefore) +
        _prefixMatch(joined.substring(end, math.min(joined.length, end + wantAfter.length)), wantAfter);
    final distance = (at - expected).abs();
    if (best == null || score > best.score || (score == best.score && distance < best.distance)) {
      best = (at: at, score: score, distance: distance);
    }
  }
  if (best == null || (strict && found > 1 && best.score == 0)) return null;
  final startAt = best.at;
  final endAt = best.at + quote.length;
  var first = segments.first, last = segments.first;
  for (final s in segments) {
    if (s.at <= startAt) first = s;
    if (s.at < endAt) last = s;
  }
  return ArticleSpan(first.block, startAt - first.at, last.block, math.min(last.length, endAt - last.at));
}

/// Finds a stored passage in the article as drawn now: by its offsets when
/// the text there is still the quote, else by searching for the quote near
/// the recorded blocks, then anywhere in the article. Null when it is gone
/// (the highlight is kept, just not drawn).
ArticleSpan? resolveLocator(ArticleLocator loc, BlockText text, int count) {
  final quote = loc.highlight ?? '';
  final recorded = loc.span;
  final startText = loc.block < count ? text(loc.block) : null;
  final endText = loc.endBlock < count ? text(loc.endBlock) : null;
  final inRange = startText != null &&
      startText.isNotEmpty &&
      endText != null &&
      endText.isNotEmpty &&
      loc.start < startText.length &&
      loc.end <= endText.length;
  if (inRange && (quote.isEmpty || spanText(recorded, text) == quote)) return normalizeSpan(recorded, text, count);
  if (quote.isEmpty || count == 0) return null;
  final near = _search(
    loc,
    quote,
    math.max(0, loc.block - ArticleAnchors.near),
    math.min(count - 1, loc.endBlock + ArticleAnchors.near),
    text,
    false,
  );
  if (near != null) return normalizeSpan(near, text, count);
  final anywhere = _search(loc, quote, 0, count - 1, text, true);
  return anywhere == null ? null : normalizeSpan(anywhere, text, count);
}
