# Production deployment — 2026-09-22

The user authorized creating the Worker, R2 bucket and custom API domain, then
uploading one EPUB from the supplied local library for an actual app test.

## Resources

- API: `https://reader.ordinity.com`.
- Worker: `thereader-api`; production version
  `55735203-1a70-41f8-8144-b1fa4d05fe71`, deployed at 100% traffic.
  This supersedes the initial deployment `f89cb1ae-98f0-4a07-a675-4313fc1b2efd`.
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

A small production HTTP timing sample used 12 catalog requests at concurrency four
and three sequential complete downloads from the Mac, each with a fresh curl
connection and the same verified HTTPS hostname. All returned 200. Catalog total
time: median 291 ms, maximum 751 ms. The 4,995,997-byte download: median 1,052 ms,
maximum 1,249 ms; median time to first byte 276 ms. These are WAN diagnostic samples
through the Singapore edge, not a stress test, phone benchmark or latency guarantee.
DNS time was excluded by the explicit address resolution. Raw samples are in
`artifacts/private/production-seed/http-timings.json`.

Private inputs, downloaded copies, response headers and structured verification
results are under ignored `artifacts/private/production-seed/`. No real EPUB,
extracted cover, credential or private input manifest was committed. Original
generated sample EPUBs remain intentionally tracked as development fixtures.
The final tracked-file check found no private input/env files, private-key or token
assignment patterns, or real-book copies matching the uploaded SHA-256. This is a
focused repository check, not a claim of comprehensive secret scanning.

## App verification

Fresh installs use `https://reader.ordinity.com`; existing custom API URLs remain
preserved. Runtime Sample mode has been removed, including migration of the old
sample-mode preference to the API. Bundled original EPUB fixtures are available
only through the explicit compile-time integration-test configuration documented
in [native verification](native-verification.md).

The progressive/polish checkpoint has 49 passing Flutter tests, 26 API tests,
three iOS native tests and two Kotlin native tests. Final Flutter analysis is
clean; iOS simulator and Android ARM64 rebuilds succeeded, and both installed
final builds passed their settings/cached-native-reading smoke checks. The earlier deployment run had clean
Flutter analysis, 29 passing Flutter tests and 20 API tests; those historical
counts are not the current suite size.

Android API 36 emulator, normal ARM64 release build 2002: production health and
catalog succeeded, the real cover loaded, and removing/re-downloading the test book
produced a verified local EPUB with the same SHA-256 as the original. Native Readium
rendered the TOC and Introduction; scrolling and reopening preserved the paragraph.
With airplane mode enabled and Wi-Fi disabled, Android reported no active default
network and production health failed. Force-stop/relaunch retained the book, and
three successive native opens rendered the saved paragraph. Wi-Fi was restored,
airplane mode disabled and production health rechecked afterward. The emulator was
returned to non-root adb operation after the read-only file-checksum inspection.

Android's emulator was started with public DNS `1.1.1.1` to avoid the host's stale
negative cache; the app used the unmodified production HTTPS hostname with normal
certificate validation. No host DNS/VPN settings were changed. These are functional
emulator checks, not physical-phone performance measurements.

The production walkthrough exposed an Android blank-reader regression on a repeated
offline reopen. Inspection showed an empty native view container, with the saved
EPUB checksum still intact. Native widget teardown could run twice and an old
widget could close the new global navigator. Cleanup is now idempotent and checks
ownership. The Flutter route guard spans both exit animation and unfinished async
publication opens, so a late abandoned controller cannot close the next book.
Regression coverage includes duplicate opens, reopening during pop, and backing out
during a delayed open followed by a successful later reopen. Failed recordings are
retained privately for diagnosis and are not labeled as passing evidence.
The fix is committed as `7301beb` and verified by the fresh release walkthrough.

## Recordings

Private, Git-ignored recordings are under `artifacts/recordings/`:

- `reader-production-test.mp4` — 152.93 seconds, 6,787,548 bytes. Complete successful
  Android production and offline walkthrough, concatenated from the two clips below
  without cutting their timeline and encoded as H.264 at 30 fps for reliable playback.
  This playback frame rate is not an app performance measurement. The original
  concatenation is retained as `reader-production-test-source.mp4`.
- `android-production-final-online.mp4` — 94.58 seconds. Production connection,
  catalog, cover, fresh download, verification, native content and saved location.
- `android-production-final-offline.mp4` — 58.34 seconds. No active network, failed
  health check, process restart and repeated cached native opens.

The coordinator inspected decoded online/offline video frames showing actual
readable EPUB body text, checked the recordings with ffprobe, and decoded the final
30 fps deliverable completely without errors.
Earlier `first-pass`, `remote-offline` and `offline-supplement` recordings include
the lifecycle failure and must not be presented as the final passing run.

The initial iOS production attempt is separately retained as
`ios-production-dns-pending.mp4`; it shows the real local DNS failure, not a passed
remote reading test. Earlier successful three-book iOS native/local/offline results
remain in `native-verification.md`.

At the end of the initial deployment run, the iOS simulator included `7301beb`
and read cached native EPUBs, but production health still failed local hostname
resolution at 17:25 UTC. That initial recording therefore did not qualify iOS
remote reading. The DNS cache subsequently expired: the later normal-app iPhone
17 simulator run successfully connected to the unchanged production HTTPS URL,
loaded the real catalog/cover, downloaded and verified the EPUB, and rendered
actual Introduction text through native Readium. No DNS override, host network
change or certificate bypass was used for this successful iOS run.

The later iOS session also tested two throttled local real-EPUB transfers, native
reading before completion and cached reading after an API-unavailable process
restart. Both local files matched full-file SHA-256; the production EPUB on disk
matched the original SHA above. See [progressive reading](progressive-reading.md)
for the exact threshold/content observations and their limits. The continuous
recording is `artifacts/recordings/ios-progressive-final.mp4` (581.175 seconds,
34,671,502 bytes, HEVC 1206×2622). It preserves loading states as well as actual
readable content. Screenshots and file hashes are under ignored
`artifacts/private/ios-progressive-*`. The API was restored to production and its
health check passed at the end.

Initial deployment Android APK: `artifacts/private/android-production-lifecycle-arm64.apk`,
25,018,059 bytes, build 2002. The production API URL remains saved on both installed
apps; the later polish build removes the runtime mode selector. Builds and
recordings are local artifacts and were not committed to Git.

The final iOS polish build repeated a fresh throttled typical-book transfer with
provisional preloading disabled: Read unlocked at 5.55%, and native Introduction
text was captured while the badge showed 17%. Completion, API-unavailable process
restart, saved native reading and production-health restoration passed. The
supplemental `ios-progressive-final-polish.mp4` is 118.981667 seconds,
21,584,206 bytes, H.264. Android build 2004 also passed production health, corrected
health-error layout and cached native Introduction rendering; its final smoke is
`android-final-polish.mp4`. The combined Android early-reading/offline evidence is
`android-progressive-verification.mp4` (201.966667 seconds, 5,174,912 bytes).
All paths are under ignored `artifacts/recordings/`; see the progressive-reading
report for complete observations and measurement caveats.
