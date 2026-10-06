# The Reader API

A small, unauthenticated Cloudflare Worker API backed by R2 and D1. Bun is used
for package management and local scripts; the deployed request handler uses only
Cloudflare Workers bindings and Web Platform APIs.

This is one deliberately shared personal profile. Anyone who can reach the API
can read its catalog and sync state, upload EPUBs, and change that state. There
are no accounts, login flows, bearer tokens, API keys, or per-device access
controls. Keep the deployment URL private if that shared behavior is not wanted.

## Local setup

Install dependencies, generate the three original EPUB samples, and seed Wrangler's local R2 store:

```sh
bun install
bun run seed:local
bun run dev
```

The API is available at `http://127.0.0.1:8787`. `seed:local` is safe to repeat. It always regenerates byte-identical EPUB files and uploads them through Wrangler into `.wrangler/state`, the same local state used by `dev`.

For an explicitly authorized private EPUB corpus, `bun run scripts/import-local.ts
<private-manifest.json>` imports into local R2 only. The input has
`selected: [{role, source}]`, with absolute local EPUB paths. It streams checksums,
uses neutral catalog aliases, and writes its generated catalog beneath ignored
`.wrangler/`. Run fixture generation first. See
[native verification](../../docs/native-verification.md) for the three-role corpus
and mobile walkthrough. Never commit the manifest, EPUBs or extracted pages.

Useful checks:

```sh
bun run typecheck
bun run test
bunx wrangler deploy --dry-run
```

## Storage layout

- `catalog/v1/manifest.json` is a bounded, runtime-validated manifest.
- `books/<id>/<edition>.epub` contains EPUB editions that publishing tools must
  treat as immutable.
- `uploads/<sha256>.epub` contains device uploads verified by R2 SHA-256 and a
  bounded EPUB ZIP structure check before their D1 catalog row is published.
- `covers/<sha256>.<ext>` contains immutable embedded cover bytes extracted from
  a verified uploaded edition. D1 records the cover ID, object key, MIME type,
  byte length and R2 ETag.
- The separate `CDN` bucket (`thereader-cdn`) holds public static files such
  as the web app's Libron faces, mirrored from `cdn/` by
  `bun run cdn:publish`. The Worker serves `GET /cdn/<key>` with immutable
  caching and keeps each object in the edge cache after its first R2 read.
  Keys are versioned and never overwritten.
- D1 stores uploaded catalog rows, pending upload metadata, and the shared sync
  state. Apply `migrations/*.sql` before starting the Worker.

The manifest includes the public book metadata, the private R2 object key, and
the real byte length and SHA-256 checksum generated from each EPUB. The Worker
never exposes R2 credentials. Uploads stream through the server-side R2 binding
with a 512 MiB application limit.

## Upload and sync contract

`POST /v1/uploads/prepare` accepts
`{sha256,fileSize,title,author,description,language,subjects}` and returns
`{book,uploaded,uploadUrl,multipart}`. New IDs are `epub-<full-sha256>`; a
matching legacy manifest object keeps its legacy ID. Files up to 64 MiB use the
relative `uploadUrl`: send the exact raw EPUB with `PUT`, `Content-Type:
application/epub+zip`, and the prepared `Content-Length`.

Larger files use the returned `{uploadId,partSize,parts}` multipart state. The
production part size is 8 MiB and the final part carries the exact remainder.
Upload missing parts with `PUT /v1/uploads/:sha256/parts/:partNumber`, raw
`application/octet-stream`, the exact part `Content-Length`, and
`X-Upload-Id`. Each successful part returns `{partNumber,etag}`. Repeating
prepare returns the same current session and its saved parts, so a client can
resume after restarting. Finish with `POST /v1/uploads/:sha256/complete` and
`{"uploadId":"..."}`. The Worker completes R2, streams the complete object
through native SHA-256, checks its bounded EPUB structure, and only then
publishes the D1 catalog row. A checksum or EPUB failure deletes the completed
object and clears saved parts so prepare can create a clean session.

Publishing is idempotent by SHA. Multipart ETags only identify R2 parts and are
never treated as a whole-file checksum. R2 automatically aborts incomplete
multipart sessions after seven days; pending D1 rows stop counting against the
100-session application queue after 24 hours.

Before an upload becomes visible, the Worker resolves embedded artwork in EPUB
3 `cover-image` properties, EPUB 2 `meta name="cover"`, guide cover documents,
and conventional cover manifest entries. JPEG, PNG, WebP and GIF covers are
signature/dimension checked up to 4 MiB. Standalone SVG covers are limited to 2
MiB and rejected if they contain active content or external resources. Books
with no embedded image return `coverId:null` and `coverUrl:null`; a declared but
invalid cover rejects publication instead of being silently marked missing.
Extracted covers use `cover-<book-sha256>` and the canonical
`/v1/books/:id/cover` URL with immutable caching, ETag revalidation, GET and
HEAD. Repeating prepare for a published pre-migration D1 upload performs the
same bounded extraction once and records `cover_checked_at`, which is the
operator backfill path and requires no public maintenance endpoint.

`GET /v1/sync` returns the full shared state. `POST /v1/sync` accepts up to 100
edition-pinned changes in `{deviceId,changes}` and returns the merged state plus
`acceptedChangeIds`. Progress, library membership, and preferences use
last-write-wins ordering by `(updatedAt,id)`. Reading sessions use a stable
device/session ID and cumulative milliseconds; retries take the maximum instead
of adding time twice. Requests are atomic and state above 1,000 book editions
returns `SYNC_STATE_TOO_LARGE` instead of silently truncating.

Progress payloads are Flutter `ReadingLocator` JSON: a non-empty `href` up to
4,096 characters, `progression` in 0–1, and optional nullable
`totalProgression`, `title`, `engine`, and object-valued `raw`. Preference
payloads are `{value:{...}}`; known fields are checked against the app's reader
settings (`fontSize` 14–28, `lineHeight` 1.2–2.2, `marginScale` 0.5–2,
`font` serif/sans, `flow` scrolled/paginated, and Boolean `justify` and
`keepAwake`). Optional `themeId` accepts `default`, `dracula`, `nord`,
`tokyo-night`, `catppuccin-mocha`, or `gruvbox`. Settings may be omitted to use client defaults. Unknown preference
fields are retained so newer clients can add settings without breaking older
Workers. Accepted preference changes merge supplied fields into the current
value, so an older client that changes typography without a `themeId` does not
erase a theme selected by a newer client. Optional `highlightColor` is a
lowercase colour key (`yellow`, `green`, …) up to 16 letters.

Highlights ride on the same request. A `highlight` change carries
`{highlightId,locator,text,color,note?,createdAt,deleted}`: `highlightId` is the
client UUID, `locator` is the Readium locator JSON (non-empty `href`, at most
16 KB), `text` is at most 4,000 characters, `color` is a semantic key the client
resolves per theme, and `deleted:true` writes a tombstone. Writes are
last-write-wins by `(updatedAt,id)` and cannot move a highlight to another
edition. Every accepted write takes a new server `rev`. To pull, add
`highlightsSince` to the request body (`null` for the full set, or the last
`cursor` seen). The response then includes
`highlights:{items,cursor,more}`: only rows changed since that rev, tombstones
included, at most 500 per response. When `more` is true, the client pulls again
from `cursor`. Requests without `highlightsSince` get the old response shape and
cost no extra reads.

Saved web articles ride on the same request too, with the sentinel edition
`bookId:"_articles"`, `sha256` of 64 zeros. An `article` change carries the
article's metadata `{articleId,url,title,siteName,byline,excerpt,leadImage,
favicon,language,dir,wordCount,readingMinutes,blockCount,publishedAt,savedAt,
bodySha256,bodySize,schema:1,deleted:false}` or a tombstone
`{articleId,deleted:true}`; `articleId` is 32 lowercase hex characters that
clients derive from the article URL. Saves and tombstones are last-write-wins
by `(updatedAt,id)`; a save newer than a tombstone resurrects the article with
an empty position. An `articleProgress` change carries
`{articleId,position:{block,offset,percent}}` and moves the position of a live
article only, on its own `(updatedAt,id)` clock. Within a batch, saves are
applied before positions. To pull, add `articlesSince` (`null` or the last
`cursor`); the response then includes `articles:{items,cursor,more}`, at most
200 rows per response, tombstones included. Field limits: URL 2,048 characters
(`http`/`https`), title 1,000, site name 300, byline 500, excerpt 2,000, image
URLs 2,048 (`http`, `https` or `data:image/`), language 35, `publishedAt` 64.

`PUT /v1/article-bodies/:sha256` stores an article's extracted document, the
exact JSON bytes whose SHA-256 the client recorded, as `application/json` or
`application/gzip` (gzip-compressed JSON). The Worker checks the uncompressed
size (at most 8 MB), the SHA-256 and that the JSON is an object with
`schema:1`, a string `url` and `title` and a `blocks` array, then stores the
bytes as sent under `articles/<sha256>` in R2. The first upload answers `201`,
repeats `200` without writing. `GET`/`HEAD` serve the stored bytes with their
type, `ETag` and immutable caching. Errors: `413 TOO_LARGE`,
`415 UNSUPPORTED_MEDIA_TYPE`, `422 CHECKSUM_MISMATCH`, `422 INVALID_ARTICLE`,
`404 NOT_FOUND`. The Worker never fetches or extracts article pages for sync.

Sync changes are keyed by the supplied `(bookId,sha256)` and do not require the
edition to be present in the catalog. This keeps a cancelled or still-pending
upload from rejecting unrelated changes in the same atomic batch. Clients skip
state for catalog editions they cannot resolve.

When R2 exposes an object SHA-256 checksum, the Worker verifies it against the
catalog before serving bytes. Objects uploaded by existing Wrangler workflows may
only expose an MD5 checksum; those remain compatible, but their sparse ranges
cannot be checked cryptographically by the Worker. For those objects, correctness
depends on treating the edition key as immutable, using the catalog checksum as
the HTTP ETag, pinning resumed reads to the observed R2 ETag, and verifying the
complete SHA-256 in the client. A hash-like object name is a convention and does
not prevent an R2 key from being overwritten.

## Production deployment

The `production` environment targets `https://reader.ordinity.com` with Worker
`thereader-api` and the separate R2 bucket `thereader-books`. The default
environment retains the local example bucket so local fixture commands cannot
overwrite production data. Deploy with `bun run deploy` (equivalent to
`bunx wrangler deploy --env production`). The custom domain manages DNS and TLS;
the workers.dev and version preview URLs are disabled.

The default local D1 binding uses an invalid all-zero placeholder because
Wrangler's local store does not need a remote database. The production binding
points at the private `thereader-state` database by its non-secret ID. Remote
migrations must be applied before the code that needs them is deployed, and
must stay additive (no `DROP` or data rewrites) because they run unattended.

Cloudflare Workers Builds deploys every push to `main` that touches
`apps/api/*` (root directory `apps/api`, build command `bun run test`, deploy
command `bun run deploy:ci`, preview builds disabled). `deploy:ci` applies
pending production D1 migrations and then deploys, so the build token needs
D1 Edit in addition to the default Workers permissions. Repository scripts
never provision remote resources.

Authenticate Wrangler outside the repository. Prefer `wrangler login
--use-keyring` on macOS; CI can supply a scoped `CLOUDFLARE_API_TOKEN` through its
secret store. Never put deployment credentials in Wrangler `vars`, app code, or
tracked files. The Worker uses native `BOOKS` and `DB` bindings: no S3 access
keys or runtime secrets are required. R2 public access stays disabled.

For the initial authorized provisioning:

```sh
bunx wrangler r2 bucket create thereader-books --env production --location apac
```

Upload EPUBs and covers first with `wrangler r2 object put
thereader-books/<object-key> --env production --remote --file <local-file>
--content-type <mime-type>`. Then publish `catalog/v1/manifest.json` the same way
with `application/json`. Use content-addressed edition keys, actual byte lengths
and SHA-256 checksums. Read and merge the existing catalog before later imports;
do not replace it with the local fixture manifest. Keep personal EPUBs, catalog
input files, and extracted covers under ignored `artifacts/private/`.

Verify `/health`, `/v1/books`, a complete download checksum, byte ranges, cover
loading and actual mobile rendering after deployment. A successful health request
alone does not verify R2 or the catalog.
