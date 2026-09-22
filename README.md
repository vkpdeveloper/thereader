# The Reader

A personal, always-dark EPUB reader for iOS and Android. Flutter supplies the
interface; a small TypeScript Cloudflare Worker serves a catalog and books from R2.
Downloaded books and reading progress live on the phone. No login or accounts.

## Workspace

- `apps/mobile`: Flutter application.
- `apps/api`: Cloudflare Worker, local R2 fixtures, and Bun development tooling.
- `docs/api-contract.md`: shared HTTP contract and application scope.

## Runtime boundary

Bun installs dependencies and runs backend development scripts. The deployed API
runs in Cloudflare Workers' runtime, using its `fetch` handler, R2 bindings, and Web
APIs. Bun server and filesystem APIs are not available in that deployed handler.

## Local development

Each application has its own setup instructions and dependency lockfile. The local
API normally listens on port 8787. Connect the Flutter app to
`http://127.0.0.1:8787`; Android emulators use `http://10.0.2.2:8787` instead.
Physical devices need a reachable development-machine address.

Sample books are original development fixtures. Demo/sample mode is distinct from
the live API catalog; connection failures must not silently turn into demo success.

## Scope

EPUB only. One dark theme. A quiet library, search, downloads, reading controls,
typography preferences, and locally saved reading position. No PDF, audiobook,
social, purchase, user-account, or cloud-progress features.

## Production API

The API is deployed at `https://reader.ordinity.com`. Check
[/health](https://reader.ordinity.com/health) or the
[catalog](https://reader.ordinity.com/v1/books). Fresh mobile installs use this API;
existing saved endpoint and sample-mode preferences are preserved.

See [deployment verification](docs/production-deployment.md), the application
READMEs, and [native verification](docs/native-verification.md) for evidence and
remaining platform limits.
