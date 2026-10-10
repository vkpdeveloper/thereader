# Comic books

Comics (CBR and CBZ) live in the same library as EPUBs and sync the same way:
membership, reading position, reading time and categories. They have no
highlights, notes, ink/canvas, typography settings, search or table of contents.

This document is the contract the API, web app and Flutter app share.

## Stored format: CBZ

The server stores every comic as a **CBZ** (a ZIP of page images). Clients
convert at import time:

- **CBZ** (ZIP magic `PK\x03\x04`) uploads as-is, original bytes. Its SHA-256
  is the SHA-256 of the file the user picked.
- **CBR** (RAR4 magic `Rar!\x1a\x07\x00`, RAR5 magic `Rar!\x1a\x07\x01\x00`) is
  extracted on the device and repacked into a CBZ with the deterministic
  layout below. Image bytes are copied unchanged; nothing is recompressed.
- A `.cbr` that is really a ZIP is treated as a CBZ; a `.cbz` that is really a
  RAR is treated as a CBR. Magic bytes decide, not the extension.
- CB7, CBT, PDF and encrypted archives are refused with a clear message.

Because the repack is deterministic, the same CBR imported on the web and on
a phone produces byte-identical CBZs, so the second import deduplicates
against the first (`POST /v1/uploads/prepare` finds the SHA-256).

### Deterministic repack (CBR → CBZ)

1. Normalize every entry name: `\` → `/`, strip a leading `/`. Drop directories.
2. Pages are the entries selected by **Page selection** below, in **Page order**.
3. Append one `ComicInfo.xml` if any entry's base name equals it
   (case-insensitive): the shallowest one, ties broken by code-unit order of
   the full name. Nothing else is copied.
4. Write a ZIP with, for each entry in that order, a local header immediately
   followed by the raw bytes, then the central directory, then the EOCD:
   - method 0 (stored), version needed 10, version made by 10 (`0x000A`),
     general-purpose flags `0x0800` (UTF-8 names), DOS time `0x0000`,
     DOS date `0x0021` (1980-01-01), CRC-32 of the bytes, compressed size =
     size, no extra fields, no comments, internal and external attributes 0,
     disk number 0.
   - EOCD: disk 0, CD disk 0, entry counts, CD size, CD offset, comment length 0.
   - No data descriptors and no ZIP64. A comic needing ZIP64 (more than
     65,535 entries or 4 GiB) is refused; the 1 GiB limit keeps clear of it.

Reference vector, from `python3 scripts/comic-cbz-reference.py`. Input entries (name → bytes, UTF-8 / hex shown as escapes):

| Name | Bytes |
| --- | --- |
| `Comic/ComicInfo.xml` | `<?xml version="1.0"?><ComicInfo><Series>Vector</Series></ComicInfo>` |
| `Comic/page10.jpg` | `\xff\xd8\xff ten` |
| `Comic/page2.JPG` | `\xff\xd8\xff two` |
| `Comic/page02b.png` | `\x89PNG two-b` |
| `Comic/Cover.webp` | `RIFF cover` |
| `Comic/__MACOSX/._page2.jpg` | `junk` |
| `Comic/.hidden.jpg` | `hidden` |
| `Comic/notes.txt` | `notes` |
| `Comic/extras/001.jpg` | `\xff\xd8\xff extra` |

Pages, in order: `Comic/Cover.webp`, `Comic/extras/001.jpg`, `Comic/page2.JPG`,
`Comic/page02b.png`, `Comic/page10.jpg`; then `Comic/ComicInfo.xml`.
The CBZ is **794 bytes** with SHA-256
`f425a5b825fd0263e84f6a9106d6ca08e240adb2982c0007e4c644835dace109`.
Both client implementations must reproduce it exactly in their tests.

## Page selection and order

Shared by the API (cover), web and mobile readers, for CBZs from any source.

- **Page selection**: a file entry is a page when its name (after `\` → `/`)
  ends, case-insensitively, in `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`,
  `.avif` or `.bmp`, and no path segment starts with `.` or equals `__MACOSX`.
  Encrypted entries (flag bit 0) make the archive invalid.
- **Page order**: natural sort on the full lower-cased name. Split each name
  into maximal runs of ASCII digits and non-digits and compare run by run:
  - a digit run sorts before a non-digit run;
  - two digit runs compare by numeric value (leading zeros stripped: shorter
    first, then lexically), then the run with fewer leading zeros first;
  - two non-digit runs compare by UTF-16 code units;
  - if all shared runs are equal, the name with fewer runs first;
  - final tie-break: code-unit order of the original (not lower-cased) names.

Sort vector: `p1.jpg, p01.jpg, p001.jpg, p2.jpg, P3.jpg, p10.jpg, a/p9.jpg,
a/p10.jpg, b/p1.jpg, cover.jpg, x 2.jpg, x 10.jpg` sorts to
`a/p9.jpg, a/p10.jpg, b/p1.jpg, cover.jpg, p1.jpg, p01.jpg, p001.jpg, p2.jpg,
P3.jpg, p10.jpg, x 2.jpg, x 10.jpg`.

## Metadata

From `ComicInfo.xml` when present, else the file name:

- `title`: `Series #Number: Title` composed from the fields present (`Series`
  alone, `Series #Number`, or `Title` alone), else the file name without its
  extension, `_` → space, trimmed.
- `author`: `Writer`, else `Penciller`, else `Unknown`.
- `description`: `Summary`, else empty. `language`: `LanguageISO` if valid,
  else `en`. `subjects`: `["Comics"]` plus `Genre` entries (comma separated),
  deduplicated, at most 32.

## API

- `Book` gains `format: "epub" | "comic"`. Clients treat a missing `format`
  as `"epub"` (older servers).
- `POST /v1/uploads/prepare` accepts optional `format` (default `"epub"`).
  Comics: id `comic-<sha256>`, object key `uploads/<sha256>.cbz`, maximum
  **1 GiB** (EPUBs keep 512 MiB). Same single/multipart thresholds.
- Uploads of comics use `Content-Type: application/vnd.comicbook+zip`.
- Completion validates a comic as a ZIP with at least one page, safe names,
  at most 10,000 entries, no encryption, and stores page 1 as its cover
  (same size limits as EPUB covers; a page that is too large means no cover).
- `GET /v1/books/:id/download` serves comics as
  `application/vnd.comicbook+zip` with a `.cbz` file name. Range, If-Range,
  ETag and HEAD behave as for EPUBs: clients read the central directory from
  the tail and fetch single pages by range while the full file downloads.
- D1 migration `0008_comics.sql` adds `format TEXT NOT NULL DEFAULT 'epub'`
  to `uploaded_books` and `pending_uploads`.

## Reading position

Comic positions ride the existing `progress` sync change and locator shape:

```json
{
  "href": "Comic/page10.jpg",
  "progression": 0,
  "totalProgression": 0.75,
  "title": "Page 5 of 5",
  "engine": "comic",
  "raw": { "page": 4, "pages": 5 }
}
```

`raw.page` is the 0-based index of the first page visible (the left page of a
spread), `href` its entry name; `totalProgression` is `page / (pages - 1)`
(1 when there is one page). Readers restore by `href` first, then `raw.page`.
Sessions (reading time) work as for books. Highlight changes never reference
comics.

## Layout and motion

- **Single page**: phones in portrait (Flutter: `shortestSide < 600` and
  portrait; web: viewport narrower than 768 px and taller than wide).
- **Two-page spreads**: everything else (landscape phones, tablets, desktop
  web). The cover (page 1) stands alone on the right; then pages pair
  (2–3, 4–5, …). A page wider than it is tall is a double-page scan and
  takes a whole spread alone; pairing continues after it. A trailing odd
  page stands alone on the left.
- **Page turn**: a 3D hinge flip. In spreads the turning leaf rotates around
  the spine (its back shows the next spread's left page); single pages hinge
  on their left edge. Driven by arrow keys / Page Up / Page Down / Space on
  the web, taps on the outer thirds and swipes on touch screens, with the
  leaf following the finger during a drag. Reduced motion uses a short
  cross-fade instead.
- Images are decoded at display size, neighbours are preloaded so a flip
  never waits, and only a few spreads stay decoded at once.

## Downloads

Comics are large, so their download never blocks the interface:

- **Mobile**: the transfer is handed to the OS (`background_downloader`:
  `URLSession` background transfer on iOS, WorkManager on Android with a
  progress notification), so it continues while the app is in the background
  or suspended and is reconciled on the next launch. While it runs, the
  reader can already open the comic: it reads the CBZ directory and the pages
  it shows by HTTP range. The file becomes the offline copy only after its
  size and SHA-256 match.
- **Web**: the existing progressive range download (tail first, reader
  demands first) runs in the app while the user keeps browsing or reads.
  Completed comics are kept in IndexedDB like EPUBs.
