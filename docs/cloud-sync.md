# EPUB imports and personal cloud state

The app uses `https://reader.ordinity.com`, R2 bucket `thereader-books`, and D1
`thereader-state` (`aa9b03e1-4efc-466a-b2a3-6fc23edf016b`). Production binding names
are `BOOKS` and `DB`. Migrations `0001_uploads_and_sync.sql` and
`0002_multipart_uploads.sql` have been applied remotely. Worker version
`7d1c2577-7ac9-46e0-9d03-2cfb0beccab3` includes both features.

## Picking and reading

Library's top-right Import EPUB action opens the native file picker. The app
inspects bounded ZIP metadata and computes SHA-256 off the UI isolate. It streams
the selected file into durable application storage, verifies that the copied bytes
match, persists its upload queue, and adds the book to the library. Reading uses
that saved file immediately after local import completes; no server download is
required. Picking is available on iOS and Android, not the browser preview.

Uploads run independently while the app is open. Files up to 64 MiB use one
streamed request; larger files, up to 512 MiB, use resumable 8 MiB R2 parts. The
client streams disk ranges in 64 KiB chunks and skips acknowledged parts on retry.
The Worker verifies the full object's SHA-256 and EPUB structure before publishing
it. Existing SHA-256 editions reuse their canonical catalog entry. Imported books now extract embedded covers into separate R2 objects and retain
local cover images for offline use; see [covers and themes](covers-themes.md).

The queue survives app restart and network failure. Retry runs on launch, resume,
foreground polling, or the visible Retry action. This is foreground application
work, not a guarantee that iOS/Android will keep uploading after suspending the
app. Local reading continues when an upload fails. Pending import deletion first
cancels its upload; completed cloud books offer Remove download in the app bar,
which retains their cloud membership, position and reading time.

## State and conflicts

D1 stores library membership, locators, reading sessions and typography preferences
for one shared personal profile. The app saves changes in an origin-scoped durable
outbox before sending them. It syncs at startup/resume, about two seconds after a
change, every 30 seconds while foregrounded, and through Settings' Sync now action.
Offline edits remain queued. Switching the configured API does not send another
origin's queue to that server.

Position and typography use timestamp ordering, with deterministic change-ID ties.
UTC timestamps preserve up to six fractional digits; server validation rejects
values more than five minutes in the future. Devices therefore need reasonably
correct clocks. An already-open reader does not jump when another device changes
position. The new position is applied after the reading session ends and syncs.
Remote library membership adds metadata only, without downloading every book.

Reading time measures foreground time with an opened reader. It is not an
attention measurement, and may include loading after the reader reports open.
Stopwatch checkpoints occur every 15 seconds and on pause/exit. A forced process
kill can lose the most recent uncheckpointed interval. Each session uses a stable
ID and cumulative elapsed counter; D1 takes its maximum, preventing retries from
double-counting. Sessions from different devices sum; simultaneous reading counts
both devices' foreground time. API address and reader-engine selection stay local.

The current app has no bookmarks, highlights or annotations to sync. Sync responses
are bounded to 1,000 book editions and reject excess state explicitly; uploads and
request payloads also have validation limits documented in the API README.

## Deployment and credentials

The user requested no login. Consequently these upload, download and sync endpoints
are unauthenticated and accessible to anyone who knows the URL. Device IDs support
session deduplication, not access control. There is one shared profile, not separate
users. R2 and D1 are reached through Worker bindings: no storage key, database
credential or deployment token ships in the app or repository. Wrangler's OAuth
credential remains encrypted outside Git with its key in macOS Keychain. D1 write
access was explicitly authorized before provisioning the database.

```sh
cd apps/api
bunx wrangler d1 migrations apply DB --remote --env production
bun run deploy
```

## Verification

- 78 Flutter tests pass; full Flutter analysis is clean.
- 40 Worker tests pass in workerd with R2/D1, plus TypeScript checking and production
  deployment validation.
- Tests cover lost responses and session deduplication, persistent offline queues,
  concurrent local changes, active-reader position protection, preference write
  ordering, native import streaming/canonical adoption, and multipart retry without
  repeating acknowledged parts.
- The actual 189,916,272-byte C++ EPUB passes metadata extraction and SHA checking.
- Android native file picking imported the 30,021,276-byte linear algebra EPUB,
  published it to production R2, and rendered its chapter text and equations from
  its local copy. Production D1 returned the selected chapter, font size 22 and
  cumulative reading time.

iOS received the Android chapter locator and font preference exactly, displayed
its two minutes of reading time, and added the uploaded book as metadata before
downloading its file. Android imported the 189,916,272-byte C++ EPUB while offline
and rendered its native Readium body before any cloud upload. Reconnecting started
the multipart upload; force-closing after six acknowledged parts and relaunching
restored the local book and resumed upload.

All videos and private EPUBs remain under ignored artifacts or simulator storage;
none are Git assets.


### Completed native checks

The 190 MB upload published successfully after the restart. An independent streamed
HTTPS download hashed to the original SHA-256
`c3a3fefe8a2c2d8ea0f822e02163c104107a5fc2a3d17277a3842d954a75514d`.
D1's pending-upload and part tables were empty after completion. The reading-session
query confirmed two distinct devices contributing to the linear algebra book.

iOS changed that book to Chapter 3, Computational linear algebra (26.27%), and font
size 24; Android pulled the new state and rendered that chapter. iOS also imported
an existing production EPUB through Files after removing only its local download,
reused the existing SHA/canonical catalog ID, and read the locally imported copy.

### Performance interpretation

Android ARM64 release build 2006 cold launch took 861 ms in this emulator sample;
its forced-restart sample took 956 ms. During large import the sampled process PSS
was 96,697 KiB; during native reading it was 166,216 KiB. These are point samples,
not peak guarantees. Metadata inspection is isolated, transfer buffers are bounded,
upload progress notifications are throttled to 80 ms, and downloads/imports avoid
whole-book in-memory buffers.

The iOS debug simulator's 50.4-second diagnostic during a heavy illustrated chapter,
font changes and closing showed Runner RSS 358–423 MiB and WebContent RSS
562.9–784.5 MiB while present. RSS is not physical footprint. These figures cannot
establish release iPhone memory use. The recorded/emulated Android gfxinfo sample
also had too few frames and substantial jank to support a frame-rate claim; it is
retained as diagnostic evidence rather than presented as a smoothness benchmark.
Physical-device release profiling, thermal behavior and battery measurement remain
unverified. No claim of “best performance” follows from simulator walkthroughs.

### Recordings

Videos are local, ignored files, not GitHub assets:

- `artifacts/recordings/ios-import-sync-complete.mp4`: iOS cloud receipt, native rendering,
  file picking, canonical deduplication, chapter/typography changes and sync.
- `artifacts/recordings/android-import-sync-final.mp4`: Android picker/upload, native
  equations, offline large import, online multipart resume after force-close, and
  receipt of the iOS chapter change. Joined clips preserve their timing and are
  normalized to 30 fps for playback. Raw clips are retained beside the final file.


A final iOS-only locator edge case was reproduced and fixed: JavaScript normalized
native `0.0` values to `0`, so the client mistook an acknowledged position for a new
edit. The client now fingerprints the retained local locator at its acknowledged
timestamp. A regression covers numeric and map-order normalization across three
successive polls without requeueing. Full tests and analysis passed after the fix. The installed iOS build cleared the
preexisting pending change on startup; three manual syncs retained an empty
outbox, confirmed in persisted storage as well as the Settings interface.

The Android combined recording is 668.633 seconds, 12,401,447 bytes, H.264
1080×2400 at 30 fps; its full decode completed without errors. The iOS combined
recording is 421.166 seconds, 12,712,380 bytes, H.264 1206×2622 at 30 fps; its full
decode also completed without errors. The final iOS handoff also includes the subsequent sync-fix smoke.


Final installed artifacts: Android ARM64 release build number 2008 (split-ABI
package version code 4008) and the iOS active-architecture debug simulator build,
both including commit `40ca36a`. Both recordings' final frames were visually
checked for an empty sync queue and all imports published. No device network
settings remain overridden.
