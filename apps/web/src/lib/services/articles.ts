import type { Article, Block, ExtractOptions } from '@thereader/extract';
import type { ArticleSummary } from '../types';
import { errorFrom, type ArticleBodyApi, type FetchLike } from './api';
import { ApiError, type ArticlePhase, type ArticleStore, type ArticlesSnapshot } from './contract';
import { sha256Bytes, sha256Hex, toHex } from './hash';
import type { KeyValueStore } from './kv';
import { isAfter, isRecord, isoOrder, nowIso, parseIso, stableStringify } from './models';
import { Emitter, WriteQueue } from './observable';
import { noopBus, type TabBus } from './tabs';

const INDEX_KEY = 'articles.v1';
/** IndexedDB key of one article's full document. */
export const articleKey = (id: string): string => `article:${id}`;

export const ARTICLE_TIMEOUT_MS = 30_000;
const CACHE_SIZE = 3;
/** The API's cap on a synced document, measured on its JSON. */
export const MAX_ARTICLE_BODY_BYTES = 4 * 1024 * 1024;
/** Documents up to this size download during sync, so they open offline. */
export const PREFETCH_MAX_BYTES = 1024 * 1024;
const RETRY_MIN_MS = 2 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
/** Deletions are remembered this long to sync them; the server keeps them for good. */
const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60_000;
const tracking = /^(?:utm_\w+|fbclid|gclid|dclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;

// ---------------------------------------------------------------- URLs

/**
 * The address to fetch for what someone typed or pasted: scheme optional
 * (https assumed), http(s) only, no credentials, fragment and common
 * tracking parameters dropped. Null when it is not a web address.
 */
export function normalizeArticleUrl(input: string): string | null {
  let s = input.trim().replace(/^<(.*)>$/, '$1');
  if (!s || /\s/.test(s)) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  if (!/\.[a-z\d-]{2,}\.?$/i.test(url.hostname)) return null;
  url.hash = '';
  const params = [...url.searchParams.keys()].filter((key) => tracking.test(key));
  for (const key of params) url.searchParams.delete(key);
  return url.href;
}

/** The first web address in pasted text: any http(s) URL, or the whole text when it is a bare domain and path. */
export function findArticleUrl(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 4096) return null;
  const match = /https?:\/\/[^\s<>"'`]+/i.exec(t);
  if (match) {
    let candidate = match[0].replace(/[.,;:!?'"]+$/, '');
    while (candidate.endsWith(')') && candidate.split('(').length < candidate.split(')').length) candidate = candidate.slice(0, -1);
    return normalizeArticleUrl(candidate);
  }
  if (/\s/.test(t) || !/^(?:[a-z\d-]+\.)+[a-z]{2,}(?:[/?]|$)/i.test(t)) return null;
  return normalizeArticleUrl(t);
}

/**
 * Same page, for dedupe and for the article's id: scheme, credentials,
 * default port, `www.`, a trailing slash, fragment and tracking parameters do
 * not matter. Plain string work, so the Dart app derives the same key
 * (`articleUrlKey` in `article_repository.dart`) from the same URL.
 */
export function articleUrlKey(href: string): string {
  const m = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(href.trim());
  if (!m) return href.trim();
  const host = m[1]
    .slice(m[1].lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/:(?:80|443)$/, '')
    .replace(/^www\./, '');
  const path = m[2].replace(/\/+$/, '');
  const query = (m[3] ?? '')
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '' && !tracking.test(pair.split('=')[0]))
    .join('&');
  return `${host}${path}${query ? `?${query}` : ''}`;
}

/**
 * The id every device gives the article at `url`: the first 128 bits of the
 * SHA-256 of its `articleUrlKey`, in hex. The same story saved on two devices
 * therefore syncs as one article.
 */
export function articleIdFor(url: string): string {
  return sha256Hex(articleUrlKey(url)).slice(0, 32);
}

const urlKey = articleUrlKey;

/** A reading position every device understands: top-level block, offset into it, share read. */
export interface ArticlePosition {
  block: number;
  offset: number;
  percent: number;
}

const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** This app's block fraction as a shared position (block count unknown: the share only). */
export function positionFromFraction(fraction: number, blockCount: number | undefined): ArticlePosition {
  const f = unit(fraction);
  const n = blockCount ?? 0;
  if (n <= 0) return { block: 0, offset: 0, percent: f };
  const at = f * n;
  const block = Math.min(n - 1, Math.floor(at));
  return { block, offset: Math.round(unit(at - block) * 10000) / 10000, percent: f };
}

export function fractionFromPosition(position: ArticlePosition, blockCount: number | undefined): number {
  const n = blockCount ?? 0;
  if (position.percent >= 0.995 || n <= 0) return Math.round(unit(position.percent) * 10000) / 10000;
  return Math.round(unit((position.block + unit(position.offset)) / n) * 10000) / 10000;
}

/** An article row pulled from the cloud (see the API's `articles` sync list). */
export interface RemoteArticle {
  id: string;
  url: string;
  title: string;
  siteName: string | null;
  byline: string | null;
  excerpt: string | null;
  leadImage: string | null;
  favicon: string | null;
  language: string | null;
  dir: 'ltr' | 'rtl';
  wordCount: number;
  readingMinutes: number;
  blockCount: number;
  publishedAt: string | null;
  bodySha256: string | null;
  bodySize: number | null;
  position: ArticlePosition | null;
  positionUpdatedAt: string | null;
  updatedAt: string;
  deleted: boolean;
}

/** The exact bytes every device hashes, uploads and verifies. */
export function articleBody(article: Article): { bytes: Uint8Array; sha256: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(article));
  return { bytes, sha256: toHex(sha256Bytes(bytes)) };
}

const hostLabel = (href: string): string => {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
};

// ---------------------------------------------------------------- decoding

function encodingFor(label: string): string | null {
  try {
    const encoding = new TextDecoder(label.trim().toLowerCase()).encoding;
    return encoding === 'x-user-defined' ? 'windows-1252' : encoding;
  } catch {
    return null;
  }
}

/** `<meta charset>` or `<meta http-equiv="Content-Type" content="…; charset=…">` in the first 2 KB. */
function metaCharset(bytes: Uint8Array): string | null {
  let head = '';
  const end = Math.min(bytes.length, 2048);
  for (let i = 0; i < end; i++) head += String.fromCharCode(bytes[i]);
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const charset = /[\s;"']charset\s*=\s*["']?\s*([^"'\s;/>]+)/i.exec(tag)?.[1];
    if (charset) return charset;
  }
  return null;
}

/**
 * The encoding a browser would pick for an HTML response: byte order mark,
 * then the Content-Type charset, then a meta declaration (UTF-16 there means
 * UTF-8), then UTF-8. Labels follow the Encoding Standard via `TextDecoder`.
 */
export function sniffEncoding(bytes: Uint8Array, contentType: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  const header = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType ?? '')?.[1];
  const fromHeader = header ? encodingFor(header) : null;
  if (fromHeader) return fromHeader;
  const meta = metaCharset(bytes);
  const fromMeta = meta ? encodingFor(meta) : null;
  if (fromMeta) return fromMeta.startsWith('utf-16') ? 'utf-8' : fromMeta;
  return 'utf-8';
}

export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  return new TextDecoder(sniffEncoding(bytes, contentType)).decode(bytes);
}

// ---------------------------------------------------------------- errors

function relayError(error: ApiError, host: string): ApiError {
  const status = Number(/HTTP (\d{3})/.exec(error.message)?.[1] ?? 0);
  switch (error.code) {
    case 'INVALID_URL':
      return new ApiError("That address can't be saved. Use a public http or https link.", 'INVALID_URL', error.status);
    case 'UNSUPPORTED_MEDIA_TYPE':
      return new ApiError("That link isn't a web page, so there's no article to save.", 'NOT_HTML', error.status);
    case 'TOO_LARGE':
      return new ApiError('That page is too large to save.', 'TOO_LARGE', error.status);
    case 'UPSTREAM_TIMEOUT':
      return new ApiError(`${host} took too long to respond.`, 'TIMEOUT', error.status, true);
    case 'UPSTREAM_UNREACHABLE':
      return new ApiError(`Couldn't reach ${host}.`, 'UNREACHABLE', error.status, true);
    case 'TOO_MANY_REDIRECTS':
      return new ApiError(`${host} redirected too many times.`, 'BLOCKED', error.status);
    case 'UPSTREAM_STATUS':
      if (status === 404 || status === 410) return new ApiError(`That page wasn't found on ${host}.`, 'NOT_FOUND', error.status);
      if (status === 401 || status === 402 || status === 403 || status === 429 || status === 451) {
        return new ApiError(`${host} blocked the request (HTTP ${status}).`, 'BLOCKED', error.status);
      }
      return new ApiError(`${host} answered with an error${status ? ` (HTTP ${status})` : ''}.`, 'BLOCKED', error.status);
    case 'NOT_FOUND':
      return new ApiError("This server can't fetch articles yet. Update The Reader's API.", 'UNSUPPORTED', error.status);
    default:
      return error;
  }
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const offlineError = () => new ApiError("You're offline. Connect to the internet to save this article.", 'OFFLINE', null, true);
const abortError = () => new DOMException('The save was cancelled.', 'AbortError');

// ---------------------------------------------------------------- records

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function parseSummary(json: unknown): ArticleSummary | null {
  if (!isRecord(json) || typeof json.id !== 'string' || typeof json.url !== 'string' || typeof json.addedAt !== 'string') return null;
  const urls = Array.isArray(json.urls) ? json.urls.filter((u): u is string => typeof u === 'string') : [];
  const progress = typeof json.progress === 'number' && Number.isFinite(json.progress) ? Math.min(1, Math.max(0, json.progress)) : null;
  const sync: Partial<ArticleSummary> = {};
  if (typeof json.progressUpdatedAt === 'string') sync.progressUpdatedAt = json.progressUpdatedAt;
  if (json.stored === false) sync.stored = false;
  if (typeof json.language === 'string') sync.language = json.language;
  if (json.dir === 'rtl' || json.dir === 'ltr') sync.dir = json.dir;
  if (count(json.wordCount) !== undefined) sync.wordCount = count(json.wordCount);
  if (typeof json.publishedAt === 'string') sync.publishedAt = json.publishedAt;
  if (count(json.blockCount) !== undefined) sync.blockCount = count(json.blockCount);
  if (typeof json.bodySha256 === 'string' && /^[a-f0-9]{64}$/.test(json.bodySha256)) sync.bodySha256 = json.bodySha256;
  if (count(json.bodySize) !== undefined) sync.bodySize = count(json.bodySize);
  return {
    ...sync,
    id: json.id,
    url: json.url,
    urls: urls.length > 0 ? urls : [json.url],
    title: stringOrNull(json.title) ?? hostLabel(json.url),
    siteName: stringOrNull(json.siteName) ?? hostLabel(json.url),
    byline: stringOrNull(json.byline),
    excerpt: stringOrNull(json.excerpt),
    favicon: stringOrNull(json.favicon),
    image: stringOrNull(json.image),
    readingMinutes: typeof json.readingMinutes === 'number' && json.readingMinutes > 0 ? Math.ceil(json.readingMinutes) : 1,
    addedAt: json.addedAt,
    lastOpenedAt: stringOrNull(json.lastOpenedAt),
    progress,
  };
}

function firstImage(blocks: readonly Block[]): string | null {
  for (const block of blocks) if (block.type === 'figure' && block.images[0]) return block.images[0].src;
  return null;
}

/** Metadata only the document has, recorded on the summary so sync never reads the document. */
function documentFields(article: Article, body: { bytes: Uint8Array; sha256: string }): Partial<ArticleSummary> {
  return {
    language: article.language,
    dir: article.dir === 'rtl' ? 'rtl' : 'ltr',
    wordCount: Math.max(0, Math.round(article.wordCount) || 0),
    publishedAt: article.publishedAt,
    blockCount: article.blocks.length,
    bodySha256: body.sha256,
    bodySize: body.bytes.byteLength,
  };
}

function summarize(id: string, article: Article, urls: string[], addedAt: string): ArticleSummary {
  return {
    id,
    url: normalizeArticleUrl(article.url) ? article.url : urls[urls.length - 1],
    urls,
    title: article.title.trim() || hostLabel(article.url),
    siteName: article.siteName?.trim() || hostLabel(article.url),
    byline: article.byline,
    excerpt: article.excerpt,
    favicon: article.favicon,
    image: article.leadImage?.src ?? firstImage(article.blocks),
    readingMinutes: Math.max(1, article.readingMinutes),
    addedAt,
    lastOpenedAt: null,
    progress: null,
  };
}

function isArticle(value: unknown): value is Article {
  return isRecord(value) && typeof value.url === 'string' && typeof value.title === 'string' && Array.isArray(value.blocks);
}

/** Lets the phase text paint before parsing and extraction hold the main thread. */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const fallback = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
}

/** Times one stage of a save (sync or async) as a `performance` measure (`article:fetch`, …), visible in DevTools. */
function measured<T>(name: string, run: () => T): T {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return run();
  const start = performance.now();
  const end = () => {
    try {
      performance.measure(`article:${name}`, { start, end: performance.now() });
    } catch {
      /* Older User Timing without options. */
    }
  };
  let result: T;
  try {
    result = run();
  } catch (error) {
    end();
    throw error;
  }
  if (result instanceof Promise) return result.finally(end) as T;
  end();
  return result;
}

type Extractor = (doc: Document, options: ExtractOptions) => Article | null | Promise<Article | null>;

/** The extraction engine chunk (kept out of the entry bundle), fetched once. */
let extractModule: Promise<Extractor> | null = null;
function loadExtractor(): Promise<Extractor> {
  extractModule ??= import('@thereader/extract').then(
    (m) => m.extract,
    (error: unknown) => {
      extractModule = null;
      throw error;
    },
  );
  return extractModule;
}

// ---------------------------------------------------------------- store

export interface ArticleDeps {
  kv: KeyValueStore;
  currentOrigin(): string;
  /** Downloads documents saved on other devices. Without it, cloud-only articles cannot open. */
  bodies?: (origin: string) => ArticleBodyApi;
  fetch?: FetchLike;
  /** Defaults to the browser's `DOMParser`. */
  parse?: (html: string) => Document;
  /** Defaults to `extract` from `@thereader/extract`, loaded on first use. */
  extract?: Extractor;
  bus?: TabBus;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Articles saved by link. A page is fetched once through the API relay,
 * decoded like a browser would, extracted on this device and stored as the
 * structured document plus a small summary in the Library index. Opening an
 * article reads IndexedDB only; it is never fetched or extracted again.
 *
 * Saved articles sync through the cloud: the sync store sends summaries,
 * positions and deletions on its schedule and uploads each document once.
 * Articles saved on other devices arrive as summaries (`stored: false`); their
 * document downloads when opened (or during sync, when small), never
 * re-extracted. Deletions keep a tombstone until they have had time to sync.
 */
export class ArticleStoreImpl extends Emitter<ArticlesSnapshot> implements ArticleStore {
  private items = new Map<string, ArticleSummary>();
  /** Deleted article ids and when; read by the sync store. */
  private tombstones = new Map<string, string>();
  private readonly downloads = new Map<string, Promise<Article>>();
  /** Cloud documents that failed to download: when to try again, and the current wait. */
  private readonly retryAt = new Map<string, { at: number; wait: number }>();
  private readonly writes = new WriteQueue();
  private queuedWrite: Promise<void> | null = null;
  /** Recently opened documents, so reopening is instant. */
  private readonly cache = new Map<string, Article>();
  private addToken: object | null = null;
  private readonly bus: TabBus;
  private readonly now: () => number;

  constructor(private readonly deps: ArticleDeps) {
    super({ loaded: false, items: [], adding: null });
    this.bus = deps.bus ?? noopBus;
    this.now = deps.now ?? Date.now;
    this.bus.listen((topic) => {
      if (topic === 'articles' && this.snapshot.loaded) void this.reload();
    });
  }

  get loaded(): boolean {
    return this.snapshot.loaded;
  }

  async load(): Promise<void> {
    const { items, tombstones } = await this.readStored();
    this.items = items;
    this.tombstones = tombstones;
    if (await this.migrate()) await this.persist();
    this.publish(true);
  }

  private async readStored(): Promise<{ items: Map<string, ArticleSummary>; tombstones: Map<string, string> }> {
    const items = new Map<string, ArticleSummary>();
    const tombstones = new Map<string, string>();
    const json = await this.deps.kv.get<unknown>(INDEX_KEY).catch(() => null);
    const list = isRecord(json) && Array.isArray(json.items) ? json.items : [];
    for (const raw of list) {
      const summary = parseSummary(raw);
      if (summary) items.set(summary.id, summary);
    }
    const oldest = this.now() - TOMBSTONE_TTL_MS;
    for (const [id, at] of Object.entries(isRecord(json) && isRecord(json.tombstones) ? json.tombstones : {})) {
      if (typeof at === 'string' && parseIso(at) > oldest && !items.has(id)) tombstones.set(id, at);
    }
    return { items, tombstones };
  }

  /**
   * Articles saved before sync had random ids and no document hash. Gives
   * each its URL-derived id (moving the document) and records what sync needs.
   */
  private async migrate(): Promise<boolean> {
    let changed = false;
    for (const summary of [...this.items.values()]) {
      if (summary.bodySha256 || summary.stored === false) continue;
      changed = true;
      this.items.delete(summary.id);
      const record = await this.deps.kv.get<unknown>(articleKey(summary.id)).catch(() => null);
      const article = isRecord(record) && isArticle(record.article) ? record.article : null;
      if (!article) continue;
      const id = articleIdFor(summary.url);
      if (this.items.has(id)) {
        await this.deps.kv.remove(articleKey(summary.id)).catch(() => undefined);
        continue;
      }
      if (id !== summary.id) {
        await this.deps.kv.set(articleKey(id), { article });
        await this.deps.kv.remove(articleKey(summary.id)).catch(() => undefined);
      }
      this.items.set(id, { ...summary, ...documentFields(article, articleBody(article)), id });
    }
    return changed;
  }

  /** Another tab saved the index; unchanged summaries keep their objects so rows skip re-rendering. */
  private async reload(): Promise<void> {
    const { items: stored, tombstones } = await this.readStored();
    for (const [id, summary] of stored) {
      const local = this.items.get(id);
      if (local && stableStringify(local) === stableStringify(summary)) stored.set(id, local);
    }
    for (const id of this.cache.keys()) if (!stored.has(id)) this.cache.delete(id);
    this.items = stored;
    this.tombstones = tombstones;
    this.publish();
  }

  private publish(loaded = this.snapshot.loaded): void {
    const items = [...this.items.values()].sort((a, b) => isoOrder(b.addedAt) - isoOrder(a.addedAt));
    this.emit({ loaded, items, adding: this.snapshot.adding });
  }

  /** Index writes made while one is queued share it, so a burst of progress saves costs one write. */
  private persist(): Promise<void> {
    if (this.queuedWrite) return this.queuedWrite;
    const write = this.writes.run(async () => {
      this.queuedWrite = null;
      await this.deps.kv.set(INDEX_KEY, { items: [...this.items.values()], tombstones: Object.fromEntries(this.tombstones) });
      this.bus.post('articles');
    });
    this.queuedWrite = write;
    return write;
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }

  summary(id: string): ArticleSummary | undefined {
    return this.items.get(id);
  }

  /** Every saved article, unsorted (the sync store's view). */
  get all(): Iterable<ArticleSummary> {
    return this.items.values();
  }

  /** Deleted ids and their deletion time, until they expire. */
  get deleted(): ReadonlyMap<string, string> {
    return this.tombstones;
  }

  private findByUrl(urls: string[]): ArticleSummary | undefined {
    const keys = new Set(urls.map(urlKey));
    for (const summary of this.items.values()) if (summary.urls.some((u) => keys.has(urlKey(u)))) return summary;
    return undefined;
  }

  /** Remembers another address for a saved article, so the next add of it needs no request. */
  private async alias(summary: ArticleSummary, urls: string[]): Promise<ArticleSummary> {
    const known = new Set(summary.urls.map(urlKey));
    const extra = urls.filter((u) => !known.has(urlKey(u)));
    if (extra.length === 0) return summary;
    const next = { ...summary, urls: [...summary.urls, ...extra] };
    this.items.set(next.id, next);
    this.publish();
    await this.persist();
    return next;
  }

  private progress(token: object, phase: ArticlePhase, url: string, progress: number | null): void {
    if (this.addToken !== token) return;
    const current = this.snapshot.adding;
    if (current && current.phase === phase && current.url === url && (current.progress ?? -1) === (progress ?? -1)) return;
    this.emit({ ...this.snapshot, adding: { url, phase, progress } });
  }

  async add(input: string, options: { signal?: AbortSignal } = {}): Promise<ArticleSummary> {
    const { signal } = options;
    const url = normalizeArticleUrl(input);
    if (!url) throw new ApiError("That doesn't look like a web address.", 'INVALID_URL');
    const existing = this.findByUrl([url]);
    if (existing) return existing;
    if (offline()) throw offlineError();

    const token = {};
    this.addToken = token;
    const check = () => {
      if (signal?.aborted) throw abortError();
    };
    try {
      this.progress(token, 'fetching', url, null);
      const extractor = this.deps.extract ? Promise.resolve(this.deps.extract) : loadExtractor();
      extractor.catch(() => undefined);
      const source = await measured('fetch', () =>
        this.fetchSource(url, signal, (fraction) => this.progress(token, 'fetching', url, Math.round(fraction * 14) / 20)),
      );
      const redirected = this.findByUrl([source.finalUrl]);
      if (redirected) return await this.alias(redirected, [url]);

      this.progress(token, 'extracting', url, 0.75);
      let extract: Extractor;
      try {
        extract = await extractor;
      } catch {
        throw new ApiError("Couldn't load the article reader. Reload the page and try again.", 'NETWORK', null, true);
      }
      await yieldToPaint();
      check();
      let article: Article | null = null;
      let doc: Document | null = null;
      try {
        const html = measured('decode', () => decodeHtml(source.bytes, source.contentType));
        const parse = this.deps.parse ?? ((s: string) => new DOMParser().parseFromString(s, 'text/html'));
        doc = measured('parse', () => parse(html));
      } catch (error) {
        console.warn('Article parsing failed', error);
      }
      if (doc) {
        // Parsing and extraction each hold the main thread; the dialog paints between them.
        this.progress(token, 'extracting', url, 0.82);
        await yieldToPaint();
        check();
        const page = doc;
        try {
          article = await measured('extract', () => extract(page, { url: source.finalUrl }));
        } catch (error) {
          console.warn('Article extraction failed', error);
        }
      }
      if (!article || article.blocks.length === 0) throw new ApiError("Couldn't find an article on that page.", 'NO_ARTICLE');

      const urls = [...new Set([url, source.finalUrl, normalizeArticleUrl(article.url)].filter((u): u is string => u !== null))];
      const duplicate = this.findByUrl(urls);
      if (duplicate) return await this.alias(duplicate, urls);

      check();
      this.progress(token, 'saving', url, 0.92);
      const draft = summarize('', article, urls, nowIso(this.now));
      const id = articleIdFor(draft.url);
      const same = this.items.get(id);
      if (same) return await this.alias(same, urls);
      // Saving a deleted article again brings it back, newer than its deletion.
      const deletedAt = this.tombstones.get(id);
      const addedAt = deletedAt && !isAfter(draft.addedAt, deletedAt) ? new Date(parseIso(deletedAt) + 1).toISOString() : draft.addedAt;
      const summary: ArticleSummary = { ...draft, ...documentFields(article, articleBody(article)), id, addedAt };
      await measured('store', () => this.deps.kv.set(articleKey(id), { article }));
      this.remember(id, article);
      this.tombstones.delete(id);
      this.items.set(id, summary);
      this.publish();
      await this.persist();
      return summary;
    } finally {
      if (this.addToken === token) {
        this.addToken = null;
        this.emit({ ...this.snapshot, adding: null });
      }
    }
  }

  private async fetchSource(
    url: string,
    signal: AbortSignal | undefined,
    onProgress: (fraction: number) => void,
  ): Promise<{ bytes: Uint8Array; contentType: string | null; finalUrl: string }> {
    const host = hostLabel(url);
    const endpoint = `${this.deps.currentOrigin()}/v1/article-source?url=${encodeURIComponent(url)}`;
    const fetchImpl: FetchLike = this.deps.fetch ?? ((input, init) => fetch(input, init));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.deps.timeoutMs ?? ARTICLE_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onAbort);
    const failure = (error: unknown): unknown => {
      if (error instanceof ApiError) return error;
      if (signal?.aborted) return abortError();
      if (timedOut) return new ApiError(`${host} took too long to respond.`, 'TIMEOUT', null, true);
      if (offline()) return offlineError();
      return new ApiError("Couldn't reach The Reader's server. Check your connection and try again.", 'NETWORK', null, true);
    };
    try {
      const response = await fetchImpl(endpoint, { signal: controller.signal, headers: { accept: 'text/html,application/xhtml+xml' } });
      if (!response.ok) throw relayError(errorFrom(response.status, await response.text().catch(() => '')), host);
      const bytes = await readBody(response, onProgress);
      const finalUrl = normalizeArticleUrl(response.headers.get('x-final-url') ?? '') ?? url;
      return { bytes, contentType: response.headers.get('content-type'), finalUrl };
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private remember(id: string, article: Article): void {
    this.cache.delete(id);
    this.cache.set(id, article);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
  }

  /**
   * The stored document. An article synced from another device downloads it
   * once (verified against its hash) and keeps it for offline reading; that
   * is the only request this makes. Null when the document is gone.
   */
  async get(id: string): Promise<Article | null> {
    const cached = this.cache.get(id);
    if (cached) {
      this.remember(id, cached);
      return cached;
    }
    const record = await this.deps.kv.get<unknown>(articleKey(id)).catch(() => null);
    const article = isRecord(record) && isArticle(record.article) ? record.article : null;
    if (article && this.items.has(id)) this.remember(id, article);
    if (article) return article;
    const summary = this.items.get(id);
    if (summary?.stored !== false) return null;
    return this.download(summary, true);
  }

  /** Downloads a cloud article's document; joins a download already running. */
  private download(summary: ArticleSummary, interactive: boolean): Promise<Article> {
    let running = this.downloads.get(summary.id);
    if (!running) {
      running = this.fetchDocument(summary).finally(() => this.downloads.delete(summary.id));
      this.downloads.set(summary.id, running);
    }
    return running.catch((error: unknown) => {
      if (!interactive) throw error;
      throw downloadError(error);
    });
  }

  private async fetchDocument(summary: ArticleSummary): Promise<Article> {
    const sha = summary.bodySha256;
    const client = this.deps.bodies?.(this.deps.currentOrigin());
    if (!sha || !client) throw new ApiError("This article's text isn't on this device.", 'UNSUPPORTED');
    if (offline()) throw new ApiError("You're offline. This article will open once it downloads.", 'OFFLINE', null, true);
    let article: Article;
    try {
      const bytes = await client.getArticleBody(sha);
      if (toHex(sha256Bytes(bytes)) !== sha) throw new ApiError('The synced copy of this article is damaged.', 'BAD_RESPONSE');
      const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (!isArticle(json)) throw new ApiError('The synced copy of this article is damaged.', 'BAD_RESPONSE');
      article = json;
    } catch (error) {
      const previous = this.retryAt.get(summary.id)?.wait ?? 0;
      const wait = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, previous * 2));
      this.retryAt.set(summary.id, { at: this.now() + wait, wait });
      throw error;
    }
    this.retryAt.delete(summary.id);
    await this.deps.kv.set(articleKey(summary.id), { article });
    const current = this.items.get(summary.id);
    if (current && current.bodySha256 === sha) {
      this.items.set(summary.id, { ...current, stored: true });
      this.publish();
      await this.persist();
    }
    this.remember(summary.id, article);
    return article;
  }

  /**
   * Downloads up to `limit` small cloud documents that are due, one at a
   * time, so recently synced articles open offline. Stops at the first
   * network failure. Called by the sync store after a successful cycle.
   */
  async prefetch(limit: number): Promise<void> {
    if (!this.deps.bodies) return;
    const now = this.now();
    const due = [...this.items.values()]
      .filter((s) => s.stored === false && s.bodySha256 && (s.bodySize ?? Infinity) <= PREFETCH_MAX_BYTES && (this.retryAt.get(s.id)?.at ?? 0) <= now)
      .sort((a, b) => isoOrder(b.addedAt) - isoOrder(a.addedAt))
      .slice(0, limit);
    for (const summary of due) {
      try {
        await this.download(summary, false);
      } catch (error) {
        if (error instanceof ApiError && error.isNetwork) return;
      }
    }
  }

  /** The exact document bytes to upload, or null when this device no longer has them. */
  async bodyFor(id: string): Promise<{ bytes: Uint8Array; sha256: string } | null> {
    const summary = this.items.get(id);
    if (!summary || summary.stored === false) return null;
    const article = this.cache.get(id) ?? (await this.deps.kv.get<unknown>(articleKey(id)).then((r) => (isRecord(r) && isArticle(r.article) ? r.article : null), () => null));
    return article ? articleBody(article) : null;
  }

  async remove(id: string): Promise<void> {
    this.cache.delete(id);
    const summary = this.items.get(id);
    if (summary) {
      this.items.delete(id);
      // The deletion must sort after the save it removes, even if the clock went back.
      const now = nowIso(this.now);
      this.tombstones.set(id, isAfter(now, summary.addedAt) ? now : new Date(parseIso(summary.addedAt) + 1).toISOString());
      this.publish();
      await this.persist();
    }
    await this.deps.kv.remove(articleKey(id));
  }

  async saveProgress(id: string, fraction: number): Promise<void> {
    const summary = this.items.get(id);
    if (!summary || !Number.isFinite(fraction)) return;
    const progress = Math.round(Math.min(1, Math.max(0, fraction)) * 10000) / 10000;
    if (summary.progress === progress) return;
    const now = nowIso(this.now);
    const progressUpdatedAt = isAfter(now, summary.progressUpdatedAt) ? now : new Date(parseIso(summary.progressUpdatedAt!) + 1).toISOString();
    this.items.set(id, { ...summary, progress, progressUpdatedAt });
    this.publish();
    await this.persist();
  }

  /**
   * Applies articles changed on other devices. Saves and deletions are
   * last-write-wins by their time; positions by theirs. A local copy of the
   * document is kept when another device saved the same story again. An open
   * article does not move: the reader holds its own position and saves it
   * when it closes.
   */
  async applyRemote(remote: RemoteArticle[]): Promise<void> {
    let changed = false;
    const removed: string[] = [];
    for (const r of remote) {
      const local = this.items.get(r.id);
      if (r.deleted) {
        if (local && isAfter(r.updatedAt, local.addedAt)) {
          this.items.delete(r.id);
          this.cache.delete(r.id);
          removed.push(r.id);
          changed = true;
        }
        // A later deletion elsewhere supersedes this device's own, so it is not sent again.
        const deletedAt = this.tombstones.get(r.id);
        if (deletedAt && isAfter(r.updatedAt, deletedAt)) {
          this.tombstones.set(r.id, r.updatedAt);
          changed = true;
        }
        continue;
      }
      if (!r.bodySha256 || !normalizeArticleUrl(r.url)) continue;
      const position =
        r.position && r.positionUpdatedAt ? { progress: fractionFromPosition(r.position, r.blockCount), progressUpdatedAt: r.positionUpdatedAt } : {};
      if (!local) {
        const deletedAt = this.tombstones.get(r.id);
        if (deletedAt && !isAfter(r.updatedAt, deletedAt)) continue; // This device's newer deletion is still to sync.
        this.tombstones.delete(r.id);
        this.items.set(r.id, { ...fromRemote(r), progress: null, progressUpdatedAt: null, ...position, lastOpenedAt: null, stored: false });
        changed = true;
        continue;
      }
      let next = local;
      if (isAfter(r.updatedAt, local.addedAt)) {
        // Saved again elsewhere: take its metadata, keep this device's document.
        const metadata = fromRemote(r);
        next = {
          ...next,
          ...metadata,
          urls: [...new Set([...local.urls, ...metadata.urls])],
          ...(local.stored === false ? {} : { bodySha256: local.bodySha256, bodySize: local.bodySize, blockCount: local.blockCount }),
          stored: local.stored,
        };
      }
      if ('progress' in position && isAfter(position.progressUpdatedAt, local.progressUpdatedAt)) next = { ...next, ...position };
      if (next !== local) {
        this.items.set(r.id, next);
        changed = true;
      }
    }
    if (!changed) return;
    this.publish();
    await this.persist();
    for (const id of removed) await this.deps.kv.remove(articleKey(id)).catch(() => undefined);
  }

  async markOpened(id: string): Promise<void> {
    const summary = this.items.get(id);
    if (!summary) return;
    this.items.set(id, { ...summary, lastOpenedAt: nowIso(this.now) });
    this.publish();
    await this.persist();
  }
}

function fromRemote(r: RemoteArticle): Omit<ArticleSummary, 'progress' | 'progressUpdatedAt' | 'lastOpenedAt' | 'stored'> {
  return {
    id: r.id,
    url: r.url,
    urls: [r.url],
    title: r.title.trim() || hostLabel(r.url),
    siteName: r.siteName?.trim() || hostLabel(r.url),
    byline: r.byline,
    excerpt: r.excerpt,
    favicon: r.favicon,
    image: r.leadImage,
    readingMinutes: Math.max(1, r.readingMinutes),
    addedAt: r.updatedAt,
    language: r.language,
    dir: r.dir,
    wordCount: r.wordCount,
    publishedAt: r.publishedAt,
    blockCount: r.blockCount,
    bodySha256: r.bodySha256,
    bodySize: r.bodySize,
  };
}

/** What the reader shows when a synced article cannot download yet. */
function downloadError(error: unknown): ApiError {
  if (!(error instanceof ApiError)) return new ApiError("Couldn't download this article. Try again.", 'NETWORK', null, true);
  if (error.status === 404) {
    return new ApiError("This article hasn't finished uploading from the device that saved it. Try again in a minute.", 'PENDING', 404, true);
  }
  if (error.code === 'TIMEOUT' || error.code === 'NETWORK') {
    return new ApiError(offline() ? "You're offline. This article will open once it downloads." : "Couldn't download this article. Try again.", error.code, null, true);
  }
  return error;
}

async function readBody(response: Response, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || total <= 0) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
