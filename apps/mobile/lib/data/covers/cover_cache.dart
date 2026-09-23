import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'cover_disk.dart';
import 'cover_validation.dart';
import 'cover_disk_stub.dart'
    if (dart.library.io) 'cover_disk_io.dart'
    as platform;

class CoverUnavailable implements Exception {
  CoverUnavailable({this.missing = false});

  /// The server answered that this cover does not exist (404/410).
  final bool missing;
}

class _Failure {
  _Failure(this.until, this.attempts);
  final DateTime? until;
  final int attempts;
}

/// Encoded covers are bounded separately from Flutter's decoded image cache.
class CoverCache {
  CoverCache({
    required this.disk,
    http.Client Function()? clientFactory,
    DateTime Function()? now,
    this.maxEntryBytes = 4 * 1024 * 1024,
    this.maxMemoryBytes = 12 * 1024 * 1024,
    this.retryDelay = const Duration(minutes: 1),
    this.maxRetryDelay = const Duration(hours: 1),
  }) : _clientFactory = clientFactory ?? http.Client.new,
       _now = now ?? DateTime.now;
  static final Future<CoverCache> shared = () async {
    try {
      return CoverCache(disk: await platform.createCoverDisk());
    } catch (_) {
      return CoverCache(disk: MemoryCoverDisk());
    }
  }();
  final CoverDisk disk;
  final http.Client Function() _clientFactory;
  final DateTime Function() _now;
  final int maxEntryBytes, maxMemoryBytes;

  /// Network retries after a failed fetch wait [retryDelay], doubling per
  /// consecutive failure up to [maxRetryDelay]. A missing cover (404/410) is
  /// not retried this session; new metadata brings a new cover URL and key.
  final Duration retryDelay, maxRetryDelay;
  final _memory = <String, Uint8List>{};
  final _pending = <String, Future<Uint8List?>>{};
  final _failed = <String, _Failure>{};
  int _memoryBytes = 0;
  int _requests = 0;
  final _waiters = <Completer<void>>[];
  Future<void> _acquire() async {
    if (_requests < 3) {
      _requests++;
      return;
    }
    final waiter = Completer<void>();
    _waiters.add(waiter);
    await waiter.future;
  }

  void _release() {
    if (_waiters.isNotEmpty) {
      _waiters.removeAt(0).complete();
    } else {
      _requests--;
    }
  }

  int get memoryBytes => _memoryBytes;
  String _key(String sha, Uri? uri) =>
      sha256.convert(utf8.encode('$sha\n${uri ?? 'embedded'}')).toString();
  void _remember(String key, Uint8List bytes) {
    _memoryBytes -= _memory.remove(key)?.length ?? 0;
    if (bytes.length > maxMemoryBytes) return;
    _memory[key] = bytes;
    _memoryBytes += bytes.length;
    while (_memoryBytes > maxMemoryBytes) {
      _memoryBytes -= _memory.remove(_memory.keys.first)!.length;
    }
  }

  Future<Uint8List?> _cached(String key) async {
    final bytes = _memory.remove(key);
    if (bytes != null) {
      _memory[key] = bytes;
      return bytes;
    }
    final stored = await disk.read(key);
    if (stored != null && !validCoverBytes(stored)) {
      await disk.remove(key);
      return null;
    }
    if (stored != null) _remember(key, stored);
    return stored;
  }

  Future<void> storeEmbedded(String sha, Uint8List bytes) async {
    if (!validCoverBytes(bytes) || bytes.length > maxEntryBytes) {
      throw CoverUnavailable();
    }
    final key = _key(sha, null);
    await disk.write(key, bytes);
    _remember(key, bytes);
  }

  Future<void> reject(String sha, Uri uri) async {
    final key = _key(sha, uri);
    _memoryBytes -= _memory.remove(key)?.length ?? 0;
    _fail(key);
    await disk.remove(key);
  }

  void _fail(String key, {bool missing = false}) {
    final attempts = (_failed.remove(key)?.attempts ?? 0) + 1;
    final delay = retryDelay * pow(2, min(attempts - 1, 20)).toInt();
    _failed[key] = _Failure(
      missing
          ? null
          : _now().add(delay < maxRetryDelay ? delay : maxRetryDelay),
      attempts,
    );
    if (_failed.length > 256) _failed.remove(_failed.keys.first);
  }

  bool _backingOff(String key) {
    final failure = _failed[key];
    if (failure == null) return false;
    return failure.until?.isAfter(_now()) ?? true;
  }

  Future<Uint8List?> load(String sha, Uri? uri) {
    final key = _key(sha, uri);
    return _pending[key] ??= _load(sha, uri, key).whenComplete(() {
      _pending.remove(key);
    });
  }

  Future<Uint8List?> _load(String sha, Uri? uri, String key) async {
    final cached = await _cached(key);
    if (cached != null || uri == null) return cached;
    final embedded = await _cached(_key(sha, null));
    if (_backingOff(key)) {
      if (embedded != null) return embedded;
      throw CoverUnavailable();
    }
    await _acquire();
    final client = _clientFactory();
    try {
      if (!['http', 'https'].contains(uri.scheme)) throw CoverUnavailable();
      final response = await client
          .send(http.Request('GET', uri)..followRedirects = false)
          .timeout(const Duration(seconds: 15));
      if (response.statusCode == 404 || response.statusCode == 410) {
        throw CoverUnavailable(missing: true);
      }
      if (response.statusCode != 200 ||
          (response.contentLength ?? 0) > maxEntryBytes) {
        throw CoverUnavailable();
      }
      final type = response.headers['content-type']?.split(';').first.trim();
      if (!{
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/svg+xml',
      }.contains(type)) {
        throw CoverUnavailable();
      }
      final buffer = BytesBuilder(copy: false);
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 15),
      )) {
        if (buffer.length + chunk.length > maxEntryBytes) {
          throw CoverUnavailable();
        }
        buffer.add(chunk);
      }
      final bytes = buffer.takeBytes();
      if (!validCoverBytes(bytes) ||
          (response.contentLength != null &&
              bytes.length != response.contentLength)) {
        throw CoverUnavailable();
      }
      await disk.write(key, bytes);
      _remember(key, bytes);
      _failed.remove(key);
      return bytes;
    } catch (e) {
      _fail(key, missing: e is CoverUnavailable && e.missing);
      if (embedded != null) return embedded;
      throw CoverUnavailable();
    } finally {
      client.close();
      _release();
    }
  }
}
