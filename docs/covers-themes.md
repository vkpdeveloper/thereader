# EPUB covers, quiet Library and theme previews

The current pure-black appearance is named **Default** and remains selected on
fresh installs. Additional dark presets are Dracula, Nord, Tokyo Night,
Catppuccin Mocha and Gruvbox. Settings shows miniature interface previews and the
selected preset. The choice affects app surfaces, text, controls, sheets and the
reading canvas; it is saved with reader preferences on each device and does not
sync.
The native launch screen remains the Default black surface.

Palette references and attribution are in [theme presets](theme-presets.md).
These are adaptations for reading, rather than editor syntax-highlighting rules.

## Separate cover objects

Uploading a verified EPUB now inspects its embedded cover and stores that image
separately in R2. Uploaded-book rows in D1 hold the cover ID, object key, content
type, byte length, ETag and inspection time. Catalog responses expose `coverId`
and `coverUrl`; the phone requests the image URL without downloading or reopening
the EPUB just to draw a library tile. Existing uploaded books are backfilled by
repeating their SHA-based prepare request, which preserves their book bytes and
reading state.

The inspector recognizes EPUB 3 `cover-image`, EPUB 2 cover metadata, guide cover
pages, and conventional cover filenames/IDs. It resolves relative ZIP paths and
reads bounded archive entries. JPEG, PNG, WebP, GIF and self-contained SVG covers
are supported. Image dimensions and encoded size are limited; SVG may not fetch
external resources. Invalid declared artwork remains an error rather than being
recorded as a confirmed missing cover. Only a successfully inspected book with
no cover gets the generated fallback.

The initial audit of the provided 99-EPUB folder found 41 EPUB 3 declarations,
56 EPUB 2 declarations, one conventional cover without either declaration and
one book without image manifest entries. The two original missing artwork files
were real JPEGs: the linear algebra cover is 295,973 bytes (700×1065), and the C++
cover is 332,823 bytes (600×754).

## Phone caching and library metadata

Local import extracts a cover once and saves it separately before cloud upload,
so the imported book can show its artwork while offline. Remote cover images use
an encoded-memory cache and persistent application-support storage. Loads for the
same key are coalesced, network concurrency is bounded, and failed requests can
retry. A loading or unavailable image is distinct from a confirmed absent cover.
Raster decode size follows the tile's display size.

Existing library entries refresh catalog metadata on startup, then with a bounded
refresh interval, so newly backfilled cover URLs reach already-downloaded books.
The update preserves the downloaded EPUB, its reading position and edition hash.

The Library shows books and reading actions without background sync errors,
progress messages or upload glyphs. Sync and upload status/retry controls live in
Settings. User-triggered file picking can still show import activity and direct
validation feedback. Background syncing itself remains enabled.

## Verification

The API passed 44 Worker tests and TypeScript checking. Migration 0003 was
applied to production D1 and Worker version
`010b4fee-3332-4ec4-9e2b-0e17d72c1998` deployed on `reader.ordinity.com`.
All four previously uploaded books were backfilled; all five catalog books now
serve separate cover images. Their conditional requests returned HTTP 304, and
the original linear-algebra and C++ cover hashes matched the served images.
The integrated Flutter suite passed 104 tests with a clean analyzer, including
a regression proving that slow cover metadata does not block preference sync.
The final CodeRabbit review of the committed mobile change returned zero findings.
Existing-book metadata refresh uses one independent background worker.
The iOS simulator verified all five real covers, all six theme previews, saved
selection after cold restart, and quiet Library behavior with an unreachable API.
Android release build 2011 (arm64, APK version code 4011) was installed and
checked on the local emulator. A fresh 34,225,559-byte EPUB imported in airplane
mode, displayed its extracted cover before upload, and opened the local book.
After connectivity returned, the app published the EPUB and its cover to R2;
the 511,421-byte served cover matched the embedded source byte for byte. The
catalog now contains six books, all with real covers. Nord coloured the native
Readium canvas and text; the selection and cover cache survived an offline
cold restart. Sync failures appeared in Settings and stayed out of Library.
The installable APK retains the name The Reader and passed signature validation.
It was delivered to Nord through Taildrop. iOS received the new cover before
downloading the EPUB, rendered native Nord body text, and restored Default.
Android then received that Default selection from D1 without a local theme tap.
Both test devices ended on Default with the production API and networking enabled.

Native recordings are `artifacts/recordings/ios-covers-themes-complete.mp4` and
`artifacts/recordings/android-covers-themes.mp4`. These simulator/emulator checks
verify behavior; they are not physical-device performance measurements. Private EPUBs, extracted artwork and recordings
remain ignored local artifacts; they are never committed to Git.
