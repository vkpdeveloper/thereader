import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:path_provider/path_provider.dart';
import 'cover_disk.dart';

Future<CoverDisk> createCoverDisk() async => IoCoverDisk(
  Directory('${(await getApplicationSupportDirectory()).path}/covers'),
);

class IoCoverDisk implements CoverDisk {
  IoCoverDisk(
    this.root, {
    this.maxBytes = 64 * 1024 * 1024,
    this.maxEntryBytes = 4 * 1024 * 1024,
  });
  final Directory root;
  final int maxBytes;
  final int maxEntryBytes;
  Future<void> _writes = Future.value();
  File _file(String key) {
    if (!RegExp(r'^[a-f0-9]{64}$').hasMatch(key)) {
      throw ArgumentError('Invalid cache key');
    }
    return File('${root.path}/$key');
  }

  @override
  Future<Uint8List?> read(String key) async {
    final file = _file(key);
    try {
      final size = await file.length();
      if (size > maxEntryBytes + 32 || size <= 32) {
        await file.delete();
        return null;
      }
      final stored = await file.readAsBytes();
      final bytes = Uint8List.sublistView(stored, 32);
      final digest = sha256.convert(bytes).bytes;
      if (List.generate(32, (i) => digest[i] != stored[i]).any((v) => v)) {
        await file.delete();
        return null;
      }
      await file.setLastModified(DateTime.now());
      return bytes;
    } on FileSystemException {
      return null;
    }
  }

  @override
  Future<void> remove(String key) async {
    try {
      await _file(key).delete();
    } on FileSystemException {
      /* Already absent. */
    }
  }

  @override
  Future<void> write(String key, Uint8List bytes) {
    final next = _writes.then((_) async {
      if (bytes.length > maxEntryBytes || bytes.length + 32 > maxBytes) return;
      await root.create(recursive: true);
      final file = _file(key);
      final temp = File('${file.path}.part');
      await temp.writeAsBytes([
        ...sha256.convert(bytes).bytes,
        ...bytes,
      ], flush: true);
      await temp.rename(file.path);
      final files = <(File, FileStat)>[];
      await for (final entry in root.list(followLinks: false)) {
        if (entry is File && !entry.path.endsWith('.part')) {
          files.add((entry, await entry.stat()));
        }
      }
      files.sort((a, b) => a.$2.modified.compareTo(b.$2.modified));
      var total = files.fold<int>(0, (n, e) => n + e.$2.size);
      for (final entry in files) {
        if (total <= maxBytes) break;
        await entry.$1.delete();
        total -= entry.$2.size;
      }
    });
    _writes = next.catchError((Object _) {});
    return next;
  }
}
