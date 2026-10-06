import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:thereader_extract/thereader_extract.dart';

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

/// Saved web articles. A link is fetched on this device, extracted on a
/// background isolate and stored once as an article document; opening an
/// article only reads that document and never touches the network. The index
/// of summaries lives in the key/value store beside the library.
class ArticleRepository extends ChangeNotifier {
  ArticleRepository({required KeyValueStore store, required ArticleStore files, required PageFetcher fetcher})
      : _store = store,
        _files = files,
        _fetcher = fetcher;

  static const _key = 'articles.v1';

  final KeyValueStore _store;
  final ArticleStore _files;
  final PageFetcher _fetcher;
  final Map<String, ArticleSummary> _items = {};
  final ValueNotifier<ArticleAddProgress?> _adding = ValueNotifier(null);
  Future<void> _writes = Future.value();
  (String, Article)? _recent;
  bool _loaded = false;

  bool get loaded => _loaded;
  bool get isDurable => _files.isDurable;

  /// Newest first.
  List<ArticleSummary> get articles =>
      UnmodifiableListView(_items.values.toList()..sort((a, b) => b.addedAt.compareTo(a.addedAt)));

  ArticleSummary? byId(String id) => _items[id];

  /// The save in progress, if any.
  ValueListenable<ArticleAddProgress?> get adding => _adding;

  Future<void> load() async {
    final json = await _store.readJson(_key);
    for (final raw in (json?['items'] as List<dynamic>? ?? const [])) {
      try {
        final s = ArticleSummary.fromJson((raw as Map).cast<String, dynamic>());
        _items[s.id] = s;
      } catch (_) {
        // Skip a corrupt record instead of losing every article.
      }
    }
    // Session-only documents (browser preview) do not survive a reload.
    for (final id in _items.keys.toList()) {
      if (!await _files.exists(id)) _items.remove(id);
    }
    _loaded = true;
    notifyListeners();
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
    for (final s in _items.values) {
      if (s.url == url || s.sourceUrl == url) return s;
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
      final (Article, String)? extracted;
      try {
        extracted = await compute(_extract, (page.bytes, page.contentType, source));
      } catch (e) {
        debugPrint('[articles] extraction failed for $source: $e');
        throw const ArticleFetchException("Couldn't read an article from that page.");
      }
      if (extracted == null) throw const ArticleFetchException("Couldn't find an article on that page.");
      final (article, json) = extracted;
      final saved = _find(article.url);
      if (saved != null) return saved;

      _adding.value = const ArticleAddProgress(ArticlePhase.saving);
      final id = sha1.convert(utf8.encode(article.url)).toString();
      try {
        await _files.write(id, json);
      } catch (e) {
        throw ArticleFetchException("Couldn't save the article on this device. $e");
      }
      final summary = ArticleSummary(
        id: id,
        url: article.url,
        sourceUrl: source,
        title: article.title,
        readingMinutes: article.readingMinutes,
        addedAt: DateTime.now().toUtc(),
        siteName: article.siteName,
        leadImage: article.leadImage?.src ?? _firstImage(article.blocks),
        rtl: article.dir == ArticleDirection.rtl,
      );
      _recent = (id, article);
      _items[id] = summary;
      notifyListeners();
      await _persist();
      return summary;
    } finally {
      _adding.value = null;
    }
  }

  /// The stored document. Parsed on a background isolate.
  Future<Article> loadArticle(String id) async {
    final recent = _recent;
    if (recent != null && recent.$1 == id) return recent.$2;
    final json = await _files.read(id);
    if (json == null) throw StateError('This article is no longer on this device.');
    final article = await compute(_parse, json);
    _recent = (id, article);
    return article;
  }

  Future<void> remove(String id) async {
    if (_items.remove(id) == null) return;
    if (_recent?.$1 == id) _recent = null;
    notifyListeners();
    await _files.delete(id);
    await _persist();
  }

  Future<void> markOpened(String id) => _update(id, (s) => s.copyWith(lastOpenedAt: DateTime.now().toUtc()));

  Future<void> saveProgress(String id, ArticleProgress progress) => _update(id, (s) => s.copyWith(progress: progress));

  Future<void> _update(String id, ArticleSummary Function(ArticleSummary) change) async {
    final s = _items[id];
    if (s == null) return;
    _items[id] = change(s);
    notifyListeners();
    await _persist();
  }

  Future<void> _persist() {
    final snapshot = {
      'items': [for (final s in _items.values) s.toJson()],
    };
    // Serialize snapshots so a slow old write never replaces newer progress.
    final next = _writes.then((_) => _store.writeJson(_key, snapshot));
    _writes = next.catchError((Object e) => debugPrint('Article index persistence failed: $e'));
    return next;
  }

  @override
  void dispose() {
    _adding.dispose();
    _fetcher.close();
    super.dispose();
  }
}

String? _firstImage(List<Block> blocks) {
  for (final b in blocks.take(6)) {
    if (b is FigureBlock && b.images.isNotEmpty) return b.images.first.src;
  }
  return null;
}

(Article, String)? _extract((Uint8List, String?, String) input) {
  final (bytes, contentType, url) = input;
  final article = extractArticle(decodeHtml(bytes, contentType: contentType), Uri.parse(url));
  return article == null ? null : (article, jsonEncode(article.toJson()));
}

Article _parse(String json) => Article.fromJson(jsonDecode(json) as Map<String, Object?>);
