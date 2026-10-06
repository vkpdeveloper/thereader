import { categoryItemKey, MAX_CATEGORY_NAME, parseCategoryColor, type Category, type CategoryColor, type CategoryItemRef } from '../categories';
import type { CategoriesSnapshot, CategoryStore } from './contract';
import { Emitter } from './observable';

/*
 * TEMPORARY, replaced by the data layer. A minimal in-memory + localStorage
 * CategoryStore so the UI can be built and exercised before the real store
 * (IndexedDB, sync outbox, cross-tab bus) lands. It does not sync.
 */

const storageKey = 'thereader.dev.categories';

interface Saved {
  categories: Category[];
  assignments: CategoriesSnapshot['assignments'];
}

function read(): Saved {
  try {
    const raw = localStorage.getItem(storageKey);
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    if (saved && Array.isArray(saved.categories)) {
      return {
        categories: saved.categories.map((c) => ({ ...c, color: parseCategoryColor(c.color) })),
        assignments: saved.assignments ?? {},
      };
    }
  } catch {
    // Fall through to an empty store.
  }
  return { categories: [], assignments: {} };
}

class TemporaryCategoryStore extends Emitter<CategoriesSnapshot> implements CategoryStore {
  constructor() {
    super({ loaded: true, ...read() });
    window.addEventListener('storage', (e) => {
      if (e.key === storageKey) this.emit({ loaded: true, ...read() });
    });
  }

  private commit(next: Saved): void {
    // Assignments to a missing category are uncategorized.
    const live = new Set(next.categories.map((c) => c.id));
    const assignments = Object.fromEntries(Object.entries(next.assignments).filter(([, a]) => live.has(a.categoryId)));
    const saved = { categories: next.categories, assignments };
    localStorage.setItem(storageKey, JSON.stringify(saved));
    this.emit({ loaded: true, ...saved });
  }

  async create(name: string, color: CategoryColor): Promise<Category> {
    const now = new Date().toISOString();
    const category: Category = { id: crypto.randomUUID(), name: clean(name), color, createdAt: now, updatedAt: now };
    this.commit({ ...this.snapshot, categories: [...this.snapshot.categories, category] });
    return category;
  }

  async update(id: string, change: { name?: string; color?: CategoryColor }): Promise<void> {
    const now = new Date().toISOString();
    this.commit({
      ...this.snapshot,
      categories: this.snapshot.categories.map((c) =>
        c.id === id ? { ...c, ...(change.name != null && { name: clean(change.name) }), ...(change.color && { color: change.color }), updatedAt: now } : c,
      ),
    });
  }

  async remove(id: string): Promise<void> {
    this.commit({ ...this.snapshot, categories: this.snapshot.categories.filter((c) => c.id !== id) });
  }

  async assign(item: CategoryItemRef, categoryId: string | null): Promise<void> {
    const assignments = { ...this.snapshot.assignments };
    if (categoryId) assignments[categoryItemKey(item)] = { categoryId, assignedAt: new Date().toISOString() };
    else delete assignments[categoryItemKey(item)];
    this.commit({ ...this.snapshot, assignments });
  }

  categoryOf(item: CategoryItemRef): Category | null {
    const a = this.snapshot.assignments[categoryItemKey(item)];
    return (a && this.snapshot.categories.find((c) => c.id === a.categoryId)) ?? null;
  }

  itemsIn(categoryId: string): CategoryItemRef[] {
    return Object.entries(this.snapshot.assignments)
      .filter(([, a]) => a.categoryId === categoryId)
      .sort(([, a], [, b]) => b.assignedAt.localeCompare(a.assignedAt))
      .map(([key]) => {
        const i = key.indexOf(':');
        return { type: key.slice(0, i) as CategoryItemRef['type'], id: key.slice(i + 1) };
      });
  }
}

const clean = (name: string) => name.trim().slice(0, MAX_CATEGORY_NAME);

export function createCategoryStore(): CategoryStore {
  return new TemporaryCategoryStore();
}
