import type { InkStore, InkSnapshot } from './contract';
import type { KeyValueStore } from './kv';
import { isRecord } from './models';
import { Emitter, WriteQueue } from './observable';
import { noopBus, type TabBus } from './tabs';

/** Pen styles: a solid line, a row of dots, dashes, and a wide translucent marker. */
export type InkTool = 'pen' | 'dotted' | 'dashed' | 'marker';
export const inkTools: InkTool[] = ['pen', 'dotted', 'dashed', 'marker'];

/** An article block: its index (`data-block-index`; -1 is the article header) and its size when drawn. */
export interface BlockAnchor {
  block: number;
  width: number;
  height: number;
}

/**
 * A character of a book chapter: the chapter (`href`, as in highlight
 * locators), the character's offset in the chapter's text, the text there
 * (to find it again should the offset drift) and the height of its line box
 * when drawn, which scales the stroke when the type size changes.
 */
export interface TextAnchor {
  href: string;
  offset: number;
  text: { before: string; highlight: string };
  height: number;
}

export type InkAnchor = BlockAnchor | TextAnchor;

export const isTextAnchor = (anchor: InkAnchor): anchor is TextAnchor => 'href' in anchor;

/**
 * One freehand stroke drawn over a page. Points are kept relative to what
 * the stroke was drawn on (`anchor`), not to the page: an article block's
 * box, or the box of one character in a book. So the drawing follows its
 * passage when the layout moves it (images loading, other pages, another
 * window size) and scales with it when the type size changes.
 */
export interface InkStroke {
  id: string;
  tool: InkTool;
  /** `#rrggbb`. */
  color: string;
  /** Line width in CSS pixels. */
  size: number;
  anchor: InkAnchor;
  /** Flat `x, y` pairs in pixels from the anchor's top-left corner. */
  points: number[];
  createdAt: string;
}

/** IndexedDB key of one page's drawing. */
export const inkKey = (docId: string): string => `ink:${docId}`;
/** The drawing of a saved article. */
export const articleInkId = (articleId: string): string => `article:${articleId}`;
/** The drawing of a book edition (every chapter in one record). */
export const bookInkId = (sha256: string): string => `book:${sha256}`;

const EMPTY: InkStroke[] = [];

function parseAnchor(raw: Record<string, unknown>): InkAnchor | null {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof raw.href === 'string') {
    const text = isRecord(raw.text) ? raw.text : {};
    if (!num(raw.offset) || !num(raw.height)) return null;
    return {
      href: raw.href,
      offset: raw.offset,
      text: { before: typeof text.before === 'string' ? text.before : '', highlight: typeof text.highlight === 'string' ? text.highlight : '' },
      height: raw.height,
    };
  }
  if (!num(raw.block) || !num(raw.width) || !num(raw.height)) return null;
  return { block: raw.block, width: raw.width, height: raw.height };
}

function parseStroke(raw: unknown): InkStroke | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.anchor) || !Array.isArray(raw.points)) return null;
  const tool = inkTools.includes(raw.tool as InkTool) ? (raw.tool as InkTool) : 'pen';
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#ededed';
  const size = typeof raw.size === 'number' && raw.size > 0 && raw.size <= 64 ? raw.size : 3;
  const anchor = parseAnchor(raw.anchor);
  if (!anchor) return null;
  const points = raw.points.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (points.length < 2 || points.length % 2 !== 0) return null;
  return {
    id: raw.id,
    tool,
    color,
    size,
    anchor,
    points,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
  };
}

/**
 * Pen drawings over pages, on this device. Each page's strokes are one
 * stored record, read the first time the page opens; every edit is saved at
 * once and other open tabs reload the pages they have loaded.
 */
export class InkStoreImpl extends Emitter<InkSnapshot> implements InkStore {
  private readonly docs = new Map<string, InkStroke[]>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly writes = new WriteQueue();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly bus: TabBus = noopBus,
  ) {
    super({ version: 0 });
    bus.listen((topic) => {
      if (topic !== 'ink') return;
      for (const docId of this.docs.keys()) void this.read(docId);
    });
  }

  /** The page's strokes in drawing order; the same array until it changes. Empty until `open` resolves. */
  strokes(docId: string): InkStroke[] {
    return this.docs.get(docId) ?? EMPTY;
  }

  isOpen(docId: string): boolean {
    return this.docs.has(docId);
  }

  /** Reads a page's drawing from storage (once). */
  open(docId: string): Promise<void> {
    if (this.docs.has(docId)) return Promise.resolve();
    let pending = this.loading.get(docId);
    if (!pending) {
      pending = this.read(docId).finally(() => this.loading.delete(docId));
      this.loading.set(docId, pending);
    }
    return pending;
  }

  private async read(docId: string): Promise<void> {
    let list: InkStroke[] = [];
    try {
      const saved = await this.kv.get<unknown>(inkKey(docId));
      const raw = isRecord(saved) && Array.isArray(saved.strokes) ? saved.strokes : [];
      list = raw.map(parseStroke).filter((s): s is InkStroke => s !== null);
    } catch {
      /* An unreadable record shows no drawing; nothing is overwritten until an edit. */
    }
    this.set(docId, list);
  }

  private set(docId: string, list: InkStroke[]): void {
    this.docs.set(docId, list);
    this.emit({ version: this.snapshot.version + 1 });
  }

  private save(docId: string): Promise<void> {
    const list = this.strokes(docId);
    return this.writes.run(async () => {
      if (list.length === 0) await this.kv.remove(inkKey(docId));
      else await this.kv.set(inkKey(docId), { strokes: list });
      this.bus.post('ink');
    });
  }

  /** Adds strokes on top (an undone erase puts them back where they were). */
  add(docId: string, strokes: InkStroke[]): Promise<void> {
    if (strokes.length === 0) return Promise.resolve();
    const ids = new Set(strokes.map((s) => s.id));
    const next = [...this.strokes(docId).filter((s) => !ids.has(s.id)), ...strokes].sort(
      (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
    );
    this.set(docId, next);
    return this.save(docId);
  }

  remove(docId: string, ids: string[]): Promise<void> {
    const drop = new Set(ids);
    const current = this.strokes(docId);
    const next = current.filter((s) => !drop.has(s.id));
    if (next.length === current.length) return Promise.resolve();
    this.set(docId, next);
    return this.save(docId);
  }

  /** Waits for pending writes (tests). */
  flush(): Promise<void> {
    return this.writes.flush();
  }
}
