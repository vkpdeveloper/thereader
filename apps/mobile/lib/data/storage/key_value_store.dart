import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Small string key/value persistence boundary so repositories can be tested
/// without platform plugins.
abstract class KeyValueStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> remove(String key);

  Future<Map<String, dynamic>?> readJson(String key) async {
    final raw = await read(key);
    if (raw == null || raw.isEmpty) return null;
    try {
      return (jsonDecode(raw) as Map).cast<String, dynamic>();
    } on FormatException {
      return null;
    }
  }

  Future<void> writeJson(String key, Map<String, dynamic> value) => write(key, jsonEncode(value));
}

class SharedPreferencesStore extends KeyValueStore {
  SharedPreferencesStore._(this._prefs);

  final SharedPreferencesWithCache _prefs;

  static Future<SharedPreferencesStore> open() async {
    final prefs = await SharedPreferencesWithCache.create(
      cacheOptions: const SharedPreferencesWithCacheOptions(),
    );
    return SharedPreferencesStore._(prefs);
  }

  @override
  Future<String?> read(String key) async => _prefs.getString(key);

  @override
  Future<void> write(String key, String value) => _prefs.setString(key, value);

  @override
  Future<void> remove(String key) => _prefs.remove(key);
}

class MemoryKeyValueStore extends KeyValueStore {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;

  @override
  Future<void> remove(String key) async => values.remove(key);
}
