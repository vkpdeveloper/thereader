# Reader engines

The UI depends on `ReaderEngine`, `ReaderController`, and optional `ReaderSearch`
interfaces in `lib/reader/engine/reader_engine.dart`.

| Engine | Targets | Behavior |
| --- | --- | --- |
| Native Readium | iOS, Android | Default; publication CSS, images, native text layout, search, TOC and exact native locators. |
| Dart EPUB | iOS, Android, browser preview | Reduced-fidelity fallback; scrolled chapter rendering, stripped publisher styles, no native publication search. |

The engine preference is a development setting (`--dart-define=THEREADER_ENGINE=dart|readium`),
not a primary product control. If native opening fails, the reader tries the Dart
engine and explicitly reports the fallback. A fallback does not establish native
compatibility or large-book performance.

## Native integration

`vendor/flutter_readium` pins the source of 0.3.3 with its upstream license and
`THEREADER.md` patch notes. It uses Swift Readium 3.9.0 and Kotlin Readium 3.2.0.
This version supports Flutter 3.41.6; later wrapper releases require a newer Flutter.
The native publication is opened from a verified durable path. Native locator JSON
is retained and restored; generic fallback locators use href plus progression.

DRM-free `.mobi` books are converted on device, off the UI isolate, into an EPUB
before the existing checksum, durable storage, upload and reader pipeline runs.
The converter preserves KF8 XHTML, styles, images, SVG and fonts, and repairs
legacy MOBI HTML and chapter links. MOBI imports are capped at 64 MiB because
conversion materializes the input and output; direct EPUB imports retain their
512 MiB streaming limit. Encrypted MOBI files are unsupported. The converter
uses `kindle_unpack` 0.2.0 (GPL-3.0), which must be considered when distributing
the app.

Reading preferences set the exact black background and off-white text, generic
`serif`/`sans-serif` families, size, leading, margins, justification, and flow.
The Flutter UI uses bundled Literata/Inter; native book text uses platform font
families, not a comma-separated font list. Serif/Sans changes were visually checked
on both native targets. Transparent publisher images receive a light backing;
explicit monochrome math-image wrappers are selectively inverted for dark reading.
Photos and covers retain their original colors.

Native search uses Readium's publication search, returns snippets and locators,
and navigates to the selected match. No service or account is involved.

The iOS method channel uses a weak reader capture and is unregistered on disposal.
Closing is serialized with the next open; a close error cannot poison later opens.
Progress flushes on inactive/paused lifecycle events as well as close. Archive/file
owners are closed on success, failure and fallback disposal.

The tracked `ios/patches/readium_href_index.rb` is applied by CocoaPods. It indexes
publication hrefs once rather than normalizing/scanning all resources for each
image request. The index preserves exact-first/fallback and depth-first semantics,
and rebuilds on manifest mutation. RunnerTests exercise equivalence and measure
the same synthetic lookup workload before/after.

Android disables PDF parsing and excludes PDFium native libraries. Some upstream
PDF/audio adapter classes and iOS modules remain dependencies; the app only accepts
EPUBs and exposes neither PDF nor audio features. See the verification report for
release artifact sizes instead of comparing a debug APK with a release APK.

## Verification and limits

See [native verification](../../../docs/native-verification.md) for real-corpus
tests, recorded sessions, memory diagnostics, release builds and reproducible commands.
Native text-selection handles were observed on iOS, but the Copy context menu was
not reliably observed in automation; clipboard behavior is not signed off.
Cross-engine locator fidelity on arbitrary large books is also not qualified.

The Dart engine indexes ZIPs from disk on native and inflates entries on demand.
It parses EPUB 2 NCX / EPUB 3 navigation, renders one column per spine document,
and closes its archive stream on disposal. Very long chapters and complex publisher
CSS are a limitation of this fallback; the real-corpus performance results are
from native Readium only.
