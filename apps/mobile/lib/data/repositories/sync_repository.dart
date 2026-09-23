import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../models/book.dart';
import '../models/highlight.dart';
import '../models/library.dart';
import '../models/settings.dart';
import '../storage/key_value_store.dart';
import 'highlight_repository.dart';
import 'library_repository.dart';
import 'settings_repository.dart';

/// One personal cloud profile, with an origin-scoped durable outbox. Device
/// identifiers deduplicate reading sessions; they are not authentication.
///
/// The API runs on a metered free tier, so traffic follows one schedule: a
/// single pull+push request every [syncInterval] while foregrounded, nothing
/// while backgrounded, exponential backoff after failures, and best-effort
/// flushes when reading stops or the app leaves the foreground. Local edits
/// are saved and queued immediately but never send a request of their own;
/// everything that changes synced data calls [requestSync].
class SyncRepository extends ChangeNotifier with WidgetsBindingObserver {
  SyncRepository({
    required KeyValueStore store,
    required this.library,
    required this.settings,
    this.highlights,
    ApiClient Function(String)? clientFactory,
    bool Function(String)? isUploadPending,
    this.pollInterval = syncInterval,
    this.retryUploads,
    DateTime Function()? now,
  }) : _store = store,
       _clientFactory =
           clientFactory ?? ((origin) => ApiClient(baseUrl: origin)),
       _isUploadPending = isUploadPending ?? ((_) => false),
       _now = now ?? DateTime.now;

  /// Foreground cadence of the one pull+push request per cycle.
  static const syncInterval = Duration(minutes: 2);

  /// Start/resume only syncs when the last attempt is at least this old.
  static const resumeGap = Duration(minutes: 1);

  /// A flush is skipped when a sync was attempted this recently.
  static const flushGap = Duration(seconds: 15);

  /// Failures double the wait from [pollInterval] up to this ceiling.
  static const maxBackoff = Duration(minutes: 15);

  /// Lets the reader's final progress save land before a flush reads it.
  static const _flushSettle = Duration(seconds: 1);

  /// Only used when a full batch left more of the outbox to send.
  static const _drainDelay = Duration(seconds: 5);

  /// How long to stop sending highlights after a server rejected them (it
  /// predates highlight sync), so the rest of the state keeps syncing.
  static const highlightsRetry = Duration(hours: 6);

  final KeyValueStore _store;
  final LibraryRepository library;
  final SettingsRepository settings;
  final HighlightRepository? highlights;
  final ApiClient Function(String) _clientFactory;
  final bool Function(String) _isUploadPending;
  final Duration pollInterval;
  final VoidCallback? retryUploads;
  final DateTime Function() _now;
  static const _key = 'cloud_sync.v1';

  /// Metadata-refresh throttle, kept apart from the sync state so a cold start
  /// does not re-fetch every library book and so the state format can evolve.
  static const _metadataKey = 'cloud_sync.metadata_refresh.v1';
  static const _metadataRetry = Duration(minutes: 5);
  static const _metadataFresh = Duration(hours: 6);
  final Map<String, _OriginState> _origins = {};
  String _deviceId = '';
  bool _loaded = false;
  bool _disposed = false;
  bool _appActive = true;
  bool _applying = false;
  bool _isSyncing = false;
  bool _autoSync = false;
  bool _drainMore = false;
  int _failures = 0;
  DateTime? _lastAttemptAt;
  String? _error;
  Timer? _next;
  Timer? _flushTimer;
  Timer? _readingTimer;
  Future<void> _writes = Future.value();
  Future<void>? _syncFuture;
  _ReadingSession? _reading;
  final Set<String> _activeEditions = {};
  final Map<String, DateTime> _metadataNextRefresh = {};
  final Set<String> _metadataRefreshInFlight = {};
  final Set<ApiClient> _metadataClients = {};
  Future<void> _metadataWrites = Future.value();

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
    await _loadMetadataThrottle();
    _loaded = true;
    library.addListener(_capture);
    settings.addListener(_capture);
    highlights?.addListener(_capture);
    WidgetsBinding.instance.addObserver(this);
    _capture();
    await _persist();
    if (startTimers) {
      _autoSync = true;
      _resume();
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
    if (_captureHighlights(origin, state)) changed = true;
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
      requestSync();
      notifyListeners();
    }
  }

  /// Queues highlights of this origin's cloud books. Highlights on local-only
  /// imports have no cloud edition and stay on this device.
  bool _captureHighlights(String origin, _OriginState state) {
    final store = highlights;
    if (store == null || !store.loaded) return false;
    var changed = false;
    Map<String, LibraryEntry>? bySha;
    for (final h in store.all) {
      if (h.origin != origin) continue;
      final key = 'highlight:${h.id}';
      final stamp = h.updatedAt.toUtc().toIso8601String();
      if (state.seen[key] == stamp) continue;
      bySha ??= {
        for (final e in library.entries)
          if (e.source == BookSource.api && e.origin == origin)
            e.book.sha256: e,
      };
      final entry = bySha[h.sha256];
      if (entry == null) continue;
      state.seen[key] = stamp;
      _queue(state, key, entry, 'highlight', h.updatedAt, {
        'highlightId': h.id,
        'locator': _boundedHighlightLocator(h.locator),
        'text': h.text,
        'color': h.color,
        if (h.note != null) 'note': h.note,
        'createdAt': h.createdAt.toUtc().toIso8601String(),
        'deleted': h.deleted,
      });
      changed = true;
    }
    return changed;
  }

  /// The API caps a highlight locator at 16 KB; long before/after context is
  /// the only part that can grow, and the range still anchors without it.
  static Map<String, dynamic> _boundedHighlightLocator(
    Map<String, dynamic> locator,
  ) {
    if (utf8.encode(jsonEncode(locator)).length <= 15 * 1024) return locator;
    final copy = Map<String, dynamic>.of(locator);
    final text = copy['text'];
    if (text is Map) {
      copy['text'] = {
        for (final e in text.entries)
          if (e.key != 'before' && e.key != 'after') e.key: e.value,
      };
    }
    if (utf8.encode(jsonEncode(copy)).length <= 15 * 1024) return copy;
    copy.remove('text');
    return copy;
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

  /// The single entry point for "synced data changed locally". Callers must
  /// already have saved and queued the change; it rides the next scheduled
  /// cycle and never sends a request by itself.
  void requestSync() => _scheduleNext(_cycleDelay, replace: false);

  Duration get _cycleDelay {
    if (_failures == 0) return pollInterval;
    final backoff = pollInterval * pow(2, min(_failures, 16)).toInt();
    return backoff < maxBackoff ? backoff : maxBackoff;
  }

  bool _attemptedWithin(Duration gap) {
    final last = _lastAttemptAt ?? _current.lastSyncedAt;
    if (last == null) return false;
    // A stamp in the future (clock moved back) must not suppress syncing.
    final since = _now().difference(last);
    return since >= Duration.zero && since < gap;
  }

  void _scheduleNext(Duration delay, {bool replace = true}) {
    if (!_loaded || _disposed || !_autoSync || !_appActive) return;
    if (!replace && _next != null) return;
    _next?.cancel();
    _next = Timer(delay, () {
      _next = null;
      if (!_appActive || _disposed) return;
      retryUploads?.call();
      unawaited(syncNow());
    });
  }

  /// App start or return to the foreground: pull once unless a sync ran very
  /// recently, otherwise continue the regular cadence.
  void _resume() {
    if (!_loaded || _disposed || !_autoSync) return;
    retryUploads?.call();
    if (_attemptedWithin(resumeGap)) {
      _scheduleNext(_cycleDelay);
    } else {
      unawaited(syncNow());
    }
  }

  /// Best-effort push when reading stops or the app is backgrounded. Skipped
  /// when nothing is queued or a sync was just attempted.
  void _flushSoon() {
    if (!_loaded || _disposed || !_autoSync) return;
    _flushTimer?.cancel();
    _flushTimer = Timer(_flushSettle, () {
      _flushTimer = null;
      if (_disposed) return;
      _checkpointReading();
      _capture();
      if (_current.pending.isEmpty || _attemptedWithin(flushGap)) return;
      unawaited(syncNow());
    });
  }

  /// Re-check after an upload publishes its canonical cloud identity.
  void uploadsChanged() {
    if (_loaded && !_disposed) {
      _capture();
      requestSync();
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

  Future<void> flush() => Future.wait([_writes, _metadataWrites]);

  /// Syncs immediately (the Settings button and the schedule itself). Calls
  /// during a running sync join it instead of starting another request.
  Future<void> syncNow() {
    if (_disposed || !_loaded) return Future.value();
    return _syncFuture ??= _sync().whenComplete(() {
      _syncFuture = null;
      _lastAttemptAt = _now();
      _scheduleNext(_drainMore ? _drainDelay : _cycleDelay);
    });
  }

  Future<void> _loadMetadataThrottle() async {
    try {
      final saved = await _store.readJson(_metadataKey);
      final now = DateTime.now();
      for (final item in (saved ?? const {}).entries) {
        final at = DateTime.tryParse(item.value as String? ?? '');
        // Ignore stale or implausibly distant stamps (clock changes, damage).
        if (at != null &&
            at.isAfter(now) &&
            !at.isAfter(now.add(_metadataFresh))) {
          _metadataNextRefresh[item.key] = at;
        }
      }
    } catch (_) {
      /* Unreadable throttle only means metadata may be refreshed early. */
    }
  }

  void _persistMetadataThrottle() {
    final now = DateTime.now();
    _metadataNextRefresh.removeWhere((_, at) => !at.isAfter(now));
    final snapshot = jsonEncode(
      _metadataNextRefresh.map(
        (key, at) => MapEntry(key, at.toUtc().toIso8601String()),
      ),
    );
    _metadataWrites = _metadataWrites
        .then((_) => _store.write(_metadataKey, snapshot))
        .catchError((Object _) {});
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
      _metadataNextRefresh[key] = now.add(_metadataRetry);
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
      _persistMetadataThrottle();
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
          _metadataFresh,
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
      if (!_disposed) _persistMetadataThrottle();
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
    _drainMore = false;
    _error = null;
    notifyListeners();
    var withHighlights =
        highlights != null &&
        state.highlightsUnsupportedUntil?.isAfter(_now()) != true;
    try {
      // Bound both count and encoded body; huge locator payloads must not block
      // every other queued change behind the API's request-size limit.
      var bytes = 100;
      final submitted = <String, Map<String, dynamic>>{};
      for (final item in state.pending.entries) {
        final value = Map<String, dynamic>.from(item.value);
        if (value['kind'] == 'highlight' && !withHighlights) continue;
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
      Map<String, dynamic> response;
      try {
        response = await client.syncState(
          deviceId: _deviceId,
          changes: submitted.values.toList(),
          highlightsSince: withHighlights ? state.highlightCursor ?? 0 : null,
        );
      } on ApiException catch (e) {
        if (!withHighlights ||
            e.statusCode != 400 ||
            e.code != 'INVALID_SYNC') {
          rethrow;
        }
        // A server without highlight sync rejects the whole atomic batch.
        // Keep everything else syncing and try highlights again later.
        withHighlights = false;
        state.highlightsUnsupportedUntil = _now().add(highlightsRetry);
        submitted.removeWhere((_, v) => v['kind'] == 'highlight');
        before.removeWhere((k, _) => !submitted.containsKey(k));
        response = await client.syncState(
          deviceId: _deviceId,
          changes: submitted.values.toList(),
        );
      }
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
                _metadataRetry,
              );
              _persistMetadataThrottle();
              book = await client.getBook(id);
              _metadataNextRefresh[metadataKey] = DateTime.now().add(
                _metadataFresh,
              );
              _persistMetadataThrottle();
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
        final pulled = response['highlights'];
        if (withHighlights && pulled is Map) {
          await _applyHighlights(origin, state, pulled);
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
      _failures = 0;
      _scheduleMetadataRefresh(origin, metadataRefresh);
      // Drain further batches without treating a blocked import as an error.
      _drainMore =
          submitted.length == 100 ||
          bytes > 200 * 1024 ||
          (withHighlights && (response['highlights'] as Map?)?['more'] == true);
    } on ApiException catch (e) {
      _failures++;
      _error = '${e.message} Changes remain saved on this device.';
    } catch (_) {
      _failures++;
      _error =
          'Cloud sync is unavailable. Changes remain saved on this device.';
    } finally {
      client.close();
      _isSyncing = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// Stores rows changed on other devices and advances the pull cursor. Rows
  /// that fail to parse are skipped; the cursor still moves past them.
  Future<void> _applyHighlights(
    String origin,
    _OriginState state,
    Map pulled,
  ) async {
    final store = highlights!;
    final remote = <Highlight>[];
    for (final raw in (pulled['items'] as List?) ?? const []) {
      try {
        final row = (raw as Map).cast<String, dynamic>();
        remote.add(
          Highlight(
            id: row['id'] as String,
            bookId: row['bookId'] as String,
            sha256: row['sha256'] as String,
            origin: origin,
            locator: (row['locator'] as Map).cast<String, dynamic>(),
            text: row['text'] as String? ?? '',
            color: row['color'] as String,
            note: row['note'] as String?,
            createdAt: DateTime.parse(row['createdAt'] as String),
            updatedAt: DateTime.parse(row['updatedAt'] as String),
            deleted: row['deleted'] == true,
          ),
        );
      } catch (_) {
        continue;
      }
    }
    await store.applyRemote(remote);
    for (final h in remote) {
      final local = store.byId(h.id);
      // Matching copies need no upload; a newer local edit stays queued.
      if (local != null && local.updatedAt == h.updatedAt) {
        state.seen['highlight:${h.id}'] = local.updatedAt
            .toUtc()
            .toIso8601String();
      }
    }
    final cursor = pulled['cursor'];
    if (cursor is num) state.highlightCursor = cursor.toInt();
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
    final wasReading = _reading != null;
    _reading?.watch.stop();
    _checkpointReading();
    final entry = _reading?.entry;
    if (entry != null) _activeEditions.remove(_edition(entry));
    _reading = null;
    _readingTimer?.cancel();
    _readingTimer = null;
    if (wasReading && !_disposed) _flushSoon();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final wasActive = _appActive;
    _appActive = state == AppLifecycleState.resumed;
    setReadingActive(_appActive);
    if (_appActive) {
      if (!wasActive) _resume();
      return;
    }
    // No polling in the background; only flush what is already queued.
    _next?.cancel();
    _next = null;
    _capture();
    unawaited(_persist());
    if (state != AppLifecycleState.inactive) _flushSoon();
  }

  @override
  void dispose() {
    endReading();
    _disposed = true;
    library.removeListener(_capture);
    settings.removeListener(_capture);
    highlights?.removeListener(_capture);
    WidgetsBinding.instance.removeObserver(this);
    _next?.cancel();
    _flushTimer?.cancel();
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

  /// Server highlight rev already pulled; null means never pulled.
  int? highlightCursor;

  /// Set when the server rejected highlight sync (not yet deployed).
  DateTime? highlightsUnsupportedUntil;
  Map<String, dynamic> toJson() => {
    'pending': pending,
    'seen': seen,
    'totals': totals,
    'sessionAcknowledged': sessionAcknowledged,
    'lastSyncedAt': lastSyncedAt?.toIso8601String(),
    if (highlightCursor != null) 'highlightCursor': highlightCursor,
    if (highlightsUnsupportedUntil != null)
      'highlightsUnsupportedUntil': highlightsUnsupportedUntil!
          .toUtc()
          .toIso8601String(),
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
    state.highlightCursor = (json['highlightCursor'] as num?)?.toInt();
    state.highlightsUnsupportedUntil = DateTime.tryParse(
      json['highlightsUnsupportedUntil'] as String? ?? '',
    );
    return state;
  }
}
