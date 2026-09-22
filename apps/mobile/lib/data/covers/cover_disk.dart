import 'dart:typed_data';

abstract interface class CoverDisk {
  Future<Uint8List?> read(String key);
  Future<void> write(String key, Uint8List bytes);
  Future<void> remove(String key);
}

class MemoryCoverDisk implements CoverDisk {
  MemoryCoverDisk({this.maxBytes = 64 * 1024 * 1024});
  final int maxBytes;
  final entries = <String, Uint8List>{};
  @override
  Future<Uint8List?> read(String key) async => entries[key];
  @override
  Future<void> remove(String key) async {
    entries.remove(key);
  }

  @override
  Future<void> write(String key, Uint8List bytes) async {
    entries.remove(key);
    if (bytes.length > maxBytes) return;
    entries[key] = bytes;
    var total = entries.values.fold<int>(0, (n, b) => n + b.length);
    while (total > maxBytes) {
      total -= entries.remove(entries.keys.first)!.length;
    }
  }
}
