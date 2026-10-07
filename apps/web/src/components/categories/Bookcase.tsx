import { useEffect, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { categoryHues, type Category, type CategoryColor } from '../../lib/categories';
import type { ArticleSummary, LibraryEntry } from '../../lib/types';
import { ArticleThumb } from '../ArticleRow';
import { CoverArt } from '../CoverArt';
import { describeCount, isItemDrag, onFiled, type FiledItem } from './model';

/** Something that can stand on a shelf. */
export type ShelfItem = { key: string } & ({ type: 'book'; entry: LibraryEntry } | { type: 'article'; article: ArticleSummary });

/** The category's hue as `--cat`, which every category surface tints with. */
export function hueStyle(color: CategoryColor, style?: CSSProperties): CSSProperties {
  return { ...style, '--cat': categoryHues[color] } as CSSProperties;
}

/** Slots for one, two or three books: the newest stands in front, in the middle. */
const slots: Record<number, string[]> = {
  1: ['mid'],
  2: ['left', 'right'],
  3: ['mid', 'left', 'right'],
};

/**
 * A shelf tinted with the category colour, with up to three books standing
 * on it. `.bookcase-scene` blooms them open on hover and focus of an
 * ancestor `.bookcase` (see categories.css); an empty shelf shows faint
 * outlines where books will stand.
 */
export function ShelfScene({ items, color, className }: { items: ShelfItem[]; color: CategoryColor; className?: string }) {
  const shown = items.slice(0, 3);
  const places = slots[shown.length] ?? [];
  return (
    <div className={['bookcase-scene', className].filter(Boolean).join(' ')} style={hueStyle(color)} aria-hidden="true">
      <div className="bookcase-glow" />
      {shown.length === 0 ? (
        <div className="bookcase-books is-empty">
          {['left', 'mid', 'right'].map((slot) => (
            <div key={slot} className={`bookcase-book is-${slot} is-ghost`} />
          ))}
        </div>
      ) : (
        <div className="bookcase-books">
          {shown.map((item, i) => (
            <div key={item.key} className={`bookcase-book is-${places[i]}`}>
              {item.type === 'book' ? (
                <CoverArt book={item.entry.book} origin={item.entry.origin} />
              ) : (
                <ArticleThumb article={item.article} shape="cover" />
              )}
            </div>
          ))}
        </div>
      )}
      <div className="bookcase-shelf" />
    </div>
  );
}

/**
 * One category in the Library home: its newest three items standing on a
 * tinted shelf, the name and count below. Covers and article rows can be
 * dropped on it to file them.
 */
export function BookcaseTile({
  category,
  items,
  onMenu,
  onDropItem,
}: {
  category: Category;
  items: FiledItem[];
  onMenu: (category: Category, e: ReactMouseEvent) => void;
  onDropItem: (category: Category, e: DragEvent) => void;
}) {
  const [over, setOver] = useState(false);
  const receiving = useReceiving(category.id);
  const count = describeCount(items);
  return (
    <Link
      to="/library/category/$id"
      params={{ id: category.id }}
      className={['bookcase', over && 'is-drop-target', receiving && 'is-receiving'].filter(Boolean).join(' ')}
      style={hueStyle(category.color)}
      aria-label={`${category.name}, ${items.length === 0 ? 'empty' : count}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(category, e);
      }}
      onDragOver={(e) => {
        if (!isItemDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!isItemDrag(e)) return;
        e.preventDefault();
        onDropItem(category, e);
      }}
    >
      <ShelfScene items={items} color={category.color} />
      <div className="bookcase-caption">
        <div className="t-title-sm clamp-1">{category.name}</div>
        <div className="t-body-sm bookcase-count tabular">{count}</div>
      </div>
    </Link>
  );
}

/** True for a moment after an item is filed into the category. */
export function useReceiving(categoryId: string): boolean {
  const [receiving, setReceiving] = useState(false);
  useEffect(() => {
    let timer = 0;
    const off = onFiled((id) => {
      if (id !== categoryId) return;
      window.clearTimeout(timer);
      setReceiving(false);
      requestAnimationFrame(() => setReceiving(true));
      timer = window.setTimeout(() => setReceiving(false), 900);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [categoryId]);
  return receiving;
}
