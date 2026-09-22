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

The Readium Swift 3.9.0 resource lookup patch lives separately in ios/patches
and is applied by the app's Podfile, with XCTest equivalence coverage.
