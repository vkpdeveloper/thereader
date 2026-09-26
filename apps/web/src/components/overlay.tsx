import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap, useIsDesktop, usePresence } from '../lib/hooks';
import { IconButton } from './buttons';
import { CloseIcon } from './icons';
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

function useOverlayLayer(active: boolean, onEscape: () => void): void {
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
