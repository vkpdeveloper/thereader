# Reading while downloading

The native app enables **Read** once at least 5% of the EPUB has been cached and
its ZIP tail is available. Opening then requests the archive metadata, chapter,
fonts and images that Readium needs. A ZIP's first 5% alone is not generally a
readable EPUB: the central directory is at the end, and an opening chapter can
itself exceed 5%. The UI enables early reading at the threshold; it does not
promise that every publication's first page can render using exactly 5% of its
bytes.

The file remains an online, partial download until its entire size and SHA-256
match the catalog. Only then is it atomically promoted to the durable offline
library. Closing the reader does not cancel the background download. A process
exit discards unfinished data on the next launch and offers a retry; this is
foreground-app downloading, including while reading, not an iOS background
transfer entitlement.

## Data path

- HTTPS requests pin each byte range to the catalog edition using its SHA ETag
  and `If-Range`. The client rejects changed validators, incorrect range totals,
  unexpected content encoding, full-body fallbacks and truncated responses.
- A disk-backed cache records complete 64 KiB chunks. Reader requests have
  priority; background requests combine adjacent chunks to reduce round trips.
  Missing ranges never read as zero-filled sparse holes.
- An ephemeral IPv4 loopback server exposes the exact original EPUB bytes to
  native Readium. Its URL has a random 192-bit path token; it is not bound to a
  LAN interface. HEAD and bounded, suffix and open-ended GET ranges are supported.
- A reader lease retains that server and file handle through native teardown,
  including after atomic finalization. A failed or cancelled transfer closes
  provisional reading and never replaces a previously verified edition.
- Swift Readium's localhost ZIP policy skips its normal whole-small-file cache
  and uses 64 KiB read-ahead. Kotlin uses a loopback-only archive/resource adapter
  with bounded HTTP reads. Normal local-file reading remains on the existing
  toolkit paths. Vendored upstream helpers retain their BSD notices.
- Download progress merges with the current library entry, preserving locators
  saved while the background transfer runs.
- Provisional iOS readers request no adjacent positions in advance; verified
  offline books retain Readium's previous-two/next-six preload policy. This limits
  speculative fetching while the requested chapter is still downloading.

Partial chunks are edition-pinned transport data, **not** independently
cryptographically verified. Full-file SHA verification happens at completion.
The Worker validates R2 SHA metadata when supplied; legacy objects without it
retain the limitation documented in the API README.

## Automated checks

The regression suite covers early readiness before completion, tail-first
bootstrap, priority/deduplicated demand reads, loopback HTTP ranges, bounded
background coalescing, exact byte coverage, final checksum, atomic promotion,
reader leases, cancellation, truncation and inconsistent range responses.
Native ZIP regressions exercise a small archive whose opening chapter can be
read without downloading its large later entry.

Android JVM tests use the test-only [Robolectric runner](https://robolectric.org/getting-started/)
to exercise Readium's Android URL types; this adds no release-app dependency.
Recordings and private corpus files are excluded from Git.

## Native simulator and emulator evidence

The normal installed apps were exercised with unchanged private EPUBs through a
local HTTP API that delayed each 64 KiB response segment by 700 ms. iOS used its
own server on port 8900; Android used port 8899. The local HTTP setup deliberately
controls transfer speed; it is not a WAN or physical-device performance benchmark.
The deployed HTTPS catalog/download was also verified separately on iOS.

| Platform / EPUB | Read enabled | Actual native content observed before completion |
| --- | --- | --- |
| Android API 36 / 4,995,997 bytes | 5.55%, 3.50 s after Download; tapped at 3.99 s | Title page in the first screenshot at 6.14 s / 10.80%; Introduction via TOC at 15.86 s / 30.48% |
| iPhone 17 simulator / 4,995,997 bytes | 5.55%, approximately 3.20 s after Download; tapped immediately | Title page rendered; Introduction screenshot showed **Downloading 35%** (server sample immediately afterward: 35.72%) |
| iPhone 17 simulator / 30,021,276 bytes | 5.04%, approximately 16.8 s after the first server request | Explicitly selected image-heavy Chapter 3 rendered with inline equations at **Downloading 69%** (server sample afterward: 70.09%) |

Server percentages count unique response bytes sent, while the app percentage
tracks completed cached chunks. They can differ during a response. Host event
intervals and screenshots include automation overhead and do not measure exact
first paint. The long-book opening initially showed Front matter; Chapter 3 was
selected through the TOC. Its earlier black host and loading indicator at 48%
were **not** counted as readable content. These results establish early native
reading, not a promise that all books render at exactly 5%.

The iOS recording also exercises TOC, scrolling and a switch to serif typography.
Both progressive downloads completed and their durable files matched full-file
SHA-256. With the local API stopped, terminating and relaunching iOS retained both
books and reopened the same Introduction and Chapter 3 positions, including the
math images. Android independently passed offline process restart and cached
native reading. iOS's check makes the book API unavailable; it does not claim the
simulator's host network was disconnected. The production API URL was restored
and health rechecked after the iOS session.

The above measurements precede the final iOS provisional-preload reduction and
cosmetic download-badge/health-message adjustments. They must not be represented
as a before/after benchmark of those changes. The final build's smoke verification
is recorded separately when completed.

At this checkpoint, 49 Flutter tests pass. The preceding native suites passed
three iOS tests and two Kotlin tests, and the API suite passed 26 tests. Final
analysis/build verification is tracked separately; simulator recordings do not
establish physical-device frame rate, battery use or universal latency bounds.

Private evidence, intentionally absent from Git:

- `artifacts/recordings/ios-progressive-final.mp4`: continuous 581.175-second
  session, 34,671,502 bytes, HEVC 1206×2622. Includes production HTTPS reading,
  both slow transfers, pending states, completion and API-unavailable restart.
- `artifacts/private/ios-progressive-events.jsonl` and
  `ios-progressive-server.jsonl`: host observations and independent server ranges.
- `artifacts/private/ios-progressive-typical-body.png` and
  `ios-progressive-current.png`: readable native content with incomplete-download
  chrome; `ios-progressive-final-files.json` records final disk hashes.
- `artifacts/private/ios-progressive-offline-restarted-typical.png` and
  `ios-progressive-offline-restarted-long.png`: body content after process restart.
- `artifacts/private/android-five-percent-events.json`: controlled Android
  threshold, tap and readable-content observations.
