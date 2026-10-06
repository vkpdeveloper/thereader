/// The extraction pipeline (`extract.ts`): metadata, title, body, blocks and
/// the tidy-up that turns them into an [Article].
library;

import 'dart:math' as math;

import 'package:html/parser.dart' as html_parser;

import 'blocks.dart';
import 'content.dart';
import 'dom.dart';
import 'js.dart';
import 'match.dart';
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
  var title = _chooseTitle(meta, doc.body, pageUrl);
  final titleMatched = title != _titleFallback(meta, pageUrl);
  final roots = findContent(doc.body, meta.articleBody);

  var blocks = Converter(base).convert(roots);
  if (!titleMatched) title = _sectionTitle(blocks, title);
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
  // The TypeScript engine reorders block keys to model.ts field order here
  // (`canonical`); the Dart model always writes them in that order.

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

final _permalinkText = RegExp(r'^[#¶§🔗]$', unicode: true);
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

int _countH1(VElement body) {
  var n = 0;
  walk(body, (el) {
    if (el.tag == 'h1') {
      n++;
      return false;
    }
    return true;
  });
  return n;
}

/// What [_chooseTitle] falls back to when no heading on the page matches the declared title.
String _titleFallback(Metadata meta, String pageUrl) {
  final host = hostOf(pageUrl);
  for (final t in meta.rawTitles) {
    final cleaned = cleanTitle(t, meta.siteName, host);
    if (cleaned.isNotEmpty) return cleaned;
  }
  return '';
}

/// A <title> that only names the site or document ("HTML Standard") over a
/// page that opens with its own top-level heading sharing a word with it
/// ("13.2 Parsing HTML documents"): that heading is this page's title.
String _sectionTitle(List<Block> blocks, String title) {
  if (blocks.isEmpty) return title;
  final first = blocks[0];
  if (first is! HeadingBlock) return title;
  for (final b in blocks) {
    if (b is HeadingBlock && b.level < first.level) return title;
  }
  final words = jsSplit(_comparable(title), ' ');
  if (words.length > 3) return title;
  final heading = collapse(inlineText(first.content));
  final hw = jsSplit(_comparable(heading), ' ');
  return words.any((w) => w.length > 2 && hw.contains(w)) ? heading : title;
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
  // Headings that are the site part of "Story - Site" (a docs menu-bar h1) never stand for the story.
  final siteParts = <String>{};
  for (final raw in meta.rawTitles) {
    final segments = jsSplit(collapse(raw), _separators).map(_comparable).toList();
    if (segments.length < 2) continue;
    siteParts.add(segments[segments.length - 1]);
    siteParts.add(segments[0]);
  }
  for (final candidate in cleaned) {
    final c = _comparable(candidate);
    if (c.length < 10) continue;
    for (final h in headings) {
      final hc = _comparable(h);
      if (siteParts.contains(hc) && hc != c) continue;
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
  // An SEO <title> that shares nothing with the page: its one h1 is the headline as published.
  if (h1s.length == 1 && cleaned.isNotEmpty) {
    final hc = _comparable(h1s[0]);
    final site = meta.siteName != null ? _comparable(meta.siteName!) : '';
    if (!siteParts.contains(hc) && hc != site && (hc.indexOf(' ') > 0 || hc.length >= 8) && _countH1(body) == 1) {
      return h1s[0];
    }
  }
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

/// "By Jane Doe", "By JANE DOE and Li Wei | Reuters": names after "By", not a sentence ("By seven the light had gone.").
final _bylineLine = RegExp(
  r"^(?:[Bb]y|BY)\s+(?:(?:\p{Lu}[\p{L}'’.-]*|de|da|van|von|der|le|la|bin|al)\s*){1,5}(?:(?:,|and|&)\s*(?:(?:\p{Lu}[\p{L}'’.-]*|de|da|van|von|der|le|la|bin|al)\s*){1,5})*(?:[|·•—–-].*)?$",
  unicode: true,
);

final _numberish = RegExp(r'^[\d\s.,/#|·•]{1,6}$');
final _ruleLine = RegExp(r'^[\s_*~=\-–—•·]{3,}$');

/// `/[.!?:;。！？"'”’)\]]\s*$/.test(text)`: the text ends a sentence (or a quote, or a bracket).
bool _endsSentence(String text) {
  var end = text.length;
  while (end > 0 && isJsSpace(text.codeUnitAt(end - 1))) {
    end--;
  }
  if (end == 0) return false;
  return switch (text.codeUnitAt(end - 1)) {
    0x2e || 0x21 || 0x3f || 0x3a || 0x3b || 0x3002 || 0xff01 || 0xff1f => true,
    0x22 || 0x27 || 0x201d || 0x2019 || 0x29 || 0x5d => true,
    _ => false,
  };
}

final _lowercaseStart = RegExp(r'^\s*\p{Ll}', unicode: true);
final _closingLinkLine = RegExp(r'''[.!?]["'”’)]?$''');
final _topicsLead = RegExp(
  r'^(?:explore more on (?:these|this) topics?|more on (?:this|these) (?:story|stories|topics?)|(?:related )?topics|tags|filed under)\s*:?$',
  caseSensitive: false,
);
final _updatedLabel = RegExp(r'^(?:last updated|updated|published|posted)(?: on)?:?$', caseSensitive: false);

List<Block> _tidy(List<Block> input, String title, Metadata meta) {
  var blocks = input
      .where((b) => !(b is ParagraphBlock && (b.content.isEmpty || _numberish.hasMatch(inlineText(b.content)))))
      .toList();
  // A line of underscores, dashes or asterisks is a section break.
  blocks = [
    for (final b in blocks)
      if (b is ParagraphBlock && b.content.length == 1 && _isRuleText(b.content[0])) const RuleBlock() else b,
  ];

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
    if (t.isNotEmpty &&
        (b is ParagraphBlock &&
                b.content.length == 1 &&
                b.content[0] is InlineImage &&
                _comparable((b.content[0] as InlineImage).alt) == t ||
            b is FigureBlock && b.images.length == 1 && b.caption == null && _comparable(b.images[0].alt) == t)) {
      blocks.removeAt(i);
      break;
    }
  }
  // The subtitle, or a heading that repeats the page description (a dek set as <h2>), is header too.
  final sub = meta.subtitle != null ? _comparable(meta.subtitle!) : '';
  final description = meta.excerpt != null ? _comparable(meta.excerpt!) : '';
  for (var i = 0; i < math.min(blocks.length, 3); i++) {
    final b = blocks[i];
    if (b is! ParagraphBlock && b is! HeadingBlock) continue;
    final c = _comparable(_blockPlain(b));
    if (c.isNotEmpty && (c == sub || b is HeadingBlock && c == description)) {
      blocks.removeAt(i);
      break;
    }
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
        _bylineLine.hasMatch(text) && text.length < 100 ||
        authors.isNotEmpty && authors.any((a) => lower == a || lower == 'by $a');
    if (isByline || _dateLine.hasMatch(text) || _isDateLine(lower)) {
      // The header's date line is the publication date when the page declares none.
      if (!isByline && meta.publishedAt == null) meta.publishedAt = normalizeDate(text);
      blocks.removeAt(i);
      i--;
    }
  }

  // A sentence split by a block the parser pulled out of it (a link's hover card: "started [card] in Figma four
  // years ago"): the card goes, the sentence is joined again.
  for (var i = 0; i + 2 < blocks.length; i++) {
    final first = blocks[i];
    if (first is! ParagraphBlock) continue;
    // Cheap first: only the paragraph's last run decides whether the sentence is unfinished.
    final tail = first.content.isEmpty ? null : first.content.last;
    if (tail is! TextRun || _endsSentence(tail.text)) continue;
    final head = jsTrimEnd(inlineText(first.content));
    if (head.isEmpty || _endsSentence(head)) continue;
    var j = i + 1;
    while (j < blocks.length && j - i <= 3) {
      final next = blocks[j];
      if (!(next is HeadingBlock || next is ParagraphBlock && inlineText(next.content).length < 200)) break;
      if (next is ParagraphBlock && _lowercaseStart.hasMatch(inlineText(next.content)) && j > i + 1) break;
      j++;
    }
    final last = j < blocks.length ? blocks[j] : null;
    if (j == i + 1 || j - i > 3 || last is! ParagraphBlock || !_lowercaseStart.hasMatch(inlineText(last.content))) {
      continue;
    }
    if (!blocks.sublist(i + 1, j).any((b) => b is HeadingBlock)) continue;
    first.content = normalizeInlines([...first.content, const TextRun(' '), ...last.content]);
    blocks.removeRange(i + 1, j + 1);
  }

  // Labels drawn over a diagram (f(t), ω, "Fig. a") come out as a run of tiny paragraphs after it.
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i] is! FigureBlock) continue;
    var j = i + 1;
    while (j < blocks.length && _isLegendLabel(blocks[j])) {
      j++;
    }
    if (j - i - 1 >= 3) blocks.removeRange(i + 1, j);
  }
  // A formula alone in its paragraph is set on its own line.
  blocks = [
    for (final b in blocks)
      if (b is ParagraphBlock && b.content.length == 1 && b.content[0] is InlineMath)
        _mathBlockOf(b.content[0] as InlineMath)
      else
        b,
  ];

  // Author bios ("Jane Doe is a reporter covering...") describe the writer, not the story.
  blocks = _dropBios(blocks, authors);

  // "Read more:" promos and link-only lines are navigation, not text.
  blocks = blocks.where((b) => !(b is ParagraphBlock && _isPromo(b.content))).toList();
  // Calls to action opening the story (a "buy the PDF" box).
  for (var i = 0; i < math.min(blocks.length, 3); i++) {
    if (_isCallToAction(blocks[i])) {
      blocks.removeAt(i);
      i--;
    }
  }
  // Contact lines, calls to action, link lists and promo headings trailing the story (before its notes).
  final notes = <Block>[];
  while (blocks.length > 1 && blocks.last is FootnotesBlock) {
    notes.insert(0, blocks.removeLast());
  }
  while (blocks.length > 1) {
    final last = blocks[blocks.length - 1];
    final prev = blocks[blocks.length - 2];
    final lastText = last is ParagraphBlock ? collapse(inlineText(last.content)) : '';
    if (last is ParagraphBlock &&
        (_isContactLine(lastText) || _isDateLine(jsLower(lastText)) || _updatedLabel.hasMatch(lastText))) {
      blocks.removeLast();
    } else if (last is ParagraphBlock && _topicsLead.hasMatch(lastText)) {
      // The lead of a topic-tag footer whose links are gone ("Explore more on these topics").
      blocks.removeLast();
    } else if (last is ParagraphBlock &&
        lastText.length < 100 &&
        _linkShare(last.content) >= 0.5 &&
        !_closingLinkLine.hasMatch(lastText)) {
      blocks.removeLast();
    } else if (_isCallToAction(last)) {
      blocks.removeLast();
    } else if (last is ListBlock &&
        last.items.length <= 6 &&
        _isCallToAction(prev) &&
        blocksText([for (final item in last.items) ...item.blocks]).length < 400) {
      // The short benefits list under a sign-up pitch ("You get articles that match your needs").
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
  blocks.addAll(notes);

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
    // The same paragraph or picture twice in a row is a rendering artifact (responsive copies, dek repeated).
    if (b is ParagraphBlock &&
        prev is ParagraphBlock &&
        prev.content.length == b.content.length &&
        _sameFirstText(prev.content, b.content) &&
        inlineText(b.content).length > 20 &&
        inlineText(prev.content) == inlineText(b.content)) {
      continue;
    }
    if (b is FigureBlock && prev is FigureBlock && prev.images.length == b.images.length) {
      var same = true;
      for (var k = 0; k < b.images.length; k++) {
        if (prev.images[k].src != b.images[k].src) same = false;
      }
      if (same) continue;
    }
    out.add(b);
  }
  while (out.isNotEmpty && (out.last is RuleBlock || out.last is HeadingBlock)) {
    out.removeLast();
  }
  return out;
}

bool _isRuleText(Inline only) => only is TextRun && only.text.length < 100 && _ruleLine.hasMatch(only.text);

MathBlock _mathBlockOf(InlineMath m) => MathBlock(tex: m.tex, mathml: m.mathml, text: m.text);

final _bioRole = RegExp(
  r'\b(?:reporter|writer|editor|journalist|correspondent|columnist|contributor|author|producer|critic|fellow|researcher|consultant|engineer|developer|designer|professor|director|founder|photographer|analyst|scientist|lecturer|host|freelancer?|economist|historian|novelist|blogger|speaker|principal)\b',
  caseSensitive: false,
);
final _bioName = RegExp(
  r"^(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:is|was|has been)\s+(?:a|an|the)\s",
  unicode: true,
);
final _bioOrphan = RegExp(r'^(?:is|was)\s+(?:a|an|the)\s');

/// Bios: a short paragraph naming one of the authors (or orphaned from its
/// name, "is a senior reporter...") with a job title, plus bios right next to one.
List<Block> _dropBios(List<Block> blocks, List<String> authors) {
  // Nothing goes without a certain bio (orphaned, or naming an author), and only those need checking first.
  if (!blocks.any((b) => b is ParagraphBlock && _bioKind(b, authors, certainOnly: true) == 2)) {
    assert(!blocks.any((b) => b is ParagraphBlock && _bioKind(b, authors) == 2), 'certain-bio prefilter missed one');
    return blocks;
  }
  final bio = [
    for (final b in blocks)
      if (b is! ParagraphBlock) 0 else _bioKind(b, authors),
  ];
  if (!bio.contains(2)) return blocks;
  // Unnamed bios count only next to a certain one (co-author boxes), across name lines and photos.
  bool near(int i, int step) {
    for (var j = i + step; j >= 0 && j < blocks.length; j += step) {
      if (bio[j] == 2) return true;
      final b = blocks[j];
      if (!(b is FigureBlock || b is ParagraphBlock && inlineText(b.content).length < 60)) return false;
    }
    return false;
  }

  for (var pass = 0; pass < 2; pass++) {
    for (var i = 0; i < bio.length; i++) {
      if (bio[i] == 1 && (near(i, -1) || near(i, 1))) bio[i] = 2;
    }
  }
  return [
    for (var i = 0; i < blocks.length; i++)
      if (bio[i] != 2) blocks[i],
  ];
}

/// 0: not a bio, 1: a bio of someone, 2: a bio of an author (or orphaned from its name). With
/// [certainOnly], 1 may come out as 0.
int _bioKind(ParagraphBlock b, List<String> authors, {bool certainOnly = false}) {
  if (certainOnly && !_mayOpenCertainBio(b.content, authors)) return 0;
  // `raw.slice(0, 200)` of `raw = inlineText(content)`, without building the rest of it.
  var length = 0;
  final prefix = StringBuffer();
  for (final node in b.content) {
    final part = switch (node) {
      TextRun(:final text) => text,
      LineBreak() => '\n',
      InlineImage() => '',
      InlineMath(:final text) => text,
      FootnoteRef(:final label) => label,
    };
    length += part.length;
    if (prefix.length < 200) prefix.write(part);
  }
  if (length > 900) return 0;
  // The anchored shape tests are cheap and fail fast on ordinary paragraphs; the job title is checked last.
  final raw = prefix.toString();
  final head = collapse(raw.length > 200 ? raw.substring(0, 200) : raw);
  final orphan = (head.startsWith('is') || head.startsWith('was')) && _bioOrphan.hasMatch(head);
  if (!orphan && certainOnly) {
    // A named bio is certain only when the name is an author's, and the name opens the paragraph.
    final lower = authors.isEmpty ? '' : jsLower(head);
    if (!authors.any(lower.startsWith)) return 0;
  }
  // Every named bio has "is", "was" or "has been" in it.
  final m = orphan || !head.contains('is') && !head.contains('was') && !head.contains('has been')
      ? null
      : _bioName.firstMatch(head);
  if (!orphan && m == null || !_bioRole.hasMatch(jsSlice(head, 0, 160))) return 0;
  if (orphan) return 2;
  return authors.contains(jsLower(m![1]!)) ? 2 : 1;
}

/// False when the paragraph's first visible character rules out a certain bio: an orphan opens with
/// "is" or "was", a named one with an author's name (lowercase in [authors]). Only ASCII is judged.
bool _mayOpenCertainBio(List<Inline> content, List<String> authors) {
  for (final node in content) {
    final part = switch (node) {
      TextRun(:final text) => text,
      LineBreak() => '\n',
      InlineImage() => '',
      InlineMath(:final text) => text,
      FootnoteRef(:final label) => label,
    };
    for (var i = 0; i < part.length; i++) {
      final c = part.codeUnitAt(i);
      if (isJsSpace(c)) continue;
      if (c >= 0x80 || c == 0x69 || c == 0x77) return true;
      final lower = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
      return authors.any((a) => a.isEmpty || a.codeUnitAt(0) == lower);
    }
  }
  return false;
}

bool _sameFirstText(List<Inline> a, List<Inline> b) {
  if (a.isEmpty || b.isEmpty) return false;
  final x = a[0];
  final y = b[0];
  return x.type == y.type && (x is! TextRun || x.text == (y as TextRun).text);
}

bool _isLegendLabel(Block b) {
  if (b is! ParagraphBlock) return false;
  final only = b.content.length == 1 ? b.content[0] : null;
  if (only is InlineMath) return only.text.length < 40;
  return jsTrim(inlineText(b.content)).length <= 12;
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

/// Sign-up, subscribe, app, membership and affiliate pitches, in the languages publishers use most.
final _callToAction = RegExp(
  r"\b(?:sign(?:ing)? up (?:for|to|here|now|today)|subscribe (?:to|for|now|here|today)|our (?:free |daily |weekly )?newsletter|email list|mailing list|register (?:as|for|now|today)|create (?:a |an )?(?:free )?account|download (?:the|our)|get (?:the|our) (?:\w+ )?app|follow (?:us|topics|authors|the authors)|support (?:us|our)|patreon page|on patreon|donate (?:to|now|today|here)|become a (?:member|patron|subscriber|supporter)|buy it here|we may earn (?:a )?(?:small )?commission|affiliate (?:links?|commission)|purchase through links)\b|suscr[ií]b(?:e|ete|irte)|descarga la|boletín|abonnez-vous|inscrivez-vous|téléchargez|abonnieren sie|jetzt herunterladen|assine|inscreva-se",
  caseSensitive: false,
);
final _quoted = RegExp(r'''^["“„«'‘]''');

/// A short pitch to sign up, subscribe, download, follow or support (a paragraph, a list of them, or a box).
/// Lowercase words, one of which every match of [_callToAction] contains: a text holding none cannot
/// match. One pass over the text, by first character.
final _callToActionWords = ClassPattern(
  'sign up |signing up |subscribe |newsletter|email list|mailing list|register |account|download the|download our|'
  'get the |get our |follow us|follow topics|follow authors|follow the authors|support us|support our|patreon|'
  'donate |become a |buy it here|commission|affiliate |purchase through links|suscr|descarga la|boletín|'
  'abonnez-vous|inscrivez-vous|téléchargez|abonnieren sie|jetzt herunterladen|assine|inscreva-se',
  memoize: false,
);

bool _isCallToAction(Block b) {
  String text;
  if (b is ParagraphBlock) {
    text = inlineText(b.content);
  } else if (b is CalloutBlock || b is ListBlock) {
    text = blocksText([b]);
  } else {
    return false;
  }
  text = collapse(text);
  // Quoted speech that mentions subscriptions is reporting, not a pitch.
  if (text.isEmpty || text.length >= 300 || _quoted.hasMatch(text)) return false;
  final lower = jsLower(text);
  if (!_callToActionWords.hasMatch(lower)) {
    assert(!_callToAction.hasMatch(text), 'call-to-action prefilter missed "$text"');
    return false;
  }
  return _callToAction.hasMatch(text);
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
