import { articleIdOf } from '../articleAnchors';
import type { Highlight } from '../types';
import type { HighlightStore, HighlightsSnapshot } from './contract';
import { randomId } from './hash';
import type { KeyValueStore } from './kv';
import { isAfter, isRecord, isoOrder, nowIso, parseHighlight, parseIso } from './models';
import { Emitter, WriteQueue } from './observable';
import { noopBus, type TabBus } from './tabs';

const HIGHLIGHTS_KEY = 'highlights.v1';
/** The API's limits on highlighted text and notes. */
export const MAX_HIGHLIGHT_TEXT = 4000;
export const MAX_HIGHLIGHT_NOTE = 4000;

/**
 * Highlights on this device. Every edit is saved locally at once and never
 * sends a request itself: the sync store notices the change and sends it on
 * its next scheduled cycle. Deletes keep a tombstone so they sync too.
 */
export class HighlightStoreImpl extends Emitter<HighlightsSnapshot> implements HighlightStore {
  private items = new Map<string, Highlight>();
  private readonly writes = new WriteQueue();
  /** `forEdition` results for the current snapshot, so repeated calls return the same array. */
  private editions = new Map<string, Highlight[]>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly bus: TabBus = noopBus,
    private readonly now: () => number = Date.now,
  ) {
    super({ loaded: false, all: [] });
    bus.listen((topic) => {
      if (topic === 'highlights' && this.snapshot.loaded) void this.reload();
    });
  }

  get loaded(): boolean {
    return this.snapshot.loaded;
  }

  async load(): Promise<void> {
    this.items = await this.readStored();
    this.publish(true);
  }

  private async readStored(): Promise<Map<string, Highlight>> {
    const map = new Map<string, Highlight>();
    try {
      const saved = await this.kv.get<unknown>(HIGHLIGHTS_KEY);
      const list = isRecord(saved) && Array.isArray(saved.items) ? saved.items : [];
      for (const raw of list) {
        try {
          const h = parseHighlight(raw);
          map.set(h.id, h);
        } catch {
          /* Skip one damaged record rather than losing all of them. */
        }
      }
    } catch {
      /* An unreadable store starts empty; nothing is overwritten until an edit. */
    }
    return map;
  }

  /** Another tab saved: records merge by last write wins (tombstones included). */
  private async reload(): Promise<void> {
    const stored = await this.readStored();
    let changed = false;
    for (const [id, h] of stored) {
      const local = this.items.get(id);
      if (!local || isAfter(h.updatedAt, local.updatedAt)) {
        this.items.set(id, h);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private publish(loaded = this.snapshot.loaded): void {
    this.editions = new Map();
    this.emit({ loaded, all: [...this.items.values()] });
  }

  /**
   * Live highlights of one edition in reading order. The same array is
   * returned until the store changes, so it is safe as a React dependency.
   */
  forEdition(origin: string, sha256: string): Highlight[] {
    const key = `${origin}\n${sha256}`;
    let list = this.editions.get(key);
    if (!list) {
      list = this.snapshot.all
        .filter((h) => !h.deleted && h.origin === origin && h.sha256 === sha256)
        .sort((a, b) => position(a) - position(b) || isoOrder(a.createdAt) - isoOrder(b.createdAt));
      this.editions.set(key, list);
    }
    return list;
  }

  /**
   * Live highlights of one saved article (any origin, like articles
   * themselves) in reading order; stable like `forEdition`.
   */
  forArticle(articleId: string): Highlight[] {
    const key = `article\n${articleId}`;
    let list = this.editions.get(key);
    if (!list) {
      list = this.snapshot.all
        .filter((h) => !h.deleted && articleIdOf(h) === articleId)
        .sort((a, b) => position(a) - position(b) || isoOrder(a.createdAt) - isoOrder(b.createdAt));
      this.editions.set(key, list);
    }
    return list;
  }

  byId(id: string): Highlight | undefined {
    return this.items.get(id);
  }

  async create(input: {
    bookId: string;
    sha256: string;
    origin: string;
    locator: Record<string, unknown>;
    text: string;
    color: string;
    note?: string | null;
  }): Promise<Highlight> {
    const at = this.stamp();
    const h: Highlight = {
      id: randomId(),
      bookId: input.bookId,
      sha256: input.sha256,
      origin: input.origin,
      locator: input.locator,
      text: input.text.length > MAX_HIGHLIGHT_TEXT ? input.text.slice(0, MAX_HIGHLIGHT_TEXT) : input.text,
      color: input.color,
      note: cleanNote(input.note),
      createdAt: at,
      updatedAt: at,
      deleted: false,
    };
    this.items.set(h.id, h);
    await this.changed();
    return h;
  }

  async recolor(id: string, color: string): Promise<void> {
    const h = this.items.get(id);
    if (!h || h.deleted || h.color === color) return;
    this.items.set(id, { ...h, color, updatedAt: this.stamp(h) });
    await this.changed();
  }

  /**
   * Sets or clears (null or blank) the note on a highlight. Notes are part of
   * the synced record, so this rides the next sync like any other edit.
   */
  async setNote(id: string, note: string | null): Promise<void> {
    const h = this.items.get(id);
    const next = cleanNote(note);
    if (!h || h.deleted || (h.note ?? null) === next) return;
    this.items.set(id, { ...h, note: next, updatedAt: this.stamp(h) });
    await this.changed();
  }

  async delete(id: string): Promise<void> {
    const h = this.items.get(id);
    if (!h || h.deleted) return;
    this.items.set(id, { ...h, deleted: true, updatedAt: this.stamp(h) });
    await this.changed();
  }

  /** Applies cloud records that are newer (last write wins by `updatedAt`). */
  async applyRemote(remote: Highlight[]): Promise<boolean> {
    let changed = false;
    for (const h of remote) {
      const local = this.items.get(h.id);
      if (local && !isAfter(h.updatedAt, local.updatedAt)) continue;
      this.items.set(h.id, h);
      changed = true;
    }
    if (changed) await this.changed();
    return changed;
  }

  /** Edits always move forward in time, even if the clock went back. */
  private stamp(previous?: Highlight): string {
    const now = nowIso(this.now);
    if (previous && !isAfter(now, previous.updatedAt)) {
      return new Date(parseIso(previous.updatedAt) + 1).toISOString();
    }
    return now;
  }

  private changed(): Promise<void> {
    this.publish();
    const snapshot = { items: [...this.items.values()] };
    return this.writes.run(async () => {
      await this.kv.set(HIGHLIGHTS_KEY, snapshot);
      this.bus.post('highlights');
    });
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }
}

function cleanNote(note: string | null | undefined): string | null {
  if (typeof note !== 'string' || note.trim() === '') return null;
  return note.length > MAX_HIGHLIGHT_NOTE ? note.slice(0, MAX_HIGHLIGHT_NOTE) : note;
}

function position(h: Highlight): number {
  const loc = h.locator.locations;
  if (isRecord(loc) && typeof loc.totalProgression === 'number') return loc.totalProgression;
  return 0;
}
