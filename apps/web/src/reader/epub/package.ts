import type { PublicationInfo, TocEntry } from '../engine';
import { normalizePath, resolveRef, safeDecode } from './path';
import type { ZipArchive } from './zip';

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

export interface SpineItem {
  /** Index in `spine` (all itemrefs, linear or not). */
  index: number;
  href: string;
  mediaType: string;
  linear: boolean;
  /** Uncompressed byte size; weights totalProgression. */
  size: number;
}

export interface EpubPackage {
  opfPath: string;
  info: PublicationInfo;
  spine: SpineItem[];
  manifestByHref: Map<string, ManifestItem>;
  fixedLayout: boolean;
  rtl: boolean;
}

export class EpubFormatError extends Error {}

function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    const html = new DOMParser().parseFromString(text, 'text/html');
    return html.documentElement ? html : null;
  }
  return doc;
}

function byLocal(root: Document | Element, name: string): Element[] {
  const ns = Array.from(root.getElementsByTagNameNS('*', name));
  return ns.length > 0 ? ns : Array.from(root.getElementsByTagName(name));
}

function childrenByLocal(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export async function readPackage(zip: ZipArchive): Promise<EpubPackage> {
  const containerText = await zip.readText('META-INF/container.xml');
  let opfPath = '';
  if (containerText) {
    const doc = parseXml(containerText);
    const rootfile = doc ? byLocal(doc, 'rootfile').find((r) => (r.getAttribute('media-type') ?? 'application/oebps-package+xml') === 'application/oebps-package+xml') ?? byLocal(doc, 'rootfile')[0] : null;
    opfPath = normalizePath(safeDecode(rootfile?.getAttribute('full-path') ?? ''));
  }
  if (!opfPath || !zip.has(opfPath)) {
    throw new EpubFormatError('This EPUB has no readable package document.');
  }
  const opfText = await zip.readText(opfPath);
  const opf = opfText ? parseXml(opfText) : null;
  if (!opf) throw new EpubFormatError('The EPUB package document could not be read.');

  const manifestById = new Map<string, ManifestItem>();
  const manifestByHref = new Map<string, ManifestItem>();
  for (const item of byLocal(opf, 'item')) {
    const rawHref = item.getAttribute('href');
    if (!rawHref) continue;
    const resolved = resolveRef(opfPath, rawHref);
    if (!resolved) continue;
    const m: ManifestItem = {
      id: item.getAttribute('id') ?? '',
      href: resolved.path,
      mediaType: item.getAttribute('media-type') ?? '',
      properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
    };
    if (m.id) manifestById.set(m.id, m);
    manifestByHref.set(m.href, m);
  }

  const spineEl = byLocal(opf, 'spine')[0] ?? null;
  const spine: SpineItem[] = [];
  for (const ref of spineEl ? childrenByLocal(spineEl, 'itemref') : []) {
    const m = manifestById.get(ref.getAttribute('idref') ?? '');
    if (!m || !zip.has(m.href)) continue;
    spine.push({
      index: spine.length,
      href: zip.entry(m.href)?.name ?? m.href,
      mediaType: m.mediaType || 'application/xhtml+xml',
      linear: ref.getAttribute('linear') !== 'no',
      size: Math.max(1, zip.entry(m.href)?.size ?? 1),
    });
  }
  if (!spine.some((s) => s.linear)) {
    for (const s of spine) s.linear = true;
  }
  if (spine.length === 0) throw new EpubFormatError('The book has no readable sections.');

  const meta = (name: string) => clean(byLocal(opf, name)[0]?.textContent);
  const metaProperty = (prop: string) =>
    byLocal(opf, 'meta').find((m) => m.getAttribute('property') === prop || m.getAttribute('name') === prop);
  const layoutMeta = metaProperty('rendition:layout');
  const fixedLayout = clean(layoutMeta?.textContent || layoutMeta?.getAttribute('content')) === 'pre-paginated';

  // Table of contents: EPUB 3 nav document, else the NCX, else one entry per section.
  let toc: TocEntry[] = [];
  const nav = [...manifestById.values()].find((m) => m.properties.includes('nav'));
  if (nav) {
    const text = await zip.readText(nav.href);
    if (text) toc = parseNav(text, nav.href);
  }
  if (toc.length === 0) {
    const ncxId = spineEl?.getAttribute('toc');
    const ncx = (ncxId ? manifestById.get(ncxId) : undefined) ?? [...manifestById.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');
    if (ncx) {
      const text = await zip.readText(ncx.href);
      if (text) toc = parseNcx(text, ncx.href);
    }
  }
  toc = toc.map((t) => ({ ...t, href: canonicalTocHref(zip, t.href) }));
  if (toc.length === 0) {
    toc = spine.filter((s) => s.linear).map((s, i) => ({ title: `Section ${i + 1}`, href: s.href, depth: 0 }));
  }

  const rtl = spineEl?.getAttribute('page-progression-direction') === 'rtl';
  await rejectProtected(zip, spine);

  return {
    opfPath,
    info: {
      title: meta('title') || 'Untitled',
      author: byLocal(opf, 'creator').map((c) => clean(c.textContent)).filter(Boolean).join(', '),
      language: meta('language') || null,
      toc,
      spineCount: spine.length,
      readingProgression: rtl ? 'rtl' : 'ltr',
    },
    spine,
    manifestByHref,
    fixedLayout,
    rtl,
  };
}

/** Font obfuscation only scrambles fonts; anything else in encryption.xml is DRM. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/** DRM-protected sections would render as garbage; say so instead, as Readium does. */
async function rejectProtected(zip: ZipArchive, spine: SpineItem[]): Promise<void> {
  const text = zip.has('META-INF/encryption.xml') ? await zip.readText('META-INF/encryption.xml').catch(() => null) : null;
  const doc = text ? parseXml(text) : null;
  if (!doc) return;
  const sections = new Set(spine.map((s) => s.href.toLowerCase()));
  for (const data of byLocal(doc, 'EncryptedData')) {
    const algorithm = byLocal(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
    if (FONT_OBFUSCATION.has(algorithm)) continue;
    const uri = byLocal(data, 'CipherReference')[0]?.getAttribute('URI');
    const path = uri ? resolveRef('', uri)?.path.toLowerCase() : null;
    if (path && sections.has(path)) {
      throw new EpubFormatError('This book is protected by DRM and cannot be opened here.');
    }
  }
}

/** Uses the zip's own casing for the path part so TOC hrefs match spine hrefs. */
function canonicalTocHref(zip: ZipArchive, href: string): string {
  const hash = href.indexOf('#');
  const path = hash < 0 ? href : href.slice(0, hash);
  const name = zip.entry(path)?.name ?? path;
  return hash < 0 ? name : name + href.slice(hash);
}

function tocHref(base: string, raw: string): string | null {
  const r = resolveRef(base, raw);
  if (!r) return null;
  return r.fragment ? `${r.path}#${r.fragment}` : r.path;
}

function parseNav(text: string, navHref: string): TocEntry[] {
  const out: TocEntry[] = [];
  const doc = parseXml(text);
  if (!doc) return out;
  const navs = byLocal(doc, 'nav');
  const nav =
    navs.find((n) => {
      for (const a of Array.from(n.attributes)) if (a.localName === 'type' && a.value.split(/\s+/).includes('toc')) return true;
      return false;
    }) ?? navs[0];
  if (!nav) return out;
  const walk = (ol: Element, depth: number) => {
    for (const li of childrenByLocal(ol, 'li')) {
      const a = childrenByLocal(li, 'a')[0];
      const span = childrenByLocal(li, 'span')[0];
      const title = clean((a ?? span)?.textContent) || clean(a?.getAttribute('title'));
      const raw = a?.getAttribute('href');
      const href = raw ? tocHref(navHref, raw) : null;
      if (title && href) out.push({ title, href, depth });
      for (const sub of childrenByLocal(li, 'ol')) walk(sub, href ? depth + 1 : depth);
    }
  };
  for (const ol of byLocal(nav, 'ol').filter((o) => o.parentElement === nav || o.parentElement?.parentElement === nav).slice(0, 1)) walk(ol, 0);
  return out;
}

function parseNcx(text: string, ncxHref: string): TocEntry[] {
  const out: TocEntry[] = [];
  const doc = parseXml(text);
  if (!doc) return out;
  const walk = (parent: Element, depth: number) => {
    for (const np of childrenByLocal(parent, 'navPoint')) {
      const label = clean(childrenByLocal(np, 'navLabel')[0]?.getElementsByTagNameNS('*', 'text')[0]?.textContent);
      const src = childrenByLocal(np, 'content')[0]?.getAttribute('src');
      const href = src ? tocHref(ncxHref, src) : null;
      if (label && href) out.push({ title: label, href, depth });
      walk(np, href && label ? depth + 1 : depth);
    }
  };
  const map = byLocal(doc, 'navMap')[0];
  if (map) walk(map, 0);
  return out;
}
