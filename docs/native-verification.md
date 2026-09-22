# Native integration and verification — 2026-09-22

All corpus data and videos are local and Git-ignored. Nothing was deployed to
Cloudflare or uploaded publicly. The Worker ran against local R2 on port 8787.

## Environment and workload

- Flutter 3.41.6 / Dart 3.11.4; Xcode 27.
- iPhone 17 simulator, iOS 26.5: primary functional and diagnostic target.
- Android API 36 emulator: complete native corpus walkthrough; final ARM64 release
  additionally checked for equations and actual process restart while offline.
- No physical-device energy, battery, sustained FPS or phone latency claims.

Three authorized private EPUBs were selected from a 99-book local collection.
Catalog aliases conceal the original titles and paths.

| Alias | Bytes | Spine items | Images | Largest chapter bytes |
| --- | ---: | ---: | ---: | ---: |
| typical | 4,995,997 | 30 | 47 | 230,280 |
| long-chapter | 30,021,276 | 13 | 7,442 | 1,474,020 |
| large | 189,916,272 | 106 | 2,538 | 271,996 |

The long chapter is a resource-lookup/layout stress case. File size alone does not
predict rendering cost. Books were streamed into durable storage, with byte count
and SHA-256 verified before the ready state and atomic rename.

## Checks completed

- Worker: 20 tests, TypeScript checks, deployment dry run (no deployment).
- Flutter: analysis clean, 23 tests; includes origin isolation, interrupted download
  recovery, serialized persistence, container path relocation, failed update keeping
  its previous verified edition/locator, and checksum failures.
- iOS XCTest: 2 tests passed, including href-index semantic equivalence, duplicate
  precedence, alternates/children, query/fragment fallback, and manifest mutation.
- Both platforms: live catalog search/paging, actual private downloads, native
  rendering, TOC, previous/next, typography, search, close/reopen, and saved locators.
  The corpus harness opens each of three books three times and asserts native
  Readium is present, so silent fallback cannot masquerade as native success.
- iOS normal `main.dart` app: download all three through the UI; change typography;
  navigate and advance in the large book; stop Worker (connection refused), terminate
  and relaunch the app; all three ready entries persist and the same text/position
  reopens. Six additional cached opens were recorded without the Flutter test harness.
- Android final trimmed release: download/open long chapter, inspect readable
  transparent equations, force-stop/relaunch with Worker stopped, reopen the same
  chapter at 26% with its equations intact.
- Text-selection handles observed on iOS. Native Copy menu/clipboard action was not
  reliably exposed by automation and is not claimed as passed.

## Measured improvements

### Resource lookup

The original iOS native reader stalled for more than 118 seconds on the long-chapter
book. Runner consumed approximately one CPU core. A process sample attributed
about 83% of main-thread samples to repeated resource lookup: both media type
resolution and Readium CSS injection scanned/normalized the publication manifest.

The fix is an eagerly built href index with mutation invalidation. In a controlled
XCTest on the same debug simulator, using 7,442 synthetic resource links and the
same 100 queries, the original Manifest lookup took **2,700.658 ms** and indexed
Publication lookup **0.464 ms**; one-time index creation took **60.648 ms**.
This is a lookup microbenchmark, not a claimed app-opening speedup. The original
and later corpus recordings used different resume locations/cache states, so they
are not used for a numerical before/after opening comparison.

### Reader retention

The repeated-open workload exposed a strong method-channel capture retaining iOS
reader/WebView graphs. After a weak capture and channel cleanup, observed maximum
WebContent process count fell from **38 to 6**. Summed WebContent RSS peaks were
**4,821.52 MiB before / 1,026.02 MiB after**. Runner peaks were **538.81 / 568.38 MiB**.

Both runs used the same three books, simulator, debug mode, preferences and nine-open
workflow. The final run reset positions and downloads, so RSS peaks are diagnostic,
not a controlled allocation benchmark. Old content processes now disappear after
closing; the clear result is removal of accumulated reader instances. RSS includes
shared pages and runtime helpers and is not equivalent to device physical footprint.

### Downloads and frame diagnostics

Final iOS debug simulator local download+verification times were 232 / 482 / 1,493 ms
for typical / long / large. Android debug emulator times were 1,173 / 1,524 / 13,459 ms.
These are local Worker/storage observations, not WAN or phone transfer benchmarks.

The final iOS harness captured 643 Flutter frame timings: build p95 19.714 ms,
raster p95 2.211 ms; 348 total spans exceeded 16.67 ms. These debug Flutter samples
exclude native WebView drawing and do not establish native FPS or energy use.

Native-host creation markers are explicitly **not first-readable-content** timings.
The harness's five-second `pump` waits also distorted visible frame scheduling:
six cached transitions clustered around 5.6 seconds in that video. A separate
normally installed app recording confirms body text appears while idle in all six
cached opens, before the next control tap. It preserves the large book's Preface,
long book's Chapter 3 and typical book's Introduction. Simulator video frame PTS
are non-monotonic across some view swaps, so exact readable-content latency is not
published from these recordings. Physical-device latency remains unmeasured.

A separate normal-app screenshot-poll run used a monotonic host clock, two warm
opens per book. All first screenshots were still black; every second screenshot
contained actual body text. Screenshot completion supplies conservative upper
bounds: **typical ≤1.9 s, large ≤2.1 s, long-chapter ≤3.0 s** in this run. These
include accessibility lookup, tap automation, deliberate polling delay and screenshot
overhead, so they are not exact first-paint times. The same restored text was
visually verified in both cycles. Private screenshots and host-clock events are
retained; `scripts/measure-cached-ios.ts` reproduces the procedure.

### Release artifacts

| Artifact | Result |
| --- | --- |
| Android ARM64 release before PDF trim | 29,903,033 bytes |
| Android ARM64 release after PDF trim | 24,778,503 bytes (17.1% smaller) |
| Unsigned iOS device Release Runner.app | build succeeded; Flutter reports 39.7 MB |

Both Android sizes are the same release/ABI configuration. The earlier 182 MB debug
APK is not the comparison baseline. Final APK contains no PDFium native library.
The Android release build emits non-fatal Kotlin metadata-version messages from
upstream dependencies; runtime EPUB verification passed. iOS device build success
does not imply a physical-device run or signed distributable IPA.

## Reproduce locally

Use Bun for Worker/tool scripts. Keep an explicit private manifest outside Git:

```json
{"selected":[{"role":"typical","source":"/absolute/private/book.epub"}]}
```

From `apps/api`:

```sh
bun install
bun run seed:local
bun run scripts/import-local.ts ../../artifacts/private/corpus.json
bun run dev
```

From `apps/mobile`, with one Flutter build/test process at a time:

```sh
flutter pub get
flutter analyze
flutter test
flutter test integration_test/live_corpus_test.dart -d <ios-simulator-id> --dart-define=RESET_CORPUS=true
flutter test integration_test/live_corpus_test.dart -d emulator-5554 --dart-define=TEST_API=http://10.0.2.2:8787 --dart-define=RESET_CORPUS=true
flutter build apk --release --split-per-abi --target-platform android-arm64
flutter build ios --release --no-codesign
```

Flutter integration-test teardown uninstalls the test app on this setup. Therefore
offline **process restart** is verified in a normally installed `flutter run` app,
not by launching a second `flutter test` and assuming its data survived. Download
books normally; stop the Worker; check `curl` cannot connect; terminate/relaunch
the same installation; reopen from Library and compare text and saved progression.

`flutter build ios --simulator` has a Flutter/Xcode 27 dual-architecture lipo-order
check failure here. `flutter run -d <simulator-id>` succeeds. Native XCTest also
succeeds using a single active architecture from `apps/mobile/ios`:

```sh
pod install
xcodebuild test -workspace Runner.xcworkspace -scheme Runner -configuration Debug \
  -destination 'platform=iOS Simulator,id=<ios-simulator-id>' \
  -only-testing:RunnerTests -parallel-testing-enabled NO ONLY_ACTIVE_ARCH=YES ARCHS=arm64 \
  FLUTTER_TARGET=lib/main.dart
```

From the repository root, `bun scripts/observe-simulator.ts <ignored-output.jsonl>
iOS_23F77` samples Runner and WebContent RSS/CPU every 500 ms; stop with SIGINT.
Close unrelated apps on that runtime before comparing. Record with
`xcrun simctl io <id> recordVideo --codec=h264 <ignored-output.mp4>`, stop with
SIGINT and verify duration/decodability using ffprobe/ffmpeg. Android `screenrecord`
has a duration limit; retain consecutive clips or concatenate without re-encoding.

For conservative readable-content bounds in the normal iPhone 17 simulator app,
prepare the three downloaded corpus aliases on Library, then run
`IDB=/path/to/idb bun scripts/measure-cached-ios.ts <simulator-id>` from the repository
root. The script captures private screenshots with monotonic intervals under
`artifacts/private/readable-poll`. Inspect the first image with actual body text and
use its `afterMs` as an upper bound; a host-view or percentage indicator is insufficient.

## Local evidence index

Paths below are workstation artifacts, intentionally absent from Git:

- `artifacts/recordings/ios-corpus-final.mp4`: complete corrected nine-open native
  harness, actual downloads, search, TOC, typography and offline-in-process reading.
- `artifacts/recordings/ios-normal-offline.mp4`: normal installed app, true offline
  process restart and position restoration.
- `artifacts/recordings/ios-normal-cached-pass.mp4`: six normal cached opens.
- `artifacts/recordings/android-corpus-full.mp4`: complete Android corpus session,
  joined from consecutive clips; initial Android fullscreen tutorial was dismissed.
- `artifacts/recordings/android-release-offline.mp4`: final trimmed release,
  formulas and offline process restart.
- `artifacts/private/ios-native-tests.log`, `ios-corpus-final.log`,
  `android-corpus.log`, `memory-indexed.jsonl`, `memory-final.jsonl`,
  `runner-stall.sample.txt`, `normal-poll-events.json`, `normal-cached-events.json`.

Earlier `ios-corpus-first-pass.mp4` preserves the initial stall; it is failure
evidence, not the final pass. No battery estimate is inferred from simulator CPU.
