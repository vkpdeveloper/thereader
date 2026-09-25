# Book opening performance — 2026-09-25

The reported delay is reproducible on an already downloaded algebra EPUB. It is
primarily native resource serving and layout, not downloading the complete file.
The existing range downloader already prioritizes a requested chapter's missing
bytes, including a saved location late in the archive.

## Cause and change

[Readium Kotlin 3.2's WebView server](https://github.com/readium/kotlin-toolkit/blob/3.2.0/readium/navigator/src/main/java/org/readium/r2/navigator/epub/WebViewServer.kt) calls `Publication.linkWithHref` for every
resource. That delegates to a recursive manifest scan, normalizing each candidate
URL on every request. The algebra EPUB has 7,442 images; its largest chapter has
3,072 image elements. A diagnostic Android method trace attributed 37.54 of
37.88 sampled seconds in the interception path to that lookup. This instrumented
trace diagnoses the hot path; it is not used as an opening-time benchmark.

`PublicationHrefIndex` indexes normalized URLs once per publication. It preserves
reading-order/resources/links precedence, depth-first alternates and children,
first duplicate wins, and exact matches before query/fragment fallback. The
publication and manifest are immutable in this app. A synchronized weak-key
cache does not retain closed publications or refer back to its keys.

The pinned Kotlin SDK is delivered as an AAR. A narrow AGP ASM visitor redirects
only its WebView server's three lookup calls to the index, leaving other SDK
callers unchanged. It fails the build if the call-site count changes. Unit tests
exercise the rewrite and index equivalence; the integration tests run the actual
transformed APK. This patch must be revalidated when upgrading Readium or AGP.
Swift already has the equivalent indexed lookup, applied by the existing Podfile.

The wrapper also stops rebuilding the table-of-contents fragment list for image
and font requests. Android's reflowable `ready` event now waits for the current-page
callback; a neighboring preloaded WebView finishing first is insufficient.
On both platforms, the app no longer resubmits unchanged opening typography at
first paint. Changes made while loading are coalesced and replayed when ready;
live changes still apply immediately. iOS locator enrichment also rejects an
older asynchronous page event after a newer one has arrived. A slow-download
check once reported progression zero despite visibly restored text. The wrapper
allowed overlapping enrichment tasks to publish out of order; the new guard
prevents that path from overwriting a newer position. Subsequent progressive,
paginated, and private-corpus resume checks passed.

## Measurement method

All runs are local debug builds: Android API 36 ARM64 headless emulator and
an isolated iPhone 17 Pro simulator on iOS 26.5. No emulator/simulator window was
opened, and physical-device performance is not inferred.

`reader_open_benchmark_test.dart` fetches each private fixture **before** starting
the clock. It separately records publication opening, native ready, and a
current-page locator with a CSS selector at the requested progression. It also
waits for the widget's current-page channel callback, because both saved-locator
echoes and an off-screen preload can otherwise create false-positive readiness.
Subsequent cycles reopen the saved native locator. Frames continue pumping every
50 ms while waiting; screenshots corroborate actual text and equation rendering.
These are first-positioned-page timings, not exact first-paint timestamps.

The private EPUBs and traces are not committed or published. The public recording
uses an original generated EPUB, not an excerpt from the private corpus.

## Results

A controlled three-cycle comparison used the same already-running Android emulator,
fixture, preferences, strengthened benchmark harness, and initial location. The
baseline restored the four changed production files from `f7180ad`; the final
run restored the proposed changes. Neither run had method profiling enabled.

| Largest algebra chapter, 80% within chapter | Cycle 1 | Cycle 2 | Cycle 3 | Median |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 28.991 s | 30.403 s | 36.168 s | 30.403 s |
| Fixed | 8.980 s | 7.182 s | 6.421 s | 7.182 s |

The median is **76.4% lower (4.2× faster)**. Cycle 1 uses href/progression;
cycles 2–3 reopen the saved native locator. Publication parsing itself is a small
fraction of the delay. A separate initial unprofiled reproduction took 42.315 s;
it is not substituted into the controlled comparison.

Additional final Android scrolled runs (three opens each): Companion at ~85% of
the book, **0.799 s median** (0.746–1.318 s); algebra Applications at ~69%,
**7.798 s median** (7.648–8.619 s). An earlier cold-emulator diagnostic run had
large scheduling/memory-pressure outliers and is excluded from the controlled
comparison. These are simulator observations, not phone latency guarantees.

Final iOS scrolled runs also reopened each native saved locator three times:
Companion **0.965 s median** (0.965–1.883 s), algebra fundamentals **3.669 s**
(3.399–3.900 s), Applications **2.782 s** (2.682–3.083 s). The existing Swift index already prevented the Android-style
manifest stall. Saved CSS anchors remained identical across all three cycles
for every measured location on both platforms.

The lookup microbenchmark (7,442 resources, 100 identical query/fragment lookups)
took **552.214 ms scanning / 0.496 ms indexed**, plus **84.990 ms** for one-time
index construction under Robolectric. Correctness assertions, rather than a
machine-dependent speed ratio, gate this test.

## Saved position and partial-download regression

`reader_progressive_resume_test.dart` uses the real downloader and native reader,
with a local server releasing 64 KiB every 200 ms per response. Its generated
35,287,073-byte EPUB has 7,442 image resources and 32 MiB of unreferenced padding
**before** the chapter HTML. It resumes chapter 10 at progression 0.8, asserts a
rendered locator while the download is incomplete, then checks the complete
file's SHA-256. This demonstrates demand fetching near the end of an archive;
it is a controlled range-priority test, not a WAN throughput measurement.

| Platform | Download start → positioned | Native open → positioned | Bytes received | Full file SHA verified |
| --- | ---: | ---: | ---: | ---: |
| Android | 18.176 s | 12.445 s | 22,573,089 / 35,287,073 (64.0%) | 30.810 s |
| iOS | 11.433 s | 5.726 s | 14,381,089 / 35,287,073 (40.8%) | 30.435 s |

Public screen recordings: [Android](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/pr-assets/t3code-3f6bcd0a/improve-book-loading-rendering/reader-android-progressive-proof-14ab1b31e776.mp4),
[iOS](https://pub-db5cc934f02943a19d855c11f462c1e9.r2.dev/pr-assets/t3code-3f6bcd0a/improve-book-loading-rendering/reader-ios-progressive-proof-2a9ba7dee90b.mp4).
These show the generated fixture's restored text and inline diagrams; they are
not recordings of the private-book before/after comparison. They include fixture
setup and intentionally throttled transfer, so the video time is not the native
opening metric. Raw measurements are in
[the benchmark JSON](benchmarks/book-opening-2026-09-25.json).

Readium lays out EPUB spine documents. It does not promise an arbitrary fixed
70–90-page window: page boundaries change with font, screen size, and flow.
Current-location byte demand takes priority, and normal adjacent-document loading
and the rest of the download continue through the existing reader/downloader.
A very large single chapter still requires its layout and images; this change
removes repeated lookup work without altering book content or locator paths.

## Validation

- `flutter analyze`: no issues; final benchmark harness analysis also clean.
- `flutter build apk --release --target-platform android-arm64`: passed, including
  the R8-minified variant and its indexed lookup helper.
- Flutter tests: 170 passed, one existing skip.
- Android native tests: 65 passed, one existing skip; two transform tests passed.
- Both platforms: three cached opens per private-corpus location, two paginated
  synthetic opens preserving the saved CSS anchor, and partial-download resume
  followed by SHA-256 verification. Android's final streaming regression also
  asserted the position stays stable after opening (50.4% downloaded at restore).
- CodeRabbit review: its one minor finding was fixed, so invalid benchmark
  filters/cycle counts cannot silently pass without opening a book.

## Reproduction

Generate public fixtures outside Git and serve only on loopback:

```sh
python3 scripts/prepare-reader-benchmark.py /tmp/reader-bench
python3 scripts/prepare-reader-benchmark.py /tmp/reader-progressive --padding-mib 32
cp /tmp/reader-progressive/synthetic.epub /tmp/reader-bench/progressive.epub
python3 -m http.server 8923 --bind 127.0.0.1 --directory /tmp/reader-bench
```

From `apps/mobile` (one Flutter build/device run at a time):

```sh
flutter test integration_test/reader_open_benchmark_test.dart -d emulator-5580 \
  --dart-define=BENCH_HOST=10.0.2.2 --dart-define=BENCH_SYNTHETIC=true
flutter test integration_test/reader_progressive_resume_test.dart -d emulator-5580 \
  --dart-define=BENCH_HOST=10.0.2.2
# iOS: substitute the isolated simulator UUID and omit BENCH_HOST.
# Add BENCH_PAGINATED=true to check pagination; scrolled is the app default.
```

For the authorized private corpus, serve the Companion as `typical.epub` and the
algebra book as `long-chapter.epub`, omit `BENCH_SYNTHETIC`, and keep those files
out of Git. `BENCH_HREF` can limit the run to one fixture location;
`BENCH_CYCLES` defaults to three. The fixture paths are explicit in the harness.

```sh
flutter analyze
flutter test
cd android
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
  ./gradlew :flutter_readium:testDebugUnitTest
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' \
  ./gradlew -p buildSrc test
```

Use isolated test devices. The progressive test leaves temporary fixture files
in its app sandbox until that test app/device is removed, allowing asynchronous
native reader teardown to finish safely.
