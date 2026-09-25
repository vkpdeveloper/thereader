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
- `ReadiumReaderWidget` passes `onExternalLinkActivated` to its channel, which
  upstream never did (`lib/reader_widget.dart`). iOS also emits `mailto:` and
  `tel:` links, not only http(s) (`EPUBReaderView.swift`). The app opens them.
- Android `findAllCssSelectors` (`ReadiumExtensions.kt`) parses a chapter once
  with jsoup and lists the `#id` of every element in document order. It feeds
  the ToC title on each locator, including the first one, and the reader stays
  covered until that first locator arrives. Upstream walked Readium's content
  iterator, whose jsoup `Element.cssSelector()` re-selects the whole document
  for every element. On a 1.5 MB maths chapter that took about a minute, and
  the book showed a blank page. A synthetic 4,000-section chapter now takes
  about 50 ms instead of about 19 s (`FindAllCssSelectorsTest`). jsoup 1.22.2,
  already a runtime dependency of readium-shared, is now a compile dependency.
  In `epubEnrichLocatorWithTocHref`, a path selector with no exact match
  falls back to its leading `#id` ancestor. iOS uses Readium Swift's own
  content service and did not reproduce the problem, so it is unchanged.
- Text selection on Android (`lib/reader_widget.dart`, `ReadiumReaderWidget.kt`,
  `SelectionActionConfig.kt`, `EpubReaderFragment.kt`):
  - The widget's tap `Listener` no longer treats a stationary press held for
    `kLongPressTimeout` or longer as a centre tap (`isReaderTap`). A long press
    selects text; it must not toggle the controls. The app also stopped wrapping
    the view in a `GestureDetector`. On Android that tap recognizer held the
    gesture arena through a long press, so the WebView never got the touch and
    no text could be selected.
  - `selectionActions` is read from the creation params. The navigator is
    created in the widget's `init` and picks its ActionMode callback then;
    Dart's `configureSelectionActions` call arrives too late, so the first book
    after launch showed no Highlight action.
  - After a custom action fires, the selection is cleared
    (`SelectableNavigator.clearSelection()`). `ActionMode.finish()` alone left
    the selection and handles over the new highlight. iOS already did this.
- `ClosedArchiveGuard` wraps every publication container
  (`ReadiumReader.assetToPublication`). Closing a book closes the EPUB's
  `ZipFile` while the WebView may still be loading chapter resources.
  Readium's `FileZipContainer` maps only `IOException`, so the
  `IllegalStateException: zip file closed` escaped on a Chromium thread and
  killed the app as the reader closed. That reproduced with a slow,
  image-heavy chapter. Such reads now return a `ReadError`, which the WebView
  sees as a failed request. `CancellationException` still propagates
  (`ClosedArchiveGuardTest`).
- `ResourceFileCache.purgeAll` returns when the plugin has no application.
  `detach()` runs from both `onDetachedFromActivity` and
  `onDetachedFromEngine`, and the second run threw
  `Application not initialized` from `onDestroy`, crashing the app on exit.

The Readium Swift 3.9.0 resource lookup patch lives separately in ios/patches
and is applied by the app's Podfile, with XCTest equivalence coverage.

Opening-performance follow-up (see `docs/book-opening-performance.md` at the
repository root):
- `PublicationHrefIndex` replaces repeated resource-list scans in Android's
  WebView server. The app's `android/buildSrc` visitor redirects its three calls
  through AGP's supported instrumentation API and fails on upstream drift.
  Exact/fallback URL semantics and precedence have equivalence coverage.
- The Android resource transform builds ToC IDs only for HTML, not for images
  and fonts. A preloaded neighbor's ready notification no longer marks the
  current page as visible; its own page callback does.
- The Dart controller applies preferences at native-view creation and replays
  only changes made during loading, avoiding a redundant layout at first paint
  on both Android and iOS.
- iOS discards stale asynchronous locator enrichment after a newer page event,
  preventing a late startup update from overwriting the restored progression.
