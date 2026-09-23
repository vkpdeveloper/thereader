# Local Readium wrapper

Source: flutter_readium 0.3.3 from pub.dev, copied from the resolved package.
The upstream license is in LICENSE. This app uses native EPUB reading only.

Local changes:
- App-owned `http://127.0.0.1` EPUBs use a bounded streaming ZIP opener on
  Android, with an exact-range resource and a 65,557-byte tail cache. The small
  archive whole-file cache is disabled for these URLs. Ordinary remote URLs
  keep the upstream policy. The adapted Readium 3.2.0 streaming classes and BSD
  license are under `android/.../progressive/`.
- iOS loopback ZIP policy is patched reproducibly by
  `ios/patches/readium_progressive_zip.rb`: tail-only cache and 64 KB read-ahead,
  leaving local Minizip and ordinary HTTP behavior unchanged.
- Android platform-view disposal is idempotent and closes the shared navigator
  only while that view still owns it; late teardown cannot remove a newer reader.
- Android publication parser disables PDF support; the app excludes PDFium
  native libraries. Kotlin adapter classes remain compile dependencies; no PDF
  parsing or PDF navigation is exposed by the EPUB-only app.
- iOS method channel captures its reader weakly and unregisters on dispose,
  breaking a retained reader/WebView graph across repeated opens.
- Shared native helper CSS gives publisher images a light backing on the black
  canvas, preserving their original colors. Explicit MathJax/inline/display math
  wrappers invert monochrome equation images so transparent black formulas remain
  readable; ordinary covers/photos are never inverted.
- Theme enforcement (docs/reader-typography.md): a THEREADER PATCH block in
  `assets/helpers/flutterReadiumTools.css` applies the reader theme's ink to
  text, headings, captions and borders at three-ID specificity. It keys off
  `--USER__textColor` / `--USER__backgroundColor`, so live preference changes
  need no script. Decorations, the TTS spotlight and media are excluded. The
  new tracked `assets/helpers/thereaderTheme.js` demotes inline `!important`
  colours once per document. iOS injects it as a document-end user script in
  `EPUBReaderView+JSBridge.swift`; Android injects it as a head `<script>` in
  `ReadiumExtensions.kt`.
- Host fonts: the `fontFamilies` creation param (accepted by all three
  `ReadiumReaderWidget` variants) lists the app's bundled fonts.
  `HostFontFamilies.kt` and `HostFontFamilies.swift` validate those entries
  and declare them to the navigator as `@font-face` families.
  - Android declares the fonts in the `EpubReaderFragment` configuration and
    serves them on the publication origin, at
    `https://readium_package/__thereader_fonts/<file>`. `HostFontContainer`
    wraps EPUB containers in `ReadiumReader.assetToPublication` and answers
    only files of currently declared faces, from `flutter_assets/assets/fonts/`.
    Readium's `readium_assets` origin is not used: its asset loader sends no
    CORS headers, so Chromium blocked the faces (`@font-face` status error).
    WebView security settings are unchanged.
  - iOS appends the declarations to `config.fontFamilyDeclarations` in
    `EPUBReaderView.swift`.
  - Faces load offline and only when used.
- iOS clears the text selection after a custom selection action fires
  (`EPUBReaderView+Selection.swift`), matching Android's `ActionMode.finish()`.
  Without it, a new highlight stays selected under the system menu.
- iOS `goToProgression` animates and ignores the current locator's text
  anchor, which Readium otherwise prefers over the progression
  (`FlutterReadiumPlugin.swift`, `EPUBReaderView+Navigation.swift`). In scroll
  mode a jump to 0 smooth-scrolls with `window.scrollTo`, since Readium sets
  that offset without animation. Android is unchanged and jumps at once.

The Readium Swift 3.9.0 resource lookup patch lives separately in ios/patches
and is applied by the app's Podfile, with XCTest equivalence coverage.
