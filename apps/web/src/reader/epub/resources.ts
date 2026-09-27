import type { ManifestItem } from './package';
import { resolveRef } from './path';
import type { ZipArchive } from './zip';

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  css: 'text/css',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
};

/**
 * Blob URLs for zip entries, reference-counted per chapter. Resources reached
 * from stylesheets (fonts, background images) are shared: their URLs are
 * baked into cached CSS text and live until `destroy`.
 */
export class Resources {
  private readonly urls = new Map<string, Promise<string | null>>();
  private readonly owners = new Map<string, Set<number>>();
  private readonly shared = new Set<string>();
  private readonly css = new Map<string, Promise<string>>();
  private destroyed = false;

  constructor(
    private readonly zip: ZipArchive,
    private readonly manifest: Map<string, ManifestItem>,
  ) {}

  typeOf(path: string): string {
    const m = this.manifest.get(path)?.mediaType;
    if (m) return m;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return EXT_TYPES[ext] ?? 'application/octet-stream';
  }

  /** Blob URL for `path`, owned by chapter `owner` (or shared when null). */
  url(path: string, owner: number | null): Promise<string | null> {
    const name = this.zip.entry(path)?.name;
    if (!name || this.destroyed) return Promise.resolve(null);
    if (owner === null) this.shared.add(name);
    else {
      let set = this.owners.get(name);
      if (!set) this.owners.set(name, (set = new Set()));
      set.add(owner);
    }
    let p = this.urls.get(name);
    if (!p) {
      p = this.zip
        .readBlob(name, this.typeOf(name))
        .then((blob) => (blob && !this.destroyed ? URL.createObjectURL(blob) : null))
        .catch(() => null);
      this.urls.set(name, p);
    }
    return p;
  }

  /** Drops chapter `owner`'s claims and revokes URLs nobody holds any more. */
  release(owner: number): void {
    for (const [name, set] of this.owners) {
      if (!set.delete(owner) || set.size > 0 || this.shared.has(name)) continue;
      this.owners.delete(name);
      const p = this.urls.get(name);
      this.urls.delete(name);
      void p?.then((u) => u && URL.revokeObjectURL(u));
    }
  }

  /** Stylesheet text with `@import` inlined and every `url()` pointing at a blob. */
  stylesheet(path: string): Promise<string> {
    let p = this.css.get(path);
    if (!p) {
      p = this.loadCss(path, new Set());
      this.css.set(path, p);
    }
    return p;
  }

  private async loadCss(path: string, seen: Set<string>): Promise<string> {
    if (seen.has(path) || seen.size > 16) return '';
    seen.add(path);
    const text = await this.zip.readText(path).catch(() => null);
    if (text === null) return '';
    return this.rewriteCss(text, path, seen);
  }

  /** Rewrites CSS found in `from` (a stylesheet or an XHTML document). */
  async rewriteCss(css: string, from: string, seen: Set<string> = new Set()): Promise<string> {
    let text = css.replace(/@charset\s+["'][^"']*["']\s*;?/gi, '');
    // Inline @import so the whole sheet applies synchronously.
    const imports: { match: string; path: string; media: string }[] = [];
    const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;
    for (let m = importRe.exec(text); m; m = importRe.exec(text)) {
      const r = resolveRef(from, m[2] ?? m[4] ?? '');
      imports.push({ match: m[0], path: r ? r.path : '', media: (m[5] ?? '').trim() });
    }
    for (const imp of imports) {
      const inner = imp.path ? await this.loadCss(imp.path, seen) : '';
      text = text.replace(imp.match, () => (imp.media ? `@media ${imp.media}{${inner}}` : inner));
    }
    const refs = new Map<string, string>();
    const urlRe = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
    for (let m = urlRe.exec(text); m; m = urlRe.exec(text)) {
      const raw = m[2];
      if (refs.has(raw) || /^(data|blob):/i.test(raw) || raw.startsWith('#')) continue;
      const r = resolveRef(from, raw);
      refs.set(raw, r ? ((await this.url(r.path, null)) ?? 'data:,') : 'data:,');
    }
    return text.replace(urlRe, (whole, _q: string, raw: string) => {
      const u = refs.get(raw);
      return u ? `url("${u}")` : whole;
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const p of this.urls.values()) void p.then((u) => u && URL.revokeObjectURL(u));
    this.urls.clear();
    this.owners.clear();
    this.shared.clear();
    this.css.clear();
  }
}
