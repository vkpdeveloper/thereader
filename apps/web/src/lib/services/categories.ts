import {
  MAX_CATEGORY_NAME,
  categoryItemKey,
  parseCategoryColor,
  type Category,
  type CategoryColor,
  type CategoryItemRef,
  type CategoryItemType,
} from '../categories';
import type { CategoriesSnapshot, CategoryStore } from './contract';
import type { KeyValueStore } from './kv';
import { isAfter, isRecord, isoOrder, nowIso, parseIso, toIso } from './models';
import { Emitter, WriteQueue } from './observable';
import { noopBus, type TabBus } from './tabs';

const CATEGORIES_KEY = 'categories.v1';
/** The API's colour key rule; unknown keys are kept (a newer build's colour) and render gray. */
const COLOR_KEY = /^[a-z]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A category as stored and synced. Tombstones (`deleted`) are final. */
export interface CategoryRecord {
  id: string;
  name: string;
  /** Raw colour key, kept as received so a newer build's colour round-trips. */
  color: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

/** Where one item is filed; `categoryId: null` means taken out of its category. */
export interface AssignmentRecord {
  type: CategoryItemType;
  id: string;
  categoryId: string | null;
  updatedAt: string;
}

/**
 * The name as saved (trimmed), or an Error with a message for people. Length
 * counts UTF-16 units, which is never fewer than the API's count.
 */
export function cleanCategoryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Enter a name for the category.');
  if (trimmed.length > MAX_CATEGORY_NAME) throw new Error(`Category names can be at most ${MAX_CATEGORY_NAME} characters.`);
  if (CONTROL.test(trimmed)) throw new Error('Category names cannot contain control characters.');
  return trimmed;
}

export function validCategoryName(name: string): boolean {
  try {
    return cleanCategoryName(name) === name;
  } catch {
    return false;
  }
}

/**
 * Categories of books and saved articles (docs/categories.md). Every edit is
 * saved locally at once and never sends a request itself: the sync store
 * notices the change and sends it on its next scheduled cycle. Deletions keep
 * a tombstone so they sync too; assignments are kept even when their category
 * is gone or not known yet, and only count while it is live.
 */
export class CategoryStoreImpl extends Emitter<CategoriesSnapshot> implements CategoryStore {
  private categories = new Map<string, CategoryRecord>();
  /** Keyed by `categoryItemKey`. */
  private assignments = new Map<string, AssignmentRecord>();
  private readonly writes = new WriteQueue();
  /** Public objects per record, so unchanged categories keep their identity across snapshots. */
  private readonly views = new WeakMap<CategoryRecord, Category>();
  /** `itemsIn` results for the current snapshot. */
  private members = new Map<string, CategoryItemRef[]>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly bus: TabBus = noopBus,
    private readonly now: () => number = Date.now,
  ) {
    super({ loaded: false, categories: [], assignments: {} });
    bus.listen((topic) => {
      if (topic === 'categories' && this.snapshot.loaded) void this.reload();
    });
  }

  get loaded(): boolean {
    return this.snapshot.loaded;
  }

  async load(): Promise<void> {
    const stored = await this.readStored();
    this.categories = stored.categories;
    this.assignments = stored.assignments;
    this.publish(true);
  }

  private async readStored(): Promise<{ categories: Map<string, CategoryRecord>; assignments: Map<string, AssignmentRecord> }> {
    const categories = new Map<string, CategoryRecord>();
    const assignments = new Map<string, AssignmentRecord>();
    try {
      const saved = await this.kv.get<unknown>(CATEGORIES_KEY);
      // Skip one damaged record rather than losing all of them.
      for (const raw of isRecord(saved) && Array.isArray(saved.categories) ? saved.categories : []) {
        const c = parseCategoryRecord(raw);
        if (c) categories.set(c.id, c);
      }
      for (const raw of isRecord(saved) && Array.isArray(saved.assignments) ? saved.assignments : []) {
        const a = parseAssignmentRecord(raw);
        if (a) assignments.set(assignmentKey(a), a);
      }
    } catch {
      /* An unreadable store starts empty; nothing is overwritten until an edit. */
    }
    return { categories, assignments };
  }

  /** Another tab saved: records merge like a pull (last write wins, tombstones final). */
  private async reload(): Promise<void> {
    const stored = await this.readStored();
    if (this.merge([...stored.categories.values()], [...stored.assignments.values()])) this.publish();
  }

  private merge(categories: CategoryRecord[], assignments: AssignmentRecord[]): boolean {
    let changed = false;
    for (const incoming of categories) {
      const local = this.categories.get(incoming.id);
      if (!takesCategory(local, incoming)) continue;
      // A tombstone row may carry no name; keep what this device knew.
      this.categories.set(incoming.id, incoming.deleted && local ? { ...local, deleted: true, updatedAt: incoming.updatedAt } : incoming);
      changed = true;
    }
    for (const incoming of assignments) {
      const key = assignmentKey(incoming);
      const local = this.assignments.get(key);
      if (local && !isAfter(incoming.updatedAt, local.updatedAt)) continue;
      this.assignments.set(key, incoming);
      changed = true;
    }
    return changed;
  }

  private publish(loaded = this.snapshot.loaded): void {
    this.members = new Map();
    const live = [...this.categories.values()]
      .filter((c) => !c.deleted)
      .sort((a, b) => isoOrder(a.createdAt) - isoOrder(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const assignments: CategoriesSnapshot['assignments'] = {};
    for (const [key, a] of this.assignments) {
      const category = a.categoryId === null ? undefined : this.categories.get(a.categoryId);
      if (category && !category.deleted) assignments[key] = { categoryId: category.id, assignedAt: a.updatedAt };
    }
    this.emit({ loaded, categories: live.map((c) => this.view(c)), assignments });
  }

  private view(record: CategoryRecord): Category {
    let category = this.views.get(record);
    if (!category) {
      category = { id: record.id, name: record.name, color: parseCategoryColor(record.color), createdAt: record.createdAt, updatedAt: record.updatedAt };
      this.views.set(record, category);
    }
    return category;
  }

  // ---------------------------------------------------------------- reads

  /** Every category record, tombstones included (the sync store's view). */
  get allCategories(): Iterable<CategoryRecord> {
    return this.categories.values();
  }

  /** Every assignment record, including ones to gone or unknown categories. */
  get allAssignments(): Iterable<AssignmentRecord> {
    return this.assignments.values();
  }

  category(id: string): CategoryRecord | undefined {
    return this.categories.get(id);
  }

  assignment(item: CategoryItemRef): AssignmentRecord | undefined {
    return this.assignments.get(categoryItemKey(item));
  }

  categoryOf(item: CategoryItemRef): Category | null {
    // Snapshot assignments only point at live categories.
    const a = this.snapshot.assignments[categoryItemKey(item)];
    const record = a ? this.categories.get(a.categoryId) : undefined;
    return record ? this.view(record) : null;
  }

  /** Newest assignment first; the same array until the store changes. */
  itemsIn(categoryId: string): CategoryItemRef[] {
    let list = this.members.get(categoryId);
    if (!list) {
      list = Object.entries(this.snapshot.assignments)
        .filter(([, a]) => a.categoryId === categoryId)
        .sort(([ka, a], [kb, b]) => isoOrder(b.assignedAt) - isoOrder(a.assignedAt) || (ka < kb ? -1 : ka > kb ? 1 : 0))
        .map(([key]) => this.assignments.get(key)!)
        .map((a) => ({ type: a.type, id: a.id }));
      this.members.set(categoryId, list);
    }
    return list;
  }

  // ---------------------------------------------------------------- edits

  async create(name: string, color: CategoryColor): Promise<Category> {
    const clean = cleanCategoryName(name);
    const at = this.stamp();
    const record: CategoryRecord = { id: uuidV4(), name: clean, color: colorKey(color), createdAt: at, updatedAt: at, deleted: false };
    this.categories.set(record.id, record);
    await this.changed();
    return this.view(record);
  }

  async update(id: string, change: { name?: string; color?: CategoryColor }): Promise<void> {
    const record = this.categories.get(id);
    if (!record || record.deleted) return;
    const name = change.name === undefined ? record.name : cleanCategoryName(change.name);
    const color = change.color === undefined ? record.color : colorKey(change.color);
    if (name === record.name && color === record.color) return;
    this.categories.set(id, { ...record, name, color, updatedAt: this.stamp(record.updatedAt) });
    await this.changed();
  }

  /**
   * Leaves a tombstone, and takes every item this device has filed there out
   * of it (`categoryId: null`), so stored state stays tidy everywhere.
   */
  async remove(id: string): Promise<void> {
    const record = this.categories.get(id);
    if (!record || record.deleted) return;
    this.categories.set(id, { ...record, deleted: true, updatedAt: this.stamp(record.updatedAt) });
    for (const [key, a] of this.assignments) {
      if (a.categoryId === id) this.assignments.set(key, { ...a, categoryId: null, updatedAt: this.stamp(a.updatedAt) });
    }
    await this.changed();
  }

  async assign(item: CategoryItemRef, categoryId: string | null): Promise<void> {
    if (categoryId !== null) {
      const target = this.categories.get(categoryId);
      if (!target || target.deleted) throw new Error('That category no longer exists.');
    }
    const key = categoryItemKey(item);
    const local = this.assignments.get(key);
    if ((local?.categoryId ?? null) === categoryId) return;
    this.assignments.set(key, { type: item.type, id: item.id, categoryId, updatedAt: this.stamp(local?.updatedAt) });
    await this.changed();
  }

  /**
   * Applies rows pulled from the cloud: last write wins by `updatedAt`, so a
   * local edit still waiting to sync is not undone by an older row, and a
   * tombstone always wins (deletions are final).
   */
  async applyRemote(remote: { categories: CategoryRecord[]; assignments: AssignmentRecord[] }): Promise<boolean> {
    const changed = this.merge(remote.categories, remote.assignments);
    if (changed) await this.changed();
    return changed;
  }

  /** Edits always move forward in time, even if the clock went back. */
  private stamp(previous?: string): string {
    const now = nowIso(this.now);
    if (previous && !isAfter(now, previous)) return new Date(parseIso(previous) + 1).toISOString();
    return now;
  }

  private changed(): Promise<void> {
    this.publish();
    const snapshot = { categories: [...this.categories.values()], assignments: [...this.assignments.values()] };
    return this.writes.run(async () => {
      await this.kv.set(CATEGORIES_KEY, snapshot);
      this.bus.post('categories');
    });
  }

  flush(): Promise<void> {
    return this.writes.flush();
  }
}

/** Whether `incoming` replaces `local`: tombstones are final, otherwise last write wins. */
function takesCategory(local: CategoryRecord | undefined, incoming: CategoryRecord): boolean {
  if (!local) return true;
  if (local.deleted) return false;
  if (incoming.deleted) return true;
  return isAfter(incoming.updatedAt, local.updatedAt);
}

const assignmentKey = (a: AssignmentRecord): string => categoryItemKey({ type: a.type, id: a.id });

const colorKey = (color: string): string => (COLOR_KEY.test(color) ? color : parseCategoryColor(color));

export function parseCategoryRecord(raw: unknown): CategoryRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !UUID.test(raw.id)) return null;
  const updatedAt = toIso(raw.updatedAt);
  if (!updatedAt) return null;
  const deleted = raw.deleted === true;
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!deleted && !name.trim()) return null;
  return {
    id: raw.id,
    name,
    color: typeof raw.color === 'string' && COLOR_KEY.test(raw.color) ? raw.color : 'gray',
    createdAt: toIso(raw.createdAt) ?? updatedAt,
    updatedAt,
    deleted,
  };
}

export function parseAssignmentRecord(raw: unknown): AssignmentRecord | null {
  if (!isRecord(raw)) return null;
  // Pulled rows use the wire's `itemType`/`itemId`; stored records `type`/`id`.
  const type = raw.itemType ?? raw.type;
  const id = raw.itemId ?? raw.id;
  if ((type !== 'book' && type !== 'article') || typeof id !== 'string' || !id) return null;
  const updatedAt = toIso(raw.updatedAt);
  if (!updatedAt) return null;
  const categoryId = typeof raw.categoryId === 'string' && raw.categoryId ? raw.categoryId : null;
  return { type, id, categoryId, updatedAt };
}

/** A lowercase v4 UUID; `crypto.randomUUID` needs a secure context, so build one if it is missing. */
export function uuidV4(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
