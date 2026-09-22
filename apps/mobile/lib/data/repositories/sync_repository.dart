import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../models/book.dart';
import '../models/library.dart';
import '../models/settings.dart';
import '../storage/key_value_store.dart';
import 'library_repository.dart';
import 'settings_repository.dart';

/// One personal cloud profile, with an origin-scoped durable outbox. Device
/// identifiers deduplicate reading sessions; they are not authentication.
class SyncRepository extends ChangeNotifier with WidgetsBindingObserver {
  SyncRepository({
    required KeyValueStore store,
    required this.library,
    required this.settings,
    ApiClient Function(String)? clientFactory,
    bool Function(String)? isUploadPending,
    this.pollInterval = const Duration(seconds: 30),
    this.retryUploads,
  }) : _store = store,
       _clientFactory =
           clientFactory ?? ((origin) => ApiClient(baseUrl: origin)),
       _isUploadPending = isUploadPending ?? ((_) => false);

  final KeyValueStore _store;
  final LibraryRepository library;
  final SettingsRepository settings;
  final ApiClient Function(String) _clientFactory;
  final bool Function(String) _isUploadPending;
  final Duration pollInterval;
  final VoidCallback? retryUploads;
  static const _key = 'cloud_sync.v1';
  final Map<String, _OriginState> _origins = {};
  String _deviceId = '';
  bool _loaded = false;
  bool _disposed = false;
  bool _appActive = true;
  bool _applying = false;
  bool _isSyncing = false;
  String? _error;
  Timer? _poll;
  Timer? _debounce;
  Timer? _readingTimer;
  Future<void> _writes = Future.value();
  Future<void>? _syncFuture;
  _ReadingSession? _reading;
  final Set<String> _activeEditions = {};
  final Map<String, DateTime> _metadataNextRefresh = {};
  final Set<String> _metadataRefreshInFlight = {};
  final Set<ApiClient> _metadataClients = {};

  bool get isSyncing => _isSyncing;
  String? get error => _error;
  String get deviceId => _deviceId;
  String get _origin {
    try {
      return ApiClient.normalizeBaseUrl(
        settings.settings.apiBaseUrl,
      ).toString();
    } on ApiException {
      return 'http://invalid.invalid';
    }
  }

  _OriginState get _current => _origins.putIfAbsent(_origin, _OriginState.new);
  DateTime? get lastSyncedAt => _current.lastSyncedAt;
  int get pendingCount => _current.pending.length;
  int get totalReadingMilliseconds =>
      _current.totals.keys.fold(
        0,
        (sum, sha) => sum + _milliseconds(_current, sha),
      ) +
      _current.pending.values
          .where(
            (c) =>
                c['kind'] == 'session' &&
                !_current.totals.containsKey(c['sha256']),
          )
          .fold(0, (sum, c) => sum + _sessionDelta(_current, c));

  int readingMillisecondsFor(LibraryEntry entry) => _milliseconds(
    _origins[entry.origin] ?? _OriginState(),
    entry.book.sha256,
  );

  int _sessionDelta(_OriginState state, Map<String, dynamic> change) => max(
    0,
    ((change['payload'] as Map)['readingMilliseconds'] as num).toInt() -
        (state.sessionAcknowledged[change['id']] ?? 0),
  );
  int _milliseconds(_OriginState state, String sha) =>
      (state.totals[sha] ?? 0) +
      state.pending.values
          .where((c) => c['kind'] == 'session' && c['sha256'] == sha)
          .fold(0, (sum, c) => sum + _sessionDelta(state, c));

  static String _uuid() {
    final r = Random.secure();
    return List.generate(
      16,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }

  static String _edition(LibraryEntry entry) =>
      '${entry.origin}\n${entry.book.sha256}';

  Future<void> load({bool startTimers = true}) async {
    final saved = await _store.readJson(_key);
    _deviceId = saved?['deviceId'] as String? ?? _uuid();
    for (final item in ((saved?['origins'] as Map?) ?? {}).entries) {
      try {
        _origins[item.key as String] = _OriginState.fromJson(
          (item.value as Map).cast(),
        );
      } catch (_) {
        /* Preserve other origins if one old state record is corrupt. */
      }
    }
    _loaded = true;
    library.addListener(_capture);
    settings.addListener(_capture);
    WidgetsBinding.instance.addObserver(this);
    _capture();
    await _persist();
    if (startTimers) {
      _poll = Timer.periodic(pollInterval, (_) {
        if (_appActive) {
          retryUploads?.call();
          unawaited(syncNow());
        }
      });
      retryUploads?.call();
      unawaited(syncNow());
    }
  }

  void _capture() {
    if (!_loaded || _disposed || _applying || !library.loaded) return;
    final origin = _origin;
    final state = _current;
    var changed = false;
    for (final entry in library.entries.where(
      (e) => e.source == BookSource.api && e.origin == origin,
    )) {
      final sha = entry.book.sha256;
      final memberKey = 'library:$sha';
      final memberStamp = entry.addedAt.toUtc().toIso8601String();
      if (state.seen[memberKey] != memberStamp) {
        state.seen[memberKey] = memberStamp;
        _queue(state, memberKey, entry, 'library', entry.addedAt, {
          'present': true,
          'addedAt': memberStamp,
        });
        changed = true;
      }
      final progress = entry.progress;
      if (progress != null) {
        final key = 'progress:$sha';
        final stamp = jsonEncode(progress.toJson());
        if (state.seen[key] != stamp) {
          state.seen[key] = stamp;
          _queue(
            state,
            key,
            entry,
            'progress',
            progress.updatedAt,
            _boundedLocator(progress.locator),
          );
          changed = true;
        }
      }
    }
    final updatedAt = settings.readerUpdatedAt;
    if (updatedAt != null &&
        state.seen['preferences'] != updatedAt.toUtc().toIso8601String()) {
      state.seen['preferences'] = updatedAt.toUtc().toIso8601String();
      state.pending['preferences'] = {
        'id': _uuid(),
        'kind': 'preferences',
        'bookId': '_preferences',
        'sha256': '0' * 64,
        'updatedAt': updatedAt.toUtc().toIso8601String(),
        'payload': {'value': settings.reader.toJson()},
      };
      changed = true;
    }
    if (changed) {
      unawaited(_persist());
      _schedule();
      notifyListeners();
    }
  }

  static Map<String, dynamic> _boundedLocator(ReadingLocator locator) {
    final value = locator.toJson();
    // Native locators can carry long selected-text/context payloads. Preserve
    // their portable href/progression rather than poisoning an entire batch.
    if (utf8.encode(jsonEncode(value)).length > 30 * 1024) value['raw'] = null;
    return value;
  }

  void _queue(
    _OriginState state,
    String key,
    LibraryEntry entry,
    String kind,
    DateTime updatedAt,
    Map<String, dynamic> payload, {
    String? id,
  }) {
    state.pending[key] = {
      'id': id ?? _uuid(),
      'bookId': library.entry(entry.id)?.book.id ?? entry.book.id,
      'sha256': entry.book.sha256,
      'kind': kind,
      'updatedAt': updatedAt.toUtc().toIso8601String(),
      'payload': payload,
    };
  }

  void _schedule() {
    if (_disposed) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(seconds: 2), () => unawaited(syncNow()));
  }

  /// Re-check after an upload publishes its canonical cloud identity.
  void uploadsChanged() {
    if (_loaded && !_disposed) {
      _capture();
      _schedule();
    }
  }

  Future<void> _persist() {
    final snapshot = jsonEncode({
      'deviceId': _deviceId,
      'origins': _origins.map((key, value) => MapEntry(key, value.toJson())),
    });
    final write = _writes.then((_) => _store.write(_key, snapshot));
    _writes = write.catchError((Object e) {
      _error = 'Could not save the sync queue on this device.';
      if (!_disposed) notifyListeners();
    });
    return write;
  }

  Future<void> flush() => _writes;

  Future<void> syncNow() {
    if (_disposed || !_loaded) return Future.value();
    return _syncFuture ??= _sync().whenComplete(() => _syncFuture = null);
  }

  void _scheduleMetadataRefresh(String origin, Iterable<LibraryEntry> entries) {
    if (_disposed ||
        !_appActive ||
        _origin != origin ||
        _metadataClients.isNotEmpty) {
      return;
    }
    final now = DateTime.now();
    final candidates = <_MetadataRefresh>[];
    for (final entry in entries) {
      final key = '$origin\n${entry.book.id}';
      if (_metadataRefreshInFlight.contains(key) ||
          _metadataNextRefresh[key]?.isAfter(now) == true) {
        continue;
      }
      _metadataRefreshInFlight.add(key);
      _metadataNextRefresh[key] = now.add(const Duration(minutes: 5));
      candidates.add(
        _MetadataRefresh(
          key: key,
          entryId: entry.id,
          bookId: entry.book.id,
          sha256: entry.book.sha256,
        ),
      );
    }
    if (candidates.isNotEmpty) {
      unawaited(_refreshMetadata(origin, candidates));
    }
  }

  Future<void> _refreshMetadata(
    String origin,
    List<_MetadataRefresh> candidates,
  ) async {
    ApiClient? client;
    try {
      client = _clientFactory(origin);
      _metadataClients.add(client);
      for (final candidate in candidates) {
        if (_disposed || !_appActive || _origin != origin) break;
        Book refreshed;
        try {
          refreshed = await client.getBook(candidate.bookId);
        } on ApiException {
          continue;
        }
        if (_disposed || !_appActive || _origin != origin) break;
        // A successful response is throttled even if the server now points the
        // ID at another edition; never relabel already verified local bytes.
        _metadataNextRefresh[candidate.key] = DateTime.now().add(
          const Duration(hours: 6),
        );
        final current = library.entry(candidate.entryId);
        if (current == null ||
            current.origin != origin ||
            current.book.sha256 != candidate.sha256 ||
            refreshed.sha256 != candidate.sha256) {
          continue;
        }
        await library.applyCloudEntry(
          book: refreshed,
          origin: origin,
          addedAt: current.addedAt,
        );
      }
    } catch (_) {
      // Metadata refresh is best effort and must never fail the durable sync.
    } finally {
      client?.close();
      if (client != null) _metadataClients.remove(client);
      for (final candidate in candidates) {
        _metadataRefreshInFlight.remove(candidate.key);
      }
    }
  }

  Future<void> _sync() async {
    _checkpointReading();
    _capture();
    await _writes;
    final origin = _origin;
    final state = _current;
    final client = _clientFactory(origin);
    _isSyncing = true;
    _error = null;
    notifyListeners();
    try {
      // Bound both count and encoded body; huge locator payloads must not block
      // every other queued change behind the API's request-size limit.
      var bytes = 100;
      final submitted = <String, Map<String, dynamic>>{};
      for (final item in state.pending.entries) {
        final value = Map<String, dynamic>.from(item.value);
        if (value['kind'] != 'preferences') {
          final entry = library.entries
              .where(
                (e) => e.origin == origin && e.book.sha256 == value['sha256'],
              )
              .firstOrNull;
          if (entry != null) {
            if (_isUploadPending(entry.id)) continue;
            value['bookId'] = entry.book.id;
          }
        }
        final length = utf8.encode(jsonEncode(value)).length;
        if (submitted.length >= 100 || bytes + length > 240 * 1024) break;
        submitted[item.key] = value;
        bytes += length + 1;
      }
      final before = {
        for (final key in submitted.keys) key: jsonEncode(state.pending[key]),
      };
      final response = await client.syncState(
        deviceId: _deviceId,
        changes: submitted.values.toList(),
      );
      if (_disposed) return;
      final rows = (response['books'] as List).cast<Map>();
      // Preserve local changes made while HTTP was in flight, even when their
      // outbox key/session ID is the same as the acknowledged request.
      for (final item in submitted.entries) {
        if (item.value['kind'] == 'session') {
          state.sessionAcknowledged[item.value['id'] as String] =
              ((item.value['payload'] as Map)['readingMilliseconds'] as num)
                  .toInt();
        }
        if (jsonEncode(state.pending[item.key]) == before[item.key]) {
          state.pending.remove(item.key);
        }
      }
      state.sessionAcknowledged.removeWhere(
        (id, _) =>
            id != _reading?.id && !state.pending.containsKey('session:$id'),
      );
      state.totals.clear();
      for (final raw in rows) {
        final row = raw.cast<String, dynamic>();
        final sha = row['sha256'] as String;
        state.totals[sha] =
            (state.totals[sha] ?? 0) +
            (row['readingMilliseconds'] as num).toInt();
      }
      // Commit ack + counters before awaiting metadata fetches. A process exit
      // can replay a session safely; it must never acknowledge unsaved changes.
      await _persist();
      final metadataRefresh = <LibraryEntry>[];
      _applying = true;
      try {
        for (final raw in rows) {
          final row = raw.cast<String, dynamic>();
          final sha = row['sha256'] as String;
          final id = row['bookId'] as String;
          final local = library.entries
              .where((e) => e.origin == origin && e.book.id == id)
              .firstOrNull;
          if (local == null && row['inLibrary'] != true) continue;
          Book book;
          try {
            if (local == null) {
              final metadataKey = '$origin\n$id';
              final refreshAt = _metadataNextRefresh[metadataKey];
              if (refreshAt?.isAfter(DateTime.now()) == true) continue;
              _metadataNextRefresh[metadataKey] = DateTime.now().add(
                const Duration(minutes: 5),
              );
              book = await client.getBook(id);
              _metadataNextRefresh[metadataKey] = DateTime.now().add(
                const Duration(hours: 6),
              );
            } else {
              book = local.book;
              metadataRefresh.add(local);
            }
          } on ApiException {
            continue;
          }
          if (book.sha256 != sha) continue;
          final active = _activeEditions.contains('$origin\n$sha');
          final stamp = DateTime.tryParse(
            row['progressUpdatedAt'] as String? ?? '',
          );
          final progress = row['progress'] is Map && stamp != null
              ? ReadingProgress(
                  locator: ReadingLocator.fromJson(
                    (row['progress'] as Map).cast(),
                  ),
                  updatedAt: stamp,
                )
              : null;
          await library.applyCloudEntry(
            book: book,
            origin: origin,
            addedAt:
                DateTime.tryParse(row['addedAt'] as String? ?? '') ??
                book.updatedAt,
            progress: active ? null : progress,
            lastOpenedAt: DateTime.tryParse(
              row['lastOpenedAt'] as String? ?? '',
            ),
          );
          final applied = library.entry(
            LibraryEntry.identity(id, BookSource.api, origin),
          );
          if (applied != null) {
            state.seen['library:$sha'] = applied.addedAt
                .toUtc()
                .toIso8601String();
            if (!active &&
                progress != null &&
                applied.progress?.updatedAt == progress.updatedAt) {
              // The server can normalize JSON numbers (0.0 to 0) or map
              // ordering. At an acknowledged timestamp, fingerprint the
              // retained local locator so representation differences cannot
              // continuously enqueue the same reading position.
              state.seen['progress:$sha'] = jsonEncode(
                applied.progress!.toJson(),
              );
            }
          }
        }
        final prefs = response['preferences'];
        if (prefs is Map && origin == _origin) {
          final updatedAt = DateTime.parse(prefs['updatedAt'] as String);
          await settings.applyCloudReader(
            ReaderPreferences.fromJson((prefs['value'] as Map).cast()),
            updatedAt,
          );
          if (settings.readerUpdatedAt == updatedAt) {
            state.seen['preferences'] = updatedAt.toUtc().toIso8601String();
          }
        }
      } finally {
        _applying = false;
      }
      _capture();
      state.lastSyncedAt = DateTime.now().toUtc();
      await _persist();
      _scheduleMetadataRefresh(origin, metadataRefresh);
      // Drain further batches without treating a blocked import as an error.
      if (submitted.length == 100 || bytes > 200 * 1024) _schedule();
    } on ApiException catch (e) {
      _error = '${e.message} Changes remain saved on this device.';
    } catch (_) {
      _error =
          'Cloud sync is unavailable. Changes remain saved on this device.';
    } finally {
      client.close();
      _isSyncing = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// Time advances only while a successfully opened reader is foregrounded.
  /// The cumulative session counter is persisted every 15 seconds and on pause.
  void beginReading(LibraryEntry entry) {
    endReading();
    if (entry.source != BookSource.api || !_loaded) return;
    _reading = _ReadingSession(entry, _uuid());
    _activeEditions.add(_edition(entry));
    if (_appActive) _reading!.watch.start();
    _readingTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => _checkpointReading(),
    );
  }

  void setReadingActive(bool active) {
    final reading = _reading;
    if (reading == null) return;
    if (active && _appActive) {
      reading.watch.start();
    } else {
      reading.watch.stop();
      _checkpointReading();
    }
  }

  Future<void> recordReadingSession(
    LibraryEntry entry, {
    required String sessionId,
    required int readingMilliseconds,
  }) async {
    if (!_loaded ||
        entry.source != BookSource.api ||
        readingMilliseconds <= 0) {
      return;
    }
    final state = _origins.putIfAbsent(entry.origin, _OriginState.new);
    final previous = state.pending['session:$sessionId'];
    final elapsed = max(
      readingMilliseconds,
      previous == null
          ? 0
          : ((previous['payload'] as Map)['readingMilliseconds'] as num)
                .toInt(),
    );
    _queue(state, 'session:$sessionId', entry, 'session', DateTime.now(), {
      'readingMilliseconds': elapsed,
    }, id: sessionId);
    await _persist();
    if (!_disposed) notifyListeners();
  }

  void _checkpointReading() {
    final reading = _reading;
    if (reading == null) return;
    final elapsed = reading.watch.elapsedMilliseconds;
    if (elapsed <= reading.lastSaved) return;
    reading.lastSaved = elapsed;
    unawaited(
      recordReadingSession(
        reading.entry,
        sessionId: reading.id,
        readingMilliseconds: elapsed,
      ),
    );
  }

  void endReading() {
    _reading?.watch.stop();
    _checkpointReading();
    final entry = _reading?.entry;
    if (entry != null) _activeEditions.remove(_edition(entry));
    _reading = null;
    _readingTimer?.cancel();
    _readingTimer = null;
    if (_loaded) _schedule();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appActive = state == AppLifecycleState.resumed;
    setReadingActive(_appActive);
    if (_appActive) {
      retryUploads?.call();
      unawaited(syncNow());
    } else {
      _capture();
      unawaited(_persist());
    }
  }

  @override
  void dispose() {
    endReading();
    _disposed = true;
    library.removeListener(_capture);
    settings.removeListener(_capture);
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _debounce?.cancel();
    for (final client in _metadataClients.toList()) {
      client.close();
    }
    _metadataClients.clear();
    super.dispose();
  }
}

class _MetadataRefresh {
  const _MetadataRefresh({
    required this.key,
    required this.entryId,
    required this.bookId,
    required this.sha256,
  });
  final String key;
  final String entryId;
  final String bookId;
  final String sha256;
}

class _ReadingSession {
  _ReadingSession(this.entry, this.id);
  final LibraryEntry entry;
  final String id;
  final Stopwatch watch = Stopwatch();
  int lastSaved = 0;
}

class _OriginState {
  final Map<String, Map<String, dynamic>> pending = {};
  final Map<String, String> seen = {};
  final Map<String, int> totals = {};
  final Map<String, int> sessionAcknowledged = {};
  DateTime? lastSyncedAt;
  Map<String, dynamic> toJson() => {
    'pending': pending,
    'seen': seen,
    'totals': totals,
    'sessionAcknowledged': sessionAcknowledged,
    'lastSyncedAt': lastSyncedAt?.toIso8601String(),
  };
  _OriginState();
  factory _OriginState.fromJson(Map<String, dynamic> json) {
    final state = _OriginState();
    for (final item in ((json['pending'] as Map?) ?? {}).entries) {
      state.pending[item.key as String] = (item.value as Map).cast();
    }
    state.seen.addAll(((json['seen'] as Map?) ?? {}).cast());
    state.totals.addAll(
      ((json['totals'] as Map?) ?? {}).map(
        (k, v) => MapEntry(k as String, (v as num).toInt()),
      ),
    );
    state.sessionAcknowledged.addAll(
      ((json['sessionAcknowledged'] as Map?) ?? {}).map(
        (k, v) => MapEntry(k as String, (v as num).toInt()),
      ),
    );
    state.lastSyncedAt = DateTime.tryParse(
      json['lastSyncedAt'] as String? ?? '',
    );
    return state;
  }
}
