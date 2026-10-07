import type { TexRenderer } from '../enhance';
import { enhanceChapter } from '../enhance/web';
import type { SpineItem } from './package';
import { resolveRef } from './path';
import type { Resources } from './resources';
import type { ZipArchive } from './zip';

export interface PreparedChapter {
  index: number;
  href: string;
  /** Source document; its body is imported into the frame on display. */
  body: HTMLElement;
  htmlAttrs: [string, string][];
  /** Book styles in document order, already rewritten. */
  styles: { css: string; media: string | null }[];
  /** Fixed-layout viewport from `<meta name=viewport>`, if any. */
  viewport: { width: number; height: number } | null;
  /** Renders the chapter's prepared formulas on mount (see `hydrateMath`); null without any. */
  tex: TexRenderer | null;
  failed: boolean;
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Elements that can execute code or pull in other browsing contexts. */
const DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'embed', 'applet', 'base', 'form']);

export function parseMarkup(text: string, mediaType: string): Document {
  const source = text.replace(/^﻿/, '');
  if (!/html/i.test(mediaType) || /xml|xhtml/i.test(mediaType)) {
    const xml = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (xml.getElementsByTagName('parsererror').length === 0 && xml.documentElement) return xml;
  }
  return new DOMParser().parseFromString(source, 'text/html');
}

export async function prepareChapter(zip: ZipArchive, res: Resources, item: SpineItem): Promise<PreparedChapter> {
  try {
    if (item.mediaType.startsWith('image/') && item.mediaType !== 'image/svg+xml') {
      const url = await res.url(item.href, item.index);
      const doc = document.implementation.createHTMLDocument('');
      const img = doc.createElement('img');
      if (url) img.src = url;
      doc.body.append(img);
      return { index: item.index, href: item.href, body: doc.body, htmlAttrs: [], styles: [], viewport: null, tex: null, failed: !url };
    }
    const text = await zip.readText(item.href);
    if (text === null) return failedChapter(item);
    const doc = parseMarkup(text, item.mediaType);
    let body = findBody(doc);
    if (!body) {
      // An SVG (or other XML) spine item: wrap its root in a body.
      const html = document.implementation.createHTMLDocument('');
      html.body.append(html.importNode(doc.documentElement, true));
      body = html.body;
    }

    const styles: PreparedChapter['styles'] = [];
    const head = doc.documentElement ? Array.from(doc.documentElement.getElementsByTagNameNS('*', 'head'))[0] ?? null : null;
    let viewport: PreparedChapter['viewport'] = null;
    if (head) {
      for (const el of Array.from(head.children)) {
        const name = el.localName.toLowerCase();
        if (name === 'link') {
          const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
          const href = el.getAttribute('href');
          if (!rel.includes('stylesheet') || rel.includes('alternate') || !href) continue;
          const r = resolveRef(item.href, href);
          if (!r) continue;
          styles.push({ css: await res.stylesheet(r.path), media: el.getAttribute('media') });
        } else if (name === 'style') {
          styles.push({ css: await res.rewriteCss(el.textContent ?? '', item.href), media: el.getAttribute('media') });
        } else if (name === 'meta' && (el.getAttribute('name') ?? '').toLowerCase() === 'viewport') {
          const content = el.getAttribute('content') ?? '';
          const w = /width\s*=\s*(\d+)/.exec(content);
          const h = /height\s*=\s*(\d+)/.exec(content);
          if (w && h) viewport = { width: Number(w[1]), height: Number(h[1]) };
        }
      }
    }

    // Before sanitizing: MathJax's `script type=math/tex` is TeX the enhancer renders.
    const { tex } = await enhanceChapter(doc, body);
    await sanitizeAndRewrite(body, item, res);

    const htmlAttrs: [string, string][] = [];
    for (const a of Array.from(doc.documentElement?.attributes ?? [])) {
      if (a.name === 'lang' || a.name === 'xml:lang' || a.name === 'dir' || a.name === 'class') {
        htmlAttrs.push([a.name === 'xml:lang' ? 'lang' : a.name, a.value]);
      }
    }
    return { index: item.index, href: item.href, body, htmlAttrs, styles, viewport, tex, failed: false };
  } catch {
    return failedChapter(item);
  }
}

function findBody(doc: Document): HTMLElement | null {
  const el = doc.getElementsByTagNameNS(XHTML_NS, 'body')[0] ?? doc.getElementsByTagName('body')[0];
  return (el as HTMLElement | undefined) ?? null;
}

export function failedChapter(item: SpineItem): PreparedChapter {
  const doc = document.implementation.createHTMLDocument('');
  const p = doc.createElement('p');
  p.className = 'reader-error';
  p.textContent = 'This section could not be displayed.';
  doc.body.append(p);
  return { index: item.index, href: item.href, body: doc.body, htmlAttrs: [], styles: [], viewport: null, tex: null, failed: true };
}

async function sanitizeAndRewrite(body: Element, item: SpineItem, res: Resources): Promise<void> {
  const pending: Promise<void>[] = [];
  const rewrite = (el: Element, attr: string, ns: string | null = null) => {
    const value = ns ? el.getAttributeNS(ns, attr.split(':').pop()!) : el.getAttribute(attr);
    if (!value || value.startsWith('#') || /^(data|blob):/i.test(value)) return;
    const r = resolveRef(item.href, value);
    if (!r) {
      // Remote resources never load inside the book (privacy, offline).
      if (/^(https?:)?\/\//i.test(value.trim())) {
        if (ns) el.removeAttributeNS(ns, attr.split(':').pop()!);
        else el.removeAttribute(attr);
      }
      return;
    }
    pending.push(
      res.url(r.path, item.index).then((u) => {
        if (!u) return;
        if (ns) el.setAttributeNS(ns, attr, u);
        else el.setAttribute(attr, u);
      }),
    );
  };

  const all = [body, ...Array.from(body.getElementsByTagName('*'))];
  for (const el of all) {
    const name = el.localName.toLowerCase();
    if (DROP.has(name) && el !== body) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'formaction') el.removeAttribute(a.name);
      // A named <img> becomes a property of the frame's document (`<img name="body">`
      // shadows `document.body`) and breaks the engine; the attribute does nothing else.
      else if (n === 'name' && name === 'img') el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href' || n === 'src') && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (name === 'meta' || name === 'link') {
      el.remove();
      continue;
    }
    if (name === 'object') {
      // Keep the fallback content; objects would need plugins or scripts. One
      // the enhancer replaced with an image keeps its fallback hidden.
      const hidden = /(^|\s)tr-hidden(\s|$)/.test(el.getAttribute('class') ?? '');
      if (hidden) {
        const span = el.ownerDocument.createElementNS(XHTML_NS, 'span');
        span.setAttribute('class', 'tr-hidden');
        span.append(...Array.from(el.childNodes));
        el.replaceWith(span);
      } else {
        el.replaceWith(...Array.from(el.childNodes));
      }
      continue;
    }
    switch (name) {
      case 'img':
        rewrite(el, 'src');
        if (el.hasAttribute('srcset')) pending.push(rewriteSrcset(el, item, res));
        break;
      case 'image':
      case 'use':
        if (el.hasAttributeNS(XLINK_NS, 'href')) rewrite(el, 'xlink:href', XLINK_NS);
        if (el.hasAttribute('href')) rewrite(el, 'href');
        break;
      case 'source':
        rewrite(el, 'src');
        if (el.hasAttribute('srcset')) pending.push(rewriteSrcset(el, item, res));
        break;
      case 'video':
      case 'audio':
        rewrite(el, 'src');
        rewrite(el, 'poster');
        break;
      case 'track':
        rewrite(el, 'src');
        break;
      case 'style':
        pending.push(
          res.rewriteCss(el.textContent ?? '', item.href).then((css) => {
            el.textContent = css;
          }),
        );
        break;
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) {
      pending.push(
        res.rewriteCss(style, item.href).then((css) => {
          el.setAttribute('style', css);
        }),
      );
    }
  }
  await Promise.all(pending);
}

async function rewriteSrcset(el: Element, item: SpineItem, res: Resources): Promise<void> {
  const parts = (el.getAttribute('srcset') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const [url, ...desc] = part.split(/\s+/);
    const r = resolveRef(item.href, url);
    const u = r ? await res.url(r.path, item.index) : null;
    if (u) out.push([u, ...desc].join(' '));
  }
  if (out.length) el.setAttribute('srcset', out.join(', '));
  else el.removeAttribute('srcset');
}
