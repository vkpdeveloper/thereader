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
- `books/<id>/<edition>.epub` contains EPUB editions that publishing tools must
  treat as immutable.

The manifest includes the public book metadata, the private R2 object key, and the real byte length and SHA-256 checksum generated from each EPUB. The Worker never exposes R2 credentials and has no public write endpoint.

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

Authenticate Wrangler outside the repository. Prefer `wrangler login
--use-keyring` on macOS; CI can supply a scoped `CLOUDFLARE_API_TOKEN` through its
secret store. Never put deployment credentials in Wrangler `vars`, app code, or
tracked files. The Worker uses the native `BOOKS` binding: no S3 access keys or
runtime secrets are required. R2 public access stays disabled; the unauthenticated
Worker exposes only catalog reads and the books named in the catalog, with no
upload endpoint.

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
