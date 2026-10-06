import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { formatForDisplay, useHotkeys, type UseHotkeyDefinition } from '@tanstack/react-hotkeys';
import { inertProps } from '../../../lib/hooks';
import { randomId } from '../../../lib/services/hash';
import { articleInkId, type InkStroke, type InkTool } from '../../../lib/services/ink';
import { nowIso } from '../../../lib/services/models';
import { useServices, useStore } from '../../../lib/services/react';
import { IconButton } from '../../buttons';
import { CheckIcon, DeleteOutlineIcon, DrawIcon, KeyboardIcon, RedoIcon, UndoIcon } from '../../icons';
import { hasOpenOverlay } from '../../overlay';
import { useToast } from '../../toast';
import { anchorBox, boxElements, dashArray, keepInside, lineWidth, marginOf, nearStroke, pickAnchor, placeStroke, strokePath, thin, toAnchor, type Box } from './geometry';
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

type Change = { kind: 'add' | 'remove'; strokes: InkStroke[] };
interface Placed {
  stroke: InkStroke;
  points: number[];
  d: string;
}
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

/** One stroke as SVG, styled by its pen. */
function StrokePath({ tool, color, size, d }: { tool: InkTool; color: string; size: number; d: string }) {
  return (
    <path
      d={d}
      className={tool === 'marker' ? 'ink-marker' : undefined}
      stroke={color}
      strokeWidth={lineWidth(tool, size)}
      strokeDasharray={dashArray(tool, size)}
    />
  );
}

/**
 * Pen drawing over the article reader. With the pen on (P), the page
 * becomes a canvas: draw, underline, circle words or write in the margins
 * with a solid, dotted or dashed pen or a marker, in any colour and three
 * widths; Shift draws a straight line; the eraser takes whole strokes.
 *
 * Strokes are drawn on an SVG laid over the whole page, so they scroll with
 * it. Each is stored relative to the block it was drawn on (the article
 * header above the first block), and placed again from that block's box
 * whenever the page's layout changes, so a drawing comes back in place when
 * the article is reopened and keeps to its passage when blocks above it
 * change height; a margin note that would fall off a narrower window slides
 * back onto the page as a whole. Mouse, pen and finger all draw; once a pen has been used, a
 * finger scrolls instead (palm rest).
 *
 * The toolbar along the bottom gets out of the way while drawing or
 * scrolling and comes back when the hand pauses, when the mouse nears the
 * bottom edge, or when a shortcut changes the pen; a small chip shows the
 * pen in use meanwhile. Shortcuts go through TanStack Hotkeys, from a table
 * the reader can rebind (`shortcuts.ts`).
 */
export function useArticleInk({
  id,
  ready,
  pageRef,
  bodyRef,
  headerRef,
}: {
  id: string;
  ready: boolean;
  pageRef: RefObject<HTMLDivElement>;
  bodyRef: RefObject<HTMLDivElement>;
  headerRef: RefObject<HTMLElement>;
}): { button: ReactNode; surface: ReactNode; toolbar: ReactNode; active: boolean } {
  const services = useServices();
  const toast = useToast();
  const docId = articleInkId(id);
  useStore(services.ink);
  const strokes = services.ink.strokes(docId);
  const shortcuts = useMemo(loadInkShortcuts, []);

  const [active, setActive] = useState(false);
  const [settings, setSettings] = useState<PenSettings>(readSettings);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);
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
  const livePath = useRef<SVGPathElement>(null);
  const placedRef = useRef(placed);
  placedRef.current = placed;
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

  // A new article starts its own undo history.
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
  useEffect(() => () => window.clearTimeout(revealTimer.current), []);

  useEffect(() => {
    if (!active) {
      setHelp(false);
      return;
    }
    revealNow();
    // Scrolling rests the toolbar until the page holds still; a mouse heading for the bottom edge brings it back.
    const onScroll = () => {
      if (live.current) return;
      rest();
      revealLater();
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.buttons === 0 && e.clientY > window.innerHeight - REVEAL_EDGE) revealNow();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onMove);
    };
  }, [active, rest, revealLater, revealNow]);

  // ------------------------------------------------------------ layout

  const origin = useCallback(() => {
    const r = pageRef.current?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top } : null;
  }, [pageRef]);

  const anchorElement = useCallback(
    (block: number): Element | null => (block < 0 ? headerRef.current : (bodyRef.current?.querySelector(`[data-block-index="${block}"]`) ?? null)),
    [bodyRef, headerRef],
  );

  // Place every stroke from its anchor's box, before paint.
  useLayoutEffect(() => {
    const at = origin();
    const width = pageRef.current?.clientWidth ?? 0;
    if (!ready || !at) {
      setPlaced([]);
      return;
    }
    const found: { stroke: InkStroke; group: string | null; points: number[] }[] = [];
    for (const stroke of strokes) {
      const el = anchorElement(stroke.anchor.block);
      const box = el && anchorBox(el, at);
      if (!box) continue;
      const points = placeStroke(stroke, box);
      const margin = marginOf(points, box);
      found.push({ stroke, group: margin && `${stroke.anchor.block}:${margin}`, points });
    }
    const fitted = keepInside(found, width);
    setPlaced(found.map(({ stroke }, i) => ({ stroke, points: fitted[i]!, d: strokePath(fitted[i]!) })));
  }, [ready, strokes, layoutTick, origin, anchorElement, pageRef]);

  // Place again when the page or an anchor changes size: fonts, images,
  // typography, the window, skipped blocks rendering.
  useEffect(() => {
    const page = pageRef.current;
    if (!ready || !page) return;
    let frame = 0;
    const bump = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setLayoutTick((n) => n + 1);
        });
    };
    const ro = new ResizeObserver(bump);
    ro.observe(page);
    for (const block of new Set(strokes.map((s) => s.anchor.block))) {
      const el = anchorElement(block);
      if (el) for (const part of boxElements(el)) ro.observe(part);
    }
    void document.fonts?.ready.then(bump);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready, strokes, pageRef, anchorElement]);

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

  const clearAll = useCallback(() => {
    const all = services.ink.strokes(docId);
    if (all.length === 0) return;
    const change: Change = { kind: 'remove', strokes: all };
    apply(change);
    record(change);
    toast.show('Drawing cleared.', {
      action: {
        label: 'Undo',
        onClick: () => {
          apply(change, true);
          record({ kind: 'add', strokes: all });
        },
      },
    });
  }, [apply, docId, record, services, toast]);

  // ------------------------------------------------------------ pointer

  const pointAt = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const at = origin();
    return at ? [e.clientX - at.left, e.clientY - at.top] : null;
  };

  const eraseAt = (x: number, y: number, gesture: Live) => {
    const hits = placedRef.current.filter(
      (p) => !gesture.erased.includes(p.stroke) && nearStroke(p.points, x, y, lineWidth(p.stroke.tool, p.stroke.size) / 2 + ERASER_REACH),
    );
    if (hits.length === 0) return;
    gesture.erased.push(...hits.map((p) => p.stroke));
    void services.ink.remove(docId, hits.map((p) => p.stroke.id));
  };

  const drawLive = () => {
    const g = live.current;
    if (livePath.current) livePath.current.setAttribute('d', g && settingsRef.current.mode !== 'eraser' ? strokePath(g.points) : '');
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (live.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // With a pen in use, a resting hand or a finger scrolls the page.
    if (e.pointerType === 'touch' && penSeen) return;
    if (e.pointerType === 'pen' && !penSeen) setPenSeen(true);
    const p = pointAt(e);
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

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = live.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const native = e.nativeEvent;
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    const events = samples.length > 0 ? samples : [native];
    if (settingsRef.current.mode === 'eraser') {
      for (const ev of events) {
        const p = pointAt(ev);
        if (p) eraseAt(p[0], p[1], g);
      }
      return;
    }
    if (e.shiftKey) {
      // A straight line from where the stroke began.
      const p = pointAt(native);
      if (p) g.points = [g.start[0], g.start[1], p[0], p[1]];
    } else {
      for (const ev of events) {
        const p = pointAt(ev);
        if (p) g.points.push(p[0], p[1]);
      }
    }
    drawLive();
  };

  const finish = (e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
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
    const at = origin();
    if (!at) return;
    const points = thin(g.points);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < points.length; i += 2) {
      minY = Math.min(minY, points[i]!);
      maxY = Math.max(maxY, points[i]!);
    }
    // Anchor to the block under the middle of the stroke (the header above the first block).
    const candidates: { key: number; box: Box }[] = [];
    const header = headerRef.current;
    const headerBox = header && anchorBox(header, at);
    if (headerBox) candidates.push({ key: -1, box: headerBox });
    for (const el of bodyRef.current?.querySelectorAll<HTMLElement>('[data-block-index]') ?? []) {
      const box = anchorBox(el, at);
      if (box) candidates.push({ key: Number(el.dataset.blockIndex) || 0, box });
    }
    const anchor = pickAnchor(candidates, (minY + maxY) / 2);
    if (!anchor) return;
    const tool: InkTool = s.mode;
    const stroke: InkStroke = {
      id: randomId(),
      tool,
      color: s.color,
      size: s.size,
      anchor: { block: anchor.key, width: Math.round(anchor.box.width * 10) / 10, height: Math.round(anchor.box.height * 10) / 10 },
      points: toAnchor(points, anchor.box),
      createdAt: nowIso(),
    };
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
        return clearAll();
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

  const hotkeys: UseHotkeyDefinition[] = (Object.keys(shortcuts) as InkAction[]).flatMap((action) =>
    shortcuts[action].map((hotkey) => ({
      hotkey,
      callback: () => {
        if (!hasOpenOverlay()) run(action);
      },
      options: { enabled: ready && (action === 'toggle' || active), meta: { name: inkActionLabels[action] } },
    })),
  );
  useHotkeys(hotkeys, { ignoreInputs: true, conflictBehavior: 'allow' });

  const tip = (label: string, action: InkAction) => {
    const keys = shortcutLabel(shortcuts, action);
    return keys ? `${label} · ${keys}` : label;
  };

  // ------------------------------------------------------------ render

  const cursor = useMemo(() => cursorFor(settings), [settings]);
  const drawing = active && settings.mode !== 'eraser' ? settings.mode : null;

  const surface = (
    <svg
      className={active ? 'ink-surface is-active' : 'ink-surface'}
      style={{ cursor: active ? cursor : undefined, touchAction: active && !penSeen ? 'none' : undefined } as CSSProperties}
      aria-hidden={!active}
      aria-label={active ? 'Drawing canvas' : undefined}
      onPointerDown={active ? onPointerDown : undefined}
      onPointerMove={active ? onPointerMove : undefined}
      onPointerUp={active ? (e) => finish(e, false) : undefined}
      onPointerCancel={active ? (e) => finish(e, true) : undefined}
      onContextMenu={active ? (e) => e.preventDefault() : undefined}
    >
      {placed.map(({ stroke, d }) => (
        <StrokePath key={stroke.id} tool={stroke.tool} color={stroke.color} size={stroke.size} d={d} />
      ))}
      {drawing && (
        <path
          ref={livePath}
          className={drawing === 'marker' ? 'ink-marker' : undefined}
          stroke={settings.color}
          strokeWidth={lineWidth(drawing, settings.size)}
          strokeDasharray={dashArray(drawing, settings.size)}
        />
      )}
    </svg>
  );

  const button = <IconButton icon={DrawIcon} label="Draw" shortcut={shortcutLabel(shortcuts, 'toggle')} aria-pressed={active} onClick={toggle} />;

  const current = modes.find((m) => m.mode === settings.mode)!;
  const open = !resting && !stowed;
  const { undo: past, redo: future } = history.current;

  const toolbar = active ? (
    <div className="ink-dock">
      {help && open && (
        <div className="ink-help" role="dialog" aria-label="Pen shortcuts">
          <p className="ink-help-title">Pen shortcuts</p>
          <dl>
            {(Object.keys(shortcuts) as InkAction[])
              .filter((a) => shortcuts[a].length > 0)
              .map((a) => (
                <div key={a}>
                  <dt>{inkActionLabels[a]}</dt>
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
          <IconButton icon={DeleteOutlineIcon} label="Clear drawing" shortcut={shortcutLabel(shortcuts, 'clear')} tooltipSide="top" disabled={strokes.length === 0} onClick={clearAll} />
          <IconButton icon={KeyboardIcon} label="Shortcuts" shortcut={shortcutLabel(shortcuts, 'help')} tooltipSide="top" aria-pressed={help} onClick={() => setHelp((v) => !v)} />
        </div>
        <span className="ink-divider" aria-hidden="true" />
        <IconButton icon={CheckIcon} label="Done" shortcut={shortcutLabel(shortcuts, 'done')} tooltipSide="top" className="ink-done" onClick={() => setActive(false)} />
      </div>
    </div>
  ) : null;

  return { button, surface, toolbar, active };
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
