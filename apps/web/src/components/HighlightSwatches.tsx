import { highlightHues } from '../lib/themes';
import { highlightColors, type HighlightColor } from '../lib/types';

/** A row of the highlight colours; `selected` gets a ring (mobile `HighlightSwatches`). */
export function HighlightSwatches({
  selected,
  onChange,
  order = highlightColors,
  label = 'Highlight colour',
  compact,
}: {
  selected: HighlightColor | null;
  onChange: (c: HighlightColor) => void;
  order?: HighlightColor[];
  label?: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'swatches is-compact' : 'swatches'} role="radiogroup" aria-label={label}>
      {order.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === selected}
          aria-label={c}
          title={c[0].toUpperCase() + c.slice(1)}
          className={c === selected ? 'swatch is-selected' : 'swatch'}
          onClick={() => onChange(c)}
        >
          <span className="swatch-ring">
            <span className="swatch-dot" style={{ background: highlightHues[c] }} />
          </span>
        </button>
      ))}
    </div>
  );
}
