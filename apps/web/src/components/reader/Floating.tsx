import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { highlightColors, type HighlightColor } from '../../lib/types';
import { HighlightSwatches } from '../HighlightSwatches';
import { CopyIcon, DeleteOutlineIcon } from '../icons';

/**
 * A small toolbar anchored to a rect in viewport coordinates: above it when
 * there is room (below on touch screens, where the system callout sits
 * above), always clamped inside the viewport.
 */
export function FloatingBar({
  rect,
  preferBelow,
  label,
  children,
  onDismiss,
}: {
  rect: DOMRect;
  preferBelow?: boolean;
  label: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = rect.top - h - gap;
    const below = rect.bottom + gap;
    let top = preferBelow ? (below + h < vh - 8 ? below : above) : above > 64 ? above : below;
    top = Math.min(Math.max(8, top), vh - h - 8);
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), vw - w - 8);
    setPos({ left, top });
  }, [rect, preferBelow]);

  return (
    <div
      ref={bar}
      className={pos ? 'floating-bar is-shown' : 'floating-bar'}
      style={pos ?? { left: -9999, top: -9999 }}
      role="toolbar"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Colour swatches (default first, ringed) and Copy, for a fresh selection. */
export function SelectionActions({
  defaultColor,
  onHighlight,
  onCopy,
}: {
  defaultColor: HighlightColor;
  onHighlight: (c: HighlightColor) => void;
  onCopy: () => void;
}) {
  const order = [defaultColor, ...highlightColors.filter((c) => c !== defaultColor)];
  return (
    <>
      <HighlightSwatches compact label="Highlight in colour" selected={defaultColor} order={order} onChange={onHighlight} />
      <span className="floating-sep" />
      <button type="button" className="floating-action" onClick={onCopy}>
        <CopyIcon size={16} />
        <span>Copy</span>
      </button>
    </>
  );
}

/** Recolour, copy or delete one highlight (mobile `showHighlightActions`). */
export function HighlightActions({
  color,
  onRecolor,
  onCopy,
  onDelete,
  compact,
}: {
  color: HighlightColor;
  onRecolor: (c: HighlightColor) => void;
  onCopy: () => void;
  onDelete: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'highlight-actions is-compact' : 'highlight-actions'}>
      <HighlightSwatches compact={compact} label="Highlight colour" selected={color} onChange={onRecolor} />
      {compact && <span className="floating-sep" />}
      <div className="highlight-actions-buttons">
        <button type="button" className="floating-action" onClick={onCopy}>
          <CopyIcon size={16} />
          <span>Copy</span>
        </button>
        <button type="button" className="floating-action is-danger" onClick={onDelete}>
          <DeleteOutlineIcon size={16} />
          <span>Delete</span>
        </button>
      </div>
    </div>
  );
}
