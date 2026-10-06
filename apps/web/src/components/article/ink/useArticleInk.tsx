import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { dashArray, lineWidth, nearStroke, strokePath } from '../../../lib/inkPaths';
import { articleInkId, isTextAnchor, type BlockAnchor, type InkStroke, type InkTool } from '../../../lib/services/ink';
import { useServices, useStore } from '../../../lib/services/react';
import { useInk, type Ink, type InkSurface } from '../../ink/useInk';
import { anchorBox, boxElements, keepInside, marginOf, pickAnchor, placeStroke, toAnchor, type Box } from './geometry';

interface Placed {
  stroke: InkStroke;
  points: number[];
  d: string;
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
 * The pen over the article reader (see `useInk` for the pen itself).
 *
 * Strokes are drawn on an SVG laid over the whole page, so they scroll with
 * it. Each is stored relative to the block it was drawn on (the article
 * header above the first block), and placed again from that block's box
 * whenever the page's layout changes, so a drawing comes back in place when
 * the article is reopened and keeps to its passage when blocks above it
 * change height; a margin note that would fall off a narrower window slides
 * back onto the page as a whole.
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
}): { ink: Ink; surface: ReactNode } {
  const services = useServices();
  const docId = articleInkId(id);
  useStore(services.ink);
  const strokes = services.ink.strokes(docId);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [layoutTick, setLayoutTick] = useState(0);
  const livePath = useRef<SVGPathElement>(null);
  const placedRef = useRef(placed);
  placedRef.current = placed;

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
      if (isTextAnchor(stroke.anchor)) continue;
      const el = anchorElement(stroke.anchor.block);
      const box = el && anchorBox(el, at);
      if (!box) continue;
      const points = placeStroke({ anchor: stroke.anchor, points: stroke.points }, box);
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
    const blocks = new Set(strokes.flatMap((s) => (isTextAnchor(s.anchor) ? [] : [s.anchor.block])));
    for (const block of blocks) {
      const el = anchorElement(block);
      if (el) for (const part of boxElements(el)) ro.observe(part);
    }
    void document.fonts?.ready.then(bump);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready, strokes, pageRef, anchorElement]);

  // ------------------------------------------------------------ the surface

  const surface: InkSurface = {
    docId,
    ready,
    point(e) {
      const at = origin();
      return at ? [e.clientX - at.left, e.clientY - at.top] : null;
    },
    live(points) {
      livePath.current?.setAttribute('d', points ? strokePath(points) : '');
    },
    anchor(points) {
      const at = origin();
      if (!at) return null;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < points.length; i += 2) {
        minY = Math.min(minY, points[i]!);
        maxY = Math.max(maxY, points[i]!);
      }
      // The block under the middle of the stroke (the header above the first block).
      const candidates: { key: number; box: Box }[] = [];
      const header = headerRef.current;
      const headerBox = header && anchorBox(header, at);
      if (headerBox) candidates.push({ key: -1, box: headerBox });
      for (const el of bodyRef.current?.querySelectorAll<HTMLElement>('[data-block-index]') ?? []) {
        const box = anchorBox(el, at);
        if (box) candidates.push({ key: Number(el.dataset.blockIndex) || 0, box });
      }
      const picked = pickAnchor(candidates, (minY + maxY) / 2);
      if (!picked) return null;
      const anchor: BlockAnchor = {
        block: picked.key,
        width: Math.round(picked.box.width * 10) / 10,
        height: Math.round(picked.box.height * 10) / 10,
      };
      return { anchor, points: toAnchor(points, picked.box) };
    },
    hits(x, y, reach) {
      return placedRef.current.filter((p) => nearStroke(p.points, x, y, lineWidth(p.stroke.tool, p.stroke.size) / 2 + reach)).map((p) => p.stroke);
    },
    clearable: () => strokes,
    clearLabel: 'Clear drawing',
  };

  const ink = useInk(surface);
  const pen = ink.active ? ink.pen : null;

  const node = (
    <svg
      className={ink.active ? 'ink-surface is-active' : 'ink-surface'}
      aria-hidden={!ink.active}
      aria-label={ink.active ? 'Drawing canvas' : undefined}
      {...(ink.active ? ink.input : {})}
    >
      {placed.map(({ stroke, d }) => (
        <StrokePath key={stroke.id} tool={stroke.tool} color={stroke.color} size={stroke.size} d={d} />
      ))}
      {pen && (
        <path
          ref={livePath}
          className={pen.tool === 'marker' ? 'ink-marker' : undefined}
          stroke={pen.color}
          strokeWidth={lineWidth(pen.tool, pen.size)}
          strokeDasharray={dashArray(pen.tool, pen.size)}
        />
      )}
    </svg>
  );

  return { ink, surface: node };
}
