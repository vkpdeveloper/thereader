import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/settings.dart';
import 'package:thereader/data/repositories/settings_repository.dart';
import 'package:thereader/data/storage/key_value_store.dart';

void main() {
  test('fresh install uses the production API', () async {
    final repository = SettingsRepository(MemoryKeyValueStore());
    await repository.load();

    expect(repository.settings.mode, AppMode.api);
    expect(repository.settings.apiBaseUrl, 'https://reader.ordinity.com');
  });

  for (final mode in AppMode.values) {
    test('saved ${mode.name} mode and custom origin survive the new defaults', () async {
      final store = MemoryKeyValueStore();
      final saved = AppSettings(mode: mode, apiBaseUrl: 'http://127.0.0.1:8787', preferredEngine: 'dart');
      await store.writeJson('settings.v1', saved.toJson());
      final repository = SettingsRepository(store);
      await repository.load();

      expect(repository.settings.toJson(), saved.toJson());
      expect(await store.readJson('settings.v1'), saved.toJson());
    });
  }

  test('partial legacy records retain their original sample and local defaults', () async {
    final store = MemoryKeyValueStore();
    await store.writeJson('settings.v1', {'preferredEngine': 'readium'});
    final repository = SettingsRepository(store);
    await repository.load();

    expect(repository.settings.mode, AppMode.sample);
    expect(repository.settings.apiBaseUrl, 'http://127.0.0.1:8787');
  });

  test('samples remain an explicit persisted choice on a fresh install', () async {
    final store = MemoryKeyValueStore();
    final repository = SettingsRepository(store);
    await repository.load();
    await repository.setMode(AppMode.sample);
    final reloaded = SettingsRepository(store);
    await reloaded.load();

    expect(reloaded.settings.mode, AppMode.sample);
    expect(reloaded.settings.apiBaseUrl, AppSettings.defaultApiBaseUrl);
  });
}
