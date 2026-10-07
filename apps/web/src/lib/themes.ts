import type { EngineColors } from '../reader/engine';
import { highlightColors, type HighlightColor } from './types';

/**
 * Colour roles, a port of the mobile `AppColors` (apps/mobile/lib/core/theme).
 * Every preset is dark; there is no light theme. `paper` and `ink` are the
 * reading surface and default to `bg` / `fg`.
 */
export interface ThemeColors {
  bg: string;
  panel: string;
  element: string;
  border: string;
  borderActive: string;
  fg: string;
  muted: string;
  subtle: string;
  blue: string;
  purple: string;
  green: string;
  orange: string;
  pink: string;
  cyan: string;
  paper: string;
  ink: string;
}

export interface ThemePreset {
  /** Stable id persisted in `ReaderPreferences.themeId`. Never rename. */
  id: string;
  name: string;
  colors: ThemeColors;
}

type Roles = Omit<ThemeColors, 'paper' | 'ink'> & Partial<Pick<ThemeColors, 'paper' | 'ink'>>;

function preset(id: string, name: string, roles: Roles): ThemePreset {
  return { id, name, colors: { ...roles, paper: roles.paper ?? roles.bg, ink: roles.ink ?? roles.fg } };
}

export const defaultThemeId = 'default';

/** Display order in Settings. Default (exact Vercel-dark) first. */
export const themePresets: ThemePreset[] = [
  preset(defaultThemeId, 'Default', {
    bg: '#000000',
    panel: '#101010',
    element: '#1f1f1f',
    border: '#1f1f1f',
    borderActive: '#676767',
    fg: '#ededed',
    muted: '#a1a1a1',
    subtle: '#676767',
    blue: '#52a8ff',
    purple: '#c472fb',
    green: '#62c073',
    orange: '#ff9907',
    pink: '#f75f8f',
    cyan: '#1da9b0',
  }),
  preset('dracula', 'Dracula', {
    bg: '#282a36',
    panel: '#21222c',
    element: '#44475a',
    border: '#44475a',
    borderActive: '#6272a4',
    fg: '#f8f8f2',
    muted: '#bfc7d5',
    subtle: '#6272a4',
    blue: '#8be9fd',
    purple: '#bd93f9',
    green: '#50fa7b',
    orange: '#ffb86c',
    pink: '#ff79c6',
    cyan: '#8be9fd',
  }),
  preset('nord', 'Nord', {
    bg: '#2e3440',
    panel: '#3b4252',
    element: '#434c5e',
    border: '#434c5e',
    borderActive: '#4c566a',
    fg: '#eceff4',
    muted: '#d8dee9',
    subtle: '#7b88a1',
    blue: '#88c0d0',
    purple: '#b48ead',
    green: '#a3be8c',
    orange: '#d08770',
    pink: '#bf616a',
    cyan: '#8fbcbb',
  }),
  preset('tokyo-night', 'Tokyo Night', {
    bg: '#1a1b26',
    panel: '#16161e',
    element: '#292e42',
    border: '#232433',
    borderActive: '#414868',
    fg: '#c0caf5',
    muted: '#a9b1d6',
    subtle: '#565f89',
    blue: '#7aa2f7',
    purple: '#bb9af7',
    green: '#9ece6a',
    orange: '#ff9e64',
    pink: '#f7768e',
    cyan: '#7dcfff',
  }),
  preset('catppuccin-mocha', 'Catppuccin Mocha', {
    bg: '#1e1e2e',
    panel: '#181825',
    element: '#313244',
    border: '#313244',
    borderActive: '#585b70',
    fg: '#cdd6f4',
    muted: '#a6adc8',
    subtle: '#6c7086',
    blue: '#89b4fa',
    purple: '#cba6f7',
    green: '#a6e3a1',
    orange: '#fab387',
    pink: '#f38ba8',
    cyan: '#89dceb',
  }),
  preset('gruvbox', 'Gruvbox', {
    bg: '#282828',
    panel: '#1d2021',
    element: '#3c3836',
    border: '#3c3836',
    borderActive: '#665c54',
    fg: '#ebdbb2',
    muted: '#a89984',
    subtle: '#928374',
    blue: '#83a598',
    purple: '#d3869b',
    green: '#b8bb26',
    orange: '#fe8019',
    pink: '#fb4934',
    cyan: '#8ec07c',
  }),
];

/** Unknown or absent ids fall back to Default, like `ThemePreset.byId`. */
export function themeById(id: string | null | undefined): ThemePreset {
  return themePresets.find((p) => p.id === id) ?? themePresets[0];
}

/** Accent set for generated art. Order is stable so a book keeps its slot across presets. */
export function accents(c: ThemeColors): string[] {
  return [c.blue, c.purple, c.green, c.orange, c.cyan, c.pink];
}

const cssVars: Record<keyof ThemeColors, string> = {
  bg: '--bg',
  panel: '--panel',
  element: '--element',
  border: '--border',
  borderActive: '--border-active',
  fg: '--fg',
  muted: '--muted',
  subtle: '--subtle',
  blue: '--blue',
  purple: '--purple',
  green: '--green',
  orange: '--orange',
  pink: '--pink',
  cyan: '--cyan',
  paper: '--paper',
  ink: '--ink',
};

const themeStorageKey = 'thereader.themeId';
let appliedThemeId: string | null = null;
let themeTransitionTimer = 0;

/**
 * Re-themes the whole app through CSS variables on `:root`. Switching presets
 * cross-fades every surface over Motion.base, like mobile's
 * `themeAnimationDuration`; the first paint applies instantly.
 */
export function applyTheme(id: string | null | undefined): void {
  const theme = themeById(id);
  const root = document.documentElement;
  if (appliedThemeId === theme.id) return;
  if (appliedThemeId !== null) {
    root.classList.add('theme-changing');
    window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = window.setTimeout(() => root.classList.remove('theme-changing'), 260);
  }
  appliedThemeId = theme.id;
  for (const key of Object.keys(cssVars) as (keyof ThemeColors)[]) {
    root.style.setProperty(cssVars[key], theme.colors[key]);
  }
  root.style.setProperty('--selection', withAlpha(theme.colors.blue, 0.3));
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors.bg);
  try {
    localStorage.setItem(themeStorageKey, theme.id);
  } catch {
    // Private mode: the saved preference still arrives from the settings store.
  }
}

/** Last applied preset, so a reload paints the right colours before the stores load. */
export function rememberedThemeId(): string | null {
  try {
    return localStorage.getItem(themeStorageKey);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- colour maths

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex).map((c) => Math.round(c * 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Flutter's `Color.computeLuminance`. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------- highlights

/** Vivid hues used in UI controls (`HighlightColors.swatch`). */
export const highlightHues: Record<HighlightColor, string> = {
  yellow: '#f5c518',
  green: '#4ade80',
  blue: '#60a5fa',
  pink: '#f472b6',
  purple: '#a78bfa',
};

/** Unknown keys (a newer build's colour) render as yellow. */
export function parseHighlightColor(key: string | null | undefined): HighlightColor {
  return (highlightColors as string[]).includes(key ?? '') ? (key as HighlightColor) : 'yellow';
}

const maxTintAlpha = 0.38;
const minTintContrast = 4.5;
const tintCache = new Map<string, string>();

/**
 * What the page paints behind highlighted text: the hue blended onto paper, as
 * strong as possible while ink keeps WCAG AA (4.5:1). Opaque, like mobile.
 */
export function highlightTint(key: HighlightColor, colors: Pick<ThemeColors, 'paper' | 'ink'>): string {
  const cacheKey = `${colors.paper}|${colors.ink}|${key}`;
  const cached = tintCache.get(cacheKey);
  if (cached) return cached;
  const paper = parseHex(colors.paper);
  const hue = parseHex(highlightHues[key]);
  const ink = luminance(parseHex(colors.ink));
  let result = colors.paper;
  for (let a = maxTintAlpha; a > 0; a -= 0.02) {
    const mix = paper.map((p, i) => p + (hue[i] - p) * a) as Rgb;
    const lm = luminance(mix);
    const ratio = (Math.max(ink, lm) + 0.05) / (Math.min(ink, lm) + 0.05);
    if (ratio >= minTintContrast) {
      result = toHex(mix);
      break;
    }
  }
  tintCache.set(cacheKey, result);
  return result;
}

/** Colours the EPUB engine paints with, resolved from a preset. */
export function engineColors(themeId: string | null | undefined): EngineColors {
  const c = themeById(themeId).colors;
  const highlightTints = Object.fromEntries(highlightColors.map((k) => [k, highlightTint(k, c)])) as Record<string, string>;
  return {
    paper: c.paper,
    ink: c.ink,
    muted: c.muted,
    link: c.blue,
    selection: withAlpha(c.blue, 0.3),
    highlightTints,
    content: {
      panel: c.panel,
      border: c.border,
      subtle: c.subtle,
      blue: c.blue,
      purple: c.purple,
      green: c.green,
      orange: c.orange,
      pink: c.pink,
      cyan: c.cyan,
    },
  };
}
