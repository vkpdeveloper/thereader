# The Reader API

A small, unauthenticated Cloudflare Worker API backed by an R2 catalog manifest and immutable EPUB objects. Bun is used for package management and local scripts; the deployed request handler uses only Cloudflare Workers and Web Platform APIs.

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
- `books/<id>/v<version>.epub` contains immutable EPUB editions.

The manifest includes the public book metadata, the private R2 object key, and the real byte length and SHA-256 checksum generated from each EPUB. The Worker never exposes R2 credentials and has no public write endpoint.

The Wrangler bucket name is intentionally illustrative. Before a separately authorized remote deployment, create or select the real R2 bucket and update `bucket_name` in `wrangler.jsonc`. No secrets or `.dev.vars` file are needed.
