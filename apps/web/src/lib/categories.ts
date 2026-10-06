/**
 * Categories: named, coloured groups of books and saved articles. Shared by
 * the data layer (`services/categories.ts`) and the UI. See
 * docs/categories.md for the behaviour and sync contract.
 */

export type CategoryColor =
  | 'red'
  | 'orange'
  | 'amber'
  | 'lime'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'gray';

/** Picker order. */
export const categoryColors: CategoryColor[] = [
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'pink',
  'gray',
];

/** One hue per key, tuned for the pure-black palette; identical on mobile. */
export const categoryHues: Record<CategoryColor, string> = {
  red: '#ff6166',
  orange: '#ff9907',
  amber: '#f5c518',
  lime: '#a3e635',
  green: '#62c073',
  teal: '#2dd4bf',
  cyan: '#1da9b0',
  blue: '#52a8ff',
  indigo: '#818cf8',
  purple: '#c472fb',
  pink: '#f75f8f',
  gray: '#a1a1a1',
};

/** Unknown keys (a newer build's colour) render as gray. */
export function parseCategoryColor(key: string | null | undefined): CategoryColor {
  return (categoryColors as string[]).includes(key ?? '') ? (key as CategoryColor) : 'gray';
}

/** First colour no live category uses yet, else blue. */
export function nextCategoryColor(used: Iterable<CategoryColor>): CategoryColor {
  const taken = new Set(used);
  return categoryColors.find((c) => !taken.has(c)) ?? 'blue';
}

export const MAX_CATEGORY_NAME = 60;

export type CategoryItemType = 'book' | 'article';

/** A book (`Book.id`) or a saved article (32-hex article id). */
export interface CategoryItemRef {
  type: CategoryItemType;
  id: string;
}

export const categoryItemKey = (item: CategoryItemRef): string => `${item.type}:${item.id}`;

export interface Category {
  /** Client-generated UUID. */
  id: string;
  name: string;
  color: CategoryColor;
  createdAt: string;
  updatedAt: string;
}
