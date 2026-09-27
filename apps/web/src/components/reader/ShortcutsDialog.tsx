import { Dialog } from '../overlay';
import type { IconProps } from '../icons';

/** Material outlined `keyboard`. */
export function KeyboardIcon({ size = 20, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
      <path d="M20 7v10H4V7h16m0-2H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-3 0h2v2H5zm0-3h2v2H5zm3 6h8v2H8zm6-3h2v2h-2zm0-3h2v2h-2zm3 3h2v2h-2zm0-3h2v2h-2z" />
    </svg>
  );
}

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function groups(rtl: boolean): { title: string; rows: [string[], string][] }[] {
  const [forward, back] = rtl ? ['←', '→'] : ['→', '←'];
  return [
    {
      title: 'Reading',
      rows: [
        [[forward, 'Space', 'PgDn'], 'Next page'],
        [[back, '⇧ Space', 'PgUp'], 'Previous page'],
        [['↓', '↑'], 'Scroll, or turn a page'],
        [[']', `⇧ ${forward}`], 'Next chapter'],
        [['[', `⇧ ${back}`], 'Previous chapter'],
        [['Home'], 'Start of chapter'],
        [['+', '−'], 'Text size'],
      ],
    },
    {
      title: 'Tools',
      rows: [
        [['T'], 'Contents'],
        [['H'], 'Highlights'],
        [['/', `${mod} F`], 'Search this book'],
        [['A', `${mod} ,`], 'Typography'],
        [['M'], 'Show or hide controls'],
        [['F'], 'Full screen'],
        [['Esc'], 'Close panel, then the book'],
      ],
    },
  ];
}

/** Every reader shortcut, opened with `?` or the keyboard button. */
export function ShortcutsDialog({ open, rtl, onClose }: { open: boolean; rtl: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      actions={
        <button type="button" className="text-button" onClick={onClose} data-autofocus>
          Done
        </button>
      }
    >
      <div className="shortcuts">
        {groups(rtl).map((g) => (
          <section key={g.title}>
            <h3 className="eyebrow">{g.title}</h3>
            <dl>
              {g.rows.map(([keys, label]) => (
                <div key={label} className="shortcut-row">
                  <dt>{label}</dt>
                  <dd>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
