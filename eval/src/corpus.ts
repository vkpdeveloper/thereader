import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Repository root and the gitignored corpus directories under `test-corpus/`. */
export const ROOT = resolve(import.meta.dir, '../..');
export const EVAL_DIR = resolve(ROOT, 'eval');
export const CORPUS_DIR = resolve(ROOT, 'test-corpus');
export const LIVE_DIR = resolve(CORPUS_DIR, 'live');
export const ZYTE_DIR = resolve(CORPUS_DIR, 'zyte');
export const OUTPUT_DIR = resolve(CORPUS_DIR, 'eval-out');
export const CURATED_PATH = resolve(EVAL_DIR, 'corpus/curated.json');

/** The request headers the app sends when it fetches an article. */
export const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export type Dataset = 'zyte' | 'curated';

/** One page to extract: decoded HTML plus the URL it was fetched from. */
export interface Doc {
  dataset: Dataset;
  id: string;
  url: string;
  html: string;
  bytes: number;
}

export interface SnapshotMeta {
  id: string;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  bytes: number;
  error?: string;
}

export interface CuratedEntry {
  id: string;
  url: string;
  tier: 1 | 2 | 3 | 4 | 5;
  category: string;
  language: string;
  notes: string;
  jsOnly?: boolean;
  title: string;
  mustInclude: string[];
  mustExclude: string[];
  minCodeBlocks?: number;
  codeLanguages?: string[];
  minImages?: number;
  minHeadings?: number;
  minTables?: number;
  hasMath?: boolean;
  hasFootnotes?: boolean;
  hasEmbeds?: boolean;
  annotationConfidence?: 'high' | 'medium' | 'low';
}

function charsetOf(value: string | null | undefined): string | undefined {
  return value?.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
}

function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    const decoder = new TextDecoder(label);
    return decoder.encoding === 'utf-16le' || decoder.encoding === 'utf-16be' ? new TextDecoder('utf-8') : decoder;
  } catch {
    return undefined;
  }
}

/**
 * Decodes HTML bytes the way a browser picks the encoding: BOM, then the
 * `Content-Type` charset, then a `<meta>` prescan of the first 1024 bytes,
 * then UTF-8. Labels go through the WHATWG Encoding table via `TextDecoder`.
 */
export function decodeHtml(bytes: Uint8Array, contentType = ''): { html: string; charset: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { html: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { html: new TextDecoder('utf-16be').decode(bytes), charset: 'utf-16be' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { html: new TextDecoder('utf-16le').decode(bytes), charset: 'utf-16le' };
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
  const meta =
    head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ??
    charsetOf(head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*>/i)?.[0]);
  const decoder = decoderFor(charsetOf(contentType)) ?? decoderFor(meta) ?? new TextDecoder('utf-8');
  return { html: decoder.decode(bytes), charset: decoder.encoding };
}

export async function loadCurated(): Promise<CuratedEntry[]> {
  return Bun.file(CURATED_PATH).json();
}

export async function loadSnapshotMeta(id: string): Promise<SnapshotMeta | undefined> {
  const path = resolve(LIVE_DIR, `${id}.json`);
  return existsSync(path) ? Bun.file(path).json() : undefined;
}

/** Curated pages with a successful snapshot, decoded. */
export async function loadCuratedDocs(entries: CuratedEntry[]): Promise<Doc[]> {
  const docs: Doc[] = [];
  for (const entry of entries) {
    const meta = await loadSnapshotMeta(entry.id);
    if (!meta || meta.error || meta.status >= 400) continue;
    const bytes = new Uint8Array(await Bun.file(resolve(LIVE_DIR, `${entry.id}.html`)).arrayBuffer());
    const { html } = decodeHtml(bytes, meta.contentType);
    docs.push({ dataset: 'curated', id: entry.id, url: meta.finalUrl, html, bytes: bytes.length });
  }
  return docs;
}

export interface ZyteTruth {
  articleBody: string;
  url: string;
}

/** The Zyte benchmark pages (UTF-8, gzipped) and their ground truth. */
export async function loadZyte(): Promise<{ docs: Doc[]; truth: Record<string, ZyteTruth> }> {
  const truth: Record<string, ZyteTruth> = await Bun.file(resolve(ZYTE_DIR, 'ground-truth.json')).json();
  const docs: Doc[] = [];
  for (const name of (await readdir(resolve(ZYTE_DIR, 'html'))).sort()) {
    const id = name.split('.')[0];
    const bytes = Bun.gunzipSync(new Uint8Array(await Bun.file(resolve(ZYTE_DIR, 'html', name)).arrayBuffer()));
    docs.push({ dataset: 'zyte', id, url: truth[id].url, html: new TextDecoder('utf-8').decode(bytes), bytes: bytes.length });
  }
  return { docs, truth };
}
