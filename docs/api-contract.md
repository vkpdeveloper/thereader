# The Reader: first application contract

The app is Flutter for iOS and Android. It is always dark, minimal, and EPUB-only.
Backend: TypeScript on Cloudflare Workers. Bun is the package manager, script runner,
and local tooling, not the deployed runtime. R2 holds books and catalog data.

## Workspace ownership

- `apps/mobile/`: Flutter frontend, Claude Fable 5.1.
- `apps/api/`: Worker backend, Sol 5.6 High.
- `docs/`, root files, integration verification: coordinating agent.

Agents may read all files but should write only their owned directory. The user
authorized a private `vkpdeveloper/thereader` repository and separate commits on
`main`, pushed as each subtask completes. The coordinator owns Git operations to
avoid concurrent staging. Do not deploy or provision Cloudflare resources.

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

## Personal use: no authentication

The user explicitly requires no login or authentication flow. All reader endpoints
work without bearer tokens, API keys, accounts, or sessions. R2 is accessed by the
Worker binding, not client-side storage credentials. The app needs only an API base
URL. Do not add auth middleware, token entry, or user management.
No sign-up, purchases, recommendations service, social features, or cloud progress
sync in this first implementation. Reading progress is local.

## Catalog and offline reading

Store a catalog manifest in R2 plus immutable EPUB objects. Provide a deterministic
local seed script with three original, valid reflowable EPUB samples:
`the-quiet-hour`, `a-walk-in-the-rain`, and `notes-on-attention` (author: The Reader).
Do not fetch copyrighted book files or depend on remote cover images for development.
The backend owns generation/seeding of these fixtures and its exact manifest format.

Frontend should support a clearly identified sample/demo mode and a real API mode.
Do not silently substitute demo data on network failure. Library/search/filter/book
details/download states/reading settings should work. Full downloaded EPUB files go
in durable application storage, not OS cache; verify integrity before marking ready.
Save locators/preferences locally and preserve books when the network is unavailable.
Put EPUB rendering behind a ReaderService/adapter. Prefer native Readium; if local
SDK/toolchain constraints block the plugin, expose that limitation honestly and keep
the frontend testable without pretending a text preview is EPUB rendering.

## UI direction

App name: The Reader. Editorial and calm, charcoal near-black surfaces, warm off-white
text, restrained warm accent, generous whitespace, exceptional typography, compact
controls. No light theme, decorative dashboard, gradients, bright neon, PDFs, audio,
or platform-native styling requirement. Brief thoughtful motion and reduced-motion
support. Large hit targets and accessible labels. No fake controls or fake success.
