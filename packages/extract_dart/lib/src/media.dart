/// Images and embeds (`media.ts`): lazy-loaded sources, srcsets, players and
/// social posts.
library;

import 'dart:convert';

import 'js.dart';
import 'match.dart';
import 'model.dart';
import 'tree.dart';
import 'url.dart';

final _placeholder = RegExp(
  r'(?:^data:image\/(?:gif|png|svg\+xml)[;,])|(?:placeholder|blank|spacer|transparent|pixel|lazy[-_]?load|1x1|grey|gray|loading|empty|dummy|lqip|blur)[\w-]*\.(?:gif|png|svg|jpe?g|webp)(?:$|\?)',
  caseSensitive: false,
);

/// Attributes lazy loaders use for the real source, most specific first.
const _lazySrc = [
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-lazy',
  'data-url',
  'data-hi-res-src',
  'data-full-src',
  'data-original-src', //
  'data-src-large',
  'data-large-src',
  'data-src-medium',
  'data-actualsrc',
  'data-echo',
  'data-img-src',
  'data-image',
  'data-pin-media',
  'data-orig-file',
  'data-large-file',
  'data-medium-file',
  'data-fallback-src',
  'data-delayed-url',
  'data-native-src',
  'data-zoom-src',
];
const _lazySrcset = ['data-srcset', 'data-lazy-srcset', 'data-original-srcset', 'data-src-set'];

final _imageExt = RegExp(r'\.(?:jpe?g|png|webp|gif|avif|bmp|svg|jxl|heic)(?:$|[?#])', caseSensitive: false);

class _Candidate {
  _Candidate(this.url, this.width, this.density);
  final String url;
  final double width;
  final double density;
}

final _space = RegExp(r'\s');
final _trailingCommas = RegExp(r',+$');
final _httpScheme = RegExp(r'^https?:', caseSensitive: false);
final _dataImage = RegExp(r'^data:image\/(?:jpe?g|png|webp|gif)', caseSensitive: false);
final _wDesc = RegExp(r'(\d+)w');
final _xDesc = RegExp(r'([\d.]+)x');

/// Parses a srcset the way browsers do: URLs may contain commas, descriptors follow whitespace.
List<_Candidate> _parseSrcset(String value, String base) {
  final out = <_Candidate>[];
  var i = 0;
  final n = value.length;
  while (i < n) {
    while (i < n && (value.codeUnitAt(i) == 0x2c || isJsSpace(value.codeUnitAt(i)))) {
      i++;
    }
    if (i >= n) break;
    var start = i;
    while (i < n && !isJsSpace(value.codeUnitAt(i))) {
      i++;
    }
    var url = value.substring(start, i);
    var descriptor = '';
    if (url.endsWith(',')) {
      url = url.replaceFirst(_trailingCommas, '');
    } else {
      start = i;
      while (i < n && value.codeUnitAt(i) != 0x2c) {
        i++;
      }
      descriptor = jsTrim(value.substring(start, i));
    }
    final abs = resolveUrl(url, base);
    if (abs == null || (!_httpScheme.hasMatch(abs) && !_dataImage.hasMatch(abs))) continue;
    var width = 0.0;
    var density = 1.0;
    final w = _wDesc.firstMatch(descriptor);
    final x = _xDesc.firstMatch(descriptor);
    if (w != null) {
      width = double.parse(w.group(1)!);
    } else if (x != null) {
      final d = jsNumber(x.group(1));
      density = d.isNaN || d == 0 ? 1 : d;
    }
    out.add(_Candidate(abs, width, density));
  }
  return out;
}

/// Largest candidate up to 1600px wide (or 2x), else the smallest above that.
_Candidate? _bestCandidate(List<_Candidate> candidates) {
  if (candidates.isEmpty) return null;
  final byWidth = candidates.where((c) => c.width > 0).toList();
  if (byWidth.isNotEmpty) {
    _Candidate? best;
    for (final c in byWidth) {
      if (c.width <= 1600 && (best == null || c.width > best.width)) best = c;
    }
    if (best != null) return best;
    for (final c in byWidth) {
      if (best == null || c.width < best.width) best = c;
    }
    return best;
  }
  _Candidate? best;
  for (final c in candidates) {
    if (c.density <= 2 && (best == null || c.density > best.density)) best = c;
  }
  return best ?? candidates[0];
}

String? _normalizeSrcset(List<_Candidate> candidates) {
  if (candidates.length < 2) return null;
  final parts = <String>[];
  for (final c in candidates) {
    if (c.url.startsWith('data:')) continue;
    parts.add(c.width > 0 ? '${c.url} ${jsNumberToString(c.width)}w' : '${c.url} ${jsNumberToString(c.density)}x');
  }
  return parts.length >= 2 ? parts.join(', ') : null;
}

final _dimensionPattern = RegExp(r'^\s*(\d+)(?:\.\d+)?\s*(?:px)?\s*$');

int? _dimension(String? value) {
  if (value == null) return null;
  final m = _dimensionPattern.firstMatch(value);
  if (m == null) return null;
  final n = double.parse(m.group(1)!);
  return n > 0 && n < 20000 ? n.toInt() : null;
}

final _dataPrefix = RegExp(r'^data:', caseSensitive: false);
final _dataBase64 = RegExp(r'^data:image\/(?:jpe?g|png|webp|gif);base64,', caseSensitive: false);

String? _usableSrc(String? value, String base) {
  if (value == null) return null;
  final v = jsTrim(value);
  if (v.isEmpty || _placeholder.hasMatch(v)) return null;
  if (_dataPrefix.hasMatch(v)) return _dataBase64.hasMatch(v) && v.length > 2000 ? v : null;
  return resolveHttp(v, base);
}

List<_Candidate> _pictureSources(VElement picture, String base) {
  for (final source in picture.children) {
    if (source is! VElement || source.tag != 'source') continue;
    final type = (source.attrs['type'] ?? '').toLowerCase();
    if (type == 'image/avif' || type == 'image/jxl') continue;
    final media = source.attrs['media'] ?? '';
    if (media.contains('max-width') && !media.contains('min-width')) continue;
    final set = source.attrs['srcset'] ?? source.attrs['data-srcset'] ?? source.attrs['data-src'];
    if (set != null) {
      final candidates = _parseSrcset(set, base);
      if (candidates.isNotEmpty) return candidates;
    }
  }
  return [];
}

final _srcsetLike = RegExp(r'\.(?:jpe?g|png|webp)\s+\d+[wx]', caseSensitive: false);
final _tracker = RegExp(r'[/.](?:pixel|beacon|tracking|tracker|spacer)[/.]|\/(?:ads?|pagead)\/', caseSensitive: false);

VElement? _linkOf(VElement img) {
  final p = img.parent;
  if (p != null && p.tag == 'a') return p;
  final pp = p?.parent;
  if (pp != null && pp.tag == 'a') return pp;
  return null;
}

/// The image an `<img>` really shows, resolving lazy loading, srcset and `<picture>`. Null for placeholders and tracking pixels.
ArticleImage? imageFrom(VElement img, String base) {
  final a = img.attrs;
  var src = _usableSrc(a['src'], base);
  var candidates = <_Candidate>[];
  for (final key in _lazySrcset) {
    if (a[key] != null) {
      candidates = _parseSrcset(a[key]!, base);
      if (candidates.isNotEmpty) break;
    }
  }
  if (candidates.isEmpty && a['srcset'] != null) candidates = _parseSrcset(a['srcset']!, base);
  if (candidates.isEmpty && img.parent != null && img.parent!.tag == 'picture') {
    candidates = _pictureSources(img.parent!, base);
  }

  String? lazy;
  for (final key in _lazySrc) {
    lazy = _usableSrc(a[key], base);
    if (lazy != null) break;
  }
  if (lazy == null && src == null && candidates.isEmpty) {
    // Unknown lazy attribute holding an image URL.
    for (final key in jsKeys(a)) {
      if (key == 'src' || key == 'srcset' || key == 'alt' || key == 'class' || key == 'style') continue;
      final value = a[key]!;
      if (_imageExt.hasMatch(value) && !_space.hasMatch(jsTrim(value))) {
        lazy = _usableSrc(value, base);
        if (lazy != null) break;
      } else if (_srcsetLike.hasMatch(value)) {
        candidates = _parseSrcset(value, base);
        if (candidates.isNotEmpty) break;
      }
    }
  }

  final best = _bestCandidate(candidates);
  // A real src paired with a srcset: prefer the larger srcset entry; lazy attributes beat a placeholder src.
  final chosen = best != null && (best.width >= 600 || src == null) ? best.url : (lazy ?? src ?? best?.url);
  if (chosen == null) return null;
  src = chosen;

  final width = _dimension(a['width']) ?? _dimension(a['data-width']);
  final height = _dimension(a['height']) ?? _dimension(a['data-height']);
  if ((width != null && width <= 2) || (height != null && height <= 2)) return null;
  if (_tracker.hasMatch(src)) return null;

  var alt = collapse(a['alt'] ?? a['title'] ?? '');
  // Generator placeholders ("[Uncaptioned image]", "Refer to caption") and file names describe nothing.
  if (_placeholderAlt.hasMatch(alt)) alt = '';
  final image = ArticleImage(src: src, alt: alt);
  if (width != null && height != null) {
    image.width = width;
    image.height = height;
  }
  // A density srcset ("a@2x.png 2x") leaves the 1x image in src.
  if (candidates.isNotEmpty &&
      candidates.every((c) => c.width == 0) &&
      !candidates.any((c) => c.density == 1) &&
      candidates.every((c) => c.url != src)) {
    candidates = [_Candidate(src, 0, 1), ...candidates];
  }
  final srcset = _normalizeSrcset(candidates);
  if (srcset != null) image.srcset = srcset;
  final link = _linkOf(img);
  if (link != null) {
    final href = resolveHttp(link.attrs['href'] ?? '', base);
    if (href != null && _imageExt.hasMatch(href) && href != src) image.href = href;
  }
  return image;
}

final _placeholderAlt = RegExp(
  r'^\[?(?:uncaptioned image|refer to caption|image|img|photo|picture|untitled|placeholder|alt text|null|undefined)\]?$|^[\w%~+-]+\.(?:jpe?g|png|gif|webp|svg|avif)$',
  caseSensitive: false,
);

final _smallClass = ClassPattern(
  r'(?:^|[\s_-])(?:emoji|wp-smiley|icon|smiley|emoticon|inline-icon|twemoji)(?:$|[\s_-])',
);

/// Icons, emoji and avatars are small: kept inline, never as figures.
bool isSmallImage(VElement img, ArticleImage image) {
  final w = image.width ?? _dimension(img.attrs['width']);
  final h = image.height ?? _dimension(img.attrs['height']);
  if ((w != null && w <= 48) || (h != null && h <= 48 && (w == null || w <= 160))) return true;
  return _smallClass.hasMatch(img.matchString);
}

final _homeLink = RegExp(r'^https?:\/\/[^/]+\/?(?:index\.html?)?(?:[?#].*)?$', caseSensitive: false);
final _decorativeClass = ClassPattern(
  r'(?:^|[\s_-])(?:avatar|gravatar|author-(?:photo|image|avatar|img)|logo|site-logo|badge|profile-(?:pic|photo|image)|headshot|byline-image|sponsor-logo|social-icon)(?:$|[\s_-])',
);
final _avatarSrc = RegExp(r'gravatar\.com\/avatar|\/avatars?\/', caseSensitive: false);
final _portraitAlt = RegExp(
  r'^(?:photo|picture|portrait|headshot|avatar|profile (?:photo|picture)) of\s',
  caseSensitive: false,
);

/// Avatars, logos and badges are chrome, not article images.
bool isDecorativeImage(VElement img, ArticleImage image, String base) {
  // An image map is a navigation bar drawn as a picture.
  if (img.attrs['usemap'] != null || img.attrs['ismap'] != null) return true;
  // An image linking to the site's home page is its logo.
  final link = _linkOf(img);
  if (link != null) {
    final href = resolveHttp(link.attrs['href'] ?? '', base);
    if (href != null && _homeLink.hasMatch(href)) return true;
  }
  if (_decorativeClass.hasMatch(img.matchString)) return true;
  // Small portraits next to author names ("Photo of Jane Doe").
  final width = _dimension(img.attrs['width']);
  if (image.width != null && image.width! <= 160 || width != null && width <= 160) {
    if (_portraitAlt.hasMatch(image.alt)) return true;
  }
  return _avatarSrc.hasMatch(image.src);
}

// ------------------------------------------------------------------ embeds

final _youtube = RegExp(
  r'(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})',
  caseSensitive: false,
);
final _vimeo = RegExp(r'(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)', caseSensitive: false);
final _dailymotion = RegExp(r'dailymotion\.com\/(?:embed\/)?video\/([\w]+)', caseSensitive: false);
final _loom = RegExp(r'loom\.com\/(?:embed|share)\/([\w]+)', caseSensitive: false);
final _wistia = RegExp(r'(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([\w]+)', caseSensitive: false);
final _ted = RegExp(r'embed\.ted\.com\/talks\/([\w-]+)', caseSensitive: false);
final _twitch = RegExp(r'player\.twitch\.tv\/\?(?:.*&)?(video|channel)=([\w]+)', caseSensitive: false);
final _spotify = RegExp(
  r'open\.spotify\.com\/(?:embed\/)?(track|episode|show|album|playlist)\/([\w]+)',
  caseSensitive: false,
);
final _soundcloud = RegExp(r'w\.soundcloud\.com\/player\/\?(?:.*&)?url=([^&]+)', caseSensitive: false);
final _applePodcasts = RegExp(r'embed\.podcasts\.apple\.com\/([^?#]+)', caseSensitive: false);
final _codepen = RegExp(r'codepen\.io\/([\w-]+)\/(?:embed|pen)\/(?:preview\/)?([\w]+)', caseSensitive: false);
final tweet = RegExp(r'(?:twitter|x)\.com\/(\w+)\/status(?:es)?\/(\d+)', caseSensitive: false);
final _bandcamp = RegExp(r'bandcamp\.com\/EmbeddedPlayer', caseSensitive: false);

VideoBlock youtubeVideo(String id, [String? title]) {
  final video = VideoBlock(
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=$id',
    embedUrl: 'https://www.youtube-nocookie.com/embed/$id',
    poster: 'https://i.ytimg.com/vi/$id/hqdefault.jpg',
  );
  if (title != null && title.isNotEmpty) video.title = title;
  return video;
}

/// A player iframe as a video, audio or embed block; null for anything else (ads, widgets).
Block? mediaFromFrame(String src, String? title) {
  var m = _youtube.firstMatch(src);
  if (m != null) return youtubeVideo(m.group(1)!, title);
  VideoBlock video(String provider, String url, String embedUrl) {
    final block = VideoBlock(provider: provider, url: url, embedUrl: embedUrl);
    if (title != null && title.isNotEmpty) block.title = title;
    return block;
  }

  AudioBlock audio(String provider, String url, String embedUrl) {
    final block = AudioBlock(provider: provider, url: url, embedUrl: embedUrl);
    if (title != null && title.isNotEmpty) block.title = title;
    return block;
  }

  m = _vimeo.firstMatch(src);
  if (m != null) return video('vimeo', 'https://vimeo.com/${m[1]}', 'https://player.vimeo.com/video/${m[1]}');
  m = _dailymotion.firstMatch(src);
  if (m != null) {
    return video(
      'dailymotion',
      'https://www.dailymotion.com/video/${m[1]}',
      'https://www.dailymotion.com/embed/video/${m[1]}',
    );
  }
  m = _loom.firstMatch(src);
  if (m != null) return video('loom', 'https://www.loom.com/share/${m[1]}', 'https://www.loom.com/embed/${m[1]}');
  m = _wistia.firstMatch(src);
  if (m != null) return video('wistia', src, 'https://fast.wistia.net/embed/iframe/${m[1]}');
  m = _ted.firstMatch(src);
  if (m != null) return video('ted', 'https://www.ted.com/talks/${m[1]}', src);
  m = _twitch.firstMatch(src);
  if (m != null) {
    return video(
      'twitch',
      m[1] == 'video' ? 'https://www.twitch.tv/videos/${m[2]}' : 'https://www.twitch.tv/${m[2]}',
      src,
    );
  }
  m = _spotify.firstMatch(src);
  if (m != null) {
    return audio(
      'spotify',
      'https://open.spotify.com/${m[1]}/${m[2]}',
      'https://open.spotify.com/embed/${m[1]}/${m[2]}',
    );
  }
  m = _soundcloud.firstMatch(src);
  if (m != null) {
    final url = m.group(1)!;
    return audio('soundcloud', jsDecodeUriComponent(url) ?? url, src);
  }
  m = _applePodcasts.firstMatch(src);
  if (m != null) return audio('apple-podcasts', 'https://podcasts.apple.com/${m[1]}', src);
  m = _codepen.firstMatch(src);
  if (m != null) return EmbedBlock(provider: 'codepen', url: 'https://codepen.io/${m[1]}/pen/${m[2]}');
  m = tweet.firstMatch(src);
  if (m != null) return EmbedBlock(provider: 'twitter', url: 'https://twitter.com/${m[1]}/status/${m[2]}');
  if (_bandcamp.hasMatch(src)) return audio('bandcamp', src, src);
  m = _streamable.firstMatch(src);
  if (m != null) return video('streamable', 'https://streamable.com/${m[1]}', 'https://streamable.com/e/${m[1]}');
  m = _bilibili.firstMatch(src);
  if (m != null) return video('bilibili', 'https://www.bilibili.com/video/${m[1]}', src);
  m = _niconico.firstMatch(src);
  if (m != null) return video('niconico', 'https://www.nicovideo.jp/watch/${m[1]}', src);
  m = _tweetFrame.firstMatch(src);
  if (m != null) return EmbedBlock(provider: 'twitter', url: 'https://twitter.com/i/status/${m[1]}');
  m = _instagram.firstMatch(src);
  if (m != null) return EmbedBlock(provider: 'instagram', url: 'https://www.instagram.com/${m[1]}/${m[2]}/');
  m = _tiktok.firstMatch(src);
  if (m != null) return EmbedBlock(provider: 'tiktok', url: 'https://www.tiktok.com/embed/v2/${m[1]}');
  return null;
}

final _streamable = RegExp(r'streamable\.com\/(?:e|o|s)\/(\w+)', caseSensitive: false);
final _bilibili = RegExp(r'player\.bilibili\.com\/player\.html\?(?:.*&)?bvid=(BV\w+)', caseSensitive: false);
final _niconico = RegExp(r'embed\.nicovideo\.jp\/watch\/((?:sm|nm|so)?\d+)', caseSensitive: false);
final _tweetFrame = RegExp(r'platform\.twitter\.com\/embed\/Tweet\.html\?(?:.*&)?id=(\d+)', caseSensitive: false);
final _instagram = RegExp(r'instagram\.com\/(p|reel|tv)\/([\w-]+)\/embed', caseSensitive: false);
final _tiktok = RegExp(r'tiktok\.com\/embed(?:\/v2)?\/(\d+)', caseSensitive: false);

/// Hosts of interactive content (charts, maps, sandboxes, slides, documents) that publishers embed.
final _embedHosts = <(RegExp, String)>[
  (RegExp(r'(?:^|\.)(?:datawrapper\.dwcdn\.net|datawrapper\.de)$'), 'datawrapper'),
  (RegExp(r'(?:^|\.)(?:flourish\.studio|flo\.uri\.sh)$'), 'flourish'),
  (RegExp(r'(?:^|\.)infogram\.com$'), 'infogram'),
  (RegExp(r'(?:^|\.)observablehq\.com$'), 'observable'),
  (RegExp(r'(?:^|\.)public\.tableau\.com$'), 'tableau'),
  (RegExp(r'(?:^|\.)(?:plotly\.com|plot\.ly)$'), 'plotly'),
  (RegExp(r'(?:^|\.)arcgis\.com$'), 'arcgis'),
  (RegExp(r'(?:^|\.)openstreetmap\.org$'), 'openstreetmap'),
  (RegExp(r'(?:^|\.)codesandbox\.io$'), 'codesandbox'),
  (RegExp(r'(?:^|\.)stackblitz\.com$'), 'stackblitz'),
  (RegExp(r'(?:^|\.)jsfiddle\.net$'), 'jsfiddle'),
  (RegExp(r'(?:^|\.)replit\.com$'), 'replit'),
  (RegExp(r'(?:^|\.)glitch\.(?:com|me)$'), 'glitch'),
  (RegExp(r'(?:^|\.)(?:play\.rust-lang\.org|go\.dev|play\.golang\.org)$'), 'playground'),
  (RegExp(r'(?:^|\.)airtable\.com$'), 'airtable'),
  (RegExp(r'(?:^|\.)figma\.com$'), 'figma'),
  (RegExp(r'(?:^|\.)slideshare\.net$'), 'slideshare'),
  (RegExp(r'(?:^|\.)speakerdeck\.com$'), 'speakerdeck'),
  (RegExp(r'(?:^|\.)scribd\.com$'), 'scribd'),
  (RegExp(r'(?:^|\.)docs\.google\.com$'), 'google-docs'),
];

/// Frames that are never content: ads, analytics, comment and chat widgets, forms.
final _widgetFrame = RegExp(
  r'doubleclick|googlesyndication|googletagmanager|google-analytics|adservice|adsystem|adnxs|criteo|taboola|outbrain|disqus|facebook\.com\/plugins\/(?:like|share|page|follow|comments)|sharethis|addthis|recaptcha|newsletter|subscribe|signup|sign-up|login|consent|cookie|intercom|zendesk|livechat|hotjar|survey|typeform|\/ads?\/',
  caseSensitive: false,
);

const _frameSrc = ['data-src', 'data-lazy-src', 'data-cmp-src', 'data-original', 'data-url'];
final _blankScheme = RegExp(r'^(?:about|javascript|data):', caseSensitive: false);
final _httpOrRelative = RegExp(r'^(?:https?:)?\/\/', caseSensitive: false);

/// The URL a frame loads, including lazy and consent-gated copies (`data-src`, `data-cmp-src`).
String frameSource(VElement el) {
  final src = jsTrim(el.attrs['src'] ?? '');
  if (src.isNotEmpty && !_blankScheme.hasMatch(src)) return src;
  for (final key in _frameSrc) {
    final value = jsTrim(el.attrs[key] ?? '');
    if (_httpOrRelative.hasMatch(value)) return value;
  }
  for (final key in jsKeys(el.attrs)) {
    final value = jsTrim(el.attrs[key]!);
    if (key.startsWith('data-') && key.endsWith('src') && _httpOrRelative.hasMatch(value)) return value;
  }
  return '';
}

final _mermaid = RegExp(
  r'^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|sankey-beta|C4Context)\b',
);
final _percentEscape = RegExp(r'%[0-9a-f]{2}', caseSensitive: false);

/// What a frame's `data-content` carries: a link-card target URL, or diagram source.
String? _frameContent(VElement el) {
  var value = el.attrs['data-content'];
  if (value == null || value.isEmpty) return null;
  if (_percentEscape.hasMatch(value)) value = jsDecodeUriComponent(value) ?? value;
  value = jsTrim(value);
  if (charCodeAt(value, 0) == 123) {
    try {
      final json = jsonDecode(value);
      if (json is! Map) return null;
      final inner = json['data'] ?? json['content'] ?? json['source'] ?? json['url'];
      return inner is String ? jsTrim(inner) : null;
    } on FormatException {
      return null;
    }
  }
  return value;
}

final _newlines = RegExp(r'\r\n?');
final _embedSubdomain = RegExp(r'^(?:embed|embeds|player)\.');
final _embedPath = RegExp(r'\/embed(?:ded)?(?:-[a-z]+)?\/[^?#]', caseSensitive: false);

/// Any frame in the article: players and social posts, interactive content on
/// known hosts, link cards and other `/embed` endpoints, diagrams shipped as
/// source. Null for ads, widgets, forms and blank frames.
Block? frameBlock(VElement el, String base) {
  final raw = frameSource(el);
  final src = raw.isNotEmpty ? resolveHttp(raw, base) : null;
  if (src == null) return null;
  final media = mediaFromFrame(src, el.attrs['title']);
  if (media != null) return media;
  if (_widgetFrame.hasMatch(src)) return null;
  final width = el.attrs['width'];
  final height = el.attrs['height'];
  if (width == '0' || width == '1' || height == '0' || height == '1') return null;
  final content = _frameContent(el);
  if (content != null && _mermaid.hasMatch(content)) {
    return CodeBlock(code: content.replaceAll(_newlines, '\n'), language: null);
  }
  final host = hostOf(src);
  for (final (pattern, provider) in _embedHosts) {
    if (pattern.hasMatch(host)) return EmbedBlock(provider: provider, url: src);
  }
  if (_embedSubdomain.hasMatch(host) || _embedPath.hasMatch(src)) {
    final target = content != null ? resolveHttp(content, base) : null;
    return EmbedBlock(provider: 'other', url: target ?? src);
  }
  return null;
}

const _noBase = 'https://invalid.invalid/';

/// A frame the converter will keep (see [frameBlock]); usable before the page base is known.
bool isContentFrame(VElement el) => frameBlock(el, _noBase) != null;

/// `<video>`/`<audio>` elements with their own files.
Block? mediaFromElement(VElement el, String base) {
  var src = el.attrs['src'] ?? el.attrs['data-src'];
  if (src == null) {
    final source = firstElement(
      el,
      (e) => e.tag == 'source' && (e.attrs['src'] != null || e.attrs['data-src'] != null),
    );
    src = source?.attrs['src'] ?? source?.attrs['data-src'];
  }
  if (src == null) return null;
  final frame = mediaFromFrame(src, null);
  if (frame != null && frame is! EmbedBlock) return frame;
  final url = resolveHttp(src, base);
  if (url == null) return null;
  if (el.tag == 'audio') return AudioBlock(provider: 'file', url: url);
  final video = VideoBlock(provider: 'file', url: url);
  final poster = el.attrs['poster'] != null ? resolveHttp(el.attrs['poster']!, base) : null;
  if (poster != null) video.poster = poster;
  return video;
}

final _youtubeId = RegExp(r'^[\w-]{11}$');
final _videoClass = ClassPattern(r'youtube|yt-|video');
final _videoIdJson = RegExp(r'"videoId"\s*:\s*"([\w-]{11})"');

/// Video placeholders that only become players with JavaScript.
VideoBlock? lazyVideo(VElement el) {
  final id = el.attrs['videoid'] ?? el.attrs['data-youtube-id'] ?? el.attrs['data-video-id'] ?? el.attrs['data-ytid'];
  if (id != null &&
      _youtubeId.hasMatch(id) &&
      (el.tag == 'lite-youtube' || _videoClass.hasMatch(el.matchString) || el.attrs['data-youtube-id'] != null)) {
    return youtubeVideo(id, el.attrs['title'] ?? el.attrs['playlabel']);
  }
  final attrs = el.attrs['data-attrs'];
  if (attrs != null && el.matchString.contains('youtube')) {
    final m = _videoIdJson.firstMatch(attrs);
    if (m != null) return youtubeVideo(m.group(1)!);
  }
  if (el.tag == 'lite-vimeo' && el.attrs['videoid'] != null) {
    return VideoBlock(
      provider: 'vimeo',
      url: 'https://vimeo.com/${el.attrs['videoid']}',
      embedUrl: 'https://player.vimeo.com/video/${el.attrs['videoid']}',
    );
  }
  return null;
}

final _twitterClass = ClassPattern(r'twitter-tweet|twitter-video');
final _fbClass = ClassPattern(r'fb-xfbml|fb-post');

/// Social posts that publishers embed as blockquotes.
String? socialProvider(VElement el) {
  final m = el.matchString;
  if (_twitterClass.hasMatch(m)) return 'twitter';
  if (m.contains('instagram-media')) return 'instagram';
  if (m.contains('tiktok-embed')) return 'tiktok';
  if (m.contains('reddit-embed') || m.contains('reddit-card')) return 'reddit';
  if (m.contains('bluesky-embed')) return 'bluesky';
  if (m.contains('text-post-media')) return 'threads';
  if (m.contains('mastodon-embed')) return 'mastodon';
  if (_fbClass.hasMatch(m)) return 'facebook';
  return null;
}
