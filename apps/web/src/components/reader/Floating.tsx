import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { highlightColors, type HighlightColor } from '../../lib/types';
import { HighlightSwatches } from '../HighlightSwatches';
import { CopyIcon, DeleteOutlineIcon, type IconProps } from '../icons';

/** The API's cap on a highlight note. */
export const NOTE_MAX = 4000;

/** Material outlined `edit_note`. */
export function NoteIcon({ size = 20, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
      <path d="M3 10h11v2H3zm0-2h11V6H3zm0 8h7v-2H3zm15.01-3.13.71-.71c.39-.39 1.02-.39 1.41 0l.71.71c.39.39.39 1.02 0 1.41l-.71.71-2.12-2.12zm-.71.71-5.3 5.3V21h2.12l5.3-5.3-2.12-2.12z" />
    </svg>
  );
}

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
  layoutKey,
}: {
  rect: DOMRect;
  preferBelow?: boolean;
  label: string;
  children: ReactNode;
  onDismiss: () => void;
  /** Change it when the content changes size, to place the bar again. */
  layoutKey?: string;
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
  }, [rect, preferBelow, layoutKey]);

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
  onNote,
  onCopy,
}: {
  defaultColor: HighlightColor;
  onHighlight: (c: HighlightColor) => void;
  /** Highlight in the default colour, then write a note on it. */
  onNote: () => void;
  onCopy: () => void;
}) {
  const order = [defaultColor, ...highlightColors.filter((c) => c !== defaultColor)];
  return (
    <>
      <HighlightSwatches compact label="Highlight in colour" selected={defaultColor} order={order} onChange={onHighlight} />
      <span className="floating-sep" />
      <button type="button" className="floating-action" onClick={onNote}>
        <NoteIcon size={16} />
        <span>Note</span>
      </button>
      <button type="button" className="floating-action" onClick={onCopy}>
        <CopyIcon size={16} />
        <span>Copy</span>
      </button>
    </>
  );
}

/**
 * Recolour, annotate, copy or delete one highlight (mobile
 * `showHighlightActions`, plus notes). The note shows above the actions.
 */
export function HighlightActions({
  color,
  note,
  onRecolor,
  onNote,
  onCopy,
  onDelete,
  compact,
}: {
  color: HighlightColor;
  note: string | null;
  onRecolor: (c: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onDelete: () => void;
  compact?: boolean;
}) {
  const actions = (
    <div className={compact ? 'highlight-actions is-compact' : 'highlight-actions'}>
      <HighlightSwatches compact={compact} label="Highlight colour" selected={color} onChange={onRecolor} />
      {compact && <span className="floating-sep" />}
      <div className="highlight-actions-buttons">
        <button type="button" className="floating-action" onClick={onNote}>
          <NoteIcon size={16} />
          <span>{note ? 'Edit note' : 'Note'}</span>
        </button>
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
  if (!note) return actions;
  return (
    <div className={compact ? 'highlight-with-note is-compact' : 'highlight-with-note'}>
      <button type="button" className="highlight-note-preview clamp-3" onClick={onNote} aria-label={`Edit note: ${note}`}>
        {note}
      </button>
      {actions}
    </div>
  );
}

/**
 * Writes, edits or clears a highlight's note. Enter with ⌘/Ctrl (or the
 * Save button) saves; Escape cancels. Saving an empty note removes it.
 */
export function NoteEditor({
  initial,
  quote,
  onSave,
  onCancel,
  compact,
}: {
  initial: string | null;
  /** The highlighted passage, shown above the field for context. */
  quote?: string;
  onSave: (note: string | null) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState(initial ?? '');
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => onSave(value.trim() ? value.trim() : null);
  return (
    <form
      className={compact ? 'note-editor is-compact' : 'note-editor'}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      {quote && <p className="note-editor-quote clamp-2">{quote}</p>}
      <textarea
        ref={field}
        aria-label="Note"
        data-autofocus
        value={value}
        maxLength={NOTE_MAX}
        rows={compact ? 3 : 4}
        placeholder="Add a note"
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="note-editor-actions">
        {value.length > NOTE_MAX - 200 && <span className="t-label-sm subtle">{NOTE_MAX - value.length} left</span>}
        {initial && (
          <button type="button" className="text-button is-danger" onClick={() => onSave(null)}>
            Remove
          </button>
        )}
        <span className="note-editor-spacer" />
        <button type="button" className="text-button is-muted" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="text-button">
          Save
        </button>
      </div>
    </form>
  );
}
