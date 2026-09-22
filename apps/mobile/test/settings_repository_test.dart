import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/key_value_store.dart';

void main() {
  test('fresh install uses the production API', () async {
    final repository = SettingsRepository(MemoryKeyValueStore());
    await repository.load();

    expect(repository.settings.apiBaseUrl, 'https://reader.ordinity.com');
    expect(repository.settings.toJson().containsKey('mode'), isFalse);
  });

  test('a saved custom origin and engine survive reload', () async {
    final store = MemoryKeyValueStore();
    const saved = AppSettings(apiBaseUrl: 'http://192.168.1.20:8787', preferredEngine: 'dart');
    await store.writeJson('settings.v1', saved.toJson());
    final repository = SettingsRepository(store);
    await repository.load();

    expect(repository.settings.toJson(), saved.toJson());
    expect(await store.readJson('settings.v1'), saved.toJson());
  });

  test('legacy API-mode records keep their custom URL, even the old local default', () async {
    final store = MemoryKeyValueStore();
    await store.writeJson('settings.v1', {
      'mode': 'api',
      'apiBaseUrl': 'http://127.0.0.1:8787',
      'preferredEngine': 'readium',
    });
    final repository = SettingsRepository(store);
    await repository.load();

    expect(repository.settings.apiBaseUrl, 'http://127.0.0.1:8787');
  });

  test('legacy sample-mode records that never chose an API move to production', () async {
    final store = MemoryKeyValueStore();
    await store.writeJson('settings.v1', {
      'mode': 'sample',
      'apiBaseUrl': 'http://127.0.0.1:8787',
      'preferredEngine': 'readium',
    });
    final repository = SettingsRepository(store);
    await repository.load();

    expect(repository.settings.apiBaseUrl, AppSettings.defaultApiBaseUrl);
  });

  test('legacy sample-mode records with a custom URL keep it', () async {
    final store = MemoryKeyValueStore();
    await store.writeJson('settings.v1', {'mode': 'sample', 'apiBaseUrl': 'https://books.example.net'});
    final repository = SettingsRepository(store);
    await repository.load();

    expect(repository.settings.apiBaseUrl, 'https://books.example.net');
  });

  test('the legacy mode field is dropped on the next write', () async {
    final store = MemoryKeyValueStore();
    await store.writeJson('settings.v1', {'mode': 'sample', 'apiBaseUrl': 'http://127.0.0.1:8787'});
    final repository = SettingsRepository(store);
    await repository.load();
    await repository.setPreferredEngine('dart');

    final written = await store.readJson('settings.v1');
    expect(written, {'apiBaseUrl': AppSettings.defaultApiBaseUrl, 'preferredEngine': 'dart'});
  });
}
