# Local Readium wrapper

Source: flutter_readium 0.3.3 from pub.dev, copied from the resolved package.
The upstream license is in LICENSE. This app uses native EPUB reading only.

Local changes:
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
