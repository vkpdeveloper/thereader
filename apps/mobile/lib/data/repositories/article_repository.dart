import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:thereader_extract/thereader_extract.dart';

import '../api/api_client.dart';
import '../articles/article_store.dart';
import '../articles/html_decoding.dart';
import '../articles/page_fetcher.dart';
import '../models/article_summary.dart';
import '../storage/key_value_store.dart';

enum ArticlePhase { fetching, extracting, saving }

@immutable
class ArticleAddProgress {
  const ArticleAddProgress(this.phase, [this.fraction]);

  final ArticlePhase phase;

  /// Download fraction while fetching, when the size is known.
  final double? fraction;
}

/// An article row pulled from the cloud (the API's `articles` sync list).
@immutable
class RemoteArticle {
  const RemoteArticle({
    required this.summary,
    required this.updatedAt,
    required this.deleted,
  });

  /// The metadata as a summary (`stored: false`), with any position.
  final ArticleSummary summary;
  final DateTime updatedAt;
  final bool deleted;

  String get id => summary.id;
}

/// Saved web articles. A link is fetched on this device, extracted on a
/// background isolate and stored once as an article document; opening an
/// article only reads that document. The index of summaries lives in the
/// key/value store beside the library.
///
/// Saved articles sync through the cloud: [SyncRepository] sends summaries,
/// positions and deletions on its schedule and uploads each document once.
/// Articles saved on other devices arrive as summaries (`stored: false`);
/// their document downloads when opened (or during sync, when small), never
/// re-extracted. Deletions keep a tombstone until they have had time to sync.
class ArticleRepository extends ChangeNotifier {
  ArticleRepository({
    required KeyValueStore store,
    required ArticleStore files,
    required PageFetcher fetcher,
    ApiClient Function()? cloud,
    DateTime Function()? now,
  })  : _store = store,
        _files = files,
        _fetcher = fetcher,
        _cloud = cloud,
        _now = now ?? DateTime.now;

  static const _key = 'articles.v1';

  /// The API's cap on a synced document, measured on its JSON.
  static const maxBodyBytes = 8 * 1024 * 1024;

  /// Documents up to this size download during sync, so they open offline.
  static const prefetchMaxBytes = 1024 * 1024;
  static const _retryMin = Duration(minutes: 2);
  static const _retryMax = Duration(hours: 6);

  /// Deletions are remembered this long to sync them; the server keeps them.
  static const _tombstoneTtl = Duration(days: 180);

  final KeyValueStore _store;
  final ArticleStore _files;
  final PageFetcher _fetcher;
  final ApiClient Function()? _cloud;
  final DateTime Function() _now;
  final Map<String, ArticleSummary> _items = {};
  final Map<String, DateTime> _tombstones = {};
  final Map<String, Future<Article>> _downloads = {};
  final Map<String, (DateTime, Duration)> _retryAt = {};

  /// Pre-sync ids moved to their shared id this session (old to new), so a
  /// screen opened with the old id keeps working.
  final Map<String, String> _moved = {};
  Future<void>? _loading;
  Future<void>? _migration;
  final ValueNotifier<ArticleAddProgress?> _adding = ValueNotifier(null);
  Future<void> _writes = Future.value();
  (String, Article)? _recent;
  bool _loaded = false;

  bool get loaded => _loaded;
  bool get isDurable => _files.isDurable;

  /// Newest first.
  List<ArticleSummary> get articles =>
      UnmodifiableListView(_items.values.toList()..sort((a, b) => b.addedAt.compareTo(a.addedAt)));

  ArticleSummary? byId(String id) => _items[_moved[id] ?? id];

  /// Every saved article, unsorted (the sync outbox reads this).
  Iterable<ArticleSummary> get all => _items.values;

  /// Deleted ids and when, until they expire.
  Map<String, DateTime> get deleted => UnmodifiableMapView(_tombstones);

  /// Same page, for dedupe and for the article's id: scheme, credentials,
  /// default port, `www.`, a trailing slash, fragment and tracking parameters
  /// do not matter. Plain string work, so the web app derives the same key
  /// (`articleUrlKey` in `articles.ts`) from the same URL.
  static String urlKey(String href) {
    final m = RegExp(r'^[a-z][a-z\d+.-]*://([^/?#]*)([^?#]*)(\?[^#]*)?', caseSensitive: false).firstMatch(href.trim());
    if (m == null) return href.trim();
    final authority = m.group(1)!;
    final host = authority
        .substring(authority.lastIndexOf('@') + 1)
        .toLowerCase()
        .replaceFirst(RegExp(r':(?:80|443)$'), '')
        .replaceFirst(RegExp(r'^www\.'), '');
    final path = m.group(2)!.replaceFirst(RegExp(r'/+$'), '');
    final query = (m.group(3) ?? '')
        .replaceFirst('?', '')
        .split('&')
        .where((pair) => pair.isNotEmpty && !_tracking.hasMatch(pair.split('=').first))
        .join('&');
    return '$host$path${query.isEmpty ? '' : '?$query'}';
  }

  static final _tracking = RegExp(r'^(?:utm_\w+|fbclid|gclid|dclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$', caseSensitive: false);

  /// The id every device gives the article at [url]: the first 128 bits of
  /// the SHA-256 of its [urlKey], in hex. The same story saved on two
  /// devices therefore syncs as one article.
  static String idFor(String url) => sha256.convert(utf8.encode(urlKey(url))).toString().substring(0, 32);

  /// The save in progress, if any.
  ValueListenable<ArticleAddProgress?> get adding => _adding;

  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    final json = await _store.readJson(_key);
    for (final raw in (json?['items'] as List<dynamic>? ?? const [])) {
      try {
        final s = ArticleSummary.fromJson((raw as Map).cast<String, dynamic>());
        _items[s.id] = s;
      } catch (_) {
        // Skip a corrupt record instead of losing every article.
      }
    }
    final oldest = _now().subtract(_tombstoneTtl);
    for (final item in ((json?['tombstones'] as Map?) ?? const {}).entries) {
      final at = DateTime.tryParse(item.value as String? ?? '');
      if (at != null && at.isAfter(oldest) && !_items.containsKey(item.key)) _tombstones[item.key as String] = at;
    }
    var changed = false;
    for (final s in _items.values.toList()) {
      if (!s.stored) continue;
      if (!await _files.exists(s.id)) {
        // Session-only documents (browser preview) do not survive a reload;
        // with a cloud to download from it comes back, otherwise it is gone.
        if (s.bodySha256 != null && _cloud != null) {
          _items[s.id] = s.copyWith(stored: false);
        } else {
          _items.remove(s.id);
        }
        changed = true;
      }
    }
    _loaded = true;
    notifyListeners();
    if (changed) await _persist();
  }

  /// Articles saved before sync were keyed by a SHA-1 of their URL and had
  /// no document hash. Gives each its shared id (moving the file) and
  /// records what sync needs. [SyncRepository] runs this once before its
  /// first capture; it reads each such document once, off the UI isolate.
  Future<void> migrateLegacy() => _migration ??= _migrateAll();

  Future<void> _migrateAll() async {
    await _loading;
    final legacy = _items.values.where((s) => s.stored && s.bodySha256 == null).toList();
    if (legacy.isEmpty) return;
    for (final s in legacy) {
      await _migrate(s);
    }
    notifyListeners();
    await _persist();
  }

  Future<void> _migrate(ArticleSummary s) async {
    final json = await _files.read(s.id);
    if (json == null) return;
    final Article article;
    try {
      article = await compute(_parse, json);
    } catch (_) {
      return; // Unreadable: it stays on this device and does not sync.
    }
    final current = _items[s.id];
    if (current == null) return; // Removed meanwhile.
    final id = idFor(s.url);
    if (id != s.id) {
      if (_items.containsKey(id)) return; // The same story is already saved under its shared id.
      await _files.write(id, json);
      _items.remove(s.id);
      _moved[s.id] = id;
      if (_recent?.$1 == s.id) _recent = (id, _recent!.$2);
    }
    final bytes = utf8.encode(json);
    _items[id] = _summarize(id, article, s.sourceUrl, s.addedAt, sha256.convert(bytes).toString(), bytes.length)
        .copyWith(lastOpenedAt: current.lastOpenedAt, progress: current.progress, progressUpdatedAt: current.progressUpdatedAt);
    if (id != s.id) await _files.delete(s.id);
  }

  /// Turns typed or pasted text into a page URL: the first http(s) link in
  /// the text, or the text itself with `https://` added when it has no scheme.
  static Uri? parseInput(String input) {
    final text = input.trim();
    if (text.isEmpty) return null;
    final embedded = RegExp(r'https?://\S+', caseSensitive: false).firstMatch(text)?.group(0);
    final candidate = embedded ?? (text.contains(RegExp(r'\s')) ? null : text);
    if (candidate == null) return null;
    final hasScheme = candidate.contains('://');
    if (!hasScheme && RegExp(r'^[a-z][a-z0-9+.-]*:(?!\d)', caseSensitive: false).hasMatch(candidate)) return null;
    final uri = Uri.tryParse(hasScheme ? candidate : 'https://$candidate');
    if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https')) return null;
    final host = uri.host;
    if (host.isEmpty || (!host.contains('.') && host != 'localhost')) return null;
    return uri.removeFragment();
  }

  ArticleSummary? _find(String url) {
    final key = urlKey(url);
    for (final s in _items.values) {
      if (s.url == url || s.sourceUrl == url || urlKey(s.url) == key || urlKey(s.sourceUrl) == key) return s;
    }
    return null;
  }

  /// Fetches, extracts and stores the article at [input]. A link that is
  /// already saved returns the saved article without a request. Throws
  /// [ArticleFetchException] with a message fit for the UI.
  Future<ArticleSummary> add(String input) async {
    final url = parseInput(input);
    if (url == null) throw const ArticleFetchException('Enter a web address, like example.com/story.');
    final existing = _find(url.toString());
    if (existing != null) return existing;
    if (_adding.value != null) throw const ArticleFetchException('Another article is being saved.');
    try {
      _adding.value = const ArticleAddProgress(ArticlePhase.fetching);
      final page = await _fetcher.fetch(
        url,
        onProgress: (f) {
          final last = _adding.value?.fraction;
          if (f == null || last == null || (f - last).abs() >= 0.01 || f == 1) {
            _adding.value = ArticleAddProgress(ArticlePhase.fetching, f);
          }
        },
      );
      final source = page.url.removeFragment().toString();
      final duplicate = _find(source);
      if (duplicate != null) return duplicate;

      _adding.value = const ArticleAddProgress(ArticlePhase.extracting);
      final (Article, String, String, int)? extracted;
      try {
        extracted = await compute(_extract, (page.bytes, page.contentType, source));
      } catch (e) {
        debugPrint('[articles] extraction failed for $source: $e');
        throw const ArticleFetchException("Couldn't read an article from that page.");
      }
      if (extracted == null) throw const ArticleFetchException("Couldn't find an article on that page.");
      final (article, json, bodySha, bodySize) = extracted;
      final saved = _find(article.url);
      if (saved != null) return saved;

      _adding.value = const ArticleAddProgress(ArticlePhase.saving);
      final id = idFor(article.url);
      final same = _items[id];
      if (same != null) return same;
      try {
        await _files.write(id, json);
      } catch (e) {
        throw ArticleFetchException("Couldn't save the article on this device. $e");
      }
      // Saving a deleted article again brings it back, newer than its deletion.
      var addedAt = _now().toUtc();
      final deletedAt = _tombstones.remove(id);
      if (deletedAt != null && !addedAt.isAfter(deletedAt)) addedAt = deletedAt.add(const Duration(milliseconds: 1));
      final summary = _summarize(id, article, source, addedAt, bodySha, bodySize);
      _recent = (id, article);
      _items[id] = summary;
      notifyListeners();
      await _persist();
      return summary;
    } finally {
      _adding.value = null;
    }
  }

  /// The stored document. Parsed on a background isolate. An article synced
  /// from another device downloads its document once here (verified against
  /// its hash) and keeps it for offline reading; that is the only request
  /// this makes. Throws [ArticleFetchException] with a message for people.
  Future<Article> loadArticle(String id) async {
    id = _moved[id] ?? id;
    final recent = _recent;
    if (recent != null && recent.$1 == id) return recent.$2;
    final json = await _files.read(id);
    if (json == null) {
      final summary = _items[id];
      if (summary == null || summary.stored) throw StateError('This article is no longer on this device.');
      try {
        return await _download(summary);
      } on ApiException catch (e) {
        throw ArticleFetchException(_downloadMessage(e));
      }
    }
    final article = await compute(_parse, json);
    _recent = (id, article);
    return article;
  }

  /// Downloads a cloud article's document; joins a download already running.
  Future<Article> _download(ArticleSummary summary) =>
      _downloads[summary.id] ??= _fetchDocument(summary).whenComplete(() {
        _downloads.remove(summary.id);
      });

  Future<Article> _fetchDocument(ArticleSummary summary) async {
    final sha = summary.bodySha256;
    final cloud = _cloud;
    if (sha == null || cloud == null) {
      throw ApiException("This article's text isn't on this device.", code: 'UNSUPPORTED');
    }
    final client = cloud();
    final Article article;
    final String json;
    try {
      final bytes = await client.getArticleBody(sha);
      if (sha256.convert(bytes).toString() != sha) {
        throw ApiException('The synced copy of this article is damaged.', code: 'BAD_RESPONSE');
      }
      try {
        json = utf8.decode(bytes);
        article = await compute(_parse, json);
      } catch (_) {
        throw ApiException('The synced copy of this article is damaged.', code: 'BAD_RESPONSE');
      }
    } catch (_) {
      final previous = _retryAt[summary.id]?.$2 ?? Duration.zero;
      var wait = previous * 2;
      if (wait < _retryMin) wait = _retryMin;
      if (wait > _retryMax) wait = _retryMax;
      _retryAt[summary.id] = (_now().add(wait), wait);
      rethrow;
    } finally {
      client.close();
    }
    _retryAt.remove(summary.id);
    await _files.write(summary.id, json);
    final current = _items[summary.id];
    if (current != null && current.bodySha256 == sha) {
      _items[summary.id] = current.copyWith(stored: true);
      notifyListeners();
      await _persist();
    }
    _recent = (summary.id, article);
    return article;
  }

  static String _downloadMessage(ApiException e) {
    if (e.statusCode == 404) {
      return "This article hasn't finished uploading from the device that saved it. Try again in a minute.";
    }
    if (e.isNetwork) return "Couldn't download this article. Check your connection and try again.";
    return e.message;
  }

  /// Downloads up to [limit] small cloud documents that are due, one at a
  /// time, so recently synced articles open offline. Stops at the first
  /// network failure. Called by [SyncRepository] after a successful cycle.
  Future<void> prefetch(int limit) async {
    if (_cloud == null) return;
    final now = _now();
    final due = _items.values
        .where((s) =>
            !s.stored &&
            s.bodySha256 != null &&
            (s.bodySize ?? prefetchMaxBytes + 1) <= prefetchMaxBytes &&
            !(_retryAt[s.id]?.$1.isAfter(now) ?? false))
        .toList()
      ..sort((a, b) => b.addedAt.compareTo(a.addedAt));
    for (final summary in due.take(limit)) {
      try {
        await _download(summary);
      } on ApiException catch (e) {
        if (e.isNetwork) return;
      } catch (_) {
        // A damaged or unreadable document waits for its retry time.
      }
    }
  }

  /// The exact document bytes to upload, or null when this device no longer
  /// has them.
  Future<(Uint8List, String)?> bodyFor(String id) async {
    final summary = _items[id];
    if (summary == null || !summary.stored) return null;
    final json = await _files.read(id);
    if (json == null) return null;
    final bytes = utf8.encode(json);
    return (bytes, sha256.convert(bytes).toString());
  }

  Future<void> remove(String id) async {
    id = _moved[id] ?? id;
    final summary = _items.remove(id);
    if (summary == null) return;
    if (_recent?.$1 == id) _recent = null;
    // The deletion must sort after the save it removes, even if the clock went back.
    final now = _now().toUtc();
    _tombstones[id] = now.isAfter(summary.addedAt) ? now : summary.addedAt.add(const Duration(milliseconds: 1));
    notifyListeners();
    await _files.delete(id);
    await _persist();
  }

  Future<void> markOpened(String id) => _update(id, (s) => s.copyWith(lastOpenedAt: _now().toUtc()));

  Future<void> saveProgress(String id, ArticleProgress progress) => _update(id, (s) {
        final now = _now().toUtc();
        final last = s.progressUpdatedAt;
        final at = last == null || now.isAfter(last) ? now : last.add(const Duration(milliseconds: 1));
        return s.copyWith(progress: progress, progressUpdatedAt: at);
      });

  /// Applies articles changed on other devices. Saves and deletions are
  /// last-write-wins by their time; positions by theirs. A local copy of the
  /// document is kept when another device saved the same story again. An
  /// open article does not move: its screen holds its own position and saves
  /// it when it closes.
  Future<void> applyRemote(List<RemoteArticle> remote) async {
    var changed = false;
    final removed = <String>[];
    for (final r in remote) {
      final local = _items[r.id];
      if (r.deleted) {
        if (local != null && r.updatedAt.isAfter(local.addedAt)) {
          _items.remove(r.id);
          if (_recent?.$1 == r.id) _recent = null;
          removed.add(r.id);
          changed = true;
        }
        // A later deletion elsewhere supersedes this device's own.
        final deletedAt = _tombstones[r.id];
        if (deletedAt != null && r.updatedAt.isAfter(deletedAt)) {
          _tombstones[r.id] = r.updatedAt;
          changed = true;
        }
        continue;
      }
      final incoming = r.summary;
      if (incoming.bodySha256 == null || parseInput(incoming.url) == null) continue;
      if (local == null) {
        final deletedAt = _tombstones[r.id];
        if (deletedAt != null && !r.updatedAt.isAfter(deletedAt)) continue; // This device's newer deletion is still to sync.
        _tombstones.remove(r.id);
        _items[r.id] = incoming;
        changed = true;
        continue;
      }
      var next = local;
      if (r.updatedAt.isAfter(local.addedAt)) next = next.withRemote(incoming);
      final at = incoming.progressUpdatedAt;
      if (incoming.progress != null && at != null && (local.progressUpdatedAt == null || at.isAfter(local.progressUpdatedAt!))) {
        next = next.copyWith(progress: incoming.progress, progressUpdatedAt: at);
      }
      if (!identical(next, local)) {
        _items[r.id] = next;
        changed = true;
      }
    }
    if (!changed) return;
    notifyListeners();
    await _persist();
    for (final id in removed) {
      try {
        await _files.delete(id);
      } catch (_) {}
    }
  }

  Future<void> _update(String id, ArticleSummary Function(ArticleSummary) change) async {
    id = _moved[id] ?? id;
    final s = _items[id];
    if (s == null) return;
    _items[id] = change(s);
    notifyListeners();
    await _persist();
  }

  Future<void> _persist() {
    final snapshot = {
      'items': [for (final s in _items.values) s.toJson()],
      'tombstones': {for (final t in _tombstones.entries) t.key: t.value.toUtc().toIso8601String()},
    };
    // Serialize snapshots so a slow old write never replaces newer progress.
    final next = _writes.then((_) => _store.writeJson(_key, snapshot));
    _writes = next.catchError((Object e) => debugPrint('Article index persistence failed: $e'));
    return next;
  }

  Future<void> flush() => _writes;

  @override
  void dispose() {
    _adding.dispose();
    _fetcher.close();
    super.dispose();
  }
}

ArticleSummary _summarize(String id, Article article, String source, DateTime addedAt, String bodySha, int bodySize) =>
    ArticleSummary(
      id: id,
      url: article.url,
      sourceUrl: source,
      title: article.title,
      readingMinutes: article.readingMinutes,
      addedAt: addedAt,
      siteName: article.siteName,
      leadImage: article.leadImage?.src ?? _firstImage(article.blocks),
      rtl: article.dir == ArticleDirection.rtl,
      byline: article.byline,
      excerpt: article.excerpt,
      favicon: article.favicon,
      language: article.language,
      wordCount: article.wordCount,
      publishedAt: article.publishedAt,
      blockCount: article.blocks.length,
      bodySha256: bodySha,
      bodySize: bodySize,
    );

String? _firstImage(List<Block> blocks) {
  for (final b in blocks.take(6)) {
    if (b is FigureBlock && b.images.isNotEmpty) return b.images.first.src;
  }
  return null;
}

/// The article, its document JSON and that JSON's SHA-256 and byte size
/// (what sync uploads and other devices verify).
(Article, String, String, int)? _extract((Uint8List, String?, String) input) {
  final (bytes, contentType, url) = input;
  final article = extractArticle(decodeHtml(bytes, contentType: contentType), Uri.parse(url));
  if (article == null) return null;
  final json = jsonEncode(article.toJson());
  final encoded = utf8.encode(json);
  return (article, json, sha256.convert(encoded).toString(), encoded.length);
}

Article _parse(String json) => Article.fromJson(jsonDecode(json) as Map<String, Object?>);
