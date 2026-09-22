import 'package:flutter/foundation.dart';

import '../models/settings.dart';
import '../storage/key_value_store.dart';

/// App mode, API URL and reader preferences. Persisted immediately on change.
class SettingsRepository extends ChangeNotifier {
  SettingsRepository(this._store);

  static const _settingsKey = 'settings.v1';
  static const _readerKey = 'reader_prefs.v1';

  final KeyValueStore _store;
  AppSettings _settings = const AppSettings();
  ReaderPreferences _reader = const ReaderPreferences();
  bool _loaded = false;

  AppSettings get settings => _settings;
  ReaderPreferences get reader => _reader;
  bool get loaded => _loaded;

  Future<void> load() async {
    final s = await _store.readJson(_settingsKey);
    if (s != null) _settings = AppSettings.fromJson(s);
    final r = await _store.readJson(_readerKey);
    if (r != null) _reader = ReaderPreferences.fromJson(r);
    _loaded = true;
    notifyListeners();
  }

  Future<void> setMode(AppMode mode) => _update(_settings.copyWith(mode: mode));

  Future<void> setApiBaseUrl(String url) => _update(_settings.copyWith(apiBaseUrl: url.trim()));

  Future<void> setPreferredEngine(String id) => _update(_settings.copyWith(preferredEngine: id));

  Future<void> _update(AppSettings next) async {
    _settings = next;
    notifyListeners();
    await _store.writeJson(_settingsKey, next.toJson());
  }

  Future<void> updateReader(ReaderPreferences Function(ReaderPreferences) change) async {
    _reader = change(_reader);
    notifyListeners();
    await _store.writeJson(_readerKey, _reader.toJson());
  }
}
