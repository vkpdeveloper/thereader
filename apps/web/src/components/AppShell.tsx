import { useCallback, useEffect, useRef, useState, type ComponentType, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { isTypingTarget } from '../lib/hooks';
import { hueStyle, useReceiving } from './categories/Bookcase';
import { useCategoryDialog } from './categories/CategoryDialog';
import { droppedItem, isItemDrag, useCategoryContents } from './categories/model';
import { AddIcon, AppMark, ExploreIcon, LibraryBooksIcon, SettingsIcon, SidebarIcon, type IconProps } from './icons';
import { hasOpenOverlay } from './overlay';
import type { Category } from '../lib/categories';
import './categories/categories.css';

const destinations: { to: '/library' | '/browse' | '/settings'; label: string; icon: ComponentType<IconProps> }[] = [
  { to: '/library', label: 'Library', icon: LibraryBooksIcon },
  { to: '/browse', label: 'Browse', icon: ExploreIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

// ---------------------------------------------------------------- collapsed state

/** Device-local and never synced (docs/categories.md). */
const collapsedKey = 'thereader.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(collapsedKey) === 'true';
  } catch {
    return false;
  }
}

function applyCollapsed(collapsed: boolean): void {
  if (collapsed) document.documentElement.dataset.sidebar = 'collapsed';
  else delete document.documentElement.dataset.sidebar;
}

// Applied while this module loads, before React renders the shell, so a
// refresh paints the rail at once instead of animating from the full sidebar.
applyCollapsed(readCollapsed());

function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => applyCollapsed(collapsed), [collapsed]);
  // Other tabs follow.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === collapsedKey) setCollapsed(e.newValue === 'true');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(collapsedKey, String(!c));
      } catch {
        // Private mode: still toggles for this page.
      }
      return !c;
    });
  }, []);
  return [collapsed, toggle];
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const toggleShortcut = isMac ? '⌘\\' : 'Ctrl+\\';

// ---------------------------------------------------------------- shell

/**
 * Three quiet destinations, then the categories. Wide screens get a left
 * sidebar that collapses to an icon rail; narrow screens keep the mobile text
 * tab row at the bottom (the Library's Categories section is their way in).
 */
export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, toggle] = useSidebarCollapsed();
  const nav = useRef<HTMLElement>(null);

  // `[` or ⌘\ / Ctrl+\ toggles the sidebar, outside text fields and dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || hasOpenOverlay() || isTypingTarget(e.target)) return;
      const bracket = e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey;
      const backslash = e.key === '\\' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey;
      if (!bracket && !backslash) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggle]);

  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav ref={nav} className="sidebar" aria-label="Main">
        <Link to="/library" className="sidebar-brand" aria-label="The Reader, Library">
          <AppMark size={26} />
          <span className="sidebar-label">The Reader</span>
        </Link>
        <ul className="sidebar-list">
          {destinations.map((d) => (
            <li key={d.to}>
              <Link
                to={d.to}
                className="sidebar-link"
                activeProps={{ className: 'is-active', 'aria-current': 'page' }}
                activeOptions={{ exact: d.to === '/library' }}
                data-rail-tip={d.label}
              >
                <d.icon size={18} className="sidebar-icon" />
                <span className="sidebar-label">{d.label}</span>
              </Link>
            </li>
          ))}
        </ul>
        <SidebarCategories />
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            aria-keyshortcuts="[ Meta+\ Control+\"
            data-rail-tip={`${toggleLabel} · ${toggleShortcut}`}
            data-tooltip-always=""
            onClick={toggle}
          >
            <SidebarIcon size={18} />
          </button>
        </div>
      </nav>
      <SidebarTooltip nav={nav} collapsed={collapsed} />
      <main className="shell-main" id="main" tabIndex={-1}>
        <div key={pathname} className="page page-fade">
          <Outlet />
        </div>
      </main>
      <nav className="tab-row" aria-label="Main">
        {destinations.map((d) => (
          <Link key={d.to} to={d.to} className="tab" activeProps={{ className: 'is-active' }}>
            {d.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------- categories

/** Its own component, so library progress ticks don't re-render the shell. */
function SidebarCategories() {
  const contents = useCategoryContents();
  const filing = useCategoryDialog();
  if (!contents.loaded) return null;
  return (
    <section className="sidebar-categories" aria-labelledby="sidebar-categories-title">
      <div className="sidebar-section-head">
        <h2 id="sidebar-categories-title" className="eyebrow sidebar-label">
          Categories
        </h2>
        <button type="button" className="sidebar-add" aria-label="New category" data-rail-tip="New category" data-tooltip-always="" onClick={filing.create}>
          <AddIcon size={16} />
        </button>
      </div>
      <ul className="sidebar-list sidebar-category-list">
        {contents.categories.map((c) => (
          <SidebarCategory key={c.id} category={c} count={contents.items.get(c.id)?.length ?? 0} onDrop={filing.file} />
        ))}
      </ul>
      {contents.categories.length === 0 && (
        <button type="button" className="sidebar-empty sidebar-label" onClick={filing.create}>
          Group books and articles, like folders.
        </button>
      )}
      {filing.dialog}
    </section>
  );
}

function SidebarCategory({
  category,
  count,
  onDrop,
}: {
  category: Category;
  count: number;
  onDrop: (item: { type: 'book' | 'article'; id: string; title: string }, categoryId: string) => Promise<void>;
}) {
  const [over, setOver] = useState(false);
  const receiving = useReceiving(category.id);
  return (
    <li>
      <Link
        to="/library/category/$id"
        params={{ id: category.id }}
        className={['sidebar-link', 'sidebar-category', over && 'is-drop-target', receiving && 'is-receiving'].filter(Boolean).join(' ')}
        activeProps={{ className: 'is-active', 'aria-current': 'page' }}
        style={hueStyle(category.color)}
        data-rail-tip={`${category.name} · ${count}`}
        aria-label={`${category.name}, ${count} ${count === 1 ? 'item' : 'items'}`}
        onDragOver={(e) => {
          if (!isItemDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const item = isItemDrag(e) ? droppedItem(e) : null;
          if (!item) return;
          e.preventDefault();
          void onDrop(item, category.id);
        }}
      >
        <span className="sidebar-icon sidebar-dot-slot">
          <span className="category-dot" />
        </span>
        <span className="sidebar-label sidebar-category-name">{category.name}</span>
        <span className="sidebar-label sidebar-count tabular">{count}</span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------- rail tooltips

/**
 * Labels to the right of the sidebar: every row in the rail, and the icon
 * buttons always. Drawn in a portal so the scrolling list can't clip them;
 * once one shows, moving to the next row shows its label at once.
 */
function SidebarTooltip({ nav, collapsed }: { nav: RefObject<HTMLElement>; collapsed: boolean }) {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const warm = useRef(0);
  useEffect(() => {
    const root = nav.current;
    if (!root) return;
    let timer = 0;
    const targetOf = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-rail-tip]');
      if (!el || !root.contains(el)) return null;
      return collapsed || el.hasAttribute('data-tooltip-always') ? el : null;
    };
    const show = (el: HTMLElement, delay: number) => {
      window.clearTimeout(timer);
      const place = () => {
        const r = el.getBoundingClientRect();
        const side = root.getBoundingClientRect().right;
        setTip({ text: el.dataset.railTip ?? '', x: Math.max(side, r.right) + 8, y: r.top + r.height / 2 });
        warm.current = Date.now();
      };
      if (delay === 0) place();
      else timer = window.setTimeout(place, delay);
    };
    const hide = () => {
      window.clearTimeout(timer);
      setTip((t) => {
        if (t) warm.current = Date.now();
        return null;
      });
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = targetOf(e);
      if (el) show(el, Date.now() - warm.current < 400 ? 0 : 350);
      else hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = targetOf(e);
      if (el && el.matches(':focus-visible')) show(el, 0);
      else hide();
    };
    root.addEventListener('pointerover', onOver);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', hide);
    root.addEventListener('pointerdown', hide);
    return () => {
      window.clearTimeout(timer);
      root.removeEventListener('pointerover', onOver);
      root.removeEventListener('pointerleave', hide);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', hide);
      root.removeEventListener('pointerdown', hide);
    };
  }, [nav, collapsed]);
  useEffect(() => setTip(null), [collapsed]);
  if (!tip) return null;
  return createPortal(
    <div className="sidebar-tooltip" role="presentation" style={{ left: tip.x, top: tip.y }}>
      {tip.text}
    </div>,
    document.body,
  );
}
