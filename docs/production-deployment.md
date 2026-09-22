# Production deployment — 2026-09-22

The user authorized creating the Worker, R2 bucket and custom API domain, then
uploading one EPUB from the supplied local library for an actual app test.

## Resources

- API: `https://reader.ordinity.com`.
- Worker: `thereader-api`; production version
  `f89cb1ae-98f0-4a07-a675-4313fc1b2efd`, deployed at 100% traffic.
- R2: `thereader-books`, Standard storage, APAC placement.
- Native Worker binding: `BOOKS`. No R2 S3 keys or Worker runtime secrets.
- Workers custom domain provides DNS and TLS. workers.dev and version previews
  are disabled. The bucket's r2.dev access is disabled and no bucket custom domain
  is attached.
- The read API intentionally has no login, matching the personal-app requirement.
  Its catalog and catalog-listed downloads are publicly reachable; there is no
  public write/upload endpoint.

Wrangler's OAuth credential is stored outside the repository in its encrypted
configuration, with the encryption key in macOS Keychain. Its authorization covers
account/user/zone reads and Workers/scripts/routes writes. No deployment token is
embedded in the Worker or Flutter app. GitHub repository visibility remains private.

Production uses `--env production`; default local commands retain the separate
example bucket and local persistence. See the API README for deployment and import
commands. Upload objects before replacing the catalog; merge future imports into
the existing remote catalog.

## Seed and HTTP verification

The selected EPUB is **The Wheel of Time Companion**, 4,995,997 bytes. The real
metadata and 109,464-byte JPEG cover were extracted from the EPUB. Its immutable
edition key uses the checksum prefix; the original EPUB was uploaded unchanged.
SHA-256:
`367f1364a03de58733362a6e12ccca0bcd5a04e6c8bac1511f87f82658d34e87`.

Verified against the deployed HTTPS endpoint:

- Health and catalog return successfully; book detail matches catalog metadata.
- Full download length and SHA-256 match the local original.
- Range `bytes=0-1023` returns 206, the exact bytes, and correct Content-Range.
- Matching If-None-Match returns 304 without a body.
- Cover response bytes match the extracted JPEG.
- Search finds the book, CORS preflight passes, and POST to the catalog returns 405.
- Public catalog omits internal R2 object keys.

Public DNS resolved correctly through Cloudflare and Google immediately after
deployment. This Mac's configured upstream resolver had cached the earlier
NXDOMAIN response. Initial HTTP checks used curl's `--resolve` with the actual
public DNS address, retaining the real HTTPS hostname and certificate validation.
This distinction matters for interpreting the initial local DNS failure.

Private inputs, downloaded copies, response headers and structured verification
results are under ignored `artifacts/private/production-seed/`. No real EPUB,
extracted cover, credential or private input manifest was committed. Original
generated sample EPUBs remain intentionally tracked as development fixtures.

## App verification

Fresh installs default to API mode at `https://reader.ordinity.com`. Existing saved
sample mode, local endpoints and custom URLs are preserved. Flutter analysis and
28 tests pass, including five settings/default/migration cases. The Worker has
20 passing tests and passing typechecks and production deployment dry run.

Native remote-rendering and recording results will be recorded after the normal
installed applications complete the production walkthrough. The earlier complete
three-book native/local/offline results remain in `native-verification.md`.
