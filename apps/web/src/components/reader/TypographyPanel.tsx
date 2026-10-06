import { useServices, useStore } from '../../lib/services/react';
import { fontStack, readerFontFamilies, resolveFontFamily, type ReaderFontFamily } from '../../lib/fonts';
import { parseHighlightColor } from '../../lib/themes';
import { MAX_FONT_SIZE, MIN_FONT_SIZE, type ReaderFlow } from '../../lib/types';
import { FieldRow, Segmented, Slider, Switch } from '../controls';
import { HighlightSwatches } from '../HighlightSwatches';
import { ArrowBackIcon, CheckIcon, ChevronRightIcon } from '../icons';
import { IconButton } from '../buttons';

const leading = [
  { value: 1.4, label: 'Tight' },
  { value: 1.6, label: 'Normal' },
  { value: 1.85, label: 'Loose' },
];
const margins = [
  { value: 0.6, label: 'Narrow' },
  { value: 1.0, label: 'Normal' },
  { value: 1.6, label: 'Wide' },
];
const layouts: { value: ReaderFlow; label: string }[] = [
  { value: 'scrolled', label: 'Scroll' },
  { value: 'paginated', label: 'Pages' },
];

/** Snaps a synced value (possibly written by another build) to the nearest option. */
function nearest(value: number, options: { value: number }[]): number {
  return options.reduce((best, o) => (Math.abs(o.value - value) < Math.abs(best - value) ? o.value : best), options[0].value);
}

/**
 * Typography controls (mobile `ReaderSettingsSheet`) plus the web's layout
 * and wake-lock switches. Every change applies to the page immediately.
 * Articles always scroll and have no highlights, so `article` drops those rows.
 */
export function TypographyPanel({ onFonts, article }: { onFonts: () => void; article?: boolean }) {
  const services = useServices();
  const { reader: p } = useStore(services.settings);
  const update = (change: Parameters<typeof services.settings.updateReader>[0]) => void services.settings.updateReader(change);
  const family = resolveFontFamily(p);
  return (
    <div className="typography">
      <FieldRow label="Font">
        <button type="button" className="font-button" aria-label={`Font, ${family.label}`} onClick={onFonts}>
          <span className="clamp-1" style={{ fontFamily: fontStack(family) }}>
            {family.label}
          </span>
          <ChevronRightIcon size={18} />
        </button>
      </FieldRow>
      <FieldRow label="Size">
        <div className="size-control">
          <span className="size-a is-small" aria-hidden="true">
            A
          </span>
          <Slider
            value={p.fontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            label="Text size"
            valueText={`${Math.round(p.fontSize)}`}
            onChange={(v) => update((r) => ({ ...r, fontSize: Math.round(v) }))}
          />
          <span className="size-a is-large" aria-hidden="true">
            A
          </span>
          <span className="size-value t-label-md">{Math.round(p.fontSize)}</span>
        </div>
      </FieldRow>
      <FieldRow label="Leading">
        <Segmented label="Leading" value={nearest(p.lineHeight, leading)} options={leading} onChange={(v) => update((r) => ({ ...r, lineHeight: v }))} />
      </FieldRow>
      <FieldRow label="Margins">
        <Segmented label="Margins" value={nearest(p.marginScale, margins)} options={margins} onChange={(v) => update((r) => ({ ...r, marginScale: v }))} />
      </FieldRow>
      {!article && (
        <FieldRow label="Layout">
          <Segmented label="Layout" value={p.flow} options={layouts} onChange={(v) => update((r) => ({ ...r, flow: v }))} />
        </FieldRow>
      )}
      <FieldRow label="Justify">
        <Switch label="Justify" checked={p.justify} onChange={(v) => update((r) => ({ ...r, justify: v }))} />
      </FieldRow>
      <FieldRow label="Keep awake">
        <Switch label="Keep screen awake" checked={p.keepAwake} onChange={(v) => update((r) => ({ ...r, keepAwake: v }))} />
      </FieldRow>
      {!article && (
        <>
          <hr className="divider" />
          <FieldRow label="Highlight">
            <HighlightSwatches
              label="Default highlight colour"
              selected={parseHighlightColor(p.highlightColor)}
              onChange={(c) => update((r) => ({ ...r, highlightColor: c }))}
            />
          </FieldRow>
        </>
      )}
    </div>
  );
}

/**
 * Font list in the style of Chrome's reading mode: every name set in its own
 * face, with a live sample of the current choice on top.
 */
export function FontPicker({ onBack }: { onBack: () => void }) {
  const services = useServices();
  const { reader } = useStore(services.settings);
  const current = resolveFontFamily(reader);
  const sampleSize = Math.min(22, Math.max(15, reader.fontSize));
  return (
    <div className="font-picker">
      <div className="font-picker-back">
        <IconButton icon={ArrowBackIcon} label="Back to typography" size={18} tooltipSide="none" onClick={onBack} />
        <span className="eyebrow">Font</span>
      </div>
      <FontSample family={current} fontSize={sampleSize} />
      <div className="font-list" role="radiogroup" aria-label="Font">
        {readerFontFamilies.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={f.id === current.id}
            aria-label={f.recommended ? `${f.label}, recommended` : f.label}
            className={f.id === current.id ? 'font-tile is-selected' : 'font-tile'}
            onClick={() => void services.settings.setFontFamily(f.id)}
          >
            <span className="font-tile-name clamp-1" style={{ fontFamily: fontStack(f) }}>
              {f.label}
            </span>
            {f.recommended && <span className="badge">Recommended</span>}
            <span className="font-tile-check">{f.id === current.id && <CheckIcon size={18} />}</span>
          </button>
        ))}
      </div>
      <p className="t-body-sm subtle">Fonts are bundled with the app and work offline.</p>
    </div>
  );
}

function FontSample({ family, fontSize }: { family: ReaderFontFamily; fontSize: number }) {
  return (
    <div className="font-sample">
      <p className="font-sample-text clamp-3" style={{ fontFamily: fontStack(family), fontSize }} aria-label={`Sample text in ${family.label}`}>
        The lamps came on one by one, and the <em>quiet</em> harbour turned to <strong>gold</strong>. Il1 O0 rn m
      </p>
      <p className="t-body-sm">{family.description}</p>
    </div>
  );
}
