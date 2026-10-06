import type { Audio, Code, Embed, Image, Video } from './model';
import { hostOf, resolveHttp, resolveUrl } from './url';
import { collapse, firstElement, VElement } from './tree';

/** Placeholder sources lazy loaders put in `src` until the real image scrolls into view. */
const PLACEHOLDER = /(?:^data:image\/(?:gif|png|svg\+xml)[;,])|(?:placeholder|blank|spacer|transparent|pixel|lazy[-_]?load|1x1|grey|gray|loading|empty|dummy|lqip|blur)[\w-]*\.(?:gif|png|svg|jpe?g|webp)(?:$|\?)/i;

/** Attributes lazy loaders use for the real source, most specific first. */
const LAZY_SRC = [
  'data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src', 'data-full-src', 'data-original-src',
  'data-src-large', 'data-large-src', 'data-src-medium', 'data-actualsrc', 'data-echo', 'data-img-src', 'data-image', 'data-pin-media',
  'data-orig-file', 'data-large-file', 'data-medium-file', 'data-fallback-src', 'data-delayed-url', 'data-native-src', 'data-zoom-src',
];
const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset', 'data-original-srcset', 'data-src-set'];

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif|bmp|svg|jxl|heic)(?:$|[?#])/i;

interface Candidate {
  url: string;
  width: number;
  density: number;
}

/** Parses a srcset the way browsers do: URLs may contain commas, descriptors follow whitespace. */
export function parseSrcset(value: string, base: string): Candidate[] {
  const out: Candidate[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && (value[i] === ',' || /\s/.test(value[i]!))) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(value[i]!)) i++;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      while (i < n && value[i] !== ',') i++;
      descriptor = value.slice(start, i).trim();
    }
    const abs = resolveUrl(url, base);
    if (abs === null || (!/^https?:/i.test(abs) && !/^data:image\/(?:jpe?g|png|webp|gif)/i.test(abs))) continue;
    let width = 0;
    let density = 1;
    const w = /(\d+)w/.exec(descriptor);
    const x = /([\d.]+)x/.exec(descriptor);
    if (w !== null) width = Number(w[1]);
    else if (x !== null) density = Number(x[1]) || 1;
    out.push({ url: abs, width, density });
  }
  return out;
}

/** Largest candidate up to 1600px wide (or 2x), else the smallest above that. */
function bestCandidate(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  const byWidth = candidates.filter((c) => c.width > 0);
  if (byWidth.length > 0) {
    let best: Candidate | null = null;
    for (const c of byWidth) if (c.width <= 1600 && (best === null || c.width > best.width)) best = c;
    if (best !== null) return best;
    for (const c of byWidth) if (best === null || c.width < best.width) best = c;
    return best;
  }
  let best: Candidate | null = null;
  for (const c of candidates) if (c.density <= 2 && (best === null || c.density > best.density)) best = c;
  return best ?? candidates[0]!;
}

function normalizeSrcset(candidates: Candidate[]): string | undefined {
  if (candidates.length < 2) return undefined;
  const parts: string[] = [];
  for (const c of candidates) {
    if (c.url.startsWith('data:')) continue;
    parts.push(c.width > 0 ? c.url + ' ' + c.width + 'w' : c.url + ' ' + c.density + 'x');
  }
  return parts.length >= 2 ? parts.join(', ') : undefined;
}

function dimension(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^\s*(\d+)(?:\.\d+)?\s*(?:px)?\s*$/.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return n > 0 && n < 20000 ? n : undefined;
}

function usableSrc(value: string | undefined, base: string): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v.length === 0 || PLACEHOLDER.test(v)) return null;
  if (/^data:/i.test(v)) return /^data:image\/(?:jpe?g|png|webp|gif);base64,/i.test(v) && v.length > 2000 ? v : null;
  return resolveHttp(v, base);
}

function pictureSources(picture: VElement, base: string): Candidate[] {
  for (const source of picture.children) {
    if (source.kind !== 1 || source.tag !== 'source') continue;
    const type = (source.attrs['type'] ?? '').toLowerCase();
    if (type === 'image/avif' || type === 'image/jxl') continue;
    const media = source.attrs['media'] ?? '';
    if (/max-width/.test(media) && !/min-width/.test(media)) continue;
    const set = source.attrs['srcset'] ?? source.attrs['data-srcset'] ?? source.attrs['data-src'];
    if (set !== undefined) {
      const candidates = parseSrcset(set, base);
      if (candidates.length > 0) return candidates;
    }
  }
  return [];
}

/** The image an `<img>` really shows, resolving lazy loading, srcset and `<picture>`. Null for placeholders and tracking pixels. */
export function imageFrom(img: VElement, base: string): Image | null {
  const a = img.attrs;
  let src = usableSrc(a['src'], base);
  let candidates: Candidate[] = [];
  for (const key of LAZY_SRCSET) {
    if (a[key] !== undefined) {
      candidates = parseSrcset(a[key]!, base);
      if (candidates.length > 0) break;
    }
  }
  if (candidates.length === 0 && a['srcset'] !== undefined) candidates = parseSrcset(a['srcset'], base);
  if (candidates.length === 0 && img.parent !== null && img.parent.tag === 'picture') candidates = pictureSources(img.parent, base);

  let lazy: string | null = null;
  for (const key of LAZY_SRC) {
    lazy = usableSrc(a[key], base);
    if (lazy !== null) break;
  }
  if (lazy === null && src === null && candidates.length === 0) {
    // Unknown lazy attribute holding an image URL.
    for (const key in a) {
      if (key === 'src' || key === 'srcset' || key === 'alt' || key === 'class' || key === 'style') continue;
      const value = a[key]!;
      if (IMAGE_EXT.test(value) && !/\s/.test(value.trim())) {
        lazy = usableSrc(value, base);
        if (lazy !== null) break;
      } else if (/\.(?:jpe?g|png|webp)\s+\d+[wx]/i.test(value)) {
        candidates = parseSrcset(value, base);
        if (candidates.length > 0) break;
      }
    }
  }

  const best = bestCandidate(candidates);
  // A real src paired with a srcset: prefer the larger srcset entry; lazy attributes beat a placeholder src.
  const chosen = best !== null && (best.width >= 600 || src === null) ? best.url : (lazy ?? src ?? best?.url ?? null);
  if (chosen === null) return null;
  src = chosen;

  const width = dimension(a['width']) ?? dimension(a['data-width']);
  const height = dimension(a['height']) ?? dimension(a['data-height']);
  if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2)) return null;
  if (/[/.](?:pixel|beacon|tracking|tracker|spacer)[/.]|\/(?:ads?|pagead)\//i.test(src)) return null;

  const image: Image = { src, alt: collapse(a['alt'] ?? a['title'] ?? '') };
  if (width !== undefined && height !== undefined) {
    image.width = width;
    image.height = height;
  }
  const srcset = normalizeSrcset(candidates);
  if (srcset !== undefined) image.srcset = srcset;
  const link = img.parent !== null && img.parent.tag === 'a' ? img.parent : img.parent?.parent?.tag === 'a' ? img.parent.parent : null;
  if (link !== null) {
    const href = resolveHttp(link.attrs['href'] ?? '', base);
    if (href !== null && IMAGE_EXT.test(href) && href !== src) image.href = href;
  }
  return image;
}

/** Icons, emoji and avatars are small: kept inline, never as figures. */
export function isSmallImage(img: VElement, image: Image): boolean {
  const w = image.width ?? dimension(img.attrs['width']);
  const h = image.height ?? dimension(img.attrs['height']);
  if ((w !== undefined && w <= 48) || (h !== undefined && h <= 48 && (w === undefined || w <= 160))) return true;
  return /(?:^|[\s_-])(?:emoji|wp-smiley|icon|smiley|emoticon|inline-icon|twemoji)(?:$|[\s_-])/.test(img.matchString);
}

/** Avatars, logos and badges are chrome, not article images. */
export function isDecorativeImage(img: VElement, image: Image, base: string): boolean {
  // An image linking to the site's home page is its logo.
  const link = img.parent !== null && img.parent.tag === 'a' ? img.parent : img.parent?.parent?.tag === 'a' ? img.parent.parent : null;
  if (link !== null) {
    const href = resolveHttp(link.attrs['href'] ?? '', base);
    if (href !== null && /^https?:\/\/[^/]+\/?(?:index\.html?)?(?:[?#].*)?$/i.test(href)) return true;
  }
  if (/(?:^|[\s_-])(?:avatar|gravatar|author-(?:photo|image|avatar|img)|logo|site-logo|badge|profile-(?:pic|photo|image)|headshot|byline-image|sponsor-logo|social-icon)(?:$|[\s_-])/.test(img.matchString)) return true;
  // Small portraits next to author names ("Photo of Jane Doe").
  if (image.width !== undefined && image.width <= 160 || dimension(img.attrs['width']) !== undefined && dimension(img.attrs['width'])! <= 160) {
    if (/^(?:photo|picture|portrait|headshot|avatar|profile (?:photo|picture)) of\s/i.test(image.alt)) return true;
  }
  return /gravatar\.com\/avatar|\/avatars?\//i.test(image.src);
}

// ------------------------------------------------------------------ embeds

const YOUTUBE = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const VIMEO = /(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)/i;
const DAILYMOTION = /dailymotion\.com\/(?:embed\/)?video\/([\w]+)/i;
const LOOM = /loom\.com\/(?:embed|share)\/([\w]+)/i;
const WISTIA = /(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([\w]+)/i;
const TED = /embed\.ted\.com\/talks\/([\w-]+)/i;
const TWITCH = /player\.twitch\.tv\/\?(?:.*&)?(video|channel)=([\w]+)/i;
const SPOTIFY = /open\.spotify\.com\/(?:embed\/)?(track|episode|show|album|playlist)\/([\w]+)/i;
const SOUNDCLOUD = /w\.soundcloud\.com\/player\/\?(?:.*&)?url=([^&]+)/i;
const APPLE_PODCASTS = /embed\.podcasts\.apple\.com\/([^?#]+)/i;
const CODEPEN = /codepen\.io\/([\w-]+)\/(?:embed|pen)\/(?:preview\/)?([\w]+)/i;
const TWEET = /(?:twitter|x)\.com\/(\w+)\/status(?:es)?\/(\d+)/i;

export function youtubeVideo(id: string, title?: string): Video {
  const video: Video = {
    type: 'video',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=' + id,
    embedUrl: 'https://www.youtube-nocookie.com/embed/' + id,
    poster: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
  };
  if (title !== undefined && title.length > 0) video.title = title;
  return video;
}

/** A player iframe as a video, audio or embed block; null for anything else (ads, widgets). */
export function mediaFromFrame(src: string, title: string | undefined): Video | Audio | Embed | null {
  let m = YOUTUBE.exec(src);
  if (m !== null) return youtubeVideo(m[1]!, title);
  const withTitle = <T extends Video | Audio>(block: T): T => {
    if (title !== undefined && title.length > 0) block.title = title;
    return block;
  };
  m = VIMEO.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'vimeo', url: 'https://vimeo.com/' + m[1], embedUrl: 'https://player.vimeo.com/video/' + m[1] });
  m = DAILYMOTION.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'dailymotion', url: 'https://www.dailymotion.com/video/' + m[1], embedUrl: 'https://www.dailymotion.com/embed/video/' + m[1] });
  m = LOOM.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'loom', url: 'https://www.loom.com/share/' + m[1], embedUrl: 'https://www.loom.com/embed/' + m[1] });
  m = WISTIA.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'wistia', url: src, embedUrl: 'https://fast.wistia.net/embed/iframe/' + m[1] });
  m = TED.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'ted', url: 'https://www.ted.com/talks/' + m[1], embedUrl: src });
  m = TWITCH.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'twitch', url: m[1] === 'video' ? 'https://www.twitch.tv/videos/' + m[2] : 'https://www.twitch.tv/' + m[2], embedUrl: src });
  m = SPOTIFY.exec(src);
  if (m !== null) return withTitle({ type: 'audio', provider: 'spotify', url: 'https://open.spotify.com/' + m[1] + '/' + m[2], embedUrl: 'https://open.spotify.com/embed/' + m[1] + '/' + m[2] });
  m = SOUNDCLOUD.exec(src);
  if (m !== null) {
    let url = m[1]!;
    try {
      url = decodeURIComponent(url);
    } catch {
      /* keep encoded */
    }
    return withTitle({ type: 'audio', provider: 'soundcloud', url, embedUrl: src });
  }
  m = APPLE_PODCASTS.exec(src);
  if (m !== null) return withTitle({ type: 'audio', provider: 'apple-podcasts', url: 'https://podcasts.apple.com/' + m[1], embedUrl: src });
  m = CODEPEN.exec(src);
  if (m !== null) return { type: 'embed', provider: 'codepen', url: 'https://codepen.io/' + m[1] + '/pen/' + m[2] };
  m = TWEET.exec(src);
  if (m !== null) return { type: 'embed', provider: 'twitter', url: 'https://twitter.com/' + m[1] + '/status/' + m[2] };
  if (/bandcamp\.com\/EmbeddedPlayer/i.test(src)) return withTitle({ type: 'audio', provider: 'bandcamp', url: src, embedUrl: src });
  m = STREAMABLE.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'streamable', url: 'https://streamable.com/' + m[1], embedUrl: 'https://streamable.com/e/' + m[1] });
  m = BILIBILI.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'bilibili', url: 'https://www.bilibili.com/video/' + m[1], embedUrl: src });
  m = NICONICO.exec(src);
  if (m !== null) return withTitle({ type: 'video', provider: 'niconico', url: 'https://www.nicovideo.jp/watch/' + m[1], embedUrl: src });
  m = TWEET_FRAME.exec(src);
  if (m !== null) return { type: 'embed', provider: 'twitter', url: 'https://twitter.com/i/status/' + m[1] };
  m = INSTAGRAM.exec(src);
  if (m !== null) return { type: 'embed', provider: 'instagram', url: 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/' };
  m = TIKTOK.exec(src);
  if (m !== null) return { type: 'embed', provider: 'tiktok', url: 'https://www.tiktok.com/embed/v2/' + m[1] };
  return null;
}

const STREAMABLE = /streamable\.com\/(?:e|o|s)\/(\w+)/i;
const BILIBILI = /player\.bilibili\.com\/player\.html\?(?:.*&)?bvid=(BV\w+)/i;
const NICONICO = /embed\.nicovideo\.jp\/watch\/((?:sm|nm|so)?\d+)/i;
const TWEET_FRAME = /platform\.twitter\.com\/embed\/Tweet\.html\?(?:.*&)?id=(\d+)/i;
const INSTAGRAM = /instagram\.com\/(p|reel|tv)\/([\w-]+)\/embed/i;
const TIKTOK = /tiktok\.com\/embed(?:\/v2)?\/(\d+)/i;

/** Hosts of interactive content (charts, maps, sandboxes, slides, documents) that publishers embed. */
const EMBED_HOSTS: [RegExp, string][] = [
  [/(?:^|\.)(?:datawrapper\.dwcdn\.net|datawrapper\.de)$/, 'datawrapper'],
  [/(?:^|\.)(?:flourish\.studio|flo\.uri\.sh)$/, 'flourish'],
  [/(?:^|\.)infogram\.com$/, 'infogram'],
  [/(?:^|\.)observablehq\.com$/, 'observable'],
  [/(?:^|\.)public\.tableau\.com$/, 'tableau'],
  [/(?:^|\.)(?:plotly\.com|plot\.ly)$/, 'plotly'],
  [/(?:^|\.)arcgis\.com$/, 'arcgis'],
  [/(?:^|\.)openstreetmap\.org$/, 'openstreetmap'],
  [/(?:^|\.)codesandbox\.io$/, 'codesandbox'],
  [/(?:^|\.)stackblitz\.com$/, 'stackblitz'],
  [/(?:^|\.)jsfiddle\.net$/, 'jsfiddle'],
  [/(?:^|\.)replit\.com$/, 'replit'],
  [/(?:^|\.)glitch\.(?:com|me)$/, 'glitch'],
  [/(?:^|\.)(?:play\.rust-lang\.org|go\.dev|play\.golang\.org)$/, 'playground'],
  [/(?:^|\.)airtable\.com$/, 'airtable'],
  [/(?:^|\.)figma\.com$/, 'figma'],
  [/(?:^|\.)slideshare\.net$/, 'slideshare'],
  [/(?:^|\.)speakerdeck\.com$/, 'speakerdeck'],
  [/(?:^|\.)scribd\.com$/, 'scribd'],
  [/(?:^|\.)docs\.google\.com$/, 'google-docs'],
];

/** Frames that are never content: ads, analytics, comment and chat widgets, forms. */
const WIDGET_FRAME = /doubleclick|googlesyndication|googletagmanager|google-analytics|adservice|adsystem|adnxs|criteo|taboola|outbrain|disqus|facebook\.com\/plugins\/(?:like|share|page|follow|comments)|sharethis|addthis|recaptcha|newsletter|subscribe|signup|sign-up|login|consent|cookie|intercom|zendesk|livechat|hotjar|survey|typeform|\/ads?\//i;

const FRAME_SRC = ['data-src', 'data-lazy-src', 'data-cmp-src', 'data-original', 'data-url'];

/** The URL a frame loads, including lazy and consent-gated copies (`data-src`, `data-cmp-src`). */
export function frameSource(el: VElement): string {
  const src = (el.attrs['src'] ?? '').trim();
  if (src.length > 0 && !/^(?:about|javascript|data):/i.test(src)) return src;
  for (const key of FRAME_SRC) {
    const value = (el.attrs[key] ?? '').trim();
    if (/^(?:https?:)?\/\//i.test(value)) return value;
  }
  for (const key in el.attrs) {
    const value = el.attrs[key]!.trim();
    if (key.startsWith('data-') && key.endsWith('src') && /^(?:https?:)?\/\//i.test(value)) return value;
  }
  return '';
}

const MERMAID = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|sankey-beta|C4Context)\b/;

/** What a frame's `data-content` carries: a link-card target URL, or diagram source. */
function frameContent(el: VElement): string | null {
  let value = el.attrs['data-content'];
  if (value === undefined || value.length === 0) return null;
  if (/%[0-9a-f]{2}/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep encoded */
    }
  }
  value = value.trim();
  if (value.charCodeAt(0) === 123) {
    try {
      const json = JSON.parse(value) as Record<string, unknown>;
      const inner = json['data'] ?? json['content'] ?? json['source'] ?? json['url'];
      return typeof inner === 'string' ? inner.trim() : null;
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Any frame in the article: players and social posts, interactive content on
 * known hosts, link cards and other `/embed` endpoints, diagrams shipped as
 * source. Null for ads, widgets, forms and blank frames.
 */
export function frameBlock(el: VElement, base: string): Video | Audio | Embed | Code | null {
  const raw = frameSource(el);
  const src = raw.length > 0 ? resolveHttp(raw, base) : null;
  if (src === null) return null;
  const media = mediaFromFrame(src, el.attrs['title']);
  if (media !== null) return media;
  if (WIDGET_FRAME.test(src)) return null;
  const width = el.attrs['width'];
  const height = el.attrs['height'];
  if (width === '0' || width === '1' || height === '0' || height === '1') return null;
  const content = frameContent(el);
  if (content !== null && MERMAID.test(content)) return { type: 'code', code: content.replace(/\r\n?/g, '\n'), language: null };
  const host = hostOf(src);
  for (const [pattern, provider] of EMBED_HOSTS) if (pattern.test(host)) return { type: 'embed', provider, url: src };
  if (/^(?:embed|embeds|player)\./.test(host) || /\/embed(?:ded)?(?:-[a-z]+)?\/[^?#]/i.test(src)) {
    const target = content !== null ? resolveHttp(content, base) : null;
    return { type: 'embed', provider: 'other', url: target ?? src };
  }
  return null;
}

const NO_BASE = 'https://invalid.invalid/';

/** A frame the converter will keep (see `frameBlock`); usable before the page base is known. */
export function isContentFrame(el: VElement): boolean {
  return frameBlock(el, NO_BASE) !== null;
}

/** `<video>`/`<audio>` elements with their own files. */
export function mediaFromElement(el: VElement, base: string): Video | Audio | null {
  let src: string | undefined = el.attrs['src'] ?? el.attrs['data-src'];
  if (src === undefined) {
    const source = firstElement(el, (e) => e.tag === 'source' && (e.attrs['src'] !== undefined || e.attrs['data-src'] !== undefined));
    src = source?.attrs['src'] ?? source?.attrs['data-src'];
  }
  if (src === undefined) return null;
  const frame = mediaFromFrame(src, undefined);
  if (frame !== null && frame.type !== 'embed') return frame;
  const url = resolveHttp(src, base);
  if (url === null) return null;
  if (el.tag === 'audio') return { type: 'audio', provider: 'file', url };
  const video: Video = { type: 'video', provider: 'file', url };
  const poster = el.attrs['poster'] !== undefined ? resolveHttp(el.attrs['poster'], base) : null;
  if (poster !== null) video.poster = poster;
  return video;
}

/** Video placeholders that only become players with JavaScript. */
export function lazyVideo(el: VElement): Video | null {
  const id = el.attrs['videoid'] ?? el.attrs['data-youtube-id'] ?? el.attrs['data-video-id'] ?? el.attrs['data-ytid'] ?? null;
  if (id !== null && /^[\w-]{11}$/.test(id) && (el.tag === 'lite-youtube' || /youtube|yt-|video/.test(el.matchString) || el.attrs['data-youtube-id'] !== undefined)) {
    return youtubeVideo(id, el.attrs['title'] ?? el.attrs['playlabel']);
  }
  const attrs = el.attrs['data-attrs'];
  if (attrs !== undefined && /youtube/.test(el.matchString)) {
    const m = /"videoId"\s*:\s*"([\w-]{11})"/.exec(attrs);
    if (m !== null) return youtubeVideo(m[1]!);
  }
  if (el.tag === 'lite-vimeo' && el.attrs['videoid'] !== undefined) {
    return { type: 'video', provider: 'vimeo', url: 'https://vimeo.com/' + el.attrs['videoid'], embedUrl: 'https://player.vimeo.com/video/' + el.attrs['videoid'] };
  }
  return null;
}

/** Social posts that publishers embed as blockquotes. */
export function socialProvider(el: VElement): string | null {
  const m = el.matchString;
  if (/twitter-tweet|twitter-video/.test(m)) return 'twitter';
  if (/instagram-media/.test(m)) return 'instagram';
  if (/tiktok-embed/.test(m)) return 'tiktok';
  if (/reddit-embed/.test(m) || /reddit-card/.test(m)) return 'reddit';
  if (/bluesky-embed/.test(m)) return 'bluesky';
  if (/text-post-media/.test(m)) return 'threads';
  if (/mastodon-embed/.test(m)) return 'mastodon';
  if (/fb-xfbml|fb-post/.test(m)) return 'facebook';
  return null;
}

export { TWEET };
