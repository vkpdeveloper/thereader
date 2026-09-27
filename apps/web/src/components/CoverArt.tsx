import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AppServices } from '../lib/services/contract';
import { useServices } from '../lib/services/react';
import { useInView } from '../lib/hooks';
import type { Book } from '../lib/types';
import { ImageIcon, ImageNotSupportedIcon } from './icons';

type CoverState = { kind: 'loading' } | { kind: 'image'; url: string } | { kind: 'plate' } | { kind: 'failed' };

const retryMs = 31_000;

/**
 * 3:4 cover frame (mobile `CoverArt`). Real artwork is cached offline by the
 * cover store; books without a cover get a generated plate; network failures
 * show a quiet unavailable state and retry after ~31 s.
 */
export function CoverArt({ book, origin, width, className }: { book: Book; origin: string; width?: number; className?: string }) {
  const services = useServices();
  const frame = useRef<HTMLDivElement>(null);
  const visible = useInView(frame, '300px');
  // The first frame comes from the store's synchronous answer, so a remounted
  // or re-keyed cover shows its image (or plate) at once instead of flashing.
  const key = `${origin}\n${book.id}\n${book.sha256}`;
  const [shown, setShown] = useState<{ key: string; cover: CoverState }>(() => ({ key, cover: peeked(services, book, origin) }));
  let state = shown.cover;
  if (shown.key !== key) {
    state = peeked(services, book, origin);
    setShown({ key, cover: state });
  }
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const set = (cover: CoverState) => !cancelled && setShown({ key, cover });
    const known = services.covers.peek(book, origin);
    if (known !== undefined) {
      set(known ? { kind: 'image', url: known } : { kind: 'plate' });
      return;
    }
    set({ kind: 'loading' });
    services.covers.load(book, origin).then(
      (url) => set(url ? { kind: 'image', url } : { kind: 'plate' }),
      () => set({ kind: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
    // A new edition (sha) or origin reloads; `attempt` drives retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, services, key, attempt]);

  // Failed loads and undecodable images retry quietly, like mobile.
  useEffect(() => {
    if (state.kind !== 'failed' || !visible) return;
    const t = window.setTimeout(() => setAttempt((a) => a + 1), retryMs);
    return () => window.clearTimeout(t);
  }, [state, visible]);

  // The browser could not decode the cached cover: drop it so the retry refetches.
  const onImageError = () => {
    setShown({ key, cover: { kind: 'failed' } });
    void services.covers.reject(book, origin).catch(() => undefined);
  };

  const style: CSSProperties | undefined = width ? { width } : undefined;
  return (
    <div ref={frame} className={['cover', className].filter(Boolean).join(' ')} style={style} role="img" aria-label={`Cover of ${book.title}`}>
      {state.kind === 'image' && (
        <img src={state.url} alt="" draggable={false} decoding="async" onError={onImageError} />
      )}
      {state.kind === 'plate' && <CoverPlate book={book} />}
      {(state.kind === 'loading' || state.kind === 'failed') && (
        <div className="cover-status" title={state.kind === 'failed' ? 'Cover unavailable. Retrying when connected.' : undefined}>
          {state.kind === 'failed' ? <ImageNotSupportedIcon /> : <ImageIcon />}
        </div>
      )}
    </div>
  );
}

function peeked(services: AppServices, book: Book, origin: string): CoverState {
  const known = services.covers.peek(book, origin);
  return known === undefined ? { kind: 'loading' } : known === null ? { kind: 'plate' } : { kind: 'image', url: known };
}

const accentVars = ['var(--blue)', 'var(--purple)', 'var(--green)', 'var(--orange)', 'var(--cyan)', 'var(--pink)'];

function seedOf(id: string): number {
  let a = 17;
  for (let i = 0; i < id.length; i++) a = (a * 31 + id.charCodeAt(i)) & 0x7fffffff;
  return a;
}

/** Generated plate for books with no cover: a seeded accent mark, title and author. */
export function CoverPlate({ book }: { book: Book }) {
  const seed = seedOf(book.id);
  const accent = accentVars[seed % 6];
  return (
    <div className="cover-plate" aria-hidden="true">
      <PlateMark seed={seed} accent={accent} />
      <div className="cover-plate-text">
        <div className="cover-plate-title">{book.title}</div>
        <div className="cover-plate-author">{book.author}</div>
      </div>
    </div>
  );
}

/** Port of `_MarkPainter`, in a 96×128 box that scales with the frame. */
function PlateMark({ seed, accent }: { seed: number; accent: string }) {
  const W = 96;
  const H = 128;
  const variant = Math.floor(seed / 7) % 4;
  const inset = W * 0.11;
  const top = H * 0.1;
  const w = W - inset * 2;
  const stroke = { stroke: accent, strokeWidth: W * 0.018, strokeLinecap: 'round' as const, fill: 'none' };
  let shapes: JSX.Element[];
  switch (variant) {
    case 0:
      shapes = [0, 1, 2, 3].map((i) => {
        const y = top + i * H * 0.045;
        return <line key={i} x1={inset} y1={y} x2={inset + w * (1 - i * 0.22)} y2={y} {...stroke} />;
      });
      break;
    case 1: {
      const r = W * 0.13;
      shapes = [
        <circle key="c" cx={inset + r} cy={top + r} r={r} {...stroke} />,
        <line key="l" x1={inset + r * 2 + inset * 0.6} y1={top + r * 2} x2={inset + w} y2={top + r * 2} {...stroke} />,
      ];
      break;
    }
    case 2:
      shapes = [0, 1, 2, 3, 4].map((i) => {
        const x = inset + i * W * 0.075;
        return <line key={i} x1={x} y1={top + H * 0.16} x2={x + W * 0.16} y2={top} {...stroke} />;
      });
      break;
    default: {
      const s = W * 0.22;
      shapes = [
        <rect key="r" x={inset} y={top} width={s} height={s} {...stroke} strokeLinecap={undefined} />,
        <circle key="d" cx={inset + s + inset * 0.9} cy={top + s / 2} r={W * 0.03} fill={accent} />,
      ];
    }
  }
  return (
    <svg className="cover-plate-mark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet" aria-hidden="true">
      {shapes}
    </svg>
  );
}
