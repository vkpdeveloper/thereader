import 'package:flutter/widgets.dart';

import 'data/api/api_client.dart';
import 'data/import/epub_import_service.dart';
import 'data/repositories/highlight_repository.dart';
import 'data/repositories/sync_repository.dart';
import 'data/api/catalog_source.dart';
import 'data/models/settings.dart';
import 'data/models/library.dart';
import 'data/models/book.dart';
import 'data/repositories/catalog_repository.dart';
import 'data/repositories/library_repository.dart';
import 'data/repositories/settings_repository.dart';
import 'reader/engine/reader_engine.dart';

/// Composition root handed down the tree. Deliberately tiny: three
/// repositories, the reader service, and a catalog source that follows the
/// configured API URL.
class AppServices {
  AppServices({
    required this.settings,
    required this.library,
    required this.readerService,
    CatalogSource? catalogSource,
    this.imports,
    this.sync,
    this.highlights,
  }) : _fixed = catalogSource {
    catalog = CatalogRepository(sourceFor(settings.settings));
    settings.addListener(_onSettings);
  }

  final EpubImportService? imports;
  final SyncRepository? sync;

  /// Null in widget tests that do not exercise annotations.
  final HighlightRepository? highlights;
  final SettingsRepository settings;
  final LibraryRepository library;
  final ReaderService readerService;
  late final CatalogRepository catalog;

  /// Test-only catalog injection (bundled fixtures). Shipping builds never set
  /// it, so the catalog always follows the saved API URL.
  final CatalogSource? _fixed;
  final Map<String, ApiCatalogSource> _apis = {};
  SampleCatalogSource? _legacySamples;

  CatalogSource sourceFor(AppSettings s) {
    final fixed = _fixed;
    if (fixed != null) return fixed;
    Uri uri;
    try {
      uri = ApiClient.normalizeBaseUrl(s.apiBaseUrl);
    } on ApiException {
      // A corrupt/legacy saved URL must not prevent access to offline books.
      uri = Uri.parse('http://invalid.invalid/');
    }
    return _apis.putIfAbsent(
      uri.toString(),
      () => ApiCatalogSource(ApiClient(baseUrl: uri.toString())),
    );
  }

  /// Source for an already-added library entry (so re-downloads use the
  /// origin the entry came from when possible). Entries downloaded by earlier
  /// builds' sample mode stay readable from disk; their bundled origin is
  /// resolved lazily and never becomes the browsing source.
  CatalogSource sourceForEntry(LibraryEntry entry) {
    if (entry.source == BookSource.sample) {
      final fixed = _fixed;
      if (fixed != null && fixed.source == BookSource.sample) return fixed;
      return _legacySamples ??= SampleCatalogSource();
    }
    return _apis.putIfAbsent(
      entry.origin,
      () => ApiCatalogSource(ApiClient(baseUrl: entry.origin)),
    );
  }

  CatalogSource get currentSource => sourceFor(settings.settings);

  void _onSettings() => catalog.replaceSource(sourceFor(settings.settings));

  void dispose() {
    imports?.dispose();
    sync?.dispose();
    settings.removeListener(_onSettings);
    catalog.dispose();
    for (final source in _apis.values) {
      source.client.close();
    }
  }
}

class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.services, required super.child});

  final AppServices services;

  static AppServices of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.services;

  @override
  bool updateShouldNotify(AppScope oldWidget) => services != oldWidget.services;
}
