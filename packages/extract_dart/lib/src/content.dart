/// Finds the article body (`content.ts`). The scoring follows Mozilla
/// Readability's proven model (paragraph scores flowing to ancestors, class
/// weights, link density, sibling joining, conditional cleaning) but runs over
/// the compact tree with statistics computed in one bottom-up pass per attempt,
/// instead of repeated `innerText` and `querySelectorAll` calls. Removals are
/// marks (`skip`), so a retry with relaxed rules does not need to re-parse the
/// page.
library;

import 'dart:math' as math;

import 'js.dart';
import 'match.dart';
import 'tree.dart';

final _unlikely = ClassPattern(
  r'-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo',
);

/// Unlikely-candidate words that prose never overrides.
final _unlikelyHard = ClassPattern(
  r'-ad-|ai2html|breadcrumbs|combx|comment|community|disqus|footer|gdpr|menu|related|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|ad-break|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo',
);
final _maybe = ClassPattern(r'and|article|body|column|content|main|mathjax|shadow|story|post-text|entry');
final _positive = ClassPattern(
  r'article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story|prose|markdown|rich-text|richtext',
);
final _negative = ClassPattern(
  r'-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|newsletter|subscribe|taboola|recirc|byline|author-bio|toolbar|breadcrumb|disclaimer|caption-credit',
);
final _byline = ClassPattern(r'byline|author|dateline|writtenby|p-author');
final _share = ClassPattern(r'(?:\b|_)(?:share|sharedaddy|social|sharing)(?:\b|_)');
const _unlikelyRoles = {
  'menu', 'menubar', 'complementary', 'navigation', 'alert', 'alertdialog', 'dialog', 'banner', 'contentinfo', //
  'search', 'tooltip',
};
final _videoHosts = RegExp(
  r'\/\/(?:www\.)?(?:(?:dailymotion|youtube|youtube-nocookie|player\.vimeo|v\.qq|loom|fast\.wistia|embed\.ted)\.com|(?:archive|upload\.wikimedia)\.org|player\.twitch\.tv|(?:open\.)?spotify\.com|w\.soundcloud\.com|youtu\.be|codepen\.io|bandcamp\.com)',
  caseSensitive: false,
);
final _adWords = RegExp(
  r'^(?:ad(?:vertising|vertisement)?|pub(?:licité)?|werb(?:ung)?|广告|Реклама|Anuncio)$',
  caseSensitive: false,
);
final _loadingWords = RegExp(r'^(?:(?:loading|正在加载|Загрузка|chargement|cargando)(?:…|\.\.\.)?)$', caseSensitive: false);

/// Strong signals that an element is the article body (publisher templates,
/// CMSs, doc generators and schema.org). A boost, never a blind choice.
final _contentHint = ClassPattern(
  r'(?:^|\s)(?:entry-content|post-content|article-content|article-body|articlebody|article__body|article__content|article-text|articletext|story-body|storybody|story-content|story__body|post-body|postbody|post__content|post-entry|blog-post-content|blog-content|entry-body|content-body|body-text|bodytext|markdown-body|gh-content|available-content|mw-parser-output|ltx_page_content|theme-doc-markdown|md-content__inner|vp-doc|rich-text|richtext|c-entry-content|td-post-content|single-post-content|article-body-text|news-content|news-body|text-content|main-content-body|post-article|articlecontent|field-name-body|field--name-body|single-content|paywall-content|caas-body|wysiwyg|prose)(?:\s|$)',
);

const _phrasing = {
  'abbr', 'audio', 'b', 'bdo', 'bdi', 'br', 'button', 'canvas', 'cite', 'code', 'data', 'datalist', 'dfn', 'em', //
  'embed', 'i', 'img', 'input', 'kbd', 'label', 'mark', 'math', 'math-tex', 'meter', 'noscript', 'object', 'output',
  'progress', 'q', 'ruby', 'rt', 'rp', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup', 'textarea', 'time',
  'var', 'wbr', 'u', 's', 'strike', 'tt', 'font', 'big', 'svg', 'picture', 'nobr', 'acronym',
};

/// Elements that make a container "not a paragraph".
const _blocks = {
  'blockquote', 'dl', 'div', 'img', 'ol', 'p', 'pre', 'table', 'ul', 'section', 'article', 'figure', 'h1', 'h2', //
  'h3', 'h4', 'h5', 'h6', 'header', 'footer', 'aside', 'nav', 'main', 'hr', 'details', 'video', 'iframe', 'form',
  'fieldset', 'address', 'center', 'picture', 'figcaption', 'li', 'dd', 'dt', 'audio',
};

const _tagsToScore = {'section', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'td', 'pre'};

class Flags {
  const Flags({required this.stripUnlikely, required this.weightClasses, required this.cleanConditionally});

  final bool stripUnlikely;
  final bool weightClasses;
  final bool cleanConditionally;
}

bool _isWhitespace(VNode node) => node is VText ? isBlank(node.text) : (node as VElement).tag == 'br';

bool isPhrasing(VNode node) {
  if (node is VText) return true;
  final el = node as VElement;
  if (_phrasing.contains(el.tag)) return true;
  if (el.tag == 'a' || el.tag == 'del' || el.tag == 'ins') return el.children.every(isPhrasing);
  return false;
}

/// Post-order: children were visited first, so their `containsBlock` is known.
bool _hasBlockChild(VElement el) {
  for (final child in el.children) {
    if (child is VElement && (_blocks.contains(child.tag) || child.containsBlock)) return true;
  }
  return false;
}

/// Bottom-up statistics over non-skipped nodes.
void measure(VElement el) {
  var text = 0;
  var link = 0.0;
  var commas = 0;
  final isLink = el.tag == 'a';
  for (final child in el.children) {
    if (child is VText) {
      text += child.length;
      commas += child.commas;
    } else if (!(child as VElement).skip) {
      measure(child);
      text += child.textLen;
      link += child.linkLen;
      commas += child.commas;
    }
  }
  el.textLen = text;
  el.commas = commas;
  if (isLink) {
    final href = el.attrs['href'] ?? '';
    // In-page links (footnotes, anchors) weigh less than links away.
    el.linkLen = href.length > 1 && href.codeUnitAt(0) == 35 ? text * 0.3 : text.toDouble();
  } else {
    el.linkLen = link;
  }
}

double _linkDensity(VElement el) => el.textLen == 0 ? 0 : math.min(1, el.linkLen / el.textLen);

int _classWeight(VElement el, Flags flags) {
  if (!flags.weightClasses) return 0;
  var weight = 0;
  final cls = jsLower(el.className);
  final id = jsLower(el.id);
  if (cls.isNotEmpty) {
    if (_negative.hasMatch(cls)) weight -= 25;
    if (_positive.hasMatch(cls)) weight += 25;
  }
  if (id.isNotEmpty) {
    if (_negative.hasMatch(id)) weight -= 25;
    if (_positive.hasMatch(id)) weight += 25;
  }
  if (_contentHint.hasMatch(cls) || el.attrs['itemprop'] == 'articleBody' || el.attrs['itemprop'] == 'articlebody') {
    weight += 30;
  }
  return weight;
}

void _initialize(VElement el, Flags flags) {
  var score = 0;
  switch (el.tag) {
    case 'div':
      score = el.attrs['data-x-as-p'] == null ? 5 : 0;
    case 'pre':
    case 'td':
    case 'blockquote':
      score = 3;
    case 'address':
    case 'ol':
    case 'ul':
    case 'dl':
    case 'dd':
    case 'dt':
    case 'li':
    case 'form':
      score = -3;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'th':
      score = -5;
    case 'article':
      score = 8;
  }
  el.score = (score + _classWeight(el, flags)).toDouble();
  el.scored = true;
}

/// One-time normalization that Readability performs inside its scoring loop:
/// inline runs inside block containers become synthetic paragraphs, divs with
/// only inline content act as paragraphs, empty wrappers disappear.
void normalize(VElement body) {
  void visit(VElement el) {
    for (var i = 0; i < el.children.length; i++) {
      final child = el.children[i];
      if (child is VElement) visit(child);
    }
    el.containsBlock = _hasBlockChild(el);
    final tag = el.tag;
    if (tag == 'div' ||
        tag == 'section' ||
        tag == 'article' ||
        tag == 'main' ||
        tag == 'center' ||
        tag == 'form' ||
        tag == 'body') {
      if (!el.containsBlock) {
        if (tag == 'div') el.attrs['data-x-as-p'] = '';
        return;
      }
      // Wrap phrasing runs between blocks in synthetic paragraphs.
      final out = <VNode>[];
      VElement? p;
      for (final child in el.children) {
        if (isPhrasing(child)) {
          if (p != null) {
            p.append(child);
          } else if (!_isWhitespace(child)) {
            p = VElement('p', {'data-x-synthetic': ''});
            p.parent = el;
            p.append(child);
            out.add(p);
          } else {
            out.add(child);
          }
        } else {
          if (p != null) {
            while (p.children.isNotEmpty && _isWhitespace(p.children.last)) {
              final ws = p.children.removeLast();
              ws.parent = el;
              out.add(ws);
            }
          }
          p = null;
          out.add(child);
        }
      }
      el.children = out;
    }
  }

  visit(body);
}

bool _isEmptyContainer(VElement el) {
  final tag = el.tag;
  if (tag != 'div' &&
      tag != 'section' &&
      tag != 'header' &&
      tag != 'h1' &&
      tag != 'h2' &&
      tag != 'h3' &&
      tag != 'h4' &&
      tag != 'h5' &&
      tag != 'h6') {
    return false;
  }
  for (final child in el.children) {
    if (child is VText) {
      if (!isBlank(child.text)) return false;
    } else if ((child as VElement).tag != 'br' && child.tag != 'hr') {
      return false;
    }
  }
  return true;
}

bool _hasAncestor(VElement el, Set<String> tags, [int limit = 64]) {
  var depth = 0;
  for (var p = el.parent; p != null && depth < limit; p = p.parent, depth++) {
    if (tags.contains(p.tag)) return true;
  }
  return false;
}

const _tableOrCode = {'table', 'code', 'pre'};

class _MarkState {
  bool bylineRemoved = false;
}

/// Pass 1 of an attempt: marks unlikely candidates, bylines and empty wrappers as skipped.
void _markUnlikely(VElement body, Flags flags, _MarkState state) {
  final totalProse = _proseLength(body);
  walk(body, (el) {
    if (identical(el, body)) return true;
    final match = el.matchString;
    if (el.attrs['aria-modal'] == 'true' && el.attrs['role'] == 'dialog') {
      el.skip = true;
      return false;
    }
    if (!state.bylineRemoved && match.length > 1 && _isByline(el, match)) {
      state.bylineRemoved = true;
      el.skip = true;
      return false;
    }
    if (flags.stripUnlikely) {
      if (_unlikely.hasMatch(match) &&
          !_maybe.hasMatch(match) &&
          el.tag != 'a' &&
          el.tag != 'body' &&
          el.tag != 'article' &&
          el.tag != 'main' &&
          !_hasAncestor(el, _tableOrCode)) {
        // "header", "banner", "extra": weak signals that real prose overrides (MDN puts intros in a header).
        // A layout wrapper holding most of the page's prose ("with-sidebar") is never unlikely.
        final prose = _proseLength(el);
        if ((_unlikelyHard.hasMatch(match) || prose < 400) && prose <= totalProse * 0.5) {
          el.skip = true;
          return false;
        }
      }
      final role = el.attrs['role'];
      if (role != null && _unlikelyRoles.contains(role)) {
        el.skip = true;
        return false;
      }
      if (el.tag == 'nav' || el.tag == 'aside' && !isCallout(el) && !_isNoteMarkup(el)) {
        el.skip = true;
        return false;
      }
      // Several articles inside an article are a feed of other posts or comments.
      if (el.tag == 'article' &&
          el.parent != null &&
          _countNestedArticles(el.parent!) >= 2 &&
          _hasAncestor(el, _article)) {
        el.skip = true;
        return false;
      }
    }
    if (_isEmptyContainer(el)) {
      el.skip = true;
      return false;
    }
    return true;
  });
}

const _article = {'article'};
const _quoteOrFigure = {'blockquote', 'figure'};

int _countNestedArticles(VElement parent) {
  var n = 0;
  for (final child in parent.children) {
    if (child is VElement && child.tag == 'article') n++;
  }
  return n;
}

/// Text of paragraphs inside [el] that is not link text (uses the attempt's fresh `measure`).
double _proseLength(VElement el) {
  var n = 0.0;
  walk(el, (e) {
    if (e.tag == 'p') {
      n += e.textLen - e.linkLen;
      return false;
    }
    return true;
  });
  return n;
}

bool _isByline(VElement el, String match) {
  final rel = el.attrs['rel'];
  final itemprop = el.attrs['itemprop'];
  if (!(rel == 'author' || (itemprop != null && itemprop.contains('author')) || _byline.hasMatch(match))) return false;
  final len = visibleLength(textOf(el));
  return len > 0 && len < 100;
}

/// Footnote and endnote lists (Pandoc, Sphinx, Hugo, GitHub, Wikipedia, Substack).
final footnoteContainer = ClassPattern(
  r'(?:^|[\s_-])(?:footnotes|footnote-list|footnotes-list|endnotes|references|reflist|refs|footnote-definitions|notes-list|fn-list)(?:$|[\s_-])',
);

bool isFootnotes(VElement el) =>
    footnoteContainer.hasMatch(el.matchString) ||
    el.attrs['role'] == 'doc-endnotes' ||
    el.attrs['data-footnotes'] != null;

final _footnoteClass = ClassPattern(r'(?:^|\s)footnote(?:\s|$)');

/// A footnote list or one of its notes: kept even when marked up as <aside>.
bool _isNoteMarkup(VElement el) =>
    isFootnotes(el) ||
    el.attrs['role'] == 'doc-footnote' ||
    el.attrs['role'] == 'doc-endnote' ||
    _footnoteClass.hasMatch(el.className);

final _callout = ClassPattern(
  r'(?:^|[\s_-])(?:note|tip|warning|caution|important|admonition|callout|alert|info|danger|notice|hint|notecard)(?:$|[\s_-])',
);

bool isCallout(VElement el) => _callout.hasMatch(el.matchString);

List<VElement> _ancestors(VElement el, int max) {
  final out = <VElement>[];
  for (var p = el.parent; p != null && out.length < max; p = p.parent) {
    out.add(p);
  }
  return out;
}

class _Attempt {
  _Attempt(this.roots, this.textLength);

  final List<VElement> roots;
  final int textLength;
}

_Attempt _grab(VElement body, Flags flags, String? articleBody) {
  _resetMarks(body);
  measure(body);
  _markUnlikely(body, flags, _MarkState());
  measure(body);

  final toScore = <VElement>[];
  walk(body, (el) {
    if (el.skip) return false;
    if (_tagsToScore.contains(el.tag) || el.attrs['data-x-as-p'] != null) toScore.add(el);
    return true;
  });

  final candidates = <VElement>[];
  for (final el in toScore) {
    if (el.parent == null || el.textLen < 25) continue;
    final ups = _ancestors(el, 5);
    if (ups.isEmpty) continue;
    final score = 1 + (el.commas + 1) + math.min(el.textLen ~/ 100, 3);
    for (var level = 0; level < ups.length; level++) {
      final a = ups[level];
      if (a.parent == null) break;
      if (!a.scored) {
        _initialize(a, flags);
        candidates.add(a);
      }
      a.score += score / (level == 0 ? 1 : (level == 1 ? 2 : level * 3));
    }
  }

  final top = <VElement>[];
  for (final c in candidates) {
    if (c.tag == 'body' || c.tag == 'html') {
      c.score *= 1 - _linkDensity(c);
      continue;
    }
    c.score *= 1 - _linkDensity(c);
    var i = 0;
    while (i < top.length && top[i].score >= c.score) {
      i++;
    }
    if (i < 5) {
      top.insert(i, c);
      if (top.length > 5) top.removeLast();
    }
  }

  var topCandidate = top.isEmpty ? null : top[0];
  if (articleBody != null) topCandidate = _alignWithStructuredBody(body, topCandidate, articleBody);

  if (topCandidate == null || topCandidate.tag == 'body') {
    measure(body);
    return _Attempt([body], body.textLen);
  }

  // Several strong candidates under one ancestor: the ancestor is the article.
  final alternatives = <List<VElement>>[];
  for (var i = 1; i < top.length; i++) {
    if (top[i].score / topCandidate.score >= 0.75 && !_isInside(top[i], topCandidate)) {
      alternatives.add(_ancestors(top[i], 64));
    }
  }
  if (alternatives.length >= 3) {
    for (var p = topCandidate.parent; p != null && p.tag != 'body'; p = p.parent) {
      var lists = 0;
      for (final list in alternatives) {
        if (list.contains(p)) lists++;
      }
      if (lists >= 3) {
        topCandidate = p;
        break;
      }
    }
  }
  if (!topCandidate!.scored) _initialize(topCandidate, flags);

  // Climb while the parent scores higher.
  var lastScore = topCandidate.score;
  final threshold = lastScore / 3;
  for (var p = topCandidate.parent; p != null && p.tag != 'body'; p = p.parent) {
    if (!p.scored) continue;
    if (p.score < threshold) break;
    if (p.score > lastScore) {
      topCandidate = p;
      break;
    }
    lastScore = p.score;
  }
  topCandidate = _joinSplitBody(topCandidate!, candidates);

  // An only child says nothing on its own.
  for (var p = topCandidate.parent; p != null && p.tag != 'body' && _liveChildren(p) == 1; p = p.parent) {
    topCandidate = p;
  }
  if (!topCandidate!.scored) _initialize(topCandidate, flags);

  // Join siblings that look like more of the same.
  final roots = <VElement>[];
  final parent = topCandidate.parent;
  if (parent == null) {
    roots.add(topCandidate);
  } else {
    final siblingThreshold = math.max(10.0, topCandidate.score * 0.2);
    for (final sibling in parent.children) {
      if (sibling is! VElement || sibling.skip) continue;
      var append = identical(sibling, topCandidate);
      if (!append) {
        final bonus = sibling.className != '' && sibling.className == topCandidate.className
            ? topCandidate.score * 0.2
            : 0.0;
        if (sibling.scored && sibling.score + bonus >= siblingThreshold) {
          append = true;
        } else if (bonus > 0 && sibling.textLen > 50 && _linkDensity(sibling) < 0.3) {
          // Same component class as the body (CMS "text block" wrappers): more of the same.
          append = true;
        } else if (sibling.tag == 'p' || sibling.attrs['data-x-as-p'] != null) {
          final density = _linkDensity(sibling);
          final len = sibling.textLen;
          if (len > 80 && density < 0.25) {
            append = true;
          } else if (len < 80 && len > 0 && density == 0 && _sentenceEnd.hasMatch(textOf(sibling))) {
            append = true;
          }
        } else if (_isLeadMedia(sibling, topCandidate) || _isAdjacentProse(sibling, topCandidate)) {
          append = true;
        }
      }
      if (append) roots.add(sibling);
    }
    _fillBetween(parent, roots);
  }

  for (final root in roots) {
    _prepare(root, flags);
  }
  var length = 0;
  for (final root in roots) {
    if (!flags.cleanConditionally) measure(root);
    length += root.textLen;
  }
  return _Attempt(roots, length);
}

final _sentenceEnd = RegExp(r'\.( |$)');

bool _isInside(VElement node, VElement ancestor) {
  for (var p = node.parent; p != null; p = p.parent) {
    if (identical(p, ancestor)) return true;
  }
  return false;
}

/// Bodies split into several containers by ads or "chunks" (Wired, many CMSs):
/// climb to the nearest ancestor (up to three levels) whose text is almost all
/// strong candidates.
VElement _joinSplitBody(VElement top, List<VElement> candidates) {
  final strong = <VElement>[];
  for (final c in candidates) {
    if (!identical(c, top) &&
        c.textLen >= 200 &&
        c.score >= top.score * 0.3 &&
        !_isInside(c, top) &&
        !_isInside(top, c)) {
      strong.add(c);
    }
  }
  if (strong.isEmpty) return top;
  // Outermost strong candidates only, so nested ones are not counted twice.
  final outer = strong.where((c) => !strong.any((o) => !identical(o, c) && _isInside(c, o))).toList();
  var ancestor = top.parent;
  for (var level = 0; level < 3 && ancestor != null && ancestor.tag != 'body'; level++, ancestor = ancestor.parent) {
    if (ancestor.textLen == 0 || _linkDensity(ancestor) > 0.25) continue;
    var covered = top.textLen;
    var others = 0;
    for (final c in outer) {
      if (_isInside(c, ancestor)) {
        covered += c.textLen;
        others++;
      }
    }
    if (others > 0 && covered >= ancestor.textLen * 0.8) return ancestor;
  }
  return top;
}

const _structure = {
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'pre', 'table', 'blockquote', 'p', 'hr', 'picture', 'details', //
  'dl', 'ul', 'ol',
};

/// Joined siblings imply the parent is the article: headings, figures, code and
/// prose between them (and a heading right before the first) belong to it too.
void _fillBetween(VElement parent, List<VElement> roots) {
  if (roots.length < 2) return;
  final kids = parent.children;
  var first = kids.indexOf(roots[0]);
  final last = kids.indexOf(roots[roots.length - 1]);
  for (var k = first - 1; k >= 0; k--) {
    final prev = kids[k];
    if (prev is VText) {
      if (!isBlank(prev.text)) break;
      continue;
    }
    final el = prev as VElement;
    if (!el.skip && _headings.contains(el.tag)) first = k;
    break;
  }
  final out = <VElement>[];
  for (var k = first; k <= last; k++) {
    final child = kids[k];
    if (child is! VElement || child.skip) continue;
    if (roots.contains(child)) {
      out.add(child);
      continue;
    }
    if (_negative.hasMatch(child.matchString) || _boilerplate.hasMatch(child.matchString)) continue;
    if (!_structure.contains(child.tag) && !(child.textLen < 400 && _hasMedia(child))) continue;
    if ((child.tag == 'ul' || child.tag == 'ol' || child.tag == 'dl') && _linkDensity(child) > 0.5) continue;
    out.add(child);
  }
  roots
    ..clear()
    ..addAll(out);
}

const _media = {'figure', 'img', 'picture', 'pre', 'table', 'video', 'iframe', 'audio', 'math', 'blockquote'};

/// Wrapper of an image, video, table or code listing (CMS media blocks between text blocks).
bool _hasMedia(VElement el) {
  var found = false;
  walk(el, (e) {
    if (found || e.skip) return false;
    if (!identical(e, el) && _media.contains(e.tag)) found = true;
    return !found;
  });
  return found;
}

/// A figure or heading directly before the body (lead image, section title) belongs to it.
bool _isLeadMedia(VElement sibling, VElement top) {
  final parent = top.parent;
  if (parent == null) return false;
  final i = parent.children.indexOf(sibling);
  final j = parent.children.indexOf(top);
  if (i < 0 || j < 0 || i > j) return false;
  for (var k = i + 1; k < j; k++) {
    final between = parent.children[k];
    if (between is VElement && !between.skip) return false;
  }
  if (sibling.tag == 'figure' || sibling.tag == 'picture') return true;
  if (sibling.textLen < 200 && _linkDensity(sibling) < 0.3) {
    var images = 0;
    walk(sibling, (e) {
      if (e.tag == 'img') images++;
      return !e.skip;
    });
    return images == 1 && !_negative.hasMatch(sibling.matchString);
  }
  return false;
}

/// A container of plain paragraphs right next to the body (an intro split from it).
bool _isAdjacentProse(VElement sibling, VElement top) {
  if (sibling.textLen < 200 ||
      _linkDensity(sibling) > 0.25 ||
      _negative.hasMatch(sibling.matchString) ||
      _boilerplate.hasMatch(sibling.matchString)) {
    return false;
  }
  final parent = top.parent;
  if (parent == null) return false;
  final kids = parent.children;
  final i = kids.indexOf(sibling);
  final j = kids.indexOf(top);
  final step = i < j ? 1 : -1;
  for (var k = i + step; k != j; k += step) {
    final between = kids[k];
    if (between is VElement && !between.skip) return false;
  }
  return _proseLength(sibling) >= sibling.textLen * 0.5 && _proseLength(sibling) >= 200;
}

int _liveChildren(VElement el) {
  var n = 0;
  for (final child in el.children) {
    if (child is VElement && !child.skip) n++;
  }
  return n;
}

void _resetMarks(VElement el) {
  el.skip = false;
  el.scored = false;
  el.score = 0;
  for (final child in el.children) {
    if (child is VElement) _resetMarks(child);
  }
}

// ------------------------------------------------------------- structured body

/// `text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)`.
List<String> _words(String text) => lettersAndNumbers(jsLower(text));

/// When the page publishes its text as schema.org `articleBody`, the element
/// whose text best matches it (high recall, then the smallest such element) is
/// a better root than scoring alone, for pages whose markup misleads scoring.
VElement? _alignWithStructuredBody(VElement body, VElement? current, String articleBody) {
  final target = _words(articleBody);
  if (target.length < 80) return current;
  final set = <String>{};
  for (var i = 0; i + 2 < target.length; i++) {
    set.add('${target[i]} ${target[i + 1]} ${target[i + 2]}');
  }
  if (set.length < 50) return current;

  (double, double) recallOf(VElement el) {
    final w = _words(textOf(el));
    var hit = 0;
    final seen = <String>{};
    for (var i = 0; i + 2 < w.length; i++) {
      final s = '${w[i]} ${w[i + 1]} ${w[i + 2]}';
      if (set.contains(s) && seen.add(s)) hit++;
    }
    final total = math.max(1, w.length - 2);
    return (hit / set.length, hit / total);
  }

  if (current != null) {
    final (recall, precision) = recallOf(current);
    if (recall > 0.8 && precision > 0.6) return current;
  }
  // Smallest element holding most of the structured text. A descendant never
  // recalls more than its ancestor, so failing subtrees are pruned.
  VElement? best;
  var bestLen = double.infinity;
  final minLen = (articleBody.length * 0.6).floor();
  walk(body, (el) {
    if (el.skip || el.textLen < minLen) return false;
    final (recall, precision) = recallOf(el);
    if (recall <= 0.85) return false;
    if (precision > 0.4 && el.textLen < bestLen) {
      best = el;
      bestLen = el.textLen.toDouble();
    }
    return true;
  });
  return best ?? current;
}

// ------------------------------------------------------------------ cleaning

bool _isDataTable(VElement table) {
  if (table.attrs['role'] == 'presentation' || table.attrs['datatable'] == '0') return false;
  final summary = table.attrs['summary'];
  if (summary != null && summary.isNotEmpty) return true;
  var caption = false;
  var headerish = false;
  var nested = false;
  var rows = 0;
  var columns = 0.0;
  walk(table, (e) {
    if (identical(e, table)) return true;
    if (e.tag == 'table') {
      nested = true;
      return false;
    }
    if (e.tag == 'caption' && e.children.isNotEmpty) caption = true;
    if (e.tag == 'col' || e.tag == 'colgroup' || e.tag == 'tfoot' || e.tag == 'thead' || e.tag == 'th') {
      headerish = true;
    }
    if (e.tag == 'tr') {
      rows++;
      var cols = 0.0;
      for (final cell in e.children) {
        if (cell is VElement && (cell.tag == 'td' || cell.tag == 'th')) {
          final span = jsNumber(cell.attrs['colspan']);
          cols += span > 0 ? span : 1;
        }
      }
      columns = math.max(columns, cols);
    }
    return true;
  });
  if (caption || headerish) return true;
  if (nested) return false;
  if (rows == 1 || columns == 1) return false;
  if (rows >= 10 || columns > 4) return true;
  return rows * columns > 10;
}

bool isDataTableCached(VElement table) {
  if (table.tableState < 0) table.tableState = _isDataTable(table) ? 1 : 0;
  return table.tableState == 1;
}

/// Boilerplate inside an article: removed regardless of score when small relative to the article.
final _boilerplate = ClassPattern(
  r'(?:^|[\s_-])(?:mw-editsection|editsection|edit-section|mw-jump-link|catlinks|printfooter|navbox|vertical-navbox|ambox|hatnote|noprint|share|sharing|social|social-links|sharedaddy|share-buttons|newsletter|subscribe|subscription|signup|sign-up|optin|opt-in|related|related-posts|related-articles|recommended|recommendations|more-stories|read-more|readmore|read-next|also-read|further-reading-promo|promo|promoted|sponsored|advert|advertisement|ad-container|ad-slot|ad-unit|ad-wrapper|adsbygoogle|dfp|gpt-ad|comments|comment-list|commentlist|disqus|breadcrumb|breadcrumbs|pagination|post-tags|entry-tags|tag-list|tags-list|article-tags|toc|table-of-contents|tableofcontents|cookie|consent|gdpr|regwall|inline-cta|cta|author-bio|about-author|author-box|authorbox|post-author-bio|byline|dateline|print|skip-link|toolbar|sticky|floating|modal|popup|overlay|outbrain|taboola|jp-relatedposts|wp-block-buttons|follow-us|listen|audio-player|article-audio|podcast-player|rating|reactions|clap|kudos)(?:$|[\s_-])',
);

/// Short stand-alone text that is UI, not prose.
final _uiText = RegExp(
  r'^(?:text size|caption|image \d+ of \/? ?\d+|\d+ of \d+|photos?|gallery|enlarge( this image)?|view (full )?gallery|advertisement|ad|sponsored|share( this)?( article| story| post)?|tweet|email|print|copy link|copy|copied!?|loading\.*|read more|continue reading|subscribe|sign up|follow|listen( to this article)?|save|bookmark|comments?|reply|related|related articles|you may also like|recommended|more from .*|skip (to )?(main )?content|back to top|top|close|menu|toggle navigation|show more|load more|see more|×)$',
  caseSensitive: false,
);

/// Statistics from the attempt's `measure(body)` are still valid here.
void _prepare(VElement root, Flags flags) {
  final rootLen = math.max(1, root.textLen);

  walk(root, (el) {
    if (identical(el, root)) return true;
    if (el.skip) return false;
    final tag = el.tag;
    if (tag == 'pre' ||
        tag == 'code' ||
        tag == 'math' ||
        tag == 'math-tex' ||
        tag == 'table' && isDataTableCached(el)) {
      return false;
    }
    if (tag == 'footer' && !_hasAncestor(el, _quoteOrFigure) ||
        tag == 'aside' && !isCallout(el) && !_isNoteMarkup(el) ||
        tag == 'nav' ||
        tag == 'd-appendix' ||
        tag == 'd-title' ||
        tag == 'd-byline' ||
        tag == 'form' && el.textLen < 200) {
      el.skip = true;
      return false;
    }
    if (tag == 'iframe' && !_videoHosts.hasMatch(el.attrs['src'] ?? el.attrs['data-src'] ?? '')) {
      el.skip = true;
      return false;
    }
    final match = el.matchString;
    if (match.length > 1 && el.textLen < math.max(500, rootLen * 0.3)) {
      if (_share.hasMatch(match) && el.textLen < 500 ||
          _boilerplate.hasMatch(match) && !_maybeContent.hasMatch(match)) {
        el.skip = true;
        return false;
      }
    }
    if (tag == 'article' && el.textLen < rootLen * 0.4 && el.textLen < 1500 && _hasLinkedHeading(el)) {
      el.skip = true;
      return false;
    }
    if ((tag == 'h1' || tag == 'h2') && _classWeight(el, flags) < 0) {
      el.skip = true;
      return false;
    }
    if (el.textLen < 40 &&
        el.textLen > 0 &&
        (tag == 'p' || tag == 'div' || tag == 'span' || tag == 'a' || tag == 'li') &&
        _uiText.hasMatch(textOf(el))) {
      el.skip = true;
      return false;
    }
    return true;
  });

  if (flags.cleanConditionally) {
    _cleanConditionally(root, flags);
  }
}

/// Teaser cards: a nested article whose heading links elsewhere.
bool _hasLinkedHeading(VElement el) {
  var found = false;
  walk(el, (e) {
    if (found) return false;
    if (e.tag == 'h1' || e.tag == 'h2' || e.tag == 'h3' || e.tag == 'h4') {
      walk(e, (x) {
        final href = x.attrs['href'];
        if (x.tag == 'a' && href != null && charCodeAt(href, 0) != 35) found = true;
        return !found;
      });
      return false;
    }
    return true;
  });
  return found;
}

final _maybeContent = ClassPattern(
  r'(?:^|[\s_-])(?:article-body|articlebody|entry-content|post-content|story-body|main-content|article-content|post-body)(?:$|[\s_-])',
);

const _conditional = {'form', 'fieldset', 'table', 'ul', 'ol', 'div', 'section', 'aside', 'header', 'dl'};

const _headings = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'};
const _lists = {'ul', 'ol'};
const _codeLike = {'pre', 'code'};
const _embeds = {'object', 'embed', 'iframe'};
const _textish = {'span', 'li', 'td', 'blockquote', 'dl', 'div', 'img', 'ol', 'p', 'pre', 'table', 'ul'};

/// Subtree counts for conditional cleaning, excluding removed descendants.
class _Counts {
  int text = 0;
  double link = 0;
  int commas = 0;
  int p = 0;
  int img = 0;
  int li = 0;
  int input = 0;

  /// pre, math or a data table: content that is never cleaned away.
  int protected = 0;
  int embeds = 0;
  int headingText = 0;
  int listText = 0;
  int textishText = 0;
}

void _cleanConditionally(VElement root, Flags flags) {
  _Counts visit(VElement el, bool inProtected) {
    final c = _Counts();
    final tag = el.tag;
    final isDataTable = tag == 'table' && isDataTableCached(el);
    final protectedHere = inProtected || _codeLike.contains(tag) || isDataTable;
    for (final child in el.children) {
      if (child is VText) {
        c.text += child.length;
        c.commas += child.commas;
        continue;
      }
      final e = child as VElement;
      if (e.skip) continue;
      final k = visit(e, protectedHere);
      if (e.skip) continue;
      final ct = e.tag;
      c.text += k.text;
      c.link += ct == 'a' ? (charCodeAt(e.attrs['href'] ?? '', 0) == 35 ? k.text * 0.3 : k.text.toDouble()) : k.link;
      c.commas += k.commas;
      c.p += k.p + (ct == 'p' ? 1 : 0);
      c.img += k.img + (ct == 'img' ? 1 : 0);
      c.li += k.li + (ct == 'li' ? 1 : 0);
      c.input += k.input + (ct == 'input' && jsLower(e.attrs['type'] ?? '') != 'checkbox' ? 1 : 0);
      c.protected +=
          k.protected +
          (ct == 'pre' || ct == 'math' || ct == 'math-tex' || ct == 'table' && isDataTableCached(e) ? 1 : 0);
      c.embeds += k.embeds + (_embeds.contains(ct) && !_videoHosts.hasMatch(e.attrs['src'] ?? '') ? 1 : 0);
      c.headingText += _headings.contains(ct) ? k.text : k.headingText;
      c.listText += _lists.contains(ct) ? k.text : k.listText;
      c.textishText += _textish.contains(ct) ? k.text : k.textishText;
    }
    el.textLen = c.text;
    el.linkLen = c.link;
    el.commas = c.commas;
    if (!identical(el, root) && _conditional.contains(tag) && !inProtected && _shouldRemove(el, c, flags)) {
      el.skip = true;
    }
    return c;
  }

  visit(root, false);
}

bool _shouldRemove(VElement el, _Counts c, Flags flags) {
  final tag = el.tag;
  if (tag == 'table' && isDataTableCached(el)) return false;
  if (c.protected > 0) return false;

  var isList = tag == 'ul' || tag == 'ol';
  if (!isList && c.text > 0) isList = c.listText / c.text > 0.9;

  final weight = _classWeight(el, flags);
  if (weight < 0) return true;
  if (c.commas >= 10) return false;
  // Heading wrappers (`div.mw-heading` with an edit link) are structure, not clutter.
  if (c.headingText > 0 && c.text - c.link <= c.headingText * 1.2) return false;

  if (c.text < 40) {
    final text = textOf(el);
    if (_adWords.hasMatch(text) || _loadingWords.hasMatch(text)) return true;
  }

  final p = c.p;
  final img = c.img;
  final li = c.li - 100;
  final headingDensity = c.text == 0 ? 0 : c.headingText / c.text;
  final contentLength = c.text;
  final density = c.text == 0 ? 0 : math.min(1, c.link / c.text);
  final textDensity = c.text == 0 ? 0 : c.textishText / c.text;
  final inFigure = _hasAncestor(el, _figure);

  var remove = false;
  if (!inFigure && img > 1 && p / img < 0.5) remove = true;
  if (!isList && li > p) remove = true;
  if (c.input > (p / 3).floor()) remove = true;
  if (!isList && !inFigure && headingDensity < 0.9 && contentLength < 25 && (img == 0 || img > 2) && density > 0) {
    remove = true;
  }
  if (!isList && weight < 25 && density > 0.2) remove = true;
  if (weight >= 25 && density > 0.5) remove = true;
  if ((c.embeds == 1 && contentLength < 75) || c.embeds > 1) remove = true;
  if (img == 0 && textDensity == 0 && contentLength == 0) remove = true;

  // Lists of images (galleries) stay.
  if (isList && remove) {
    for (final child in el.children) {
      if (child is VElement && !child.skip && child.children.whereType<VElement>().length > 1) return remove;
    }
    if (c.li == img) return false;
  }
  return remove;
}

const _figure = {'figure'};

const _flagSets = [
  Flags(stripUnlikely: true, weightClasses: true, cleanConditionally: true),
  Flags(stripUnlikely: false, weightClasses: true, cleanConditionally: true),
  Flags(stripUnlikely: false, weightClasses: false, cleanConditionally: true),
  Flags(stripUnlikely: false, weightClasses: false, cleanConditionally: false),
];

/// Runs the attempts and returns the article's root elements in document
/// order. Mirrors Readability's retry: when the result is short, retry with
/// fewer heuristics and keep the longest result.
List<VElement> findContent(VElement body, String? articleBody, [int charThreshold = 500]) {
  normalize(body);
  final attempts = <_Attempt>[];
  for (final flags in _flagSets) {
    final attempt = _grab(body, flags, articleBody);
    if (attempt.textLength >= charThreshold) return attempt.roots;
    attempts.add(attempt);
  }
  var best = attempts[0];
  for (final a in attempts) {
    if (a.textLength > best.textLength) best = a;
  }
  // Re-run the winning attempt so the marks on the tree match it.
  final index = attempts.indexOf(best);
  return _grab(body, _flagSets[index], articleBody).roots;
}
