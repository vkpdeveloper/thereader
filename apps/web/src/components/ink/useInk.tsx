import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { formatForDisplay, matchesKeyboardEvent, useHotkeys, type UseHotkeyDefinition } from '@tanstack/react-hotkeys';
import { inertProps } from '../../lib/hooks';
import { lineWidth, thin, type InkPen } from '../../lib/inkPaths';
import { randomId } from '../../lib/services/hash';
import type { InkStroke, InkTool } from '../../lib/services/ink';
import { nowIso } from '../../lib/services/models';
import { useServices, useStore } from '../../lib/services/react';
import { IconButton } from '../buttons';
import { CheckIcon, DeleteOutlineIcon, DrawIcon, KeyboardIcon, RedoIcon, UndoIcon } from '../icons';
import { hasOpenOverlay } from '../overlay';
import { useToast } from '../toast';
import { inkActionLabels, loadInkShortcuts, shortcutLabel, type InkAction } from './shortcuts';
import './ink.css';

type Mode = InkTool | 'eraser';
interface PenSettings {
  mode: Mode;
  color: string;
  size: number;
}

export const inkColors: { hex: string; name: string }[] = [
  { hex: '#f2f2f2', name: 'White' },
  { hex: '#ff5f57', name: 'Red' },
  { hex: '#ff9f0a', name: 'Orange' },
  { hex: '#f5c518', name: 'Yellow' },
  { hex: '#4ade80', name: 'Green' },
  { hex: '#60a5fa', name: 'Blue' },
  { hex: '#a78bfa', name: 'Purple' },
  { hex: '#f472b6', name: 'Pink' },
];
const sizes: { value: number; name: string }[] = [
  { value: 2, name: 'Thin' },
  { value: 3.5, name: 'Medium' },
  { value: 6, name: 'Bold' },
];
const modes: { mode: Mode; name: string }[] = [
  { mode: 'pen', name: 'Pen' },
  { mode: 'dotted', name: 'Dotted pen' },
  { mode: 'dashed', name: 'Dashed pen' },
  { mode: 'marker', name: 'Marker' },
  { mode: 'eraser', name: 'Eraser' },
];

const SETTINGS_KEY = 'thereader.ink';
const defaults: PenSettings = { mode: 'pen', color: '#ff5f57', size: 3.5 };
/** How close the eraser must pass to a line, beyond the line's own half width. */
const ERASER_REACH = 8;
/** The toolbar comes back this long after the last stroke or scroll. */
const REVEAL_MS = 900;
/** A mouse this close to the bottom edge brings the toolbar back at once. */
const REVEAL_EDGE = 120;

function readSettings(): PenSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<PenSettings> | null;
    if (!raw) return defaults;
    return {
      mode: modes.some((m) => m.mode === raw.mode) ? (raw.mode as Mode) : defaults.mode,
      color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : defaults.color,
      size: sizes.some((s) => s.value === raw.size) ? raw.size! : defaults.size,
    };
  } catch {
    return defaults;
  }
}

/**
 * What the pen draws on: the article page or a book's chapter. The pen owns
 * the gestures, the toolbar, the shortcuts and the undo history; the
 * surface owns its coordinates, where strokes are anchored and how they are
 * drawn.
 */
export interface InkSurface {
  /** The record strokes are saved in (`articleInkId`, `bookInkId`). */
  docId: string;
  /** The page can be drawn on (the article or the book is open). */
  ready: boolean;
  /** A pointer's position in the surface's coordinates; null when off the page. */
  point(e: { clientX: number; clientY: number }): [number, number] | null;
  /** Shows the stroke being drawn (surface coordinates), or clears it. */
  live(points: number[] | null, pen: InkPen): void;
  /** Anchors a finished stroke's points to the page; null when nothing there can hold it. */
  anchor(points: number[]): Pick<InkStroke, 'anchor' | 'points'> | null;
  /** Strokes passing within `reach` (beyond their own half width) of a point. */
  hits(x: number, y: number, reach: number): InkStroke[];
  /** What Clear removes. */
  clearable(): InkStroke[];
  /** "Clear drawing", "Clear page". */
  clearLabel: string;
  /**
   * A finger the pen leaves alone once a stylus has been used, for the page
   * to scroll or turn under it.
   */
  pass?: (phase: 'down' | 'move' | 'up', e: PointerEvent) => void;
}

type Change = { kind: 'add' | 'remove'; strokes: InkStroke[] };
interface Live {
  pointerId: number;
  points: number[];
  start: [number, number];
  /** Strokes the eraser took in this gesture. */
  erased: InkStroke[];
}

/** The cursor while drawing: a dot of the pen's colour and width (a ring for the eraser). */
function cursorFor(settings: PenSettings): string {
  if (settings.mode === 'eraser') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="9" fill="rgba(0,0,0,0.35)" stroke="white" stroke-width="1.5"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, cell`;
  }
  const w = Math.max(4, Math.min(28, lineWidth(settings.mode, settings.size)));
  const box = Math.ceil(w + 6);
  const c = box / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}">` +
    `<circle cx="${c}" cy="${c}" r="${w / 2 + 1}" fill="black" fill-opacity="0.5"/>` +
    `<circle cx="${c}" cy="${c}" r="${w / 2}" fill="${settings.color}" fill-opacity="${settings.mode === 'marker' ? 0.6 : 1}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(c)} ${Math.round(c)}, crosshair`;
}

export interface Ink {
  active: boolean;
  setActive(active: boolean): void;
  toggle(): void;
  /** The pen in hand, or null for the eraser. */
  pen: InkPen | null;
  /** Draw / stop drawing, for a top bar. */
  button: ReactNode;
  /** The toolbar docked at the bottom while drawing. */
  toolbar: ReactNode;
  /** Props for the element that takes the pen's input while drawing. */
  input: {
    style: CSSProperties;
    onPointerDown(e: ReactPointerEvent<Element>): void;
    onPointerMove(e: ReactPointerEvent<Element>): void;
    onPointerUp(e: ReactPointerEvent<Element>): void;
    onPointerCancel(e: ReactPointerEvent<Element>): void;
    onContextMenu(e: { preventDefault(): void }): void;
  };
  /** A pen shortcut owns this key right now: other handlers leave it alone. */
  claims(e: KeyboardEvent): boolean;
  /** Runs the pen shortcut a key forwarded from elsewhere (a book's frame) matches; true when one did. */
  handleKey(e: KeyboardEvent): boolean;
  /** Rests the toolbar for a moment (the page moved under it). */
  nudge(): void;
}

/**
 * The pen: with it on (P), the surface becomes a canvas. Draw, underline,
 * circle words or write in the margins with a solid, dotted or dashed pen or
 * a marker, in any colour and three widths; Shift draws a straight line; the
 * eraser takes whole strokes. Mouse, pen and finger all draw; once a stylus
 * has been used, a finger is handed to the surface instead (palm rest).
 *
 * The toolbar along the bottom gets out of the way while drawing or
 * scrolling and comes back when the hand pauses, when the mouse nears the
 * bottom edge, or when a shortcut changes the pen; a small chip shows the
 * pen in use meanwhile. Shortcuts go through TanStack Hotkeys, from a table
 * the reader can rebind (`shortcuts.ts`).
 */
export function useInk(surface: InkSurface): Ink {
  const services = useServices();
  const toast = useToast();
  const { docId, ready } = surface;
  useStore(services.ink);
  const shortcuts = useMemo(loadInkShortcuts, []);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  const [active, setActive] = useState(false);
  const [settings, setSettings] = useState<PenSettings>(readSettings);
  const history = useRef<{ undo: Change[]; redo: Change[] }>({ undo: [], redo: [] });
  const [, setHistoryVersion] = useState(0);
  const [penSeen, setPenSeen] = useState(false);
  /** Out of the way for now (drawing, scrolling); comes back by itself. */
  const [resting, setResting] = useState(false);
  /** Put away by the reader (T); only the chip shows until brought back. */
  const [stowed, setStowed] = useState(false);
  const [help, setHelp] = useState(false);
  const revealTimer = useRef(0);
  const live = useRef<Live | null>(null);
  /** A finger handed to the surface (palm rest). */
  const passing = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    void services.ink.open(docId);
  }, [docId, services]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* Private windows may refuse; the pen just starts from defaults next time. */
    }
  }, [settings]);

  // Another page starts its own undo history.
  useEffect(() => {
    history.current = { undo: [], redo: [] };
    setHistoryVersion((n) => n + 1);
    setActive(false);
  }, [docId]);

  // ------------------------------------------------------------ toolbar visibility

  const revealNow = useCallback(() => {
    window.clearTimeout(revealTimer.current);
    setResting(false);
  }, []);
  const rest = useCallback(() => {
    window.clearTimeout(revealTimer.current);
    setResting(true);
  }, []);
  const revealLater = useCallback(() => {
    window.clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => setResting(false), REVEAL_MS);
  }, []);
  const nudge = useCallback(() => {
    if (live.current) return;
    rest();
    revealLater();
  }, [rest, revealLater]);
  useEffect(() => () => window.clearTimeout(revealTimer.current), []);

  useEffect(() => {
    if (!active) {
      setHelp(false);
      return;
    }
    revealNow();
    // Scrolling rests the toolbar until the page holds still; a mouse heading for the bottom edge brings it back.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.buttons === 0 && e.clientY > window.innerHeight - REVEAL_EDGE) revealNow();
    };
    window.addEventListener('scroll', nudge, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('scroll', nudge);
      window.removeEventListener('pointermove', onMove);
    };
  }, [active, nudge, revealNow]);

  // ------------------------------------------------------------ edits

  const apply = useCallback(
    (change: Change, inverse = false) => {
      const adding = (change.kind === 'add') !== inverse;
      if (adding) void services.ink.add(docId, change.strokes);
      else void services.ink.remove(docId, change.strokes.map((s) => s.id));
    },
    [docId, services],
  );

  const record = useCallback((change: Change) => {
    history.current = { undo: [...history.current.undo, change].slice(-200), redo: [] };
    setHistoryVersion((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    const { undo: past, redo: future } = history.current;
    const change = past[past.length - 1];
    if (!change) return;
    apply(change, true);
    history.current = { undo: past.slice(0, -1), redo: [...future, change] };
    setHistoryVersion((n) => n + 1);
  }, [apply]);

  const redo = useCallback(() => {
    const { undo: past, redo: future } = history.current;
    const change = future[future.length - 1];
    if (!change) return;
    apply(change);
    history.current = { undo: [...past, change], redo: future.slice(0, -1) };
    setHistoryVersion((n) => n + 1);
  }, [apply]);

  const clear = useCallback(() => {
    const strokes = surfaceRef.current.clearable();
    if (strokes.length === 0) return;
    const change: Change = { kind: 'remove', strokes };
    apply(change);
    record(change);
    toast.show(strokes.length === 1 ? 'Stroke cleared.' : `${strokes.length} strokes cleared.`, {
      action: {
        label: 'Undo',
        onClick: () => {
          apply(change, true);
          record({ kind: 'add', strokes });
        },
      },
    });
  }, [apply, record, toast]);

  // ------------------------------------------------------------ pointer

  const penOf = (s: PenSettings): InkPen => ({ tool: s.mode === 'eraser' ? 'pen' : s.mode, color: s.color, size: s.size });

  const eraseAt = (x: number, y: number, gesture: Live) => {
    const hits = surfaceRef.current.hits(x, y, ERASER_REACH).filter((s) => !gesture.erased.some((e) => e.id === s.id));
    if (hits.length === 0) return;
    gesture.erased.push(...hits);
    void services.ink.remove(docId, hits.map((s) => s.id));
  };

  const drawLive = () => {
    const g = live.current;
    const s = settingsRef.current;
    surfaceRef.current.live(g && s.mode !== 'eraser' ? g.points : null, penOf(s));
  };

  const onPointerDown = (e: ReactPointerEvent<Element>) => {
    if (live.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // With a stylus in use, a resting hand or a finger goes to the page.
    if (e.pointerType === 'touch' && penSeen) {
      if (passing.current == null && surfaceRef.current.pass) {
        passing.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        surfaceRef.current.pass('down', e.nativeEvent);
      }
      return;
    }
    if (e.pointerType === 'pen' && !penSeen) setPenSeen(true);
    const p = surfaceRef.current.point(e);
    if (!p) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const gesture: Live = { pointerId: e.pointerId, points: [p[0], p[1]], start: p, erased: [] };
    live.current = gesture;
    setHelp(false);
    rest();
    if (settingsRef.current.mode === 'eraser') eraseAt(p[0], p[1], gesture);
    drawLive();
  };

  const onPointerMove = (e: ReactPointerEvent<Element>) => {
    if (passing.current === e.pointerId) {
      surfaceRef.current.pass?.('move', e.nativeEvent);
      return;
    }
    const g = live.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const native = e.nativeEvent;
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const events = samples.length > 0 ? samples : [native];
    const point = (ev: { clientX: number; clientY: number }) => surfaceRef.current.point(ev);
    if (settingsRef.current.mode === 'eraser') {
      for (const ev of events) {
        const p = point(ev);
        if (p) eraseAt(p[0], p[1], g);
      }
      return;
    }
    if (e.shiftKey) {
      // A straight line from where the stroke began.
      const p = point(native);
      if (p) g.points = [g.start[0], g.start[1], p[0], p[1]];
    } else {
      for (const ev of events) {
        const p = point(ev);
        if (p) g.points.push(p[0], p[1]);
      }
    }
    drawLive();
  };

  const finish = (e: ReactPointerEvent<Element>, cancelled: boolean) => {
    if (passing.current === e.pointerId) {
      passing.current = null;
      surfaceRef.current.pass?.('up', e.nativeEvent);
      return;
    }
    const g = live.current;
    if (!g || g.pointerId !== e.pointerId) return;
    live.current = null;
    drawLive();
    revealLater();
    const s = settingsRef.current;
    if (s.mode === 'eraser') {
      if (g.erased.length > 0) record({ kind: 'remove', strokes: g.erased });
      return;
    }
    if (cancelled) return;
    const anchored = surfaceRef.current.anchor(thin(g.points));
    if (!anchored) return;
    const stroke: InkStroke = { id: randomId(), tool: s.mode, color: s.color, size: s.size, ...anchored, createdAt: nowIso() };
    apply({ kind: 'add', strokes: [stroke] });
    record({ kind: 'add', strokes: [stroke] });
  };

  // ------------------------------------------------------------ shortcuts

  const toggle = useCallback(() => {
    live.current = null;
    setActive((v) => !v);
  }, []);

  /** A pen change from the keyboard shows the toolbar, so the reader sees what they picked. */
  const choose = useCallback(
    (change: (s: PenSettings) => PenSettings) => {
      setSettings(change);
      if (!stowed) revealNow();
    },
    [revealNow, stowed],
  );

  const step = <T,>(list: T[], current: number, by: number): T => list[(((current + by) % list.length) + list.length) % list.length]!;

  const run = (action: InkAction) => {
    switch (action) {
      case 'toggle':
        return toggle();
      case 'pen':
      case 'dotted':
      case 'dashed':
      case 'marker':
      case 'eraser':
        return choose((s) => ({ ...s, mode: action }));
      case 'nextColor':
      case 'previousColor':
        return choose((s) => ({
          ...s,
          mode: s.mode === 'eraser' ? 'pen' : s.mode,
          color: step(inkColors, inkColors.findIndex((c) => c.hex === s.color), action === 'nextColor' ? 1 : -1).hex,
        }));
      case 'thinner':
      case 'thicker':
        return choose((s) => {
          const at = sizes.findIndex((x) => x.value === s.size);
          const next = Math.max(0, Math.min(sizes.length - 1, at + (action === 'thicker' ? 1 : -1)));
          return { ...s, size: sizes[next]!.value };
        });
      case 'undo':
        return undo();
      case 'redo':
        return redo();
      case 'clear':
        return clear();
      case 'toolbar':
        setStowed((v) => !v);
        return revealNow();
      case 'help':
        setStowed(false);
        revealNow();
        return setHelp((v) => !v);
      case 'done':
        if (help) return setHelp(false);
        return setActive(false);
    }
  };

  const enabled = (action: InkAction) => ready && (action === 'toggle' || active);
  const actions = Object.keys(shortcuts) as InkAction[];

  /**
   * The last key event a pen shortcut ran for. Other handlers on the same
   * target may run after the shortcut's own state change has re-rendered
   * (the pen already off after Escape), so they ask about the event itself.
   */
  const handled = useRef<KeyboardEvent | null>(null);

  const hotkeys: UseHotkeyDefinition[] = actions.flatMap((action) =>
    shortcuts[action].map((hotkey) => ({
      hotkey,
      callback: (event: KeyboardEvent) => {
        handled.current = event;
        if (!hasOpenOverlay()) run(action);
      },
      options: { enabled: enabled(action), meta: { name: inkActionLabels[action] } },
    })),
  );
  useHotkeys(hotkeys, { ignoreInputs: true, conflictBehavior: 'allow' });

  const matching = (e: KeyboardEvent): InkAction | undefined =>
    actions.find((action) => enabled(action) && shortcuts[action].some((hotkey) => matchesKeyboardEvent(e, hotkey)));

  const claims = (e: KeyboardEvent) => handled.current === e || (!hasOpenOverlay() && matching(e) !== undefined);

  const handleKey = (e: KeyboardEvent): boolean => {
    if (hasOpenOverlay()) return false;
    const action = matching(e);
    if (!action) return false;
    e.preventDefault();
    run(action);
    return true;
  };

  const tip = (label: string, action: InkAction) => {
    const keys = shortcutLabel(shortcuts, action);
    return keys ? `${label} · ${keys}` : label;
  };

  // ------------------------------------------------------------ render

  const cursor = useMemo(() => cursorFor(settings), [settings]);

  const input: Ink['input'] = {
    style: { cursor, touchAction: penSeen ? 'pan-x pan-y' : 'none' },
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => finish(e, false),
    onPointerCancel: (e) => finish(e, true),
    onContextMenu: (e) => e.preventDefault(),
  };

  const button = <IconButton icon={DrawIcon} label="Draw" shortcut={shortcutLabel(shortcuts, 'toggle')} aria-pressed={active} onClick={toggle} />;

  const current = modes.find((m) => m.mode === settings.mode)!;
  const open = !resting && !stowed;
  const { undo: past, redo: future } = history.current;
  const canClear = active && surface.clearable().length > 0;

  const toolbar = active ? (
    <div className="ink-dock">
      {help && open && (
        <div className="ink-help" role="dialog" aria-label="Pen shortcuts">
          <p className="ink-help-title">Pen shortcuts</p>
          <dl>
            {actions
              .filter((a) => shortcuts[a].length > 0)
              .map((a) => (
                <div key={a}>
                  <dt>{a === 'clear' ? surface.clearLabel : inkActionLabels[a]}</dt>
                  <dd>
                    {shortcuts[a].map((h) => (
                      <kbd key={h}>{formatForDisplay(h)}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            <div>
              <dt>Straight line</dt>
              <dd>
                <kbd>{formatForDisplay('Shift')}</kbd> while drawing
              </dd>
            </div>
          </dl>
        </div>
      )}
      <button
        type="button"
        className={open ? 'ink-chip' : 'ink-chip is-shown'}
        aria-label={`${current.name}. Show pen tools`}
        data-tooltip={tip('Show pen tools', 'toolbar')}
        data-tooltip-side="top"
        tabIndex={open ? -1 : 0}
        onClick={() => {
          setStowed(false);
          revealNow();
        }}
      >
        <ToolGlyph mode={settings.mode} color={settings.mode === 'eraser' ? undefined : settings.color} />
      </button>
      <div className={open ? 'ink-toolbar is-shown' : 'ink-toolbar'} role="toolbar" aria-label="Pen" aria-hidden={!open} {...inertProps(!open)}>
        <div className="ink-group" role="radiogroup" aria-label="Pen style">
          {modes.map((m) => (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={settings.mode === m.mode}
              aria-label={m.name}
              data-tooltip={tip(m.name, m.mode)}
              data-tooltip-side="top"
              className="ink-tool"
              onClick={() => setSettings((s) => ({ ...s, mode: m.mode }))}
            >
              <ToolGlyph mode={m.mode} color={m.mode === 'eraser' ? undefined : settings.color} />
            </button>
          ))}
        </div>
        <span className="ink-divider" aria-hidden="true" />
        <div className="ink-group" role="radiogroup" aria-label="Colour">
          {inkColors.map((c) => (
            <button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={settings.color === c.hex}
              aria-label={c.name}
              data-tooltip={c.name}
              data-tooltip-side="top"
              className="ink-swatch"
              onClick={() => setSettings((s) => ({ ...s, color: c.hex, mode: s.mode === 'eraser' ? 'pen' : s.mode }))}
            >
              <span style={{ background: c.hex }} />
            </button>
          ))}
          <label
            className="ink-swatch is-custom"
            data-tooltip="Any colour"
            data-tooltip-side="top"
            aria-checked={!inkColors.some((c) => c.hex === settings.color)}
            role="radio"
          >
            <span style={inkColors.some((c) => c.hex === settings.color) ? undefined : { background: settings.color }} />
            <input
              type="color"
              aria-label="Any colour"
              value={settings.color}
              onChange={(e) => setSettings((s) => ({ ...s, color: e.target.value, mode: s.mode === 'eraser' ? 'pen' : s.mode }))}
            />
          </label>
        </div>
        <span className="ink-divider" aria-hidden="true" />
        <div className="ink-group" role="radiogroup" aria-label="Thickness">
          {sizes.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={settings.size === s.value}
              aria-label={s.name}
              data-tooltip={s.name}
              data-tooltip-side="top"
              className="ink-tool"
              onClick={() => setSettings((cur) => ({ ...cur, size: s.value }))}
            >
              <span className="ink-size" style={{ width: s.value * 2 + 2, height: s.value * 2 + 2 }} />
            </button>
          ))}
        </div>
        <span className="ink-divider" aria-hidden="true" />
        <div className="ink-group">
          <IconButton icon={UndoIcon} label="Undo" shortcut={shortcutLabel(shortcuts, 'undo')} tooltipSide="top" disabled={past.length === 0} onClick={undo} />
          <IconButton icon={RedoIcon} label="Redo" shortcut={shortcutLabel(shortcuts, 'redo')} tooltipSide="top" disabled={future.length === 0} onClick={redo} />
          <IconButton icon={DeleteOutlineIcon} label={surface.clearLabel} shortcut={shortcutLabel(shortcuts, 'clear')} tooltipSide="top" disabled={!canClear} onClick={clear} />
          <IconButton icon={KeyboardIcon} label="Shortcuts" shortcut={shortcutLabel(shortcuts, 'help')} tooltipSide="top" aria-pressed={help} onClick={() => setHelp((v) => !v)} />
        </div>
        <span className="ink-divider" aria-hidden="true" />
        <IconButton icon={CheckIcon} label="Done" shortcut={shortcutLabel(shortcuts, 'done')} tooltipSide="top" className="ink-done" onClick={() => setActive(false)} />
      </div>
    </div>
  ) : null;

  return {
    active,
    setActive,
    toggle,
    pen: settings.mode === 'eraser' ? null : penOf(settings),
    button,
    toolbar,
    input,
    claims,
    handleKey,
    nudge,
  };
}

/** A short wavy line in the pen's style; an eraser for the eraser. */
function ToolGlyph({ mode, color }: { mode: Mode; color?: string }) {
  if (mode === 'eraser') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
        <path d="M8.5 20H20" strokeLinecap="round" />
        <path d="M3.9 14.6 13.6 4.9a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8L11.5 20H8.3l-4.4-4.6a.6.6 0 0 1 0-.8Z" />
        <path d="m8.5 10 6.5 6.5" />
      </svg>
    );
  }
  const wave = 'M3 15c3-6 5-6 7 0s4 6 7 0 3-5 4-5';
  const stroke = color ?? 'currentColor';
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mode === 'marker' ? (
        <path d={wave} stroke={stroke} strokeWidth="6" opacity="0.55" />
      ) : (
        <path d={wave} stroke={stroke} strokeWidth="2" strokeDasharray={mode === 'dotted' ? '0 4' : mode === 'dashed' ? '5 4' : undefined} />
      )}
    </svg>
  );
}
