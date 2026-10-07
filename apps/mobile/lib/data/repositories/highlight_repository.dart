import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../articles/article_anchors.dart';
import '../models/highlight.dart';
import '../storage/key_value_store.dart';

/// Highlights on this device. Every edit is saved locally at once and never
/// sends a request itself: [SyncRepository] notices the change and sends it
/// on its next scheduled cycle. Deletes keep a tombstone so they sync too.
class HighlightRepository extends ChangeNotifier {
  HighlightRepository(this._store, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  static const _key = 'highlights.v1';

  final KeyValueStore _store;
  final DateTime Function() _now;
  final Map<String, Highlight> _items = {};
  Future<void> _writes = Future.value();
  bool _loaded = false;

  bool get loaded => _loaded;

  /// Every record, tombstones included (the sync outbox reads this).
  Iterable<Highlight> get all => _items.values;

  Highlight? byId(String id) => _items[id];

  Future<void> load() async {
    try {
      final saved = await _store.readJson(_key);
      for (final raw in (saved?['items'] as List?) ?? const []) {
        try {
          final h = Highlight.fromJson((raw as Map).cast());
          _items[h.id] = h;
        } catch (_) {
          /* Skip one damaged record rather than losing all of them. */
        }
      }
    } catch (_) {
      /* An unreadable store starts empty; nothing is overwritten until an edit. */
    }
    _loaded = true;
    notifyListeners();
  }

  /// Live highlights of one edition, in reading order.
  List<Highlight> forEdition(String origin, String sha256) {
    final list = _items.values
        .where((h) => !h.deleted && h.origin == origin && h.sha256 == sha256)
        .toList();
    list.sort((a, b) {
      final pa = _position(a), pb = _position(b);
      final c = pa.compareTo(pb);
      return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
    });
    return list;
  }

  /// Live highlights of one saved article in reading order, whatever origin
  /// they were made under (articles themselves show under any origin).
  List<Highlight> forArticle(String articleId) {
    final bookId = ArticleAnchors.bookIdFor(articleId);
    final list = _items.values
        .where(
          (h) =>
              !h.deleted &&
              h.bookId == bookId &&
              h.sha256 == ArticleAnchors.sha256,
        )
        .toList();
    list.sort((a, b) {
      final c = _position(a).compareTo(_position(b));
      return c != 0 ? c : a.createdAt.compareTo(b.createdAt);
    });
    return list;
  }

  static double _position(Highlight h) {
    final loc = h.locator['locations'];
    if (loc is Map) {
      final total = loc['totalProgression'];
      if (total is num) return total.toDouble();
    }
    return 0;
  }

  Future<Highlight> create({
    required String bookId,
    required String sha256,
    required String origin,
    required Map<String, dynamic> locator,
    required String text,
    required String color,
    String? note,
  }) async {
    final at = _stamp();
    final h = Highlight(
      id: _uuid(),
      bookId: bookId,
      sha256: sha256,
      origin: origin,
      locator: locator,
      text: text.length > 4000 ? text.substring(0, 4000) : text,
      color: color,
      note: _clipNote(note),
      createdAt: at,
      updatedAt: at,
    );
    _items[h.id] = h;
    await _changed();
    return h;
  }

  Future<void> recolor(String id, String color) async {
    final h = _items[id];
    if (h == null || h.deleted || h.color == color) return;
    _items[id] = h.copyWith(color: color, updatedAt: _stamp(h));
    await _changed();
  }

  /// Writes or replaces the note; null or blank removes it.
  Future<void> setNote(String id, String? note) async {
    final h = _items[id];
    if (h == null || h.deleted) return;
    final next = _clipNote(note);
    if (next == h.note) return;
    _items[id] = h.copyWith(
      note: next,
      clearNote: next == null,
      updatedAt: _stamp(h),
    );
    await _changed();
  }

  /// The API takes notes up to 4,000 characters.
  static String? _clipNote(String? note) {
    final n = note?.trim();
    if (n == null || n.isEmpty) return null;
    return n.length > maxNote ? n.substring(0, maxNote) : n;
  }

  static const maxNote = 4000;

  Future<void> delete(String id) async {
    final h = _items[id];
    if (h == null || h.deleted) return;
    _items[id] = h.copyWith(deleted: true, updatedAt: _stamp(h));
    await _changed();
  }

  /// Applies a record from the cloud when it is newer (last write wins by
  /// `updatedAt`). Returns whether the local copy now matches [remote].
  Future<bool> applyRemote(List<Highlight> remote) async {
    var changed = false;
    for (final h in remote) {
      final local = _items[h.id];
      if (local != null && !h.updatedAt.isAfter(local.updatedAt)) continue;
      _items[h.id] = h;
      changed = true;
    }
    if (changed) await _changed();
    return changed;
  }

  /// Edits always move forward in time, even if the clock went back, so an
  /// edit is never lost to an older copy under last-write-wins.
  DateTime _stamp([Highlight? previous]) {
    final now = _now().toUtc();
    if (previous != null && !now.isAfter(previous.updatedAt)) {
      return previous.updatedAt.toUtc().add(const Duration(milliseconds: 1));
    }
    return now;
  }

  Future<void> _changed() {
    notifyListeners();
    final snapshot = jsonEncode({
      'items': [for (final h in _items.values) h.toJson()],
    });
    final write = _writes.then((_) => _store.write(_key, snapshot));
    _writes = write.catchError((Object _) {});
    return write;
  }

  Future<void> flush() => _writes;

  static String _uuid() {
    final r = Random.secure();
    return List.generate(
      16,
      (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
  }
}
