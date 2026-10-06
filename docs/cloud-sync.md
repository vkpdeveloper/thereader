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

D1 stores library membership, locators and reading sessions for one shared
personal profile. Reader settings (theme, font, size, spacing, highlight colour)
are per-device: mobile keeps them in shared preferences and web in IndexedDB, and
none of them sync. Servers acknowledge and discard `preferences` changes from
older clients, and migration 0006 dropped the old `sync_preferences` table. The app saves changes in an origin-scoped durable
outbox before sending them. It syncs at startup/resume, about two seconds after a
change, every 30 seconds while foregrounded, and through Settings' Sync now action.
Offline edits remain queued. Switching the configured API does not send another
origin's queue to that server.

Position uses timestamp ordering, with deterministic change-ID ties.
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
both devices' foreground time. API address, reader engine and all reader settings
stay local.

Highlights and saved articles sync too (below and in the API README). Sync responses
are bounded to 1,000 book editions and reject excess state explicitly; uploads and
request payloads also have validation limits documented in the API README.

## Saved articles

Articles saved by link sync between devices, but each article is analyzed only
once: the device that saves it fetches the page and extracts it on the client;
the Worker never fetches or extracts pages for sync. That device uploads the
extracted document (the `Article` JSON, schema 1) once; other devices list the
article from its synced metadata and download the same document when it is
opened, verified against its SHA-256, and keep it for offline reading.

- **Identity.** An article's id is the first 128 bits (32 hex characters) of
  the SHA-256 of its URL key: the article's canonical URL with scheme,
  credentials, default port, `www.`, trailing slashes, fragment and tracking
  parameters (`utm_*`, `fbclid`, `gclid`, …) removed and the host lowercased.
  The web app (`articleUrlKey` in `articles.ts`) and the Flutter app
  (`ArticleRepository.urlKey`) implement the same string rules and share test
  vectors, so the same story saved on two devices converges on one article.
  Articles saved before sync are moved to this id the first time the new
  version starts.
- **Metadata, positions, deletions** ride the scheduled `/v1/sync` request as
  `article` and `articleProgress` changes in the same durable outbox as books
  (see the [API README](../apps/api/README.md)). Saves and deletions are
  last-write-wins by their time; a deletion is a tombstone, and saving the URL
  again later brings the article back with a fresh position. A deletion is
  only sent for an article that already synced. Positions are `{block, offset,
  percent}`: the index in `article.blocks` of the top-level block at the
  reading line, how far into it, and the share read. Both readers find blocks
  by that index (mobile builds one list item per block; the web reader marks
  each block's element with `data-block-index`), never by how many elements a
  block happens to render. They use their own timestamp ordering like book
  positions; an open article does not jump, and the reader's own position is
  saved when it closes. Pulls use an `articlesSince` rev cursor, 200 rows per
  response.
- **Documents** are content-addressed R2 objects, `articles/<sha256>`, stored
  as the exact bytes the saving device hashed (gzip-compressed by both apps).
  `PUT /v1/article-bodies/<sha256>` is idempotent and checks size (4 MB
  uncompressed), hash and the document's leading `{"schema":1,` without
  parsing it; `GET` serves them with immutable caching. When a deletion is
  accepted and no live article still references the document, the Worker
  removes it from R2; saving the article again uploads it again. The saving
  device queues the upload in its outbox state; uploads run in a foreground
  sync cycle right after the server accepts the save (never before, so a
  concurrent deletion cannot remove a document a newer save still points at),
  at most five per cycle, and survive restart. A network or server failure
  retries next cycle; a document the server refuses stays local only. A
  document over 4 MB (real articles measure up to about 1.2 MB) keeps the
  whole article on its device: it is saved and readable there, but no save
  or position is ever queued for it (nor a deletion, unless an earlier save
  of the same URL reached the server), so it cannot fail a batch or pause
  article sync.
- **Receiving.** A pulled article appears in the Library as "Not downloaded".
  After each successful cycle, up to five documents of at most 1 MB download
  so recent articles open offline; larger ones download when opened. An
  article whose document has not been uploaded yet says so when opened and
  opens once it arrives; failed downloads back off from two minutes to six
  hours.
- **Older servers.** A server without article sync rejects the batch; the
  apps then resend it without articles and retry article sync six hours later,
  as they do for highlights.

Free plan cost: articles add no request to the sync schedule. Saving an
article adds one `PUT` (one R2 Class B read to check for the object and one
Class A write) the next time the app syncs, and each other device makes one
`GET` (one Class B read) for its document, once. D1 work per cycle is the
upserts in the batch plus one indexed range read of changed rows. Documents
are kept after deletion, so a resurrected article needs no upload, and
identical documents saved twice share one object.

## Article highlights

Passages highlighted in saved web articles (web reader only so far) are
ordinary highlights: the same local store, the same `highlight` change in the
scheduled `/v1/sync` batch, the same `highlightsSince` pull, tombstones and
last-write-wins. Creating, recolouring, annotating or deleting one never sends
a request of its own. What differs is what they are pinned to:

- **Edition.** `bookId` is `article-<articleId>` (the article's 32-hex id,
  which every device derives from its URL) and `sha256` is 64 zeros. The id is
  shared across devices; the document's `bodySha256` is not used because saving
  the URL again re-extracts the page into a new document, and a highlight can
  never move to another edition. No book has that id or hash, so book views
  (web `forEdition`, Flutter `HighlightRepository.forEdition`) never show
  them, and neither app re-sends a pulled one as a book highlight. `origin`
  is the API the device was using; like articles themselves, article
  highlights show under any origin and sync to whichever one is current.
- **Locator.** The index of the top-level block in `article.blocks` (the same
  index reading positions use) and UTF-16 offsets into that block's text, plus
  the quote in Readium's `text` shape:

  ```json
  {
    "type": "article",
    "href": "https://example.org/post",
    "articleId": "76faff49e6928df24de0670458eb6518",
    "block": 3, "start": 0, "endBlock": 3, "end": 61,
    "title": "The brief",
    "locations": { "progression": 0.042, "totalProgression": 0.042 },
    "text": { "before": "…in every thread.\n", "highlight": "We focused on four journeys…", "after": ". At the 75th" }
  }
  ```

  `href` is the article URL (the API requires a non-empty `href`). A passage
  may cross blocks: `end` is then an offset into `endBlock`, and the quote
  joins the blocks' texts with a line break, skipping blocks without text.
  `title` is the nearest heading above, for lists; `totalProgression` (block
  plus share of it, over the block count) orders them. A block's text is its
  rendered text minus reader chrome: buttons, the code bar, heading links,
  footnote return arrows, image alt-text fallbacks and math (TeX or MathML
  depending on the device) do not count. The quote is at most 4,000
  characters; a longer selection is cut to that. The API may drop
  `text.before`/`after` (or `text`) to fit its 16 KB locator cap.
- **Re-anchoring.** A client trusts the offsets when the text there still
  equals the quote; otherwise it searches for the quote in the six blocks
  around the recorded ones, then the whole article, preferring the occurrence
  whose surrounding text matches `before`/`after`, then the nearest. A passage
  that cannot be found is kept (and still listed and synced) but not drawn.
  Clients that compute block text differently (Flutter, later) should treat
  the offsets as a hint and rely on the quote. The web implementation is
  `apps/web/src/lib/articleAnchors.ts`, with tests.
- **Removing an article** keeps its highlights, as removing a book keeps its
  own: they come back if the URL is saved again (same id), re-anchored by
  quote if the page changed. Highlights on an article that stays on its
  device (a document over 4 MB) stay local too.

The web reader paints them with the CSS Custom Highlight API (`::highlight()`,
Chrome 105+, Safari 17.2+, Firefox 140+) over React's own text nodes, so the
article DOM is never changed. The Flutter app stores pulled article
highlights but has no article highlight UI yet.

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
