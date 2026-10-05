import type { ReaderFont, ReaderPreferences } from './types';

/**
 * Reading typefaces, a port of `ReaderFonts` (apps/mobile/lib/core/typography).
 * Bundled files are served from `/fonts/<file>`, Libron from the R2-backed
 * `/cdn/` route; system families use the browser's generic serif or sans-serif.
 */

export interface ReaderFontFace {
  /** Same-origin path, e.g. `/fonts/Literata.ttf`. */
  url: string;
  italic: boolean;
  minWeight: number;
  maxWeight: number;
}

export interface ReaderFontFamily {
  /** Stable id persisted as `ReaderPreferences.fontFamilyId`. Never rename. */
  id: string;
  label: string;
  /** Written as the legacy `font` so older builds fall back to the same class. */
  fontClass: ReaderFont;
  description: string;
  /** CSS family name of a bundled family; null for system families. */
  cssFamily: string | null;
  faces: ReaderFontFace[];
  recommended: boolean;
}

const face = (url: string, minWeight: number, maxWeight: number, italic = false): ReaderFontFace => ({
  url,
  italic,
  minWeight,
  maxWeight,
});

export const systemSerif: ReaderFontFamily = {
  id: 'system-serif',
  label: 'System serif',
  fontClass: 'serif',
  description: "Your device's built-in serif.",
  cssFamily: null,
  faces: [],
  recommended: false,
};

export const systemSans: ReaderFontFamily = {
  id: 'system-sans',
  label: 'System sans',
  fontClass: 'sans',
  description: "Your device's built-in sans-serif.",
  cssFamily: null,
  faces: [],
  recommended: false,
};

/** The default reading face. Static Regular and Bold, each with an italic. */
export const libron: ReaderFontFamily = {
  id: 'libron',
  label: 'Libron',
  fontClass: 'serif',
  description: 'Calm, neutral book serif with small caps, made for reading.',
  cssFamily: 'Libron',
  faces: [
    face('/cdn/fonts/libron/v0.25/Libron-Regular.woff2', 400, 400),
    face('/cdn/fonts/libron/v0.25/Libron-Italic.woff2', 400, 400, true),
    face('/cdn/fonts/libron/v0.25/Libron-Bold.woff2', 700, 700),
    face('/cdn/fonts/libron/v0.25/Libron-BoldItalic.woff2', 700, 700, true),
  ],
  recommended: true,
};

export const literata: ReaderFontFamily = {
  id: 'literata',
  label: 'Literata',
  fontClass: 'serif',
  description: 'Book serif drawn for long reading on screens.',
  cssFamily: 'Literata',
  faces: [face('/fonts/Literata.ttf', 200, 900), face('/fonts/Literata-Italic.ttf', 200, 900, true)],
  recommended: false,
};

export const sourceSerif: ReaderFontFamily = {
  id: 'source-serif-4',
  label: 'Source Serif 4',
  fontClass: 'serif',
  description: 'Crisp transitional serif with optical sizes.',
  cssFamily: 'SourceSerif4',
  faces: [face('/fonts/SourceSerif4.ttf', 200, 900), face('/fonts/SourceSerif4-Italic.ttf', 200, 900, true)],
  recommended: false,
};

export const atkinson: ReaderFontFamily = {
  id: 'atkinson-hyperlegible-next',
  label: 'Atkinson Hyperlegible',
  fontClass: 'sans',
  description: 'Sans with distinct shapes for look-alike letters such as I, l and 1.',
  cssFamily: 'AtkinsonHyperlegibleNext',
  faces: [face('/fonts/AtkinsonHyperlegibleNext.ttf', 200, 800), face('/fonts/AtkinsonHyperlegibleNext-Italic.ttf', 200, 800, true)],
  recommended: false,
};

/** Lexend has no upstream italic; italic text is slanted by the renderer. */
export const lexend: ReaderFontFamily = {
  id: 'lexend',
  label: 'Lexend',
  fontClass: 'sans',
  description: 'Wide, open sans with roomy letter spacing.',
  cssFamily: 'Lexend',
  faces: [face('/fonts/Lexend.ttf', 100, 900)],
  recommended: false,
};

export const inter: ReaderFontFamily = {
  id: 'inter',
  label: 'Inter',
  fontClass: 'sans',
  description: 'Neutral sans, the same face as the app interface.',
  cssFamily: 'Inter',
  faces: [face('/fonts/Inter.ttf', 100, 900), face('/fonts/Inter-Italic.ttf', 100, 900, true)],
  recommended: false,
};

/** Picker order. */
export const readerFontFamilies: ReaderFontFamily[] = [libron, literata, sourceSerif, atkinson, lexend, inter, systemSerif, systemSans];

export const systemSerifStack = 'ui-serif, Georgia, "Times New Roman", serif';
export const systemSansStack = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function fontFamilyById(id: string | null | undefined): ReaderFontFamily | null {
  return readerFontFamilies.find((f) => f.id === id) ?? null;
}

/**
 * The family to render. A known id applies only while its class matches the
 * synced `font`; otherwise serif renders Libron and sans the system sans.
 */
export function resolveFontFamily(prefs: Pick<ReaderPreferences, 'font' | 'fontFamilyId'>): ReaderFontFamily {
  const chosen = fontFamilyById(prefs.fontFamilyId);
  if (chosen && chosen.fontClass === prefs.font) return chosen;
  return prefs.font === 'serif' ? libron : systemSans;
}

/** Preferences after choosing `family`: the id is always written. */
export function selectFontFamily(prefs: ReaderPreferences, family: ReaderFontFamily): ReaderPreferences {
  return { ...prefs, font: family.fontClass, fontFamilyId: family.id };
}

/** CSS `font-family` value for previews and the engine. */
export function fontStack(family: ReaderFontFamily): string {
  const generic = family.fontClass === 'serif' ? systemSerifStack : systemSansStack;
  return family.cssFamily ? `"${family.cssFamily}", ${generic}` : generic;
}

/** `@font-face` rules for every bundled family, for documents that need them (e.g. the book frame). */
export function fontFaceCss(origin = ''): string {
  return readerFontFamilies
    .flatMap((f) =>
      f.faces.map(
        (x) =>
          `@font-face{font-family:"${f.cssFamily}";src:url("${origin}${x.url}") format("${x.url.endsWith('.woff2') ? 'woff2' : 'truetype'}");` +
          `font-style:${x.italic ? 'italic' : 'normal'};font-weight:${x.minWeight} ${x.maxWeight};font-display:swap;}`,
      ),
    )
    .join('\n');
}

export const ReaderFonts = {
  all: readerFontFamilies,
  bundled: readerFontFamilies.filter((f) => f.cssFamily !== null),
  byId: fontFamilyById,
  resolve: resolveFontFamily,
  select: selectFontFamily,
  stack: fontStack,
};
