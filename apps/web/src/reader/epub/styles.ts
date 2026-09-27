import type { ReaderPreferences } from '../../lib/types';
import type { EngineColors } from '../engine';

/**
 * Reader typography. Families mirror the mobile app's `ReaderFonts`
 * (apps/mobile/lib/core/typography/reader_fonts.dart); ids are synced, never rename.
 */
interface FontFamily {
  id: string;
  fontClass: 'serif' | 'sans';
  css: string | null;
  faces: { file: string; italic: boolean; weights: string }[];
}

const FAMILIES: FontFamily[] = [
  {
    id: 'literata',
    fontClass: 'serif',
    css: 'Literata',
    faces: [
      { file: 'Literata.ttf', italic: false, weights: '200 900' },
      { file: 'Literata-Italic.ttf', italic: true, weights: '200 900' },
    ],
  },
  {
    id: 'source-serif-4',
    fontClass: 'serif',
    css: 'SourceSerif4',
    faces: [
      { file: 'SourceSerif4.ttf', italic: false, weights: '200 900' },
      { file: 'SourceSerif4-Italic.ttf', italic: true, weights: '200 900' },
    ],
  },
  {
    id: 'atkinson-hyperlegible-next',
    fontClass: 'sans',
    css: 'AtkinsonHyperlegibleNext',
    faces: [
      { file: 'AtkinsonHyperlegibleNext.ttf', italic: false, weights: '200 800' },
      { file: 'AtkinsonHyperlegibleNext-Italic.ttf', italic: true, weights: '200 800' },
    ],
  },
  // Lexend has no italic; the browser slants it.
  { id: 'lexend', fontClass: 'sans', css: 'Lexend', faces: [{ file: 'Lexend.ttf', italic: false, weights: '100 900' }] },
  {
    id: 'inter',
    fontClass: 'sans',
    css: 'Inter',
    faces: [
      { file: 'Inter.ttf', italic: false, weights: '100 900' },
      { file: 'Inter-Italic.ttf', italic: true, weights: '100 900' },
    ],
  },
  { id: 'system-serif', fontClass: 'serif', css: null, faces: [] },
  { id: 'system-sans', fontClass: 'sans', css: null, faces: [] },
];

const SERIF_STACK = `Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif`;
const SANS_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Same rule as `ReaderFonts.resolve`: an id applies only while its class matches `font`. */
export function resolveFontStack(prefs: ReaderPreferences): string {
  const chosen = FAMILIES.find((f) => f.id === prefs.fontFamilyId);
  const family = chosen && chosen.fontClass === prefs.font ? chosen : null;
  const generic = prefs.font === 'sans' ? SANS_STACK : SERIF_STACK;
  return family?.css ? `"${family.css}", ${generic}` : generic;
}

export function fontFaceCss(origin: string): string {
  const out: string[] = [];
  for (const f of FAMILIES) {
    for (const face of f.faces) {
      out.push(
        `@font-face{font-family:"${f.css}";src:url("${origin}/fonts/${face.file}") format("truetype");` +
          `font-style:${face.italic ? 'italic' : 'normal'};font-weight:${face.weights};font-display:swap;}`,
      );
    }
  }
  return out.join('\n');
}

export interface PageGeometry {
  mode: 'scrolled' | 'paginated' | 'fixed';
  /** Iframe size in CSS px. */
  width: number;
  height: number;
  columns: number;
  /** Gap between columns; each page edge gets half. */
  gap: number;
  padTop: number;
  padBottom: number;
  /** Scrolled mode: horizontal padding and max text measure. */
  sidePad: number;
  measure: number;
}

/** Readium's page margin factor on mobile: 0.8 + marginScale * 0.6 (1.4 at Normal). */
export function marginFactor(prefs: ReaderPreferences): number {
  const scale = Number.isFinite(prefs.marginScale) ? prefs.marginScale : 1;
  return 0.8 + Math.min(Math.max(scale, 0.2), 3) * 0.6;
}

/**
 * Geometry for a container. The measure shrinks as margins grow (about 34em,
 * 65–75 characters, at Normal); paginated frames are capped at that measure
 * per column and centred, so wide screens never produce very long lines.
 */
export function computeGeometry(prefs: ReaderPreferences, width: number, height: number, fixed: boolean): PageGeometry {
  const factor = marginFactor(prefs);
  const fontSize = clampFont(prefs.fontSize);
  const measure = Math.round(((34 * 1.4) / factor) * fontSize);
  const sidePad = Math.round(Math.max(16, Math.min(width * 0.06, 22 * factor)));
  const padTop = Math.round(Math.min(64, Math.max(20, height * 0.045)));
  const padBottom = Math.round(padTop * 1.15);
  if (fixed) {
    return { mode: 'fixed', width, height, columns: 1, gap: 0, padTop: 0, padBottom: 0, sidePad: 0, measure };
  }
  if (prefs.flow !== 'paginated') {
    return { mode: 'scrolled', width, height, columns: 1, gap: 0, padTop: padTop + 8, padBottom: padBottom + 8, sidePad, measure };
  }
  const columns = width > 1000 ? 2 : 1;
  const gap = Math.round(Math.max(32, Math.min(width * 0.08, 30 * factor * (columns === 2 ? 1.6 : 1))));
  const maxWidth = columns * (measure + gap);
  return {
    mode: 'paginated',
    width: Math.max(200, Math.min(width, maxWidth)),
    height,
    columns,
    gap,
    padTop,
    padBottom,
    sidePad,
    measure,
  };
}

function clampFont(size: number): number {
  return Number.isFinite(size) ? Math.min(Math.max(size, 8), 72) : 18;
}

const NOT_MONO = ':not(code):not(kbd):not(samp):not(pre):not(tt):not(var):not(pre *):not(code *):not(math):not(math *)';

/**
 * The user stylesheet injected after the book's own styles. `rtl` is the
 * book's page progression: columns then run right to left. The multicol root
 * always gets an explicit direction, so a chapter's own `dir` only sets its
 * text direction (see the engine's `reader-dir`) and never reverses paging.
 */
export function preferencesCss(prefs: ReaderPreferences, colors: EngineColors, g: PageGeometry, rtl = false): string {
  const fontSize = clampFont(prefs.fontSize);
  const lineHeight = Number.isFinite(prefs.lineHeight) ? prefs.lineHeight : 1.6;
  const align = prefs.justify ? 'justify' : 'left';
  const hyphens = prefs.justify ? 'auto' : 'manual';
  const tints = Object.entries(colors.highlightTints)
    .map(([key, tint]) => `reader-hl[data-hl-color="${cssString(key)}"]{background-color:${tint} !important;}`)
    .join('\n');
  const fallbackTint = colors.highlightTints.yellow ?? 'rgba(255, 214, 10, 0.35)';

  const common = `
:root{color-scheme:${isDark(colors.paper) ? 'dark' : 'light'};background-color:${colors.paper} !important;
  -webkit-text-size-adjust:100%;text-size-adjust:100%;}
::selection{background-color:${colors.selection} !important;}
reader-hl[data-hl-id]{background-color:${fallbackTint} !important;color:inherit !important;border-radius:2px;
  -webkit-box-decoration-break:clone;box-decoration-break:clone;cursor:pointer;}
${tints}
::highlight(reader-flash){background-color:${colors.selection};}
[data-reader-ui]{all:initial;}
`;

  if (g.mode === 'fixed') {
    return `${common}
html,body{margin:0 !important;padding:0 !important;overflow:hidden !important;}
body{background-color:${colors.paper};}
`;
  }

  const typography = `
html{font-size:${fontSize}px !important;background-color:${colors.paper} !important;}
body{font-size:1rem !important;font-family:${resolveFontStack(prefs)} !important;color:${colors.ink} !important;
  background:${colors.paper} !important;line-height:${lineHeight} !important;
  overflow-wrap:break-word;font-kerning:normal;text-rendering:optimizeLegibility;}
body *${NOT_MONO}{font-family:inherit !important;}
body *{color:inherit !important;background-color:transparent !important;border-color:${colors.muted} !important;}
body :is(p, li, dd, dt, blockquote, div, td, th, figcaption, span, a, em, i, b, strong, cite, small, sup, sub){line-height:inherit !important;}
body, body p:not(blockquote p):not(figcaption p):not(header p):not(footer p), body li, body dd{
  text-align:${align} !important;-webkit-hyphens:${hyphens} !important;hyphens:${hyphens} !important;}
body a[href], body a[href] *{color:${colors.link} !important;text-decoration-color:${colors.link};}
body hr{background-color:${colors.muted} !important;border-color:${colors.muted} !important;}
body img, body svg, body video, body picture{background-color:transparent !important;}
body pre{white-space:pre-wrap !important;overflow-wrap:anywhere;}
body table{max-width:100%;}
body img, body video{max-width:100% !important;height:auto;box-sizing:border-box;}
body svg{max-width:100%;}
.reader-error{font-style:italic;color:${colors.muted} !important;text-align:center !important;margin-top:30vh !important;}
`;

  if (g.mode === 'scrolled') {
    return `${common}${typography}
html{overflow-x:hidden !important;overflow-y:auto !important;height:auto !important;column-count:auto !important;padding:0 !important;margin:0 !important;
  direction:ltr !important;}
body{box-sizing:content-box !important;max-width:${g.measure}px !important;margin:0 auto !important;
  padding:${g.padTop}px ${g.sidePad}px ${g.padBottom}px !important;min-height:0 !important;height:auto !important;}
[data-reader-ui].reader-next{display:block !important;margin:3.5em 0 1em !important;text-align:center !important;}
[data-reader-ui].reader-next > button{all:initial;cursor:pointer !important;display:inline-block !important;padding:10px 18px !important;
  border-radius:999px !important;border:1px solid ${colors.muted} !important;font-family:${SANS_STACK} !important;font-size:14px !important;
  font-weight:500 !important;line-height:1.4 !important;color:${colors.muted} !important;background:transparent !important;}
[data-reader-ui].reader-next > button:hover{color:${colors.ink} !important;border-color:${colors.ink} !important;}
[data-reader-ui].reader-next > button:focus-visible{outline:2px solid ${colors.link} !important;outline-offset:2px !important;}
`;
  }

  const contentHeight = Math.max(80, g.height - g.padTop - g.padBottom);
  return `${common}${typography}
html{height:${g.height}px !important;width:100% !important;max-width:none !important;overflow:hidden !important;margin:0 !important;
  position:static !important;transform:none !important;direction:${rtl ? 'rtl' : 'ltr'} !important;
  box-sizing:border-box !important;padding:${g.padTop}px ${g.gap / 2}px ${g.padBottom}px !important;
  column-count:${g.columns} !important;column-gap:${g.gap}px !important;column-fill:auto !important;column-rule:none !important;}
body{margin:0 !important;padding:0 !important;max-width:none !important;width:auto !important;height:auto !important;
  min-height:0 !important;overflow:visible !important;columns:auto !important;}
body img, body svg, body video{max-height:${Math.floor(contentHeight * 0.95)}px !important;object-fit:contain;break-inside:avoid;}
body :is(h1, h2, h3, h4, h5, h6){break-after:avoid;}
`;
}

function cssString(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

function isDark(color: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return true;
  let hex = m[1];
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128;
}
