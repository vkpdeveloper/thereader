/**
 * Builds the mobile reader's content enhancer from the web sources:
 *
 *   apps/mobile/assets/reader/enhance.js   self-executing bundle (temml + a highlight.js subset)
 *   apps/mobile/assets/reader/enhance.css  stylesheet, font URL relative to itself
 *   apps/mobile/assets/reader/TheReaderMath.woff2 (+ OFL) copied from apps/web/public/fonts
 *
 * Run from apps/web: `bun run build:enhance`. The output is committed; rebuild
 * and bump ENHANCE_VERSION (src/reader/enhance/index.ts) whenever the rules,
 * styles or libraries change.
 *
 * The math font is a subset of STIX Two Math 2.13 (SIL OFL 1.1) that keeps the
 * OpenType MATH table, made with fonttools:
 *   pyftsubset STIXTwoMath-Regular.otf --layout-features='*' --no-hinting --desubroutinize --flavor=woff2 \
 *     --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0237,U+02C6-02DD,U+0300-036F,U+0370-03FF,U+2000-206F,U+2070-209F,U+20D0-20FF,U+2100-218F,U+2190-23FF,U+25A0-25FF,U+27C0-27FF,U+2900-2AFF,U+3008-3009,U+1D400-1D7FF" \
 *     --output-file=TheReaderMath.woff2
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enhanceCss, MATH_FONT_FILE } from '../src/reader/enhance/css';
import { ENHANCE_VERSION } from '../src/reader/enhance/index';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(web, '..', 'mobile', 'assets', 'reader');
mkdirSync(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(web, 'src/reader/enhance/bundle.ts')],
  format: 'iife',
  target: 'browser',
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const js = await result.outputs[0].text();

const header = (comment: string) =>
  `/* The Reader content enhancer v${ENHANCE_VERSION}. ${comment}\n` +
  ` * GENERATED from apps/web/src/reader/enhance by \`cd apps/web && bun run build:enhance\`; do not edit.\n` +
  ` * Includes temml (MIT) and highlight.js (BSD-3-Clause). */\n`;

writeFileSync(join(out, 'enhance.js'), header('Exposes globalThis.TheReaderEnhance = { version, enhance, setTheme }.') + js);
writeFileSync(join(out, 'enhance.css'), header(`Pair with enhance.js; ${MATH_FONT_FILE} sits next to this file.`) + enhanceCss({ mathFontUrl: MATH_FONT_FILE }).trim() + '\n');
copyFileSync(join(web, 'public/fonts', MATH_FONT_FILE), join(out, MATH_FONT_FILE));
copyFileSync(join(web, 'public/fonts/TheReaderMathOFL.txt'), join(out, 'TheReaderMathOFL.txt'));
console.log(`enhance v${ENHANCE_VERSION}: enhance.js ${(js.length / 1024).toFixed(0)} KiB -> ${out}`);
