import { checkHotkey, formatForDisplay, type Hotkey } from '@tanstack/react-hotkeys';

/** Everything the pen does from the keyboard. */
export type InkAction =
  | 'toggle'
  | 'pen'
  | 'dotted'
  | 'dashed'
  | 'marker'
  | 'eraser'
  | 'nextColor'
  | 'previousColor'
  | 'thinner'
  | 'thicker'
  | 'undo'
  | 'redo'
  | 'clear'
  | 'toolbar'
  | 'help'
  | 'done';

export const inkActionLabels: Record<InkAction, string> = {
  toggle: 'Pen on or off',
  pen: 'Pen',
  dotted: 'Dotted pen',
  dashed: 'Dashed pen',
  marker: 'Marker',
  eraser: 'Eraser',
  nextColor: 'Next colour',
  previousColor: 'Previous colour',
  thinner: 'Thinner',
  thicker: 'Thicker',
  undo: 'Undo',
  redo: 'Redo',
  clear: 'Clear drawing',
  toolbar: 'Show or hide the toolbar',
  help: 'Pen shortcuts',
  done: 'Done drawing',
};

/** Default bindings; the first of each is the one shown in tooltips. */
export const defaultInkShortcuts: Record<InkAction, Hotkey[]> = {
  toggle: ['P'],
  pen: ['1'],
  dotted: ['2'],
  dashed: ['3'],
  marker: ['4'],
  eraser: ['E'],
  nextColor: ['C'],
  previousColor: ['Shift+C'],
  thinner: ['['],
  thicker: [']'],
  undo: ['Mod+Z'],
  redo: ['Mod+Shift+Z', 'Mod+Y'],
  clear: ['Mod+Backspace'],
  toolbar: ['T'],
  help: ['?'],
  done: ['Escape'],
};

const STORAGE_KEY = 'thereader.shortcuts.ink';

/**
 * The bindings in use: the defaults, with any the reader has changed
 * (stored on this device as `{ action: ["Mod+K", ...] }`). An override that
 * does not parse as a hotkey is ignored, so a bad entry never loses a
 * shortcut; an empty list turns the action's shortcut off.
 */
export function loadInkShortcuts(): Record<InkAction, Hotkey[]> {
  const result = { ...defaultInkShortcuts };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!saved || typeof saved !== 'object') return result;
    for (const action of Object.keys(defaultInkShortcuts) as InkAction[]) {
      const list = saved[action];
      if (!Array.isArray(list)) continue;
      const valid = list.filter((h): h is Hotkey => typeof h === 'string' && checkHotkey(h));
      if (valid.length === list.length) result[action] = valid;
    }
  } catch {
    /* Unreadable overrides: the defaults stand. */
  }
  return result;
}

/** Changes one action's bindings (for a future shortcuts editor, e.g. with `useHotkeyRecorder`); pass the defaults to reset. */
export function saveInkShortcut(action: InkAction, hotkeys: Hotkey[]): void {
  try {
    const saved = (JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<string, unknown> | null) ?? {};
    saved[action] = hotkeys;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* Storage refused: the change lasts until reload. */
  }
}

/** "Ctrl+Z" / "⌘ Z": the action's first binding as the platform writes it, or undefined when it has none. */
export function shortcutLabel(shortcuts: Record<InkAction, Hotkey[]>, action: InkAction): string | undefined {
  const first = shortcuts[action][0];
  return first ? formatForDisplay(first) : undefined;
}
