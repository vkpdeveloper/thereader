import { useMemo, type DragEvent } from 'react';
import { categoryItemKey, type Category, type CategoryItemRef } from '../../lib/categories';
import { useServices, useStore } from '../../lib/services/react';
import type { ArticleSummary, LibraryEntry } from '../../lib/types';

/** A categorized item that is on this device, resolved for display. */
export type FiledItem =
  | { type: 'book'; key: string; assignedAt: string; entry: LibraryEntry }
  | { type: 'article'; key: string; assignedAt: string; article: ArticleSummary };

export interface CategoryContents {
  loaded: boolean;
  /** Live categories, oldest first. */
  categories: Category[];
  /** Each category's items on this device, newest assignment first. */
  items: Map<string, FiledItem[]>;
  /** Whether the item is in a live category (so the Library home hides it). */
  isFiled(ref: CategoryItemRef): boolean;
}

export const bookRef = (entry: LibraryEntry): CategoryItemRef => ({ type: 'book', id: entry.book.id });
export const articleRef = (article: Pick<ArticleSummary, 'id'>): CategoryItemRef => ({ type: 'article', id: article.id });

/**
 * Categories joined with the library and saved articles. Assignments whose
 * item is not on this device (yet) are left out of the lists and counts, so
 * what a count says is what the category view shows.
 */
export function useCategoryContents(): CategoryContents {
  const services = useServices();
  const cats = useStore(services.categories);
  const lib = useStore(services.library);
  const articles = useStore(services.articles);
  return useMemo(() => {
    // One entry per book id: the most recently added edition.
    const books = new Map<string, LibraryEntry>();
    for (const entry of lib.entries) {
      const known = books.get(entry.book.id);
      if (!known || entry.addedAt > known.addedAt) books.set(entry.book.id, entry);
    }
    const saved = new Map(articles.items.map((a) => [a.id, a]));
    const items = new Map<string, FiledItem[]>(cats.categories.map((c) => [c.id, []]));
    for (const [key, { categoryId, assignedAt }] of Object.entries(cats.assignments)) {
      const list = items.get(categoryId);
      if (!list) continue;
      const split = key.indexOf(':');
      const type = key.slice(0, split);
      const id = key.slice(split + 1);
      if (type === 'book') {
        const entry = books.get(id);
        if (entry) list.push({ type: 'book', key, assignedAt, entry });
      } else if (type === 'article') {
        const article = saved.get(id);
        if (article) list.push({ type: 'article', key, assignedAt, article });
      }
    }
    for (const list of items.values()) list.sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
    const isFiled = (ref: CategoryItemRef) => cats.assignments[categoryItemKey(ref)] != null && items.has(cats.assignments[categoryItemKey(ref)].categoryId);
    return { loaded: cats.loaded, categories: cats.categories, items, isFiled };
  }, [cats, lib.entries, articles.items]);
}

/** "3 books · 2 articles", "1 book", "Empty". */
export function describeCount(items: FiledItem[]): string {
  const books = items.filter((i) => i.type === 'book').length;
  const articles = items.length - books;
  const parts = [
    books > 0 && `${books} ${books === 1 ? 'book' : 'books'}`,
    articles > 0 && `${articles} ${articles === 1 ? 'article' : 'articles'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Empty';
}

// ---------------------------------------------------------------- filing pulse

/**
 * Tells the bookcase tile and sidebar row of a category that an item just
 * landed in it, so they can acknowledge it (the item itself leaves the
 * Library grid at the same moment).
 */
const filed = new EventTarget();

export function announceFiled(categoryId: string): void {
  filed.dispatchEvent(new CustomEvent('filed', { detail: categoryId }));
}

export function onFiled(listener: (categoryId: string) => void): () => void {
  const handle = (e: Event) => listener((e as CustomEvent<string>).detail);
  filed.addEventListener('filed', handle);
  return () => filed.removeEventListener('filed', handle);
}

// ---------------------------------------------------------------- drag and drop

/** Covers and article rows can be dragged onto a category in the sidebar or a bookcase. */
export const dragType = 'application/x-thereader-item';

export interface DraggedItem extends CategoryItemRef {
  title: string;
}

export function startItemDrag(e: DragEvent, item: DraggedItem): void {
  e.dataTransfer.setData(dragType, JSON.stringify(item));
  e.dataTransfer.effectAllowed = 'move';
}

export function isItemDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(dragType);
}

export function droppedItem(e: DragEvent): DraggedItem | null {
  try {
    const item = JSON.parse(e.dataTransfer.getData(dragType)) as DraggedItem;
    return (item.type === 'book' || item.type === 'article') && typeof item.id === 'string' ? item : null;
  } catch {
    return null;
  }
}
