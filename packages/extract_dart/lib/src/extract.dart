/// The extraction pipeline (`extract.ts`): metadata, title, body, blocks and
/// the tidy-up that turns them into an [Article].
library;

import 'dart:math' as math;

import 'package:html/parser.dart' as html_parser;

import 'blocks.dart';
import 'content.dart';
import 'dom.dart';
import 'js.dart';
import 'metadata.dart';
import 'model.dart';
import 'text.dart';
import 'tree.dart';
import 'url.dart';

/// Extracts the readable article from raw HTML fetched from [url] (after
/// redirects). Parses with package:html, then runs the same pipeline as the
/// TypeScript engine. Returns null when the page has no readable article.
Article? extractArticle(String html, Uri url) => extractHtml(html, url.toString());

/// [extractArticle] with the page URL as a string, exactly as given.
Article? extractHtml(String html, String url) => extractTree(fromDocument(html_parser.parse(html)), url);

/// Platform-independent part of the pipeline: everything after the DOM is
/// copied into a [VDocument]. Mutates [doc].
Article? extractTree(VDocument doc, String url) {
  final pageUrl = url;
  final base = doc.baseHref != null ? resolveUrl(doc.baseHref!, pageUrl) ?? pageUrl : pageUrl;
  final meta = readMetadata(doc, pageUrl);
  final title = _chooseTitle(meta, doc.body, pageUrl);
  final roots = findContent(doc.body, meta.articleBody);

  var blocks = Converter(base).convert(roots);
  blocks = _tidy(blocks, title, meta);

  final bodyText = blocksText(blocks);
  final articleBody = meta.articleBody;
  if (articleBody != null && articleBody.length > 500 && bodyText.length < articleBody.length * 0.3) {
    blocks = _paragraphsFrom(articleBody);
  }
  if (blocks.isEmpty) return null;
  if (blocksText(blocks).length < 50 &&
      !blocks.any((b) => b is FigureBlock || b is VideoBlock || b is CodeBlock || b is EmbedBlock)) {
    return null;
  }

  _addLeadImage(blocks, meta.leadImage);

  final text = blocksText(blocks);
  final wordCount = countWords(text);
  return Article(
    url: meta.url,
    title: title,
    subtitle: meta.subtitle != null && meta.subtitle != title ? meta.subtitle : null,
    byline: meta.authors.isNotEmpty ? meta.authors.join(', ') : null,
    authors: meta.authors,
    siteName: meta.siteName,
    publishedAt: meta.publishedAt,
    modifiedAt: meta.modifiedAt,
    language: meta.language,
    dir: meta.dir ?? _detectDirection(text),
    excerpt: _excerptOf(meta.excerpt, blocks),
    leadImage: meta.leadImage,
    favicon: meta.favicon,
    wordCount: wordCount,
    readingMinutes: math.max(1, (wordCount / 230).ceil()),
    blocks: blocks,
  );
}

// ------------------------------------------------------------------ title

final _separators = RegExp(r'\s+[|\-–—·•»:]{1,2}\s+|\s+\/\s+|\s+::\s+');
final _tld = RegExp(r'\.[a-z]+$');

/// `value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()`.
String _comparable(String value) => lettersAndNumbers(jsLower(value)).join(' ');

/// Removes the site name a <title> carries at either end ("Story | Site", "Site - Story").
String cleanTitle(String raw, String? siteName, String host) {
  final title = collapse(raw);
  final parts = jsSplit(title, _separators);
  if (parts.length < 2) return title;
  final site = siteName == null ? '' : _comparable(siteName);
  final hostWords = _comparable(host.replaceFirst(_tld, ''));
  bool isSite(String part) {
    final c = _comparable(part);
    return c.isNotEmpty &&
        (c == site ||
            c == hostWords ||
            c.replaceAll(' ', '') == hostWords.replaceAll(' ', '') ||
            (site.isNotEmpty && site.contains(c) && c.length > 3) ||
            (site.isNotEmpty && c.contains(site) && c.length < site.length + 12));
  }

  var start = 0;
  var end = parts.length;
  if (isSite(parts[end - 1])) end--;
  if (end - start > 1 && isSite(parts[0])) start++;
  if (start == 0 && end == parts.length) return title;
  // Rebuild from the original string so inner separators survive.
  final first = parts[start];
  final last = parts[end - 1];
  final from = title.indexOf(first);
  final to = title.lastIndexOf(last) + last.length;
  final cleaned = from >= 0 && to > from ? jsTrim(title.substring(from, to)) : title;
  return cleaned.length >= 3 ? cleaned : title;
}

final _permalinkText = RegExp(r'^[#¶§🔗]$');
final _trailingPermalink = RegExp(r'\s*[#¶§]$');

/// Heading text without permalink anchors (`¶`, `#`).
String _headingText(VElement el) {
  final out = StringBuffer();
  void visit(VElement node) {
    for (final child in node.children) {
      if (child is VText) {
        out.write(child.text);
      } else if (!((child as VElement).tag == 'a' && _permalinkText.hasMatch(collapse(textOf(child))))) {
        visit(child);
      }
    }
  }

  visit(el);
  return collapse(out.toString()).replaceFirst(_trailingPermalink, '');
}

String _chooseTitle(Metadata meta, VElement body, String pageUrl) {
  final host = hostOf(pageUrl);
  final cleaned = meta.rawTitles.map((t) => cleanTitle(t, meta.siteName, host)).where((t) => t.isNotEmpty).toList();
  final headings = <String>[];
  final h1s = <String>[];
  walk(body, (el) {
    if (headings.length >= 8) return false;
    if (el.tag == 'h1' || el.tag == 'h2') {
      final t = _headingText(el);
      if (t.isNotEmpty && t.length <= 300 && (t.length >= 3 || el.tag == 'h1')) {
        headings.add(t);
        if (el.tag == 'h1') h1s.add(t);
      }
      return false;
    }
    return true;
  });
  // The visible heading that matches the page's declared title is the title as written.
  for (final candidate in cleaned) {
    final c = _comparable(candidate);
    if (c.isEmpty) continue;
    for (final h in headings) {
      final hc = _comparable(h);
      if (hc == c) return h;
    }
  }
  for (final candidate in cleaned) {
    final c = _comparable(candidate);
    if (c.length < 10) continue;
    for (final h in headings) {
      final hc = _comparable(h);
      if (hc.length >= 10 &&
          (c.contains(hc) && hc.length > c.length * 0.6 || hc.contains(c) && c.length > hc.length * 0.6)) {
        return h;
      }
    }
  }
  // A heading equal to one segment of "Story - Section - Site".
  for (final raw in meta.rawTitles) {
    final segments = jsSplit(collapse(raw), _separators).map(_comparable).toList();
    if (segments.length < 2) continue;
    // The last segment is the site in "Story - Site" titles; never match it.
    for (var i = 0; i < segments.length - 1; i++) {
      if (segments[i].isEmpty) continue;
      // Short (often CJK) titles only match the page's h1.
      for (final h in segments[i].length < 3 ? h1s : headings) {
        if (_comparable(h) == segments[i]) return h;
      }
    }
  }
  // Rewritten headlines ("Trump says..." vs "Donald Trump says a..."): the visible
  // heading that shares most of its words with the declared title.
  String? best;
  var bestOverlap = 0.6;
  for (final candidate in cleaned) {
    final words = jsSplit(_comparable(candidate), ' ').toSet();
    if (words.length < 3) continue;
    for (final h in headings) {
      final hw = jsSplit(_comparable(h), ' ');
      if (hw.length < 3) continue;
      var shared = 0;
      for (final w in hw) {
        if (words.contains(w)) shared++;
      }
      final overlap = shared / math.max(hw.length, words.length);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = h;
      }
    }
  }
  if (best != null) return best;
  if (cleaned.isNotEmpty) return cleaned[0];
  if (headings.isNotEmpty) return headings[0];
  return host;
}

// ------------------------------------------------------------------ tidy

String _blockPlain(Block block) => switch (block) {
  HeadingBlock(:final content) || ParagraphBlock(:final content) => inlineText(content),
  _ => '',
};

final _dateLine = RegExp(
  r'^(?:(?:published|updated|posted|last updated|modified)\s*:?\s*)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})(?:,?\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?(?:\s+[a-z]{2,4})?)?$',
  caseSensitive: false,
);

final _dateWords = RegExp(
  r'\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|updated|published|posted|last|modified|on|at|am|pm|a\.m|p\.m|[a-z]?[ecmp][sd]t|gmt|utc|bst|cet|cest|ist|aest|jst|hours?|minutes?|days?|ago|original|of)\b',
);
final _digit = RegExp(r'\d');
final _dateFiller = RegExp(r'[\d\s.,:;|/·•@\-–—()]+');

/// A line made only of dates, times and words like "Updated".
bool _isDateLine(String lower) {
  if (lower.length > 100 || !_digit.hasMatch(lower)) return false;
  return lower.replaceAll(_dateWords, '').replaceAll(_dateFiller, '').length < 3;
}

final _numberish = RegExp(r'^[\d\s.,/#|·•]{1,6}$');
final _byPrefix = RegExp(r'^by\s+\S', caseSensitive: false);
final _updatedLabel = RegExp(r'^(?:last updated|updated|published|posted)(?: on)?:?$', caseSensitive: false);

List<Block> _tidy(List<Block> input, String title, Metadata meta) {
  var blocks = input
      .where((b) => !(b is ParagraphBlock && (b.content.isEmpty || _numberish.hasMatch(inlineText(b.content)))))
      .toList();

  // The title (and a repeated subtitle) are drawn by the renderer, not the body.
  final t = _comparable(title);
  for (var i = 0; i < math.min(blocks.length, 4); i++) {
    final b = blocks[i];
    if (b is! HeadingBlock && b is! ParagraphBlock) continue;
    final c = _comparable(_blockPlain(b));
    if (c.isNotEmpty &&
        (c == t ||
            b is HeadingBlock && t.length > 10 && (c.contains(t) || t.contains(c) && c.length > t.length * 0.75))) {
      blocks.removeAt(i);
      break;
    }
  }
  // Title set as an image (old sites): a lone inline image whose alt text is the title.
  for (var i = 0; i < math.min(blocks.length, 3); i++) {
    final b = blocks[i];
    if (b is ParagraphBlock && b.content.length == 1) {
      final only = b.content[0];
      if (only is InlineImage && _comparable(only.alt) == t && t.isNotEmpty) {
        blocks.removeAt(i);
        break;
      }
    }
  }
  final subtitle = meta.subtitle;
  if (subtitle != null &&
      blocks.isNotEmpty &&
      blocks[0] is ParagraphBlock &&
      _comparable(_blockPlain(blocks[0])) == _comparable(subtitle)) {
    blocks.removeAt(0);
  }

  // Bylines and bare dates at the top repeat the header.
  final authors = meta.authors.map(jsLower).toList();
  for (var i = 0; i < math.min(blocks.length, 5); i++) {
    final b = blocks[i];
    if (b is! ParagraphBlock) continue;
    final text = collapse(_blockPlain(b));
    if (text.isEmpty || text.length > 120) continue;
    final lower = jsLower(text);
    final isByline =
        _byPrefix.hasMatch(text) && text.length < 100 ||
        authors.isNotEmpty && authors.any((a) => lower == a || lower == 'by $a');
    if (isByline || _dateLine.hasMatch(text) || _isDateLine(lower)) {
      blocks.removeAt(i);
      i--;
    }
  }

  // "Read more:" promos and link-only lines are navigation, not text.
  blocks = blocks.where((b) => !(b is ParagraphBlock && _isPromo(b.content))).toList();
  // Contact lines, link lists and promo headings trailing the story.
  while (blocks.length > 1) {
    final last = blocks[blocks.length - 1];
    final lastText = last is ParagraphBlock ? collapse(inlineText(last.content)) : '';
    if (last is ParagraphBlock &&
        (_isContactLine(lastText) || _isDateLine(jsLower(lastText)) || _updatedLabel.hasMatch(lastText))) {
      blocks.removeLast();
    } else if (last is ListBlock &&
        last.items.every((item) {
          if (item.blocks.length != 1) return false;
          final only = item.blocks[0];
          return only is ParagraphBlock && _linkShare(only.content) > 0.8;
        })) {
      blocks.removeLast();
    } else if (last is HeadingBlock) {
      blocks.removeLast();
    } else {
      break;
    }
  }

  // Heading levels start at 2 under the title, keeping their relative depth.
  var min = 7;
  for (final b in blocks) {
    if (b is HeadingBlock && b.level < min) min = b.level;
  }
  if (min < 7 && min != 2) {
    for (final b in blocks) {
      if (b is HeadingBlock) b.level = math.max(2, math.min(6, b.level - min + 2));
    }
  }

  // No empty structure, no rules at the edges or back to back, notes merged.
  final out = <Block>[];
  for (final b in blocks) {
    final prev = out.isEmpty ? null : out.last;
    if (b is RuleBlock && (prev == null || prev is RuleBlock || prev is HeadingBlock)) continue;
    if (b is FootnotesBlock && prev is FootnotesBlock) {
      prev.items.addAll(b.items);
      continue;
    }
    if (b is HeadingBlock &&
        prev is HeadingBlock &&
        prev.level == b.level &&
        inlineText(prev.content) == inlineText(b.content)) {
      continue;
    }
    out.add(b);
  }
  while (out.isNotEmpty && (out.last is RuleBlock || out.last is HeadingBlock)) {
    out.removeLast();
  }
  return out;
}

double _linkShare(List<Inline> content) {
  var all = 0;
  var linked = 0;
  for (final n in content) {
    if (n is! TextRun) continue;
    final len = jsTrim(n.text).length;
    all += len;
    if (n.href != null) linked += len;
  }
  return all == 0 ? 0 : linked / all;
}

final _promo = RegExp(
  r"^(?:see more|read more|read also|also read|related|more|don'?t miss|watch|watch now|recommended|must read|trending|click here|related articles?|related stories|related coverage|more on this|more from|listen|subscribe|sign up|follow us|read next|up next|next)\s*[:|>»\-–—]",
  caseSensitive: false,
);
final _promoLine = RegExp(
  r"^(?:don'?t miss|read more|related|see also|recommended|more stories|more great .* stories|trending|most popular|you may also like|advertisement|share this( article)?)$",
  caseSensitive: false,
);

bool _isPromo(List<Inline> content) {
  final text = collapse(inlineText(content));
  if (text.isEmpty) return false;
  final share = _linkShare(content);
  if (_promo.hasMatch(text) && (share > 0.4 || text.length < 120)) return true;
  if (_promoLine.hasMatch(text)) return true;
  // A short line that is entirely a link to another page, or a stack of them.
  if (share >= 0.9 && (text.length < 160 || content.any((n) => n is LineBreak))) return true;
  return false;
}

final _email = RegExp(r'^[\w.+-]+@[\w-]+\.[\w.-]+$');
final _socialUrl = RegExp(
  r'^(?:https?:\/\/)?(?:www\.)?(?:twitter|x|facebook|instagram|linkedin|threads|bsky)\.(?:com|app|net)\/\S+$',
  caseSensitive: false,
);
final _handle = RegExp(r'^@\w{2,30}$');
final _followLine = RegExp(r'^(?:follow|contact|email|reach)\b.{0,80}(?:@|twitter|on x\b)', caseSensitive: false);

bool _isContactLine(String text) {
  if (text.length > 120) return false;
  return _email.hasMatch(text) || _socialUrl.hasMatch(text) || _handle.hasMatch(text) || _followLine.hasMatch(text);
}

final _paragraphBreak = RegExp(r'\n\s*\n|\r?\n');
final _sentence = RegExp(r'''[^.!?。！？]+[.!?。！？]+["'”’)]*\s*|[^.!?。！？]+$''');

List<Block> _paragraphsFrom(String text) {
  var parts = jsSplit(text, _paragraphBreak).map(collapse).where((p) => p.isNotEmpty).toList();
  if (parts.length == 1 && parts[0].length > 1500) {
    final matches = _sentence.allMatches(parts[0]).map((m) => m[0]!).toList();
    final sentences = matches.isEmpty ? [parts[0]] : matches;
    parts = [];
    var current = StringBuffer();
    for (final s in sentences) {
      current.write(s);
      if (current.length > 600) {
        parts.add(jsTrim(current.toString()));
        current = StringBuffer();
      }
    }
    final rest = jsTrim(current.toString());
    if (rest.isNotEmpty) parts.add(rest);
  }
  return [
    for (final p in parts) ParagraphBlock([TextRun(p)]),
  ];
}

final _imageKey = RegExp(
  r'\/([^/?#]+?)(?:[-_]\d+x\d+|[-_](?:large|medium|small|thumb|scaled|\d{2,4}w?))?\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])',
  caseSensitive: false,
);

String _keyOf(String src) {
  final m = _imageKey.firstMatch(src);
  return jsLower(m == null ? src : m[1]!);
}

final _placeholderImage = RegExp(
  r'(?:logo|default|placeholder|share|social|og-image|opengraph|fallback|favicon|icon|avatar|banner-default)[\w.-]*\.(?:jpe?g|png|webp|gif|svg)',
  caseSensitive: false,
);
final _svg = RegExp(r'\.svg(?:$|\?)', caseSensitive: false);

/// Shows the page's lead image above the text when the body itself opens without one.
void _addLeadImage(List<Block> blocks, ArticleImage? lead) {
  if (lead == null) return;
  if (_placeholderImage.hasMatch(lead.src) || _svg.hasMatch(lead.src)) return;
  final width = lead.width;
  if (width != null && width < 400) return;
  final key = _keyOf(lead.src);
  for (final b in blocks) {
    if (b is FigureBlock && b.images.any((i) => i.src == lead.src || _keyOf(i.src) == key)) return;
  }
  for (var i = 0; i < math.min(blocks.length, 3); i++) {
    final b = blocks[i];
    if (b is FigureBlock || b is VideoBlock) return;
  }
  final image = ArticleImage(src: lead.src, alt: lead.alt);
  if (lead.width != null && lead.height != null) {
    image.width = lead.width;
    image.height = lead.height;
  }
  blocks.insert(0, FigureBlock(images: [image]));
}

// ------------------------------------------------------------------ details

final _lastWord = RegExp(r'\s+\S*$');

String? _excerptOf(String? description, List<Block> blocks) {
  if (description != null && description.length >= 20) {
    return description.length > 400 ? '${description.substring(0, 397).replaceFirst(_lastWord, '')}…' : description;
  }
  for (final b in blocks) {
    if (b is! ParagraphBlock) continue;
    final raw = StringBuffer();
    for (final n in b.content) {
      raw.write(switch (n) {
        TextRun(:final text) => text,
        InlineMath(:final text) => text,
        LineBreak() => ' ',
        _ => '',
      });
    }
    final text = collapse(raw.toString());
    if (text.length < 40) continue;
    return text.length > 300 ? '${text.substring(0, 297).replaceFirst(_lastWord, '')}…' : text;
  }
  return description;
}

ArticleDirection _detectDirection(String text) {
  final sample = text.length > 3000 ? text.substring(0, 3000) : text;
  var rtl = 0;
  var ltr = 0;
  for (var i = 0; i < sample.length; i++) {
    final c = sample.codeUnitAt(i);
    if ((c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff)) {
      rtl++;
    } else if ((c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0xc0 && c <= 0x24f) ||
        (c >= 0x370 && c <= 0x52f) ||
        (c >= 0x3040 && c <= 0x9fff)) {
      ltr++;
    }
  }
  return rtl > ltr ? ArticleDirection.rtl : ArticleDirection.ltr;
}
