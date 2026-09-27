import { forwardRef, useId, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { IconButton } from './buttons';
import { CloseIcon, SearchIcon } from './icons';

/** Themed on/off switch (mobile `Switch`). */
export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'switch is-on' : 'switch'}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

/** Bordered segmented control (mobile `_Segmented`). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'segmented-option is-selected' : 'segmented-option'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Range slider with the thin track and round thumb of the mobile theme. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  valueText,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  valueText?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      style={{ '--slider-fill': `${pct}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/** Text input in the mobile input style; optional search glyph and clear button. */
export const TextField = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
    value: string;
    onValueChange: (v: string) => void;
    search?: boolean;
    onClear?: () => void;
    mono?: boolean;
    trailing?: ReactNode;
  }
>(function TextField({ value, onValueChange, search, onClear, mono, trailing, className, ...rest }, ref) {
  return (
    <div className={['text-field', search && 'has-prefix', mono && 'is-mono', className].filter(Boolean).join(' ')}>
      {search && <SearchIcon className="text-field-prefix" size={18} />}
      <input ref={ref} value={value} onChange={(e) => onValueChange(e.target.value)} {...rest} />
      {onClear && value.length > 0 && (
        <IconButton className="text-field-clear" icon={CloseIcon} label="Clear search" tone="muted" size={18} tooltipSide="none" onClick={onClear} />
      )}
      {trailing}
    </div>
  );
});

/** Filter chip (Browse subjects, Downloaded). */
export function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" className={selected ? 'chip is-selected' : 'chip'} aria-pressed={selected} onClick={onClick}>
      {label}
    </button>
  );
}

/** Label + control row used in the typography panel and settings. */
export function FieldRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  const id = useId();
  return (
    <div className="field-row">
      <label className="field-row-label" htmlFor={htmlFor} id={id}>
        {label}
      </label>
      <div className="field-row-control">{children}</div>
    </div>
  );
}
