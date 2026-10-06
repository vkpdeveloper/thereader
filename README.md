# The Reader

A personal, always-dark EPUB and MOBI reader for iOS and Android. Flutter supplies the
interface; a small TypeScript Cloudflare Worker serves a catalog and books from R2.
Books stay on the phone for offline reading; D1 syncs position, reading time and
typography across devices. Native EPUB and MOBI imports upload to R2 as EPUBs while remaining
readable from their local copy. No login or accounts.

## Workspace

- `apps/mobile`: Flutter application.
- `apps/web`: browser reader (Vite + React), served by the API.
- `apps/api`: Cloudflare Worker, local R2 fixtures, and Bun development tooling.
- `packages/truffle`: Truffle, the article extraction engine (TypeScript, npm name `truffle`).
- `packages/truffle_dart`: its Dart port, the engine the mobile app runs (pub name `truffle`).
- `eval`: extraction quality and speed against other engines.
- `docs/api-contract.md`: shared HTTP contract and application scope.

Apps use Truffle as an installed package, through two workspaces at the repository root:

- Bun: `package.json` lists `apps/web`, `packages/truffle` and `eval`; consumers declare
  `"truffle": "workspace:*"` and `import … from 'truffle'`. One `bun.lock` at the root.
- Dart: `pubspec.yaml` lists `apps/mobile` and `packages/truffle_dart`; consumers declare
  `truffle: ^0.1.0` and `import 'package:truffle/truffle.dart'`. One `pubspec.lock` at the root.

`apps/api` does not use Truffle and stays outside the Bun workspace with its own lockfile.

## Runtime boundary

Bun installs dependencies and runs backend development scripts. The deployed API
runs in Cloudflare Workers' runtime, using its `fetch` handler, R2 bindings, and Web
APIs. Bun server and filesystem APIs are not available in that deployed handler.

## Local development

Each application has its own setup instructions; lockfiles are per workspace (above). The local
API normally listens on port 8787. Connect the Flutter app to
`http://127.0.0.1:8787`; Android emulators use `http://10.0.2.2:8787` instead.
Physical devices need a reachable development-machine address.

The shipping app always uses the configured API. Original bundled books remain
explicit test fixtures only; there is no Sample mode in the interface.

## Scope

EPUB reading, with on-device MOBI conversion. A pure-black Default theme plus optional dark editor-inspired themes.
A quiet library, search, downloads, reading controls,
typography preferences, EPUB and MOBI imports, and cloud reading-state sync. No PDF,
audiobook, social, purchase, or user-account features.

## Production API

The API is deployed at `https://reader.ordinity.com`. Check
[/health](https://reader.ordinity.com/health) or the
[catalog](https://reader.ordinity.com/v1/books). Fresh mobile installs use this API;
existing custom API addresses are preserved. Legacy Sample mode settings migrate
to the API.

See [deployment verification](docs/production-deployment.md), the application
READMEs, and [native verification](docs/native-verification.md) for evidence and
remaining platform limits. [Progressive reading](docs/progressive-reading.md)
describes early opening, background caching and offline verification.
[Import and cloud sync](docs/cloud-sync.md) covers D1, resumable uploads and
conflict handling.

[EPUB covers and themes](docs/covers-themes.md) documents cover extraction, offline
image caching, the quiet Library, and selectable theme previews.
[Drawing on articles](docs/article-pen.md) covers the web article reader's pen.
