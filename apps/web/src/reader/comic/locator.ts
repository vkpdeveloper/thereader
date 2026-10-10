import type { ReadingLocator } from '../../lib/types';

/**
 * Comic reading positions (docs/comics.md, "Reading position"): the first
 * visible page's entry name and index ride the shared locator shape.
 */

export function comicLocator(pages: readonly string[], page: number): ReadingLocator {
  const count = pages.length;
  const index = Math.min(Math.max(0, page), Math.max(0, count - 1));
  return {
    href: pages[index] ?? '',
    progression: 0,
    totalProgression: count > 1 ? index / (count - 1) : 1,
    title: `Page ${index + 1} of ${count}`,
    engine: 'comic',
    raw: { page: index, pages: count },
  };
}

/** The page a saved locator points at: by entry name first, then `raw.page`; 0 when neither fits. */
export function pageForLocator(pages: readonly string[], locator: ReadingLocator | null | undefined): number {
  if (!locator || pages.length === 0) return 0;
  if (locator.href) {
    const exact = pages.indexOf(locator.href);
    if (exact >= 0) return exact;
  }
  const raw = locator.raw?.page;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.min(Math.max(0, Math.floor(raw)), pages.length - 1);
  return 0;
}
