/**
 * Enhancer styles. Colours come from the theme through `--tr-*` custom
 * properties (the web engine sets them from the active preset; the mobile
 * bundle's `setTheme` does the same) and fall back to mixes of
 * `currentColor`, so they follow whatever text colour the reader applies
 * (ReadiumCSS included). Only syntax colours have a last-resort fallback
 * (the Default preset's hues blended toward the text) for hosts that set none.
 *
 * Every rule is prefixed with `:root:not(#tr-none)`: the `:not(#id)` adds an
 * id's specificity, enough to beat book CSS and the readers' own
 * `body *{color:inherit !important}` style resets without touching them.
 */

/** The bundled math font's family name; see `MATH_FONT_FILE`. */
export const MATH_FONT_FAMILY = 'TheReader Math';
/** A subset of STIX Two Math 2.13 (SIL OFL 1.1, see TheReaderMathOFL.txt) with its MATH table, served next to the stylesheet. */
export const MATH_FONT_FILE = 'TheReaderMath.woff2';

const P = ':root:not(#tr-none)';

const MATH_STACK = `"${MATH_FONT_FAMILY}", "STIX Two Math", "STIXTwoMath-Regular", "Latin Modern Math", "Cambria Math", "Noto Sans Math", math`;
const MONO_STACK = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", "Cascadia Mono", Consolas, "Roboto Mono", "Liberation Mono", monospace`;

/** Inside each formula's shadow root (temml's layout rules, trimmed). */
export const SHADOW_CSS = `
:host{color:inherit;position:relative;}
math{font-family:var(--tr-math-font, ${MATH_STACK});font-style:normal;font-weight:normal;line-height:normal;
  font-size-adjust:none;text-indent:0;text-transform:none;letter-spacing:normal;word-spacing:normal;word-wrap:normal;
  direction:ltr;color:inherit;font-feature-settings:"dtls" off;}
math *{border-color:currentColor;}
math.tml-display{display:block;}
/* temml's line wrapping; a rebuilt book formula (.tr-mml) keeps MathML layout and its operator spacing. */
@supports (not (-moz-appearance:none)){
  math:not(.tr-mml){display:inline-flex;flex-wrap:wrap;align-items:baseline;}
  math.tml-display, math.tr-mml[display="block"]{display:block math;}
  .tml-sml-pad{padding-left:0.05em;}
  .tml-med-pad{padding-left:0.10em;}
  .tml-lrg-pad{padding-left:0.15em;}
}
math > mrow{padding:0.25ex 0;}
.tml-right{text-align:right;text-align:-webkit-right;}
.tml-left{text-align:left;text-align:-webkit-left;}
mtable.tml-jot > mtr > mtd{padding-top:0.7ex;padding-bottom:0.7ex;}
mtable.tml-small mtd{padding-top:0.35ex;padding-bottom:0.35ex;}
/* Strikes (cancel, not) are absolutely positioned inside their enclosure. */
menclose, .menclose{display:inline-block;position:relative;padding:0.5ex 0;}
.tml-overline{padding:0.1em 0 0 0;border-top:0.065em solid;}
.tml-underline{padding:0 0 0.1em 0;border-bottom:0.065em solid;}
.tml-fbox{padding:3pt;border:1px solid;}
.tml-cancel{display:inline-block;position:absolute;left:0.5px;bottom:0;width:100%;height:100%;background-color:currentColor;}
.upstrike{clip-path:polygon(0.05em 100%,0em calc(100% - 0.05em),calc(100% - 0.05em) 0em,100% 0.05em);}
.downstrike{clip-path:polygon(0em 0.05em,0.05em 0em,100% calc(100% - 0.05em),calc(100% - 0.05em) 100%);}
.sout{clip-path:polygon(0em calc(55% + 0.0333em),0em calc(55% - 0.0333em),100% calc(55% - 0.0333em),100% calc(55% + 0.0333em));}
.tml-eqn::before{counter-increment:tmlEqnNo;content:"(" counter(tmlEqnNo) ")";}
`;

export interface EnhanceCssOptions {
  /** URL of the bundled math font; null leaves formulas to installed math fonts. */
  mathFontUrl: string | null;
}

/** Document-level stylesheet for every rule. */
export function enhanceCss({ mathFontUrl }: EnhanceCssOptions): string {
  const face = mathFontUrl
    ? `@font-face{font-family:"${MATH_FONT_FAMILY}";src:url("${mathFontUrl}") format("woff2");font-style:normal;font-weight:400;font-display:swap;}\n`
    : '';
  return `${face}
:root{
  --tr-math-font:${MATH_STACK};
  --tr-mono:${MONO_STACK};
}
${P} .tr-hidden, ${P} [class~="tr-hidden"]{display:none !important;}

/* ---- math (rules 1-3) */
${P} math{font-family:var(--tr-math-font) !important;font-style:normal !important;font-weight:normal !important;color:inherit !important;
  line-height:normal !important;text-indent:0 !important;letter-spacing:normal !important;word-spacing:normal !important;
  text-transform:none !important;direction:ltr;background-color:transparent !important;}
${P} math *{font-family:inherit !important;color:inherit !important;}
${P} .tr-math-scroll, ${P} .tr-math-display{display:block !important;max-width:100% !important;box-sizing:border-box !important;
  overflow-x:auto !important;overflow-y:hidden !important;margin:0.6em 0 !important;padding:0.15em 0 !important;
  text-align:center !important;text-indent:0 !important;break-inside:avoid;-webkit-overflow-scrolling:touch;}
${P} .tr-math-scroll > math{margin:0 auto;}
${P} .tr-math{display:inline;text-indent:0;color:inherit !important;font-style:normal !important;font-weight:normal !important;
  white-space:normal !important;background-color:transparent !important;}
${P} .tr-math-display{display:block !important;}
${P} .tr-switch-case{display:inline;}
/* MathML a library hid for screen readers (KaTeX, MathJax assistive MathML), shown in place of its rendering. */
${P} .tr-shown{position:static !important;clip:auto !important;clip-path:none !important;width:auto !important;height:auto !important;
  max-width:100% !important;overflow:visible !important;padding:0 !important;margin:0 !important;border:0 !important;opacity:1 !important;
  display:inline !important;top:auto !important;left:auto !important;line-height:normal !important;font-size:inherit !important;
  -webkit-user-select:text !important;user-select:text !important;}
${P} .tr-shown > math[display="block"], ${P} .tr-shown > .tr-math-scroll, ${P} .tr-shown > .tr-math-display{display:block !important;}

/* ---- code (rule 5) */
${P} pre{display:block !important;white-space:pre !important;word-break:normal !important;overflow-wrap:normal !important;
  word-wrap:normal !important;overflow-x:auto !important;overflow-y:hidden !important;tab-size:4;-moz-tab-size:4;
  font-family:var(--tr-mono) !important;font-size:0.82em !important;line-height:1.55 !important;font-style:normal !important;
  text-align:left !important;text-indent:0 !important;-webkit-hyphens:none !important;hyphens:none !important;
  direction:ltr !important;unicode-bidi:isolate;
  padding:0.85em 1em !important;margin:1em 0 !important;max-width:100% !important;box-sizing:border-box !important;
  border:1px solid var(--tr-border, color-mix(in srgb, currentColor 16%, transparent)) !important;border-radius:6px !important;
  background-color:var(--tr-panel, color-mix(in srgb, currentColor 7%, transparent)) !important;color:inherit !important;
  break-inside:avoid;-webkit-overflow-scrolling:touch;}
${P} pre *{font-family:inherit !important;font-size:inherit !important;line-height:inherit !important;white-space:inherit !important;
  word-break:inherit !important;overflow-wrap:inherit !important;background-color:transparent !important;}
${P} pre code{display:inline !important;padding:0 !important;margin:0 !important;border:0 !important;border-radius:0 !important;}
${P} pre.tr-wrap{white-space:pre-wrap !important;overflow-wrap:anywhere !important;word-wrap:anywhere !important;
  overflow-x:visible !important;overflow-y:visible !important;break-inside:auto;}
${P} :not(pre) > :is(code, kbd, samp, tt){font-family:var(--tr-mono) !important;font-size:0.88em !important;font-style:normal !important;
  padding:0.08em 0.32em !important;border-radius:4px !important;overflow-wrap:anywhere;
  background-color:var(--tr-panel, color-mix(in srgb, currentColor 9%, transparent)) !important;
  -webkit-box-decoration-break:clone;box-decoration-break:clone;}
${P} :is(h1, h2, h3, h4, h5, h6, a) > :is(code, tt){background-color:transparent !important;padding:0 !important;font-size:0.95em !important;}
${P} .hljs-comment, ${P} .hljs-quote{color:var(--tr-syn-comment, color-mix(in srgb, currentColor 55%, transparent)) !important;font-style:italic !important;}
${P} :is(.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-operator){color:var(--tr-syn-keyword, color-mix(in srgb, #c472fb 80%, currentColor)) !important;}
${P} :is(.hljs-string, .hljs-regexp, .hljs-char) {color:var(--tr-syn-string, color-mix(in srgb, #62c073 80%, currentColor)) !important;}
${P} :is(.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet, .hljs-link){color:var(--tr-syn-number, color-mix(in srgb, #ff9907 80%, currentColor)) !important;}
${P} :is(.hljs-title, .hljs-section, .hljs-function){color:var(--tr-syn-title, color-mix(in srgb, #52a8ff 80%, currentColor)) !important;}
${P} :is(.hljs-type, .hljs-built_in, .hljs-class){color:var(--tr-syn-type, color-mix(in srgb, #1da9b0 80%, currentColor)) !important;}
${P} :is(.hljs-attr, .hljs-attribute, .hljs-property, .hljs-variable, .hljs-template-variable, .hljs-params){color:var(--tr-syn-attr, color-mix(in srgb, #52a8ff 80%, currentColor)) !important;}
${P} :is(.hljs-tag, .hljs-name, .hljs-selector-id, .hljs-selector-class, .hljs-meta){color:var(--tr-syn-tag, color-mix(in srgb, #f75f8f 80%, currentColor)) !important;}
${P} .hljs-addition{color:var(--tr-syn-string, color-mix(in srgb, #62c073 80%, currentColor)) !important;}
${P} .hljs-deletion{color:var(--tr-syn-tag, color-mix(in srgb, #f75f8f 80%, currentColor)) !important;}
${P} .hljs-emphasis{font-style:italic !important;}
${P} .hljs-strong{font-weight:700 !important;}

/* ---- tables (rule 6) */
${P} .tr-table-scroll{display:block !important;max-width:100% !important;overflow-x:auto !important;overflow-y:hidden !important;
  margin:1em 0 !important;break-inside:avoid;-webkit-overflow-scrolling:touch;}
${P} .tr-table-scroll > table{margin:0 !important;max-width:none !important;}
${P} .tr-table-scroll.tr-wrap{overflow:visible !important;break-inside:auto;}
${P} .tr-table-scroll.tr-wrap > table{table-layout:fixed !important;width:100% !important;max-width:100% !important;overflow-wrap:anywhere;}

/* ---- dark-ink images (rule 4) */
${P} :is(img, image).tr-ink{filter:invert(1) hue-rotate(180deg) !important;}
/* Black on white: the white turns black and screens into whatever the page colour is. */
${P} img.tr-ink-paper{filter:invert(1) hue-rotate(180deg) !important;mix-blend-mode:screen;background-color:transparent !important;}
${P} svg.tr-svg-ink{background-color:transparent !important;}

/* ---- PDF conversions (rule 7) */
${P} .tr-pdf-neutral{font-style:normal !important;font-weight:normal !important;text-decoration:none !important;}
${P} .tr-pdf-hidden{display:block !important;height:0 !important;min-height:0 !important;margin:0 !important;padding:0 !important;
  border:0 !important;overflow:hidden !important;font-size:0 !important;line-height:0 !important;}
${P} .tr-pdf-para{display:block !important;margin:0.85em 0 !important;padding:0 !important;}
${P} .tr-pdf-para > *{display:inline !important;margin:0 !important;padding:0 !important;text-indent:0 !important;}
${P} .tr-pdf-para > :not(:last-child):not(.tr-pdf-hidden):not(.tr-pdf-hyphen)::after{content:" ";}
/* Out of flow, so the spaces around a collapsed header merge into one; the page anchor keeps a position. */
${P} .tr-pdf-para > .tr-pdf-hidden{position:absolute !important;width:0 !important;}
${P} .tr-pdf-label{font-weight:700 !important;margin:1.4em 0 0.15em !important;break-after:avoid;}
${P} .tr-pdf-title{font-weight:700 !important;margin:0 0 0.6em !important;break-after:avoid;}
`;
}

/** Theme roles the stylesheet reads; hosts pass their active preset. */
export interface EnhanceTheme {
  panel?: string;
  border?: string;
  subtle?: string;
  blue?: string;
  purple?: string;
  green?: string;
  orange?: string;
  pink?: string;
  cyan?: string;
}

/** `--tr-*` declarations for a theme (no selector). */
export function themeDeclarations(t: EnhanceTheme): string {
  const out: string[] = [];
  const put = (name: string, value: string | undefined) => {
    if (value && /^[#\w(),.%\s-]+$/.test(value)) out.push(`--tr-${name}:${value};`);
  };
  put('panel', t.panel);
  put('border', t.border);
  put('syn-comment', t.subtle);
  put('syn-keyword', t.purple);
  put('syn-string', t.green);
  put('syn-number', t.orange);
  put('syn-title', t.blue);
  put('syn-type', t.cyan);
  put('syn-attr', t.blue);
  put('syn-tag', t.pink);
  return out.join('');
}
