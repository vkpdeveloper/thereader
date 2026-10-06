import 'package:flutter/foundation.dart';

import '../../core/typography/reader_fonts.dart';
import '../models/settings.dart';
import '../storage/key_value_store.dart';

/// API URL, preferred engine and reader preferences. Persisted immediately on
/// change, on this device only: none of it syncs.
class SettingsRepository extends ChangeNotifier {
  SettingsRepository(this._store);

  static const _settingsKey = 'settings.v1';
  static const _readerKey = 'reader_prefs.v1';

  final KeyValueStore _store;
  AppSettings _settings = const AppSettings();
  ReaderPreferences _reader = const ReaderPreferences();
  bool _loaded = false;
  Future<void> _readerWrites = Future.value();

  AppSettings get settings => _settings;
  ReaderPreferences get reader => _reader;
  bool get loaded => _loaded;

  Future<void> load() async {
    final s = await _store.readJson(_settingsKey);
    if (s != null) _settings = AppSettings.fromJson(s);
    final r = await _store.readJson(_readerKey);
    // Older builds stored an `_updatedAt` for sync; it is ignored.
    if (r != null) _reader = ReaderPreferences.fromJson(r);
    _loaded = true;
    notifyListeners();
  }

  Future<void> setApiBaseUrl(String url) =>
      _update(_settings.copyWith(apiBaseUrl: url.trim()));

  Future<void> setPreferredEngine(String id) =>
      _update(_settings.copyWith(preferredEngine: id));

  Future<void> _update(AppSettings next) async {
    _settings = next;
    notifyListeners();
    await _store.writeJson(_settingsKey, next.toJson());
  }

  /// Chooses a colour preset. Stored on the reader preferences, so like them
  /// it applies to this device only.
  Future<void> setThemeId(String id) => updateReader((r) => r.copyWith(themeId: id));

  /// Writes the id plus its legacy serif/sans class; see [ReaderFonts.select].
  Future<void> setFontFamily(ReaderFontFamily family) => updateReader((r) => ReaderFonts.select(r, family));

  Future<void> updateReader(
    ReaderPreferences Function(ReaderPreferences) change,
  ) async {
    _reader = change(_reader);
    notifyListeners();
    await _persistReader();
  }

  Future<void> _persistReader() {
    final snapshot = _reader.toJson();
    final write = _readerWrites.then(
      (_) => _store.writeJson(_readerKey, snapshot),
    );
    _readerWrites = write.catchError(
      (Object e) => debugPrint('Preferences persistence failed: $e'),
    );
    return write;
  }
}
