import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app.dart';
import 'app_scope.dart';
import 'core/theme/app_theme.dart';
import 'data/api/catalog_source.dart';
import 'data/api/api_client.dart';
import 'data/articles/article_store.dart';
import 'data/articles/page_fetcher.dart';
import 'data/import/epub_import_service.dart';
import 'data/repositories/article_repository.dart';
import 'data/repositories/highlight_repository.dart';
import 'data/repositories/sync_repository.dart';
import 'data/repositories/library_repository.dart';
import 'data/repositories/settings_repository.dart';
import 'data/storage/book_store.dart';
import 'data/storage/key_value_store.dart';
import 'reader/dart_engine/dart_reader_engine.dart';
import 'reader/engine/reader_engine.dart';
import 'reader/readium_engine/readium_reader_engine.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(AppTheme.overlay);
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);

  final kv = await SharedPreferencesStore.open();
  final bookStore = await BookStore.create();
  final settings = SettingsRepository(kv);
  final library = LibraryRepository(store: kv, bookStore: bookStore);
  await settings.load();
  // `--dart-define=THEREADER_ENGINE=dart|readium` forces the preferred engine
  // (used by the integration walkthrough; never silently in production).
  const forcedEngine = String.fromEnvironment('THEREADER_ENGINE');
  if (forcedEngine.isNotEmpty &&
      settings.settings.preferredEngine != forcedEngine) {
    await settings.setPreferredEngine(forcedEngine);
  }
  // `--dart-define=THEREADER_BUNDLED_CATALOG=true` swaps the API for the
  // bundled fixture catalog. Only the integration walkthrough sets it; there is
  // no runtime switch, so shipping builds always browse the configured API.
  const bundledCatalog = bool.fromEnvironment('THEREADER_BUNDLED_CATALOG');
  final importClients = <String, ApiClient>{};
  final imports = bundledCatalog
      ? null
      : EpubImportService(
          bookStore: bookStore,
          library: library,
          store: kv,
          clientForCurrentOrigin: () {
            final origin = ApiClient.normalizeBaseUrl(
              settings.settings.apiBaseUrl,
            ).toString();
            return importClients.putIfAbsent(
              origin,
              () => ApiClient(baseUrl: origin),
            );
          },
        );
  final highlights = HighlightRepository(kv);
  final articles = ArticleRepository(
    store: kv,
    files: await ArticleStore.create(),
    // The browser preview cannot fetch other sites (CORS); it uses the API's
    // relay at the configured origin.
    fetcher: PageFetcher(relayBase: () => ApiClient.normalizeBaseUrl(settings.settings.apiBaseUrl)),
    // Documents of articles saved on other devices download from the API.
    cloud: bundledCatalog ? null : () => ApiClient(baseUrl: settings.settings.apiBaseUrl),
  );
  final sync = bundledCatalog
      ? null
      : SyncRepository(
          store: kv,
          library: library,
          settings: settings,
          highlights: highlights,
          articles: articles,
          isUploadPending: (id) => imports?.isPending(id) ?? false,
          retryUploads: () => unawaited(imports?.retryPending()),
        );
  if (sync != null) imports?.addListener(sync.uploadsChanged);
  final services = AppServices(
    settings: settings,
    library: library,
    imports: imports,
    sync: sync,
    highlights: highlights,
    articles: articles,
    readerService: ReaderService(
      engines: const [ReadiumReaderEngine(), DartReaderEngine()],
    ),
    catalogSource: bundledCatalog ? SampleCatalogSource() : null,
  );
  // Library loads in the background; external files only wait for local state,
  // not for upload and sync setup, before opening the reader.
  final libraryReady = library.load();
  unawaited(articles.load());
  Future<void> loadPersonalLibrary() async {
    await libraryReady;
    await imports?.load();
    await highlights.load();
    await sync?.load();
  }

  unawaited(loadPersonalLibrary());
  runApp(TheReaderApp(services: services, libraryReady: libraryReady));
}
