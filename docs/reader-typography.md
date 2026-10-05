# Reader typography and theme enforcement

## Fonts

The picker (`lib/features/reader/reader_font_picker.dart`) lists the catalogue
in `lib/core/typography/reader_fonts.dart`. Each name is set in its own face,
and a live sample of the current choice sits above the list. Choices apply
immediately.

| id | Label | Class | Files (SHA-256 prefix) | Source |
|---|---|---|---|---|
| `libron` (Recommended, default) | Libron | serif | `Libron-Regular.ttf` 18995ba8, `-Italic` 1c229bfc, `-Bold` 0258c7de, `-BoldItalic` cd346608 | nicoverbruggen/libron v0.25 (46cf11c8), `Libron.zip` |
| `literata` | Literata | serif | `Literata.ttf` b41138c9, `-Italic` d483dfae | google/fonts OFL (already bundled) |
| `source-serif-4` | Source Serif 4 | serif | `SourceSerif4.ttf` 97b2d4da, `-Italic` 15fbc7e4 | adobe-fonts/source-serif b3980ade, via google/fonts e44c4b0 |
| `atkinson-hyperlegible-next` | Atkinson Hyperlegible | sans | `AtkinsonHyperlegibleNext.ttf` 5a455d1c, `-Italic` ce9cffed | googlefonts/atkinson-hyperlegible-next 7925f50f, via google/fonts e44c4b0 |
| `lexend` | Lexend | sans | `Lexend.ttf` 3add53e6 | googlefonts/lexend 20491885, via google/fonts e44c4b0 |
| `inter` | Inter | sans | `Inter.ttf` 29160a80, `-Italic` acd98e64 | google/fonts OFL (already bundled, app UI face) |
| `system-serif` | System serif | serif | none | platform generic `serif` |
| `system-sans` | System sans | sans | none | platform generic `sans-serif` |

- Libron ships static Regular, Italic, Bold and Bold Italic files; every
  other bundled family is a variable TTF. All are under the SIL Open Font
  License 1.1. The
  license text sits next to each file (`assets/fonts/<Family>OFL.txt`) and is
  listed as an asset in `pubspec.yaml`.
- The license files are verbatim upstream copies. Line 21 ends in a trailing
  space, which `git diff --check` flags. It is left in place because the OFL
  forbids changing the license document, and the committed Inter and Literata
  copies have the same space.
- Lexend's license names the Reserved Font Name "RevReading Lexend". The file
  ships unmodified under its upstream name.
- Lexend has no upstream italic, so the renderer slants its italics.
- Descriptions are neutral. Do not add claims about reading speed or medical
  benefit.
- Fonts are offline, and WebViews load faces lazily. Each native navigator
  declares the bundled families as `@font-face` rules, pointing at the Flutter
  asset bundle (see `vendor/flutter_readium/THEREADER.md`). A WebView only
  fetches a face when the chosen family is used.
  - Android serves the faces on the book's own origin
    (`https://readium_package/__thereader_fonts/<file>`). Font loads are CORS
    requests, and Readium's `readium_assets` origin sends no CORS headers, so
    faces served from there fail with `@font-face` status `error`.
  - Only files of declared faces are answered. WebView security settings are
    not relaxed.
- Readium's `fontFamily` preference always receives one declared name:
  `serif`, `sans-serif` or a bundled `cssFamily`. It never receives a list.
- Bold and italic come from the variable weight axis and the italic files
  (Libron: its static 400 and 700 faces).
  Code keeps the publisher's or ReadiumCSS monospace.

### Sync schema and compatibility

Older clients decode `font` with `ReaderFont.values.byName`, which accepts
only `serif` or `sans`. The design keeps them working:

- `font` stays `serif` or `sans`. Choosing a family always writes that
  family's class.
- The new optional `fontFamilyId` holds the chosen id. The API validates it
  as a slug (`^[a-z0-9][a-z0-9-]{0,63}$`) rather than an enum, so ids from
  newer clients are accepted. `null` is rejected.
- The D1 `json_patch` merge keeps keys that a client omits. An older client
  syncing only `font` therefore leaves `fontFamilyId` intact, the same way
  `themeId` is kept.
- `ReaderFonts.resolve` applies a known id only while its class matches
  `font`. If an older build switches serif to sans, that change wins, and the
  reader shows the system family of the new class.
- An unknown id, from a future build, falls back to the default of `font`:
  Libron for serif, the system sans for sans. The id is still kept in local
  JSON so it can round-trip.
- Users with no id read Libron (serif) or the system sans. Choosing System
  serif writes `system-serif`, which is kept.
- The Dart fallback engine now renders legacy `serif` as system serif. It
  used to render Literata, which did not match native.

## Theme enforcement

Problem: publisher CSS paints headings, captions and boxes in fixed colours,
for example navy `#content h2`. ReadiumCSS forces `color: inherit` at
specificity (0,2,7), but it excludes h1–h6 and `pre`, so those colours
override the theme ink.

Native fix, in both WebViews (`vendor/flutter_readium/assets/helpers/`):

1. `flutterReadiumTools.css` → THEREADER PATCH block.
   - Colour rules are boosted with
     `:not(#tr-a):not(#tr-b):not(#tr-c)`, three IDs, to outrank realistic
     publisher selectors.
   - They are gated on `:root[style*="--USER__textColor"]` or
     `--USER__backgroundColor`.
   - Because Readium updates those variables on `:root` for every
     preference change, live theme switches apply to open pages. They also
     apply to later chapters, in both paginated and scrolled modes, with no
     extra script.
   - Declarations:
     - Text, `-webkit-text-fill-color` and pseudo-elements inherit the ink.
     - Borders use ink at 30% (`color-mix`).
     - Text shadows are removed. A glow tuned for white paper smears on a
       dark preset.
     - Backgrounds of `body` and every non-media element become
       transparent. Background images are kept, because CSS cannot tell a
       gradient from artwork, and a `url()` background may be content.
     - `pre` gets a 7% ink panel.
     - Links become ink with an underline.
   - Excluded from the rules: Readium decorations (`[id^="r2-decoration-"]`,
     for highlights and TTS), the TTS spotlight state, and
     img/svg/video/canvas/picture/object/embed/iframe/math.
   - Image pixels are untouched, and no font, weight, style or layout
     property is set.
2. `thereaderTheme.js` demotes inline `!important` colour properties once per
   document, when the DOM has been parsed. The properties are colour,
   background, border, outline, decoration colours and `text-shadow`.
   - It removes only the priority and keeps the value, so the boosted
     stylesheet wins. There is no observer, rAF or timer.
   - It starts at `<html>` itself, so inline `!important` colours on `html`
     and `body` are covered. Readium's `--USER__` variables are never
     touched.
   - Like the CSS, it skips decorations, the spotlight, and artwork: SVG,
     MathML, img/video/canvas/picture/object/embed/iframe and all their
     descendants.
   - iOS injects it as a `WKUserScript` at document end.
   - Android injects it as a `<script>` tag after the helper CSS.

Dart fallback engine (`dart_reader_view.dart`):
- `prepareHtml` strips `<style>`, `<script>` and the presentational attributes
  `style`, `color`, `bgcolor`, `text`, `link`, `vlink` and `alink`.
  - It only touches start tags, so code text that looks like attributes
    survives.
  - Inline SVG and MathML are left untouched. The core HTML widget does not
    render inline SVG today.
- `stylesFor` paints h1–h6, captions, `th`/`td` and code in ink.

### Regression proof

- `test/fixtures/publisher_colors.xhtml` is a synthetic chapter. It
  reproduces the book's patterns:
  - ID-scoped heading and caption colours;
  - an inline `!important` colour and single-quoted styles;
  - `<font color>`;
  - a `pre` background and black cell borders;
  - a code line containing `color="red"`;
  - inline `!important` colours on `html` and `body`, and a `text-shadow`;
  - an inline SVG and a MathML formula whose inline `!important` colours
    must survive.
- `test/reader_typography_test.dart` checks:
  - the boosted selectors outrank every fixture selector;
  - no heading or `pre` is excluded;
  - the decoration, spotlight and media exclusions are present;
  - no layout or font properties are set;
  - the JS is one-shot and injected on both platforms;
  - the real `thereaderTheme.js` runs in Node against a DOM built from the
    fixture (`test/support/theme_dom_harness.cjs`). The harness adds
    Readium's `--USER__` variables and a highlight layer. It asserts that
    html, body and paragraph colours are demoted, that SVG, MathML and
    decorations keep `!important`, and that a rerun demotes nothing. The
    test is skipped when `node` is missing;
  - Dart stripping and ink styles;
  - Android font sources are absolute package-origin URLs, served only for
    declared faces, with no CORS or WebView security relaxation.
- No book content or images are committed.

### Caveats

- Borders that a publisher made transparent on purpose now show as faint
  ink.
- Complex `:not()` lists need Chrome 88+ or Safari 9+. `color-mix` needs
  Chrome 111+ or Safari 16.2+.
  - Older engines drop the rule and keep the previous behaviour.
  - Without `color-mix`, borders fall back to `currentColor` and the `pre`
    panel is transparent.
- Link colour now matches the text, and the underline keeps links
  distinguishable.
- While the TTS spotlight is active, the plugin's own dimming rules take
  precedence.
- Inline colours added by script after load keep `!important`. The demotion
  runs only once per document.
- Background-image gradients on text boxes are kept. None were found in the
  test book.

## Native verification (root)

1. Open "Build a Large Language Model From Scratch", chapter 4, on the
   iPhone 17 simulator and on Android with the Gruvbox theme. Headings,
   figure and listing captions, table text and borders should use Gruvbox
   ink. Images should look unchanged, and code should stay monospace.
2. Switch between themes while the chapter is open, in paginated mode and
   then in scrolled mode. Every page should restyle without a reload. The
   next chapter should also load already themed.
3. Check that highlights and TTS highlights and spotlight keep their
   colours.
4. Choose each font in the picker. The page should re-render in that face,
   with bold, italic and code intact. Repeat in airplane mode.
   - On Android, check through WebView DevTools that every face of the
     chosen family reports `document.fonts` status `loaded`, with no CORS
     error in the log. A visually similar fallback does not count.
5. Use a local test account only, and never your real cloud reading
   position.

## Web delivery of Libron

The web app does not bundle Libron. The WOFF2 faces from `Libron_Web.zip` live
in `apps/api/cdn/fonts/libron/v0.25/` and are uploaded to the `thereader-cdn`
R2 bucket by `bun run cdn:publish` (also part of `bun run deploy`). The Worker
serves them same-origin at `/cdn/<key>`:

- `Cache-Control: public, max-age=31536000, immutable`, so a browser never
  revalidates a face once it has it. Keys are versioned; publish new bytes
  under a new version path, never over an existing key.
- The first request in each Cloudflare data centre reads R2 and stores the
  response in that edge's cache; later requests there skip R2.
- The service worker treats `/cdn/*` like `/fonts/*`: cache first, and
  precached on install because `index.css` declares the faces.
- Same origin means no extra DNS or TLS handshake and no CORS, and the book
  frame's `font-src` already allows it.
