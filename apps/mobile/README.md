# The Reader (mobile)

Flutter app for iOS, Android and a browser preview. Always dark, with native
EPUB and MOBI imports; MOBI is converted on device to EPUB for reading and sync.
No accounts. See `docs/api-contract.md` at the repository root for the API.

## Run

```sh
flutter pub get
flutter run -d "iPhone 17"          # iOS simulator (preferred for review)
flutter run -d chrome               # browser preview (in-memory downloads)
flutter build apk --debug           # Android
flutter build apk --release --split-per-abi --target-platform android-arm64
flutter build ios --release --no-codesign
```

Fresh installs use `https://reader.ordinity.com`. Existing custom API URLs are
preserved; Sample mode has been removed. For local development, enter
`http://127.0.0.1:8787` on the iOS simulator or `http://10.0.2.2:8787` on the
Android emulator. The health check button calls `GET /health`.

## Android releases

Pull requests targeting `main` run the Android analysis, tests, and signed
**release** APK build before merge. Every push to `main`, including a merged
pull request, also keeps the APK as a GitHub Actions artifact for 90 days and
publishes it on a versioned GitHub release. The workflow can be run manually
from Actions.

The version starts from `pubspec.yaml` (`0.1.0+2`) and adds the workflow run
number to the patch and Android build code. For example, run 4 produces
`v0.1.4` with build code `6`. Failed runs and PR checks can leave gaps in
published versions. To change the major or minor version, update `pubspec.yaml`
and keep its build code at least as high as the previous source value.

The release build uses the checked-in `ci-debug-signing.p12` key. Its password
is public (`android`), so these APKs are suitable for direct installation and
updates from this repository, not for Play Store distribution. Keep this key
unchanged to allow one GitHub release to update another.

## Layout

```
lib/
  core/theme/        tokens.dart (palette, spacing, type), app_theme.dart
  data/
    models/          Book, LibraryEntry, DownloadState, ReadingLocator, settings
    api/             ApiClient (HTTP, relative URL resolution, error envelopes),
                     CatalogSource (ApiCatalogSource | SampleCatalogSource)
    storage/         KeyValueStore (SharedPreferences | memory),
                     BookStore (durable app-support dir | in-memory on web)
    download/        Downloader: streamed write + chunked SHA-256 + size check
    import/          EPUB/MOBI picker, MOBI conversion, bounded EPUB metadata, resumable R2 upload
    repositories/    SettingsRepository, LibraryRepository, CatalogRepository,
                     SyncRepository (durable outbox and foreground reading sessions)
  reader/
    engine/          ReaderEngine / ReaderController / ReaderService boundary
    dart_engine/     built-in EPUB engine (package parser + renderer)
    readium_engine/  native Readium engine via flutter_readium (see docs/reader-engine.md)
  features/          library, catalog, book, reader, settings, shared widgets
assets/samples/      three original sample EPUBs + manifest (tool/make_samples.py)
assets/fonts/        Literata and Inter (SIL OFL)
```

## Checks

```sh
flutter analyze
flutter test
# Test-only bundled fixture walkthrough (no runtime Sample mode):
flutter test integration_test/walkthrough_test.dart -d <simulator-id> --dart-define=THEREADER_BUNDLED_CATALOG=true
flutter test integration_test/walkthrough_test.dart -d <simulator-id> --dart-define=THEREADER_BUNDLED_CATALOG=true --dart-define=THEREADER_ENGINE=dart
```

Note: `flutter build ios --simulator` currently fails on this machine with a
Flutter tool lipo-ordering check (Xcode 27, dual-arch simulator build).
`flutter run -d <simulator>` and the integration test build work.

See [native verification](../../docs/native-verification.md) for the real local
corpus harness, release sizes, offline process restart procedure, performance
diagnostics, recordings and remaining limitations. Native Readium is pinned with
small local fixes in `vendor/flutter_readium`; its provenance and patch notes are
tracked beside the upstream license. Private books and recordings stay ignored.

See [progressive reading](../../docs/progressive-reading.md) for early native
opening while bytes continue downloading. Partial publications require a
connection; only complete, verified files are marked downloaded.

See [import and cloud sync](../../docs/cloud-sync.md) for native book picking,
local reading during upload, D1 state, offline retry and cross-device behavior.
