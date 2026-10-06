# The Reader: application contract

The app is Flutter for iOS and Android. It is always dark, minimal, and EPUB-only.
Backend: TypeScript on Cloudflare Workers. Bun is the package manager, script runner,
and local tooling, not the deployed runtime. R2 holds books; D1 stores uploaded
book metadata and the shared personal reading state.

## Workspace ownership

- `apps/mobile/`: Flutter frontend, Claude Fable 5.1.
- `apps/api/`: Worker backend, Sol 5.6 High.
- `docs/`, root files, integration verification: coordinating agent.

Agents may read all files but should write only their owned directory. The user
authorized a private `vkpdeveloper/thereader` repository and separate commits on
`main`, pushed as each subtask completes. The coordinator owns Git operations to
avoid concurrent staging. The user subsequently authorized provisioning and
deploying the Worker, R2 bucket, custom domain and D1 database.

## HTTP API

Base URL supplied by the user at runtime; local development is normally
`http://127.0.0.1:8787`. Android emulator uses `http://10.0.2.2:8787`.
Paths are versioned beneath `/v1`.

- `GET /health` -> `{ "status": "ok", "service": "thereader-api" }`
- `GET /v1/books?limit=24&cursor=...&q=...` -> `{ "items": Book[], "nextCursor": string | null }`
- `GET /v1/books/:id` -> `{ "book": Book }`
- `GET /v1/books/:id/download` -> streamed `application/epub+zip` bytes, Content-Length,
  ETag, Content-Disposition. Support HEAD and valid single byte ranges if feasible.
- `GET /v1/books/:id/cover` -> optional cover image; 404 if none.
- `GET /v1/article-source?url=...` -> the raw HTML of a public article page (see below).
- `PUT /v1/article-bodies/:sha256`, `GET`/`HEAD /v1/article-bodies/:sha256` -> a saved
  article's extracted document, uploaded once by the device that saved it (see below).

Book fields (all present unless explicitly nullable):

```json
{
  "id": "the-quiet-hour",
  "version": "1",
  "title": "The Quiet Hour",
  "author": "The Reader",
  "description": "An original short reading sample.",
  "language": "en",
  "subjects": ["Essays"],
  "coverUrl": null,
  "downloadUrl": "/v1/books/the-quiet-hour/download",
  "fileSize": 1234,
  "sha256": "64 lowercase hexadecimal characters",
  "updatedAt": "2026-09-22T00:00:00.000Z"
}
```

URLs may be relative to the API origin; the client must resolve them. IDs are URL-safe lowercase slugs.
Book version + checksum identify a file edition. `fileSize` must describe real bytes.

Errors: `{ "error": { "code": "NOT_FOUND", "message": "Book not found." } }`.
Use meaningful HTTP statuses and validate query values and path identifiers.

### Article source relay

`GET /v1/article-source?url=<encoded absolute URL>` lets a browser read an
article page it cannot fetch cross-origin. It is a byte relay: the Worker never
parses the page; clients decode, extract and store the article themselves.

- Only public `http:`/`https:` URLs on default ports: no credentials, IP
  literals, single-label hosts or reserved suffixes (`localhost`, `local`,
  `internal`, `test`, `invalid`, `onion`, `arpa`, `home`, `lan`); at most 2048
  characters. Otherwise `400 INVALID_URL`.
- Up to 5 redirects are followed manually and every hop is re-validated
  (`400 INVALID_URL` for an unsafe hop, `502 TOO_MANY_REDIRECTS` beyond five).
- Upstream requests send a desktop Chrome `User-Agent`,
  `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` and
  `Accept-Language: en-US,en;q=0.9`, with a 15 s budget for the whole exchange
  (`504 UPSTREAM_TIMEOUT`). Connection failures are `502 UPSTREAM_UNREACHABLE`;
  a non-2xx final answer is `502 UPSTREAM_STATUS`.
- Only `text/html` and `application/xhtml+xml` are relayed
  (`415 UNSUPPORTED_MEDIA_TYPE` otherwise); bodies above 8 MB are
  `413 TOO_LARGE`.
- Success: `200` with the raw (decompressed) body, the upstream `Content-Type`
  (charset included), `X-Final-Url` (the URL after redirects, exposed to CORS),
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so opening the relay
  URL in a tab never runs the page's scripts on this origin.

### Saved-article sync

Saved articles sync without the server ever fetching or extracting a page.
The saving device extracts the article and uploads its `Article` JSON
(schema 1) to `PUT /v1/article-bodies/<sha256>` as `application/gzip` (or
`application/json`); the Worker checks the uncompressed size (8 MB, counted
while inflating), the SHA-256 of the uncompressed bytes and, without parsing,
that the document starts with `{"schema":1,` and ends with `}` (clients must
serialize `schema` as the first key, without whitespace), then stores the
bytes as sent. Deleting an article removes its document once no live article
references it; clients upload a document only after its save is accepted.
Other devices `GET` the same path (immutable caching, ETag) and verify the
hash.
Metadata (`url`, `title`, `siteName`, `byline`, `excerpt`, `leadImage`,
`favicon`, `language`, `dir`, `wordCount`, `readingMinutes`, `blockCount`,
`publishedAt`, `savedAt`, `bodySha256`, `bodySize`, `schema`), reading
positions and deletions ride `POST /v1/sync` as `article` and
`articleProgress` changes, pulled with `articlesSince`. Ids, ordering and
limits: [cloud sync](cloud-sync.md#saved-articles) and the
[API README](../apps/api/README.md).

## Personal use: no authentication

The user explicitly requires no login or authentication flow. All reader endpoints
work without bearer tokens, API keys, accounts, or sessions. R2 is accessed by the
Worker binding, not client-side storage credentials. The app needs only an API base
URL. Do not add auth middleware, token entry, or user management.
There is one shared personal profile. Upload and sync endpoints also have no
authentication: anyone with the API URL can access or change that shared state.
No sign-up, purchases, recommendations service or social features.

## Catalog and offline reading

Store a catalog manifest in R2 plus immutable EPUB objects. Provide a deterministic
local seed script with three original, valid reflowable EPUB samples:
`the-quiet-hour`, `a-walk-in-the-rain`, and `notes-on-attention` (author: The Reader).
Do not fetch copyrighted book files or depend on remote cover images for development.
The backend owns generation/seeding of these fixtures and its exact manifest format.

Sample mode is removed from the shipping interface; bundled books are test-only.
Do not silently substitute demo data on network failure. Library/search/filter/book
details/download states/reading settings should work. Full downloaded EPUB files go
in durable application storage, not OS cache; verify integrity before marking ready.
Save locators/preferences locally and preserve books when the network is unavailable.
Put EPUB rendering behind a ReaderService/adapter. Prefer native Readium; if local
SDK/toolchain constraints block the plugin, expose that limitation honestly and keep
the frontend testable without pretending a text preview is EPUB rendering.

## UI direction

App name: The Reader. Editorial and calm, using the exact user-supplied palette in
`docs/design-theme.json` and `docs/design-theme.md`: pure black background, #101010
panels, #1f1f1f elements/borders, #ededed text, #a1a1a1 muted text, #52a8ff primary.
Generous whitespace, exceptional typography, compact controls. No light/sepia theme,
decorative dashboard, gradients, bright neon, PDFs, audio, or platform-native styling
requirement. Brief thoughtful motion and reduced-motion support. Large hit targets
and accessible labels. No fake controls or fake success.

## Imports and D1 sync

The live protocol, validation limits and response examples are documented in
[the API README](../apps/api/README.md). Routes include:

- `POST /v1/uploads/prepare`: SHA-based deduplication and upload preparation.
- `PUT /v1/uploads/:sha`: streamed verified upload up to 64 MiB.
- `PUT /v1/uploads/:sha/parts/:number`: resumable 8 MiB parts for larger EPUBs.
- `POST /v1/uploads/:sha/complete`: whole-object SHA and EPUB validation.
- `GET /v1/sync` and `POST /v1/sync`: library membership, locators, cumulative
  reading sessions, typography preferences, highlights and saved articles.

Maximum EPUB size is 512 MiB. The mobile app first saves and verifies an imported
file locally; it never downloads that same imported file to make it readable.
See [cloud sync](cloud-sync.md) for local persistence, lifecycle and conflicts.
