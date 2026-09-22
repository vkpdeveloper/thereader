# Reader engine status

The reading surface is built behind `lib/reader/engine/reader_engine.dart`
(`ReaderEngine`, `ReaderController`, `ReaderService`). UI code never imports
an engine directly. Two engines are compiled in:

| Engine | Where | Status |
| --- | --- | --- |
| `ReadiumReaderEngine` (`lib/reader/readium_engine/`) | iOS, Android | Native Readium through `flutter_readium` 0.3.3 (swift-toolkit 3.9.0, kotlin-toolkit 3.2.0). Preferred by default. Unavailable on web (JS bundle not shipped). |
| `DartReaderEngine` (`lib/reader/dart_engine/`) | iOS, Android, web | Built-in pure-Dart EPUB engine. Fallback on native, the only engine in the browser preview. |

Settings lets the user pick the preferred engine. `ReaderService.candidates`
orders the available engines by that preference; the reader tries them in
order and, if the preferred engine throws while opening a book, falls back to
the next one and shows a snackbar saying which engine is in use.
`--dart-define=THEREADER_ENGINE=dart|readium` forces the preference (used by
the integration walkthrough).

## Readium adapter

- Opens the durable file by path (`FlutterReadium.openPublication`).
- Maps `Locator` events to `ReadingLocator` (href, progression,
  totalProgression, title) and keeps the Readium JSON in `raw` so the exact
  position is restored. Locators written by the Dart engine (href + fraction)
  are translated back via the publication's reading order.
- Applies `ReaderPreferences` with `EPUBPreferences`: background `#000000`,
  text `#ededed`, Literata/Inter, size ratio, line height, page margins,
  justification, scrolled vs paginated, publisher styles off.
- Native requirements already applied: Android `minSdk 24`, core library
  desugaring, `FlutterFragmentActivity`; iOS deployment target 15 and the six
  Readium pods in `ios/Podfile`.

Why 0.3.3: `flutter_readium` 0.4.0 through 0.6.0 declare `flutter >= 3.44.8`;
the machine has 3.41.6 and a global upgrade was out of scope. 0.3.3 declares
`>= 3.32.0`. Scratch-project probes on 2026-09-22 built a debug APK and an
unsigned iOS device app with it. The wrapper also pulls Readium's PDF and
audio modules, which inflates the Android debug APK (about 170 MB debug in
the probe); trimming those is a follow-up for the integration pass.

Verified on the iPhone 17 (iOS 26.5) simulator on 2026-09-22: the Readium
view opens the sample EPUB on a black canvas, paginates, restores position,
navigates by contents, and the app chrome toggles from Readium's tap signal.

Not yet verified: whether Readium honours the comma-separated
`fontFamily` fallback list (the page still looked serif after choosing Sans in
one run), real-corpus performance, the native text-selection menu, and
locator round-tripping between engines on large books. `flutter build apk`
for the app itself was started at the end of this build; check
`/tmp/thereader_android_build.log` or rebuild.

## Built-in Dart engine

A real EPUB package reader, not a text preview:

- On native the zip is indexed from disk (`InputFileStream`) and entries are
  inflated on demand, so a 70 MB illustrated book is not loaded whole.
- Parses `META-INF/container.xml`, the OPF package (metadata, manifest,
  spine) and the table of contents (EPUB 3 nav or EPUB 2 NCX).
- Renders each spine document's XHTML with `flutter_widget_from_html_core`
  on a pure black canvas with app typography. Book-level `<style>` and inline
  styles are stripped so no page can paint white; images are served from the
  container.

Limitations (stated in Settings): scrolled flow only, no publisher CSS, one
column per spine item so very long chapters open slower than in Readium.
