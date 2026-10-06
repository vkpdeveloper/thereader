import type { Image } from './model';
import { canonicalUrl, resolveUrl } from './url';
import { collapse, textOf, walk, type VDocument, type VElement } from './tree';

export interface Metadata {
  url: string;
  title: string | null;
  /** Title as written in <title>/og:title, before cleaning. Used to recognise the in-page heading. */
  rawTitles: string[];
  subtitle: string | null;
  authors: string[];
  siteName: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  language: string | null;
  dir: 'ltr' | 'rtl' | null;
  excerpt: string | null;
  leadImage: Image | null;
  favicon: string | null;
  /** schema.org `articleBody`, when the page ships its text as structured data. */
  articleBody: string | null;
}

const ARTICLE_TYPES = new Set([
  'article', 'newsarticle', 'blogposting', 'techarticle', 'scholarlyarticle', 'report', 'reportagenewsarticle',
  'analysisnewsarticle', 'opinionnewsarticle', 'reviewnewsarticle', 'backgroundnewsarticle', 'liveblogposting', 'socialmediaposting', 'discussionforumposting', 'medicalscholarlyarticle', 'advertisercontentarticle',
  'satiricalarticle', 'askpublicnewsarticle', 'review', 'howto', 'recipe', 'creativework', 'posting',
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function parseJsonLd(source: string): Json | null {
  const text = source.trim().replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '');
  try {
    return JSON.parse(text) as Json;
  } catch {
    try {
      // Common publisher mistakes: raw newlines in strings, trailing commas.
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1')) as Json;
    } catch {
      return null;
    }
  }
}

function typesOf(node: { [key: string]: Json }): string[] {
  const t = node['@type'];
  if (typeof t === 'string') return [t.toLowerCase()];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
  return [];
}

function jsonObjects(value: Json, out: { [key: string]: Json }[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) jsonObjects(item, out, depth + 1);
    return;
  }
  out.push(value);
  const graph = value['@graph'];
  if (graph !== undefined) jsonObjects(graph, out, depth + 1);
  const main = value['mainEntity'];
  if (main !== undefined && typeof main === 'object') jsonObjects(main, out, depth + 1);
}

function str(value: Json | undefined): string | null {
  if (typeof value === 'string') {
    const s = collapse(decodeEntities(value));
    return s.length > 0 ? s : null;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

function names(value: Json | undefined, out: string[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    const s = str(value);
    if (s !== null) out.push(s);
  } else if (Array.isArray(value)) {
    for (const item of value) names(item, out);
  } else if (typeof value === 'object') {
    const n = str(value['name']);
    if (n !== null) out.push(n);
    else {
      const given = str(value['givenName']);
      const family = str(value['familyName']);
      if (given !== null || family !== null) out.push(collapse((given ?? '') + ' ' + (family ?? '')));
    }
  }
}

function imageUrl(value: Json | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = imageUrl(item);
      if (url !== null) return url;
    }
    return null;
  }
  if (typeof value === 'object') return str(value['url']) ?? str(value['contentUrl']) ?? str(value['@id']);
  return null;
}

const ENTITIES = new Map<string, string>([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0']]);

/** Decodes the handful of entities publishers double-encode into metadata strings. */
export function decodeEntities(value: string): string {
  if (value.indexOf('&') < 0) return value;
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.charCodeAt(0) === 35) {
      const code = key.charCodeAt(1) === 120 ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES.get(key) ?? match;
  });
}

const MONTHS: Record<string, number> = Object.assign(Object.create(null) as {}, {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
});

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** ISO 8601 when the value is (or plainly spells) a date; otherwise null. */
export function normalizeDate(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(v);
  if (iso !== null) {
    const date = iso[1] + '-' + iso[2] + '-' + iso[3];
    if (iso[4] === undefined) return date;
    let zone = iso[7] ?? '';
    if (zone.length === 5) zone = zone.slice(0, 3) + ':' + zone.slice(3);
    return date + 'T' + iso[4] + ':' + iso[5] + ':' + (iso[6] ?? '00') + zone;
  }
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})?)?$/.exec(v);
  if (compact !== null) return compact[1] + '-' + compact[2] + '-' + compact[3];
  const mdy = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(v);
  if (mdy !== null) {
    const m = MONTHS[mdy[1]!.toLowerCase()];
    if (m !== undefined) return mdy[3] + '-' + pad(m) + '-' + pad(Number(mdy[2]));
  }
  const dmy = /(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(v);
  if (dmy !== null) {
    const m = MONTHS[dmy[2]!.toLowerCase()];
    if (m !== undefined) return dmy[3] + '-' + pad(m) + '-' + pad(Number(dmy[1]));
  }
  return null;
}

function normalizeLanguage(value: string | null): string | null {
  if (value === null) return null;
  const m = /^\s*([A-Za-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z]{2}|\d{3}))?/.exec(value);
  if (m === null) return null;
  let tag = m[1]!.toLowerCase();
  if (m[2] !== undefined) tag += '-' + m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
  if (m[3] !== undefined) tag += '-' + m[3]!.toUpperCase();
  return tag;
}

const BYLINE_PREFIX = /^(?:by|written by|posted by|words by|author|authors|von|par|por|di|door|av|af|przez|автор|от|作者|著者|筆者|文|撰文|글|المؤلف|بقلم|מאת)(?:\s*[:：\-]\s*|\s+)/i;

function cleanAuthor(value: string): string | null {
  let s = collapse(value).replace(BYLINE_PREFIX, '');
  if (/^https?:\/\//i.test(s) || s.indexOf('@') >= 0 || /\d{2,}/.test(s) || /affiliation|email|e-mail|profile|follow|subscribe|message/i.test(s)) return null;
  if (s.split(' ').length > 8) return null;
  s = s.replace(/\s*[|·•,]\s*$/, '').trim();
  if (s.length < 2 || s.length > 100) return null;
  return s;
}

function addAuthors(raw: string[], out: string[]): void {
  for (const value of raw) {
    for (const part of value.split(/\s*(?:,|;|\band\b|&|\bund\b|\bet\b|\by\b|،)\s*/)) {
      const name = cleanAuthor(part);
      if (name !== null && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
}

function isAbsoluteHttp(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

function sameSite(a: string, b: string): boolean {
  const host = (u: string) => {
    const m = /^https?:\/\/([^/:?#]+)/i.exec(u);
    if (m === null) return '';
    const parts = m[1]!.toLowerCase().split('.');
    return parts.slice(Math.max(0, parts.length - 2)).join('.');
  };
  return host(a) !== '' && host(a) === host(b);
}

function pathOf(url: string): string {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url);
  return m === null || m[1] === '' ? '/' : m[1]!;
}

/** Reads metadata from <head>, JSON-LD, microdata and well-known byline markup. */
export function readMetadata(doc: VDocument, pageUrl: string): Metadata {
  const meta = new Map<string, string>();
  const links: VElement[] = [];
  let titleTag: string | null = null;

  const readMeta = (el: VElement) => {
    if (el.tag === 'meta') {
      const key = (el.attrs['property'] ?? el.attrs['name'] ?? el.attrs['itemprop'] ?? el.attrs['http-equiv'] ?? '').toLowerCase().trim();
      const content = el.attrs['content'];
      if (key.length > 0 && content !== undefined && content.trim().length > 0 && !meta.has(key)) meta.set(key, collapse(decodeEntities(content)));
    } else if (el.tag === 'link') {
      links.push(el);
    } else if (el.tag === 'title' && titleTag === null) {
      titleTag = textOf(el);
    }
  };
  if (doc.head !== null) walk(doc.head, (el) => readMeta(el));
  walk(doc.body, (el) => {
    if (el.tag === 'meta' || el.tag === 'link') readMeta(el);
    else if (el.tag === 'title' && titleTag === null) titleTag = textOf(el);
  });

  // JSON-LD: the article node, plus the page's publisher.
  let article: { [key: string]: Json } | null = null;
  let webPage: { [key: string]: Json } | null = null;
  let siteNode: string | null = null;
  for (const source of doc.jsonLd) {
    const parsed = parseJsonLd(source);
    if (parsed === null) continue;
    const objects: { [key: string]: Json }[] = [];
    jsonObjects(parsed, objects);
    for (const obj of objects) {
      const types = typesOf(obj);
      if (article === null && types.some((t) => ARTICLE_TYPES.has(t))) article = obj;
      else if (webPage === null && types.some((t) => t === 'webpage' || t === 'itempage' || t === 'aboutpage' || t === 'collectionpage')) webPage = obj;
      if (siteNode === null && types.some((t) => t === 'website' || t === 'organization' || t === 'newsmediaorganization')) {
        siteNode = str(obj['name']);
      }
    }
  }
  const ld = article ?? webPage;

  const m = (key: string): string | null => meta.get(key) ?? null;
  const ldStr = (key: string): string | null => (ld === null ? null : str(ld[key]));

  // Site name.
  let publisher: string | null = null;
  if (ld !== null) {
    const p = ld['publisher'];
    if (p !== undefined && p !== null && typeof p === 'object' && !Array.isArray(p)) publisher = str(p['name']);
  }
  const siteName = m('og:site_name') ?? titleSite(titleTag ?? m('og:title'), pageUrl) ?? publisher ?? siteNode ?? m('application-name') ?? m('apple-mobile-web-app-title') ?? m('twitter:site:name') ?? null;

  // Authors.
  const rawAuthors: string[] = [];
  if (ld !== null) names(ld['author'], rawAuthors);
  if (rawAuthors.length === 0 && ld !== null) names(ld['creator'], rawAuthors);
  for (const key of ['author', 'article:author', 'parsely-author', 'sailthru.author', 'dc.creator', 'dcterms.creator', 'byl', 'twitter:creator:name', 'citation_author']) {
    if (rawAuthors.length > 0) break;
    const v = m(key);
    if (v !== null) rawAuthors.push(v);
  }
  if (rawAuthors.length === 0) {
    const found = findByline(doc.body);
    if (found !== null) rawAuthors.push(found);
  }
  const authors: string[] = [];
  addAuthors(rawAuthors, authors);
  if (siteName !== null) {
    const site = siteName.toLowerCase();
    for (let i = authors.length - 1; i >= 0; i--) if (authors[i]!.toLowerCase() === site) authors.splice(i, 1);
  }

  // Dates.
  let published = normalizeDate(ldStr('datePublished') ?? ldStr('dateCreated'));
  for (const key of ['article:published_time', 'og:article:published_time', 'published_time', 'datepublished', 'pubdate', 'publishdate', 'publish-date', 'date', 'dc.date.issued', 'dc.date', 'dcterms.created', 'parsely-pub-date', 'sailthru.date', 'citation_publication_date', 'citation_date', 'article.published', 'og:updated_time']) {
    if (published !== null) break;
    published = normalizeDate(m(key));
  }
  if (published === null) published = findTime(doc.body);
  const modified = normalizeDate(ldStr('dateModified') ?? m('article:modified_time') ?? m('og:updated_time') ?? m('datemodified') ?? m('dcterms.modified'));

  // Title.
  const rawTitles: string[] = [];
  for (const t of [m('og:title'), ldStr('headline'), m('twitter:title'), titleTag, ldStr('name'), m('dc.title'), m('citation_title'), m('parsely-title'), m('sailthru.title')]) {
    if (t !== null && t.length > 0 && rawTitles.indexOf(t) < 0) rawTitles.push(decodeEntities(t));
  }

  // Language and direction.
  const htmlLang = doc.root.attrs['lang'] ?? doc.root.attrs['xml:lang'] ?? doc.body.attrs['lang'] ?? null;
  const language = normalizeLanguage(htmlLang ?? m('content-language') ?? m('og:locale') ?? ldStr('inLanguage') ?? m('language') ?? m('dc.language'));
  const dirAttr = (doc.root.attrs['dir'] ?? doc.body.attrs['dir'] ?? '').toLowerCase();
  const dir = dirAttr === 'rtl' ? 'rtl' : dirAttr === 'ltr' ? 'ltr' : null;

  // Canonical URL.
  let url = canonicalUrl(pageUrl);
  const canonicalLink = links.find((l) => /(?:^|\s)canonical(?:\s|$)/i.test(l.attrs['rel'] ?? '') && l.attrs['href']);
  for (const candidate of [canonicalLink?.attrs['href'] ?? null, m('og:url')]) {
    if (candidate === null) continue;
    const abs = resolveUrl(candidate, pageUrl);
    if (isAbsoluteHttp(abs) && sameSite(abs, pageUrl) && !(pathOf(abs) === '/' && pathOf(pageUrl) !== '/')) {
      url = canonicalUrl(abs);
      break;
    }
  }

  // Lead image.
  let leadImage: Image | null = null;
  const imageCandidate =
    m('og:image:secure_url') ?? m('og:image') ?? m('og:image:url') ?? m('twitter:image') ?? m('twitter:image:src') ??
    (ld !== null ? imageUrl(ld['image']) ?? imageUrl(ld['thumbnailUrl']) : null) ??
    links.find((l) => (l.attrs['rel'] ?? '').toLowerCase() === 'image_src')?.attrs['href'] ?? m('thumbnail') ?? null;
  if (imageCandidate !== null) {
    const src = resolveUrl(imageCandidate, pageUrl);
    if (isAbsoluteHttp(src)) {
      leadImage = { src, alt: m('og:image:alt') ?? m('twitter:image:alt') ?? '' };
      const w = Number(m('og:image:width'));
      const h = Number(m('og:image:height'));
      if (w > 0 && h > 0 && Number.isInteger(w) && Number.isInteger(h)) {
        leadImage.width = w;
        leadImage.height = h;
      }
    }
  }

  // Favicon: the largest declared icon; apple-touch icons are usually 180px.
  let favicon: string | null = null;
  let best = -1;
  for (const l of links) {
    const rel = (l.attrs['rel'] ?? '').toLowerCase();
    const href = l.attrs['href'];
    if (!href || !/(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/.test(rel)) continue;
    const sizes = /(\d+)x\d+/.exec(l.attrs['sizes'] ?? '');
    let size = sizes !== null ? Number(sizes[1]) : rel.indexOf('apple-touch-icon') >= 0 ? 180 : 16;
    if (/\.svg(?:$|\?)/i.test(href) || l.attrs['type'] === 'image/svg+xml') size = 120;
    if (size > 256) size = 64;
    const abs = resolveUrl(href, pageUrl);
    if (isAbsoluteHttp(abs) && size > best) {
      best = size;
      favicon = abs;
    }
  }
  if (favicon === null) {
    const origin = /^(https?:\/\/[^/?#]+)/i.exec(pageUrl);
    favicon = origin === null ? null : origin[1] + '/favicon.ico';
  }

  const description = m('og:description') ?? m('description') ?? m('twitter:description') ?? ldStr('description') ?? m('dc.description');
  const articleBody = article === null ? null : typeof article['articleBody'] === 'string' ? (article['articleBody'] as string) : null;

  return {
    url,
    title: null,
    rawTitles,
    subtitle: ldStr('alternativeHeadline') ?? findDek(doc.body, description),
    authors,
    siteName: siteName === null ? null : decodeEntities(siteName),
    publishedAt: published,
    modifiedAt: modified,
    language,
    dir,
    excerpt: description,
    leadImage,
    favicon,
    articleBody,
  };
}

/** "Story - Wikipedia" on en.wikipedia.org: the last title segment, when it names the host. */
function titleSite(title: string | null, pageUrl: string): string | null {
  if (title === null) return null;
  const parts = collapse(decodeEntities(title)).split(/\s+[|\-–—·•»]\s+/);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  const key = last.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (key.length < 3 || last.length > 40) return null;
  const m = /^https?:\/\/([^/:?#]+)/i.exec(pageUrl);
  const host = m === null ? '' : m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return host.indexOf(key) >= 0 ? last : null;
}

const BYLINE_CLASS = /(?:^|[\s_-])(?:byline|by-line|author|authors|author-name|authorname|writer|contributor|byline__name|post-author|entry-author|article-author|meta-author|c-byline)(?:$|[\s_-])/;

function findByline(body: VElement): string | null {
  let found: string | null = null;
  walk(body, (el) => {
    if (found !== null) return false;
    const rel = el.attrs['rel'];
    const itemprop = el.attrs['itemprop'];
    const isAuthor =
      (rel !== undefined && /(?:^|\s)author(?:\s|$)/.test(rel)) ||
      (itemprop !== undefined && /(?:^|\s)author(?:\s|$)/.test(itemprop)) ||
      BYLINE_CLASS.test(el.matchString);
    if (!isAuthor) return true;
    // Prefer the name inside a byline widget (avatar, karma and buttons are not the name).
    let target = el;
    walk(el, (child) => {
      if (child !== el && (child.attrs['itemprop'] === 'name' || /(?:^|[\s_-])(?:name|username|user-name|author-name|authorname|fn|byline__name|ltx_personname|nickname)(?:$|[\s_-])/.test(child.matchString))) {
        target = child;
        return false;
      }
      return true;
    });
    let text = '';
    for (const child of target.children) {
      if (child.kind === 1 && (child.tag === 'br' || child.tag === 'div' || child.tag === 'p')) {
        if (text.trim().length > 0) break;
        continue;
      }
      text += child.kind === 0 ? child.text : textOf(child) + ' ';
    }
    text = collapse(text);
    if (text.length > 1 && text.length < 100 && !/\d{4}/.test(text) && cleanAuthor(text) !== null) found = text;
    return found === null;
  });
  return found;
}

const DEK = /(?:^|[\s_-])(?:subtitle|sub-title|subhead|subheading|subheadline|dek|deck|standfirst|strapline|tagline|article-summary|post-subtitle|lede)(?:$|[\s_-])/;

/**
 * The standfirst under the headline: among the first elements after the h1, one
 * marked as a subtitle/dek, or one whose text is the page description.
 */
function findDek(body: VElement, description: string | null): string | null {
  const want = description !== null ? collapse(description).toLowerCase() : '';
  let seenH1 = false;
  let after = 0;
  let found: string | null = null;
  walk(body, (el) => {
    if (found !== null || after > 40) return false;
    if (el.tag === 'h1') {
      if (seenH1) {
        after = 41;
        return false;
      }
      seenH1 = true;
      return false;
    }
    if (!seenH1) return true;
    after++;
    if (el.tag === 'p' || el.tag === 'h2' || el.tag === 'div' || el.tag === 'span') {
      const text = collapse(textOf(el));
      // A plain paragraph equal to the description is the article's own first paragraph, not a dek.
      if (text.length >= 10 && text.length <= 300 && (DEK.test(el.matchString) || el.tag !== 'p' && want.length > 0 && text.toLowerCase() === want)) {
        found = text;
        return false;
      }
    }
    return true;
  });
  return found;
}

function findTime(body: VElement): string | null {
  let found: string | null = null;
  walk(body, (el) => {
    if (found !== null) return false;
    if (el.attrs['itemprop'] === 'datePublished') {
      found = normalizeDate(el.attrs['datetime'] ?? el.attrs['content'] ?? textOf(el));
    } else if (el.tag === 'time') {
      found = normalizeDate(el.attrs['datetime'] ?? textOf(el));
    }
    return found === null;
  });
  return found;
}
