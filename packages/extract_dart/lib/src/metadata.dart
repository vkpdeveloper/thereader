/// Page metadata (port of `packages/extract/src/metadata.ts`).
library;

import 'dart:convert';

import 'js.dart';
import 'match.dart';
import 'model.dart';
import 'tree.dart';
import 'url.dart';

class Metadata {
  Metadata({
    required this.url,
    required this.rawTitles,
    required this.subtitle,
    required this.authors,
    required this.siteName,
    required this.publishedAt,
    required this.modifiedAt,
    required this.language,
    required this.dir,
    required this.excerpt,
    required this.leadImage,
    required this.favicon,
    required this.articleBody,
  });

  final String url;
  final List<String> rawTitles;
  final String? subtitle;
  final List<String> authors;
  final String? siteName;
  final String? publishedAt;
  final String? modifiedAt;
  final String? language;
  final ArticleDirection? dir;
  final String? excerpt;
  final ArticleImage? leadImage;
  final String? favicon;
  final String? articleBody;
}

const _articleTypes = {
  'article', 'newsarticle', 'blogposting', 'techarticle', 'scholarlyarticle', 'report', 'reportagenewsarticle', //
  'analysisnewsarticle',
  'opinionnewsarticle',
  'reviewnewsarticle',
  'backgroundnewsarticle',
  'liveblogposting',
  'socialmediaposting',
  'discussionforumposting',
  'medicalscholarlyarticle',
  'advertisercontentarticle',
  'satiricalarticle',
  'askpublicnewsarticle',
  'review',
  'howto', 'recipe', 'creativework', 'posting',
};

final _commentOpen = RegExp(r'^<!--');
final _commentClose = RegExp(r'-->$');
final _cdataOpen = RegExp(r'^\s*\/\/\s*<!\[CDATA\[');
final _cdataClose = RegExp(r'\/\/\s*\]\]>\s*$');
final _controls = RegExp(r'[\u0000-\u001f]+');
final _trailingComma = RegExp(r',\s*([}\]])');

Object? _parseJsonLd(String source) {
  final text = jsTrim(source)
      .replaceFirst(_commentOpen, '')
      .replaceFirst(_commentClose, '')
      .replaceFirst(_cdataOpen, '')
      .replaceFirst(_cdataClose, '');
  try {
    return jsonDecode(text);
  } on FormatException {
    try {
      return jsonDecode(text.replaceAll(_controls, ' ').replaceAllMapped(_trailingComma, (m) => m[1]!));
    } on FormatException {
      return null;
    }
  }
}

List<String> _typesOf(Map<String, dynamic> node) {
  final t = node['@type'];
  if (t is String) return [jsLower(t)];
  if (t is List) {
    return [
      for (final x in t)
        if (x is String) jsLower(x),
    ];
  }
  return [];
}

void _jsonObjects(Object? value, List<Map<String, dynamic>> out, [int depth = 0]) {
  if (depth > 6 || value == null) return;
  if (value is List) {
    for (final item in value) {
      _jsonObjects(item, out, depth + 1);
    }
    return;
  }
  if (value is! Map<String, dynamic>) return;
  out.add(value);
  final graph = value['@graph'];
  if (graph != null) _jsonObjects(graph, out, depth + 1);
  final main = value['mainEntity'];
  if (main != null && (main is Map || main is List)) _jsonObjects(main, out, depth + 1);
}

String? _str(Object? value) {
  if (value is String) {
    final s = collapse(decodeEntities(value));
    return s.isNotEmpty ? s : null;
  }
  if (value is num) return jsNumberToString(value);
  return null;
}

void _names(Object? value, List<String> out) {
  if (value == null) return;
  if (value is String) {
    final s = _str(value);
    if (s != null) out.add(s);
  } else if (value is List) {
    for (final item in value) {
      _names(item, out);
    }
  } else if (value is Map) {
    final n = _str(value['name']);
    if (n != null) {
      out.add(n);
    } else {
      final given = _str(value['givenName']);
      final family = _str(value['familyName']);
      if (given != null || family != null) out.add(collapse('${given ?? ''} ${family ?? ''}'));
    }
  }
}

String? _imageUrl(Object? value) {
  if (value == null) return null;
  if (value is String) {
    final t = jsTrim(value);
    return t.isEmpty ? null : t;
  }
  if (value is List) {
    for (final item in value) {
      final url = _imageUrl(item);
      if (url != null) return url;
    }
    return null;
  }
  if (value is Map) return _str(value['url']) ?? _str(value['contentUrl']) ?? _str(value['@id']);
  return null;
}

const _entities = {'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'", 'nbsp': '\u00a0', '#39': "'"};
final _entity = RegExp(r'&(#x[0-9a-f]+|#[0-9]+|[a-z]+);', caseSensitive: false);

/// Decodes the handful of entities publishers double-encode into metadata strings.
String decodeEntities(String value) {
  if (!value.contains('&')) return value;
  return value.replaceAllMapped(_entity, (match) {
    final key = jsLower(match[1]!);
    if (charCodeAt(key, 0) == 35) {
      final code = charCodeAt(key, 1) == 120
          ? int.tryParse(key.substring(2), radix: 16)
          : int.tryParse(key.substring(1));
      return code != null && code > 0 && code <= 0x10ffff ? String.fromCharCode(code) : match[0]!;
    }
    return _entities[key] ?? match[0]!;
  });
}

const _months = {
  'jan': 1,
  'january': 1,
  'feb': 2,
  'february': 2,
  'mar': 3,
  'march': 3,
  'apr': 4,
  'april': 4,
  'may': 5,
  'jun': 6,
  'june': 6, //
  'jul': 7,
  'july': 7,
  'aug': 8,
  'august': 8,
  'sep': 9,
  'sept': 9,
  'september': 9,
  'oct': 10,
  'october': 10,
  'nov': 11,
  'november': 11,
  'dec': 12, 'december': 12,
};

String _pad(int n) => n < 10 ? '0$n' : '$n';

final _iso = RegExp(r'^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?');
final _compact = RegExp(r'^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})?)?$');
final _mdy = RegExp(r'([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})');
final _dmy = RegExp(r'(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})');

/// ISO 8601 when the value is (or plainly spells) a date; otherwise null.
String? normalizeDate(String? value) {
  if (value == null) return null;
  final v = jsTrim(value);
  final iso = _iso.firstMatch(v);
  if (iso != null) {
    final date = '${iso[1]}-${iso[2]}-${iso[3]}';
    if (iso[4] == null) return date;
    var zone = iso[7] ?? '';
    if (zone.length == 5) zone = '${zone.substring(0, 3)}:${zone.substring(3)}';
    return '${date}T${iso[4]}:${iso[5]}:${iso[6] ?? '00'}$zone';
  }
  final compact = _compact.firstMatch(v);
  if (compact != null) return '${compact[1]}-${compact[2]}-${compact[3]}';
  final mdy = _mdy.firstMatch(v);
  if (mdy != null) {
    final m = _months[jsLower(mdy[1]!)];
    if (m != null) return '${mdy[3]}-${_pad(m)}-${_pad(int.parse(mdy[2]!))}';
  }
  final dmy = _dmy.firstMatch(v);
  if (dmy != null) {
    final m = _months[jsLower(dmy[2]!)];
    if (m != null) return '${dmy[3]}-${_pad(m)}-${_pad(int.parse(dmy[1]!))}';
  }
  return null;
}

final _langTag = RegExp(r'^\s*([A-Za-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z]{2}|\d{3}))?');

String? _normalizeLanguage(String? value) {
  if (value == null) return null;
  final m = _langTag.firstMatch(value);
  if (m == null) return null;
  var tag = jsLower(m[1]!);
  if (m[2] != null) tag += '-${m[2]![0].toUpperCase()}${jsLower(m[2]!.substring(1))}';
  if (m[3] != null) tag += '-${m[3]!.toUpperCase()}';
  return tag;
}

final _bylinePrefix = RegExp(
  r'^(?:by|written by|posted by|words by|author|authors|von|par|por|di|door|av|af|przez|автор|от|作者|著者|筆者|文|撰文|글|المؤلف|بقلم|מאת)(?:\s*[:：\-]\s*|\s+)',
  caseSensitive: false,
);
final _httpUrl = RegExp(r'^https?:\/\/', caseSensitive: false);
final _twoDigits = RegExp(r'\d{2,}');
final _notAName = RegExp(r'affiliation|email|e-mail|profile|follow|subscribe|message', caseSensitive: false);
final _trailingSep = RegExp(r'\s*[|·•,]\s*$');

String? _cleanAuthor(String value) {
  var s = collapse(value).replaceFirst(_bylinePrefix, '');
  if (_httpUrl.hasMatch(s) || s.contains('@') || _twoDigits.hasMatch(s) || _notAName.hasMatch(s)) return null;
  if (jsSplit(s, ' ').length > 8) return null;
  s = jsTrim(s.replaceFirst(_trailingSep, ''));
  if (s.length < 2 || s.length > 100) return null;
  return s;
}

final _authorSplit = RegExp(r'\s*(?:,|;|\band\b|&|\bund\b|\bet\b|\by\b|،)\s*');

void _addAuthors(List<String> raw, List<String> out) {
  for (final value in raw) {
    for (final part in jsSplit(value, _authorSplit)) {
      final name = _cleanAuthor(part);
      if (name != null && !out.any((n) => jsLower(n) == jsLower(name))) out.add(name);
    }
  }
}

bool _isAbsoluteHttp(String? url) => url != null && _httpUrl.hasMatch(url);

final _hostRe = RegExp(r'^https?:\/\/([^/:?#]+)', caseSensitive: false);

bool _sameSite(String a, String b) {
  String host(String u) {
    final m = _hostRe.firstMatch(u);
    if (m == null) return '';
    final parts = jsLower(m[1]!).split('.');
    return parts.sublist(parts.length - 2 < 0 ? 0 : parts.length - 2).join('.');
  }

  return host(a) != '' && host(a) == host(b);
}

final _pathRe = RegExp(r'^https?:\/\/[^/?#]+([^?#]*)', caseSensitive: false);

String _pathOf(String url) {
  final m = _pathRe.firstMatch(url);
  return m == null || m[1] == '' ? '/' : m[1]!;
}

final _canonicalRel = RegExp(r'(?:^|\s)canonical(?:\s|$)', caseSensitive: false);
final _iconRel = RegExp(r'(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)');
final _sizes = RegExp(r'(\d+)x\d+');
final _svgHref = RegExp(r'\.svg(?:$|\?)', caseSensitive: false);
final _origin = RegExp(r'^(https?:\/\/[^/?#]+)', caseSensitive: false);

/// Reads metadata from `<head>`, JSON-LD, microdata and well-known byline markup.
Metadata readMetadata(VDocument doc, String pageUrl) {
  final meta = <String, String>{};
  final links = <VElement>[];
  String? titleTag;

  void readMeta(VElement el) {
    if (el.tag == 'meta') {
      final key = jsTrim(
        jsLower(el.attrs['property'] ?? el.attrs['name'] ?? el.attrs['itemprop'] ?? el.attrs['http-equiv'] ?? ''),
      );
      final content = el.attrs['content'];
      if (key.isNotEmpty && content != null && jsTrim(content).isNotEmpty && !meta.containsKey(key)) {
        meta[key] = collapse(decodeEntities(content));
      }
    } else if (el.tag == 'link') {
      links.add(el);
    } else if (el.tag == 'title' && titleTag == null) {
      titleTag = textOf(el);
    }
  }

  if (doc.head != null) {
    walk(doc.head!, (el) {
      readMeta(el);
      return true;
    });
  }
  walk(doc.body, (el) {
    if (el.tag == 'meta' || el.tag == 'link') {
      readMeta(el);
    } else if (el.tag == 'title' && titleTag == null) {
      titleTag = textOf(el);
    }
    return true;
  });

  Map<String, dynamic>? article;
  Map<String, dynamic>? webPage;
  String? siteNode;
  for (final source in doc.jsonLd) {
    final parsed = _parseJsonLd(source);
    if (parsed == null) continue;
    final objects = <Map<String, dynamic>>[];
    _jsonObjects(parsed, objects);
    for (final obj in objects) {
      final types = _typesOf(obj);
      if (article == null && types.any(_articleTypes.contains)) {
        article = obj;
      } else if (webPage == null &&
          types.any((t) => t == 'webpage' || t == 'itempage' || t == 'aboutpage' || t == 'collectionpage')) {
        webPage = obj;
      }
      if (siteNode == null && types.any((t) => t == 'website' || t == 'organization' || t == 'newsmediaorganization')) {
        siteNode = _str(obj['name']);
      }
    }
  }
  final ld = article ?? webPage;

  String? m(String key) => meta[key];
  String? ldStr(String key) => ld == null ? null : _str(ld[key]);

  String? publisher;
  if (ld != null) {
    final p = ld['publisher'];
    if (p is Map) publisher = _str(p['name']);
  }
  final siteName =
      m('og:site_name') ??
      _titleSite(titleTag ?? m('og:title'), pageUrl) ??
      publisher ??
      siteNode ??
      m('application-name') ??
      m('apple-mobile-web-app-title') ??
      m('twitter:site:name');

  final rawAuthors = <String>[];
  if (ld != null) _names(ld['author'], rawAuthors);
  if (rawAuthors.isEmpty && ld != null) _names(ld['creator'], rawAuthors);
  for (final key in [
    'author',
    'article:author',
    'parsely-author',
    'sailthru.author',
    'dc.creator',
    'dcterms.creator',
    'byl',
    'twitter:creator:name',
    'citation_author',
  ]) {
    if (rawAuthors.isNotEmpty) break;
    final v = m(key);
    if (v != null) rawAuthors.add(v);
  }
  if (rawAuthors.isEmpty) {
    final found = _findByline(doc.body);
    if (found != null) rawAuthors.add(found);
  }
  final authors = <String>[];
  _addAuthors(rawAuthors, authors);
  if (siteName != null) {
    final site = jsLower(siteName);
    authors.removeWhere((a) => jsLower(a) == site);
  }

  var published = normalizeDate(ldStr('datePublished') ?? ldStr('dateCreated'));
  for (final key in [
    'article:published_time',
    'og:article:published_time',
    'published_time',
    'datepublished',
    'pubdate',
    'publishdate',
    'publish-date',
    'date', //
    'dc.date.issued',
    'dc.date',
    'dcterms.created',
    'parsely-pub-date',
    'sailthru.date',
    'citation_publication_date',
    'citation_date',
    'article.published', 'og:updated_time',
  ]) {
    if (published != null) break;
    published = normalizeDate(m(key));
  }
  published ??= _findTime(doc.body);
  final modified = normalizeDate(
    ldStr('dateModified') ??
        m('article:modified_time') ??
        m('og:updated_time') ??
        m('datemodified') ??
        m('dcterms.modified'),
  );

  final rawTitles = <String>[];
  for (final t in [
    m('og:title'),
    ldStr('headline'),
    m('twitter:title'),
    titleTag,
    ldStr('name'),
    m('dc.title'),
    m('citation_title'),
    m('parsely-title'),
    m('sailthru.title'),
  ]) {
    if (t != null && t.isNotEmpty && !rawTitles.contains(t)) rawTitles.add(decodeEntities(t));
  }

  final htmlLang = doc.root.attrs['lang'] ?? doc.root.attrs['xml:lang'] ?? doc.body.attrs['lang'];
  final language = _normalizeLanguage(
    htmlLang ?? m('content-language') ?? m('og:locale') ?? ldStr('inLanguage') ?? m('language') ?? m('dc.language'),
  );
  final dirAttr = jsLower(doc.root.attrs['dir'] ?? doc.body.attrs['dir'] ?? '');
  final dir = dirAttr == 'rtl'
      ? ArticleDirection.rtl
      : dirAttr == 'ltr'
      ? ArticleDirection.ltr
      : null;

  var url = canonicalUrl(pageUrl);
  VElement? canonicalLink;
  for (final l in links) {
    if (_canonicalRel.hasMatch(l.attrs['rel'] ?? '') && (l.attrs['href'] ?? '').isNotEmpty) {
      canonicalLink = l;
      break;
    }
  }
  for (final candidate in [canonicalLink?.attrs['href'], m('og:url')]) {
    if (candidate == null) continue;
    final abs = resolveUrl(candidate, pageUrl);
    if (_isAbsoluteHttp(abs) && _sameSite(abs!, pageUrl) && !(_pathOf(abs) == '/' && _pathOf(pageUrl) != '/')) {
      url = canonicalUrl(abs);
      break;
    }
  }

  ArticleImage? leadImage;
  String? imageSrcLink;
  for (final l in links) {
    if (jsLower(l.attrs['rel'] ?? '') == 'image_src') {
      imageSrcLink = l.attrs['href'];
      break;
    }
  }
  final imageCandidate =
      m('og:image:secure_url') ??
      m('og:image') ??
      m('og:image:url') ??
      m('twitter:image') ??
      m('twitter:image:src') ??
      (ld != null ? _imageUrl(ld['image']) ?? _imageUrl(ld['thumbnailUrl']) : null) ??
      imageSrcLink ??
      m('thumbnail');
  if (imageCandidate != null) {
    final src = resolveUrl(imageCandidate, pageUrl);
    if (_isAbsoluteHttp(src)) {
      leadImage = ArticleImage(src: src!, alt: m('og:image:alt') ?? m('twitter:image:alt') ?? '');
      final w = jsNumber(m('og:image:width'));
      final h = jsNumber(m('og:image:height'));
      if (w > 0 && h > 0 && jsIsInteger(w) && jsIsInteger(h)) {
        leadImage.width = jsNum(w);
        leadImage.height = jsNum(h);
      }
    }
  }

  String? favicon;
  var best = -1.0;
  for (final l in links) {
    final rel = jsLower(l.attrs['rel'] ?? '');
    final href = l.attrs['href'];
    if (href == null || href.isEmpty || !_iconRel.hasMatch(rel)) continue;
    final sizes = _sizes.firstMatch(l.attrs['sizes'] ?? '');
    var size = sizes != null ? double.parse(sizes[1]!) : (rel.contains('apple-touch-icon') ? 180.0 : 16.0);
    if (_svgHref.hasMatch(href) || l.attrs['type'] == 'image/svg+xml') size = 120;
    if (size > 256) size = 64;
    final abs = resolveUrl(href, pageUrl);
    if (_isAbsoluteHttp(abs) && size > best) {
      best = size;
      favicon = abs;
    }
  }
  if (favicon == null) {
    final origin = _origin.firstMatch(pageUrl);
    favicon = origin == null ? null : '${origin[1]}/favicon.ico';
  }

  final description =
      m('og:description') ??
      m('description') ??
      m('twitter:description') ??
      ldStr('description') ??
      m('dc.description');
  final body = article?['articleBody'];
  final articleBody = body is String ? body : null;

  return Metadata(
    url: url,
    rawTitles: rawTitles,
    subtitle: ldStr('alternativeHeadline'),
    authors: authors,
    siteName: siteName == null ? null : decodeEntities(siteName),
    publishedAt: published,
    modifiedAt: modified,
    language: language,
    dir: dir,
    excerpt: description,
    leadImage: leadImage,
    favicon: favicon,
    articleBody: articleBody,
  );
}

final _titleSep = RegExp(r'\s+[|\-–—·•»]\s+');
final _nonAlnum = RegExp(r'[^a-z0-9]+');

String? _titleSite(String? title, String pageUrl) {
  if (title == null) return null;
  final parts = collapse(decodeEntities(title)).split(_titleSep);
  if (parts.length < 2) return null;
  final last = parts[parts.length - 1];
  final key = lettersAndNumbers(jsLower(last)).join();
  if (key.length < 3 || last.length > 40) return null;
  final m = _hostRe.firstMatch(pageUrl);
  final host = m == null ? '' : jsLower(m[1]!).replaceAll(_nonAlnum, '');
  return host.contains(key) ? last : null;
}

final _bylineClass = ClassPattern(
  r'(?:^|[\s_-])(?:byline|by-line|author|authors|author-name|authorname|writer|contributor|byline__name|post-author|entry-author|article-author|meta-author|c-byline)(?:$|[\s_-])',
);
final _authorToken = ClassPattern(r'(?:^|\s)author(?:\s|$)');
final _nameClass = ClassPattern(
  r'(?:^|[\s_-])(?:name|username|user-name|author-name|authorname|fn|byline__name|ltx_personname|nickname)(?:$|[\s_-])',
);
final _year = RegExp(r'\d{4}');

String? _findByline(VElement body) {
  String? found;
  walk(body, (el) {
    if (found != null) return false;
    final rel = el.attrs['rel'];
    final itemprop = el.attrs['itemprop'];
    final isAuthor =
        (rel != null && _authorToken.hasMatch(rel)) ||
        (itemprop != null && _authorToken.hasMatch(itemprop)) ||
        _bylineClass.hasMatch(el.matchString);
    if (!isAuthor) return true;
    var target = el;
    walk(el, (child) {
      if (!identical(child, el) && (child.attrs['itemprop'] == 'name' || _nameClass.hasMatch(child.matchString))) {
        target = child;
        return false;
      }
      return true;
    });
    final buffer = StringBuffer();
    for (final child in target.children) {
      if (child is VElement && (child.tag == 'br' || child.tag == 'div' || child.tag == 'p')) {
        if (!isBlank(buffer.toString())) break;
        continue;
      }
      buffer.write(child is VText ? child.text : '${textOf(child)} ');
    }
    final text = collapse(buffer.toString());
    if (text.length > 1 && text.length < 100 && !_year.hasMatch(text) && _cleanAuthor(text) != null) found = text;
    return found == null;
  });
  return found;
}

String? _findTime(VElement body) {
  String? found;
  walk(body, (el) {
    if (found != null) return false;
    if (el.attrs['itemprop'] == 'datePublished') {
      found = normalizeDate(el.attrs['datetime'] ?? el.attrs['content'] ?? textOf(el));
    } else if (el.tag == 'time') {
      found = normalizeDate(el.attrs['datetime'] ?? textOf(el));
    }
    return found == null;
  });
  return found;
}
