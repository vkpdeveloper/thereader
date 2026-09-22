import 'package:flutter/widgets.dart';

import 'data/api/api_client.dart';
import 'data/api/catalog_source.dart';
import 'data/models/settings.dart';
import 'data/repositories/catalog_repository.dart';
import 'data/repositories/library_repository.dart';
import 'data/repositories/settings_repository.dart';
import 'reader/engine/reader_engine.dart';

/// Composition root handed down the tree. Deliberately tiny: three
/// repositories, the reader service, and a catalog source that follows the
/// current mode/URL.
class AppServices {
  AppServices({
    required this.settings,
    required this.library,
    required this.readerService,
    SampleCatalogSource? sampleSource,
  }) : _sample = sampleSource ?? SampleCatalogSource() {
    catalog = CatalogRepository(sourceFor(settings.settings));
    settings.addListener(_onSettings);
  }

  final SettingsRepository settings;
  final LibraryRepository library;
  final ReaderService readerService;
  late final CatalogRepository catalog;
  final SampleCatalogSource _sample;
  ApiCatalogSource? _api;

  CatalogSource sourceFor(AppSettings s) {
    if (s.mode == AppMode.sample) return _sample;
    final current = _api;
    Uri? want;
    try {
      want = ApiClient.normalizeBaseUrl(s.apiBaseUrl);
    } on ApiException {
      want = null;
    }
    if (current != null && want != null && current.client.baseUri == want) return current;
    current?.client.close();
    _api = ApiCatalogSource(ApiClient(baseUrl: want?.toString() ?? 'http://invalid.invalid'));
    return _api!;
  }

  /// Source for an already-added library entry (so re-downloads use the
  /// origin the entry came from when possible).
  CatalogSource get currentSource => sourceFor(settings.settings);

  void _onSettings() => catalog.replaceSource(sourceFor(settings.settings));

  void dispose() {
    settings.removeListener(_onSettings);
    catalog.dispose();
    _api?.client.close();
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
