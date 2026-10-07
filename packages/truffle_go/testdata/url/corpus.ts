/**
 * The URL-ish attribute values of the parity corpus (test-corpus/parity/vdoc),
 * each with its page URL as the base, deduplicated: links, images, srcset
 * candidates (sliced as media.ts `parseSrcset` slices them) and whole srcset
 * values, media sources, `data-*` sources and URLs, URL-valued `<meta>`
 * content, JSON-LD URLs and `<base href>`. url_test.go collects the same.
 */
import { readFileSync } from 'node:fs';

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'poster', 'cite', 'action', 'background', 'longdesc', 'data', 'formaction', 'manifest', 'icon', 'xlink:href', 'imagesrcset']);
const DATA_ATTR = /^data-.*(?:src|url|href|srcset|permalink|uri)$/;
const META_KEY = /url|image|video|audio|player|thumbnail/i;
const LD_KEY = /^(?:url|image|thumbnailurl|@id|contenturl|embedurl|logo|sameas|mainentityofpage)$/i;

/** The `url` slices media.ts `parseSrcset` resolves. */
export function srcsetUrls(value: string): string[] {
  const urls: string[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && (value[i] === ',' || /\s/.test(value[i]!))) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(value[i]!)) i++;
    let url = value.slice(start, i);
    if (url.endsWith(',')) {
      let end = url.length - 1;
      while (end > 0 && url.charCodeAt(end - 1) === 44) end--;
      url = url.slice(0, end);
    } else {
      while (i < n && value[i] !== ',') i++;
    }
    urls.push(url);
  }
  return urls;
}

type VNode = string | { t: string; a?: Record<string, string>; c?: VNode[] };

export function collect(dir: string): { pages: string[]; pairs: [string, string][] } {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as { key: string; url: string }[];
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  const pages: string[] = [];
  for (const { key, url } of manifest) {
    pages.push(url);
    const add = (value: string) => {
      const k = url + '\u0000' + value;
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push([url, value]);
      }
    };
    const doc = JSON.parse(readFileSync(`${dir}/vdoc/${key}.json`, 'utf8')) as { root: VNode; jsonLd: string[]; baseHref: string | null };
    if (doc.baseHref !== null) add(doc.baseHref);
    const visit = (node: VNode) => {
      if (typeof node === 'string') return;
      const attrs = node.a ?? {};
      for (const [name, value] of Object.entries(attrs)) {
        const lower = name.toLowerCase();
        if (!URL_ATTRS.has(lower) && !DATA_ATTR.test(lower)) continue;
        add(value);
        if (lower.endsWith('srcset')) for (const u of srcsetUrls(value)) add(u);
      }
      if (node.t === 'meta') {
        const k = attrs['property'] ?? attrs['name'] ?? attrs['itemprop'] ?? '';
        if (attrs['content'] !== undefined && META_KEY.test(k)) add(attrs['content']);
      }
      for (const child of node.c ?? []) visit(child);
    };
    visit(doc.root);
    const ld = (value: unknown, key: string) => {
      if (typeof value === 'string') {
        if (LD_KEY.test(key)) add(value);
      } else if (Array.isArray(value)) {
        for (const v of value) ld(v, key);
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) ld(v, k);
      }
    };
    for (const raw of doc.jsonLd ?? []) {
      try {
        ld(JSON.parse(raw), '');
      } catch {
        // Not JSON: the engine skips it too.
      }
    }
  }
  return { pages, pairs };
}
