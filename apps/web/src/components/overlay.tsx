import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useIsDesktop, usePresence } from '../lib/hooks';
import { IconButton } from './buttons';
import { CloseIcon, type IconProps } from './icons';
import { Eyebrow } from './states';

// ---------------------------------------------------------------- overlay stack

/**
 * Open modal overlays, topmost last. Only the top one answers Escape, and
 * page-level shortcuts (the reader's) stay quiet while any is open.
 */
const stack: symbol[] = [];

export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

export function useOverlayLayer(active: boolean, onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const id = Symbol('overlay');
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== id) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

const motionMs = 220;

// ---------------------------------------------------------------- dialog

/** Centred modal (mobile `AlertDialog`): focus trapped, Escape and scrim close it. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  const { mounted, shown } = usePresence(open, motionMs);
  const panel = useRef<HTMLDivElement>(null);
  useOverlayLayer(open, onClose);
  useFocusTrap(panel, open && mounted);
  if (!mounted) return null;
  return createPortal(
    <div className={shown ? 'overlay is-shown' : 'overlay'}>
      <div className="overlay-scrim" onClick={onClose} />
      <div ref={panel} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-body">
        <h2 id="dialog-title" className="t-title-lg">
          {title}
        </h2>
        {children && (
          <div id="dialog-body" className="dialog-body">
            {children}
          </div>
        )}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Two-button confirmation (Keep / Remove). The destructive button is not focused first. */
export function ConfirmDialog({
  open,
  title,
  body,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  danger,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  cancelLabel: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      actions={
        <>
          <button type="button" className="text-button is-muted" onClick={onCancel} data-autofocus>
            {cancelLabel}
          </button>
          <button type="button" className={danger ? 'text-button is-danger' : 'text-button'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

// ---------------------------------------------------------------- sheet

/**
 * Bottom sheet on narrow screens; on desktop either a right-hand drawer over
 * a light scrim, or (with `docked`) an inline side panel that shares the row
 * with the page, so the page stays readable next to it.
 */
export function Sheet({
  open,
  onClose,
  title,
  label,
  docked,
  width = 380,
  children,
  headerExtra,
  fill,
}: {
  open: boolean;
  onClose: () => void;
  /** Eyebrow heading; also the accessible name unless `label` is set. */
  title?: string;
  label?: string;
  docked?: boolean;
  width?: number;
  children: ReactNode;
  headerExtra?: ReactNode;
  /** Bottom sheet opens tall (lists), like DraggableScrollableSheet at 0.6–0.92. */
  fill?: boolean;
}) {
  const desktop = useIsDesktop();
  const inline = desktop && !!docked;
  const { mounted, shown } = usePresence(open, motionMs);
  const panel = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  useOverlayLayer(open && !inline, onClose);
  useFocusTrap(panel, open && mounted, !inline);

  if (!mounted) return null;
  const name = label ?? title ?? 'Panel';
  const header = (
    <div className="sheet-header">
      {title ? <Eyebrow as="h2">{title}</Eyebrow> : <span />}
      <div className="sheet-header-actions">
        {headerExtra}
        {desktop && <IconButton icon={CloseIcon} label="Close" tone="muted" size={18} tooltipSide="left" onClick={onClose} />}
      </div>
    </div>
  );

  if (inline) {
    return (
      <aside
        ref={panel}
        className={shown ? 'side-panel is-shown' : 'side-panel'}
        style={{ '--panel-width': `${width}px` } as CSSProperties}
        aria-label={name}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="side-panel-inner">
          {header}
          <div className="sheet-body">{children}</div>
        </div>
      </aside>
    );
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    if (desktop) return;
    dragStart.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (dragStart.current == null) return;
    setDrag(Math.max(0, e.clientY - dragStart.current));
  };
  const onPointerUp = () => {
    if (dragStart.current == null) return;
    dragStart.current = null;
    if (drag > 90) onClose();
    setDrag(0);
  };

  return createPortal(
    <div className={['overlay', shown && 'is-shown', desktop ? 'is-drawer' : 'is-bottom'].filter(Boolean).join(' ')}>
      <div className="overlay-scrim" onClick={onClose} />
      <div
        ref={panel}
        className={['sheet', desktop ? 'sheet-drawer' : 'sheet-bottom', fill && 'is-fill'].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        style={
          desktop
            ? ({ '--panel-width': `${width}px` } as CSSProperties)
            : drag > 0
              ? { transform: `translateY(${drag}px)`, transition: 'none' }
              : undefined
        }
      >
        {!desktop && (
          <div className="sheet-grabber-zone" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <div className="sheet-grabber" />
          </div>
        )}
        {header}
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- context menu

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: ComponentType<IconProps>;
  danger?: boolean;
  /** Draws a hairline above this item. */
  separated?: boolean;
}

export interface MenuPoint {
  x: number;
  y: number;
  /** `end` puts the menu's right edge at `x` (menus opened from a button). */
  align?: 'start' | 'end';
}

export interface MenuRequest extends MenuPoint {
  items: MenuItem[];
  label: string;
}

/**
 * Where a context menu opens for a mouse event, or under the target for the
 * keyboard (Shift+F10 / the menu key report 0,0) and for ⋯ buttons.
 */
export function menuPoint(
  e: { clientX: number; clientY: number; currentTarget: EventTarget },
  anchor: 'pointer' | 'below' = 'pointer',
): MenuPoint {
  if (anchor === 'pointer' && (e.clientX !== 0 || e.clientY !== 0)) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return anchor === 'below' ? { x: r.right, y: r.bottom + 4, align: 'end' } : { x: r.left + 12, y: r.top + 12 };
}

/**
 * Desktop context menu (the mobile long-press, widened into actions). Opens
 * at the pointer, stays inside the viewport, and is fully keyboard driven:
 * arrows / Home / End move, Enter selects, Escape or Tab closes.
 */
export function ContextMenu({ request, onClose }: { request: MenuRequest | null; onClose: () => void }) {
  const open = request != null;
  const { mounted, shown } = usePresence(open, 140);
  const menu = useRef<HTMLDivElement>(null);
  const last = useRef<MenuRequest | null>(null);
  if (request) last.current = request;
  const current = request ?? last.current;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useOverlayLayer(open, onClose);
  useFocusTrap(menu, open && mounted, false);

  useLayoutEffect(() => {
    const el = menu.current;
    if (!request || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const pad = 8;
    const start = request.align === 'end' ? request.x - w : request.x;
    const x = start < pad ? pad : start + w + pad > window.innerWidth ? Math.max(pad, request.x - w) : start;
    const y = request.y + h + pad > window.innerHeight ? Math.max(pad, request.y - h) : request.y;
    setPos({ x, y });
  }, [request, mounted]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open, onClose]);

  if (!mounted || !current) return null;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const focus = (n: number) => items[(n + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') focus(i + 1);
    else if (e.key === 'ArrowUp') focus(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(-1);
    else if (e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
  };

  return createPortal(
    <div
      ref={menu}
      className={shown && pos ? 'context-menu is-shown' : 'context-menu'}
      role="menu"
      aria-label={current.label}
      style={{ left: pos?.x ?? current.x, top: pos?.y ?? current.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {current.items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          data-autofocus={i === 0 ? '' : undefined}
          className={['context-menu-item', item.danger && 'is-danger', item.separated && 'is-separated'].filter(Boolean).join(' ')}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon ? <item.icon size={16} /> : <span className="context-menu-icon-slot" />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** State for one context menu per screen. */
export function useContextMenu(): {
  request: MenuRequest | null;
  show: (request: MenuRequest) => void;
  close: () => void;
} {
  const [request, setRequest] = useState<MenuRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);
  return { request, show: setRequest, close };
}
