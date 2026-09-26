import type { CSSProperties } from 'react';
import { accents, themeById, themePresets, type ThemeColors, type ThemePreset } from '../lib/themes';
import { CheckIcon } from './icons';
import { Eyebrow } from './states';

/**
 * Theme picker: one card per preset, each a miniature of the app painted in
 * that preset's own colours, so the choice is visible before it is made.
 */
export function ThemeSection({ selectedId, onSelect }: { selectedId: string | undefined; onSelect: (id: string) => void }) {
  const current = themeById(selectedId);
  return (
    <section className="settings-section" aria-labelledby="theme-eyebrow">
      <Eyebrow as="h2" id="theme-eyebrow">
        Theme
      </Eyebrow>
      <div className="theme-grid" role="radiogroup" aria-labelledby="theme-eyebrow">
        {themePresets.map((p) => (
          <ThemeCard key={p.id} preset={p} selected={p.id === current.id} onSelect={() => onSelect(p.id)} />
        ))}
      </div>
    </section>
  );
}

function ThemeCard({ preset, selected, onSelect }: { preset: ThemePreset; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${preset.name} theme`}
      className={selected ? 'theme-card is-selected' : 'theme-card'}
      onClick={onSelect}
    >
      <ThemeMiniature colors={preset.colors} />
      <span className="theme-card-name">
        <span>{preset.name}</span>
        {selected ? <CheckIcon size={16} /> : <span className="theme-card-check-slot" />}
      </span>
    </button>
  );
}

/**
 * A tiny mock of the Library screen in the preset's colours: title, a
 * continue-reading row, two covers, a paper swatch and the tab row. Sized in
 * container units so it scales with the card.
 */
function ThemeMiniature({ colors: c }: { colors: ThemeColors }) {
  const a = accents(c);
  const vars = {
    '--m-bg': c.bg,
    '--m-panel': c.panel,
    '--m-element': c.element,
    '--m-border': c.border,
    '--m-fg': c.fg,
    '--m-muted': c.muted,
    '--m-subtle': c.subtle,
    '--m-paper': c.paper,
    '--m-ink': c.ink,
  } as CSSProperties;
  return (
    <span className="mini" style={vars} aria-hidden="true">
      <span className="mini-title">Library</span>
      <MiniCover className="mini-continue-cover" accent={a[0]} />
      <span className="mini-bar" style={{ left: '24cqw', top: '26cqw', width: '40cqw', height: '3cqw', background: c.fg }} />
      <span className="mini-bar" style={{ left: '24cqw', top: '32cqw', width: '26cqw', height: '2.2cqw', background: c.muted }} />
      <span className="mini-bar" style={{ left: '24cqw', top: '39cqw', width: '52cqw', height: '1.4cqw', background: c.element }} />
      <span className="mini-bar" style={{ left: '24cqw', top: '39cqw', width: '22cqw', height: '1.4cqw', background: c.fg }} />
      <span className="mini-divider" />
      <MiniCover className="mini-grid-cover-1" accent={a[1]} />
      <MiniCover className="mini-grid-cover-2" accent={a[3]} />
      <span className="mini-paper">
        <span style={{ width: '24cqw' }} />
        <span style={{ width: '30cqw' }} />
        <span style={{ width: '18cqw' }} />
      </span>
      <span className="mini-tabs">
        <span style={{ background: c.fg }} />
        <span style={{ background: c.subtle }} />
        <span style={{ background: c.subtle }} />
      </span>
    </span>
  );
}

function MiniCover({ className, accent }: { className: string; accent: string }) {
  return (
    <span className={`mini-cover ${className}`}>
      <span className="mini-cover-accent" style={{ background: accent }} />
      <span className="mini-cover-title" />
      <span className="mini-cover-author" />
    </span>
  );
}
