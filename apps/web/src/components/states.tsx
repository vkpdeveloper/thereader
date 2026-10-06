import type { CSSProperties, ReactNode } from 'react';
import { QuietButton } from './buttons';

/** Small uppercase label used for section headings. */
export function Eyebrow({ children, color, as: Tag = 'div', id }: { children: ReactNode; color?: string; as?: 'div' | 'h2' | 'h3'; id?: string }) {
  return (
    <Tag className="eyebrow" style={color ? { color } : undefined} id={id}>
      {children}
    </Tag>
  );
}

/** Tiny pill for subjects, language and size. */
export function Tag({ children, color, filled }: { children: ReactNode; color?: string; filled?: boolean }) {
  return (
    <span className={filled ? 'tag is-filled' : 'tag'} style={color ? ({ '--tag-color': color } as CSSProperties) : undefined}>
      {children}
    </span>
  );
}

/** Top-of-screen serif title with an optional trailing action centred on its glyphs. */
export function ScreenHeader({ title, size = 'lg', trailing }: { title: string; size?: 'lg' | 'sm'; trailing?: ReactNode }) {
  return (
    <header className="screen-header">
      <h1 className={size === 'lg' ? 't-display-lg' : 't-display-sm'}>{title}</h1>
      {trailing && <div className="screen-header-trailing">{trailing}</div>}
    </header>
  );
}

/**
 * A 2px progress line; `value` null is indeterminate. `working` sweeps a sheen
 * across the fill, animated on the compositor so it keeps moving while the
 * main thread is busy (parsing, extraction).
 */
export function ProgressLine({ value, label, className, working }: { value: number | null; label?: string; className?: string; working?: boolean }) {
  const pct = value == null ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={['progress-line', value == null && 'is-indeterminate', working && 'is-working', className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="progress-line-fill" style={pct == null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** Small circular progress (catalog rows); `value` null spins. */
export function ProgressRing({ value, size = 22, label }: { value: number | null; size?: number; label?: string }) {
  const r = (size - 3) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      className={value == null ? 'progress-ring is-indeterminate' : 'progress-ring'}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuenow={value == null ? undefined : Math.round(value * 100)}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--element)" strokeWidth={2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--fg)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={value == null ? circumference * 0.7 : circumference * (1 - Math.min(1, Math.max(0, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Quiet loading indicator: a single thin line, no spinner clutter. */
export function LoadingLine({ label }: { label?: string }) {
  return (
    <div className="loading-line" role="status" aria-live="polite">
      <ProgressLine value={null} label={label ?? 'Loading'} className="loading-line-bar" />
      {label && <p className="t-body-sm">{label}</p>}
    </div>
  );
}

/** Editorial empty/error message with an optional single action. */
export function StateMessage({
  title,
  body,
  actionLabel,
  onAction,
  error,
  tone,
  secondary,
}: {
  title: string;
  body?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  error?: boolean;
  tone?: string;
  secondary?: ReactNode;
}) {
  const rule = tone ?? (error ? 'var(--pink)' : 'var(--muted)');
  return (
    <div className="state-message" role={error ? 'alert' : undefined}>
      <div className="state-message-rule" style={{ background: rule }} />
      <h2 className="t-headline">{title}</h2>
      {body != null && <p className="state-message-body">{body}</p>}
      {(actionLabel && onAction) || secondary ? (
        <div className="state-message-actions">
          {actionLabel && onAction && <QuietButton label={actionLabel} onClick={onAction} />}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
