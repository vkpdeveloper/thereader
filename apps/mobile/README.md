# The Reader (mobile)

Flutter app for iOS, Android and a browser preview. Always dark, EPUB only,
no accounts. See `docs/api-contract.md` at the repository root for the API.

## Run

```sh
flutter pub get
flutter run -d "iPhone 17"          # iOS simulator (preferred for review)
flutter run -d chrome               # browser preview (sample mode, in-memory downloads)
flutter build apk --debug           # Android
```

Sample mode is the default and is labelled everywhere. Switch to **Your API**
in Settings and enter the Worker URL (`http://127.0.0.1:8787` on the
simulator, `http://10.0.2.2:8787` on the Android emulator). The health check
button calls `GET /health`.

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
    repositories/    SettingsRepository, LibraryRepository, CatalogRepository
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
# On-device walkthrough (sample mode, default Readium engine or forced Dart engine):
flutter test integration_test/walkthrough_test.dart -d <simulator-id>
flutter test integration_test/walkthrough_test.dart -d <simulator-id> --dart-define=THEREADER_ENGINE=dart
```

Note: `flutter build ios --simulator` currently fails on this machine with a
Flutter tool lipo-ordering check (Xcode 27, dual-arch simulator build).
`flutter run -d <simulator>` and the integration test build work.
