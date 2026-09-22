import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app.dart';
import 'app_scope.dart';
import 'core/theme/app_theme.dart';
import 'data/api/catalog_source.dart';
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
  if (forcedEngine.isNotEmpty && settings.settings.preferredEngine != forcedEngine) {
    await settings.setPreferredEngine(forcedEngine);
  }
  // `--dart-define=THEREADER_BUNDLED_CATALOG=true` swaps the API for the
  // bundled fixture catalog. Only the integration walkthrough sets it; there is
  // no runtime switch, so shipping builds always browse the configured API.
  const bundledCatalog = bool.fromEnvironment('THEREADER_BUNDLED_CATALOG');
  final services = AppServices(
    settings: settings,
    library: library,
    readerService: ReaderService(engines: const [ReadiumReaderEngine(), DartReaderEngine()]),
    catalogSource: bundledCatalog ? SampleCatalogSource() : null,
  );
  // Library loads in the background; the screen shows a quiet line meanwhile.
  library.load();
  runApp(TheReaderApp(services: services));
}
