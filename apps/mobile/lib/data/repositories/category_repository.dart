import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart' hide Category;

import '../models/category.dart';
import '../storage/key_value_store.dart';

/// A category as stored and synced, tombstones included. [color] is the raw
/// key, so a colour from a newer build survives a rename on this one.
@immutable
class CategoryRecord {
  const CategoryRecord({
    required this.id,
    required this.name,
    required this.color,
    required this.createdAt,
    required this.updatedAt,
    this.deleted = false,
  });

  final String id;
  final String name;
  final String color;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool deleted;

  Category toCategory() => Category(
    id: id,
    name: name,
    color: CategoryColor.parse(color),
    createdAt: createdAt,
    updatedAt: updatedAt,
  );

  /// Same content as [other]; timestamps are compared by instant.
  bool sameAs(CategoryRecord other) =>
      other.id == id &&
      other.deleted == deleted &&
      other.updatedAt.isAtSameMomentAs(updatedAt) &&
      (deleted || (other.name == name && other.color == color));

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'color': color,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
    'deleted': deleted,
  };

  factory CategoryRecord.fromJson(Map<String, dynamic> json) {
    final updatedAt = DateTime.parse(json['updatedAt'] as String);
    return CategoryRecord(
      id: json['id'] as String,
      name: json['name'] as String? ?? '',
      color: json['color'] as String? ?? CategoryColor.gray.name,
      createdAt:
          DateTime.tryParse(json['createdAt'] as String? ?? '') ?? updatedAt,
      updatedAt: updatedAt,
      deleted: json['deleted'] == true,
    );
  }
}

/// Which category an item is in, as of [updatedAt]. A null [categoryId]
/// (removed) is kept so the removal syncs.
@immutable
class CategoryAssignment {
  const CategoryAssignment({
    required this.item,
    required this.categoryId,
    required this.updatedAt,
  });

  final CategoryItemRef item;
  final String? categoryId;
  final DateTime updatedAt;

  bool sameAs(CategoryAssignment other) =>
      other.item == item &&
      other.categoryId == categoryId &&
      other.updatedAt.isAtSameMomentAs(updatedAt);

  Map<String, dynamic> toJson() => {
    'itemType': item.type.name,
    'itemId': item.id,
    'categoryId': categoryId,
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };

  /// Null for an item type this build does not know.
  static CategoryAssignment? fromJson(Map<String, dynamic> json) {
    final type = CategoryItemType.values
        .where((t) => t.name == json['itemType'])
        .firstOrNull;
    final id = json['itemId'];
    if (type == null || id is! String || id.isEmpty) return null;
    return CategoryAssignment(
      item: CategoryItemRef(type, id),
      categoryId: json['categoryId'] as String?,
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

/// Categories and which items are in them, on this device. Every edit is
/// saved locally at once and never sends a request itself: [SyncRepository]
/// notices the change and sends it on its next scheduled cycle. Deletions
/// keep a tombstone (final: a deleted category never comes back), and
/// removals keep a `categoryId: null` assignment, so both sync.
///
/// Assignments are not checked against the library; [itemsIn] can name a
/// book or article this device does not have.
class CategoryRepository extends ChangeNotifier implements CategoryStore {
  CategoryRepository(this._store, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  static const _key = 'categories.v1';

  final KeyValueStore _store;
  final DateTime Function() _now;
  final Map<String, CategoryRecord> _records = {};
  final Map<String, CategoryAssignment> _assignments = {};
  Future<void> _writes = Future.value();
  bool _loaded = false;
  List<Category>? _live;
  Map<String, Category>? _byId;

  @override
  bool get loaded => _loaded;

  /// Every category, tombstones included (the sync outbox reads this).
  Iterable<CategoryRecord> get records => _records.values;

  /// Every assignment, removals included (the sync outbox reads this).
  Iterable<CategoryAssignment> get assignments => _assignments.values;

  CategoryRecord? recordFor(String id) => _records[id];

  CategoryAssignment? assignmentFor(CategoryItemRef item) =>
      _assignments[item.key];

  Future<void> load() async {
    try {
      final saved = await _store.readJson(_key);
      for (final raw in (saved?['categories'] as List?) ?? const []) {
        try {
          final r = CategoryRecord.fromJson((raw as Map).cast());
          _records[r.id] = r;
        } catch (_) {
          /* Skip one damaged record rather than losing all of them. */
        }
      }
      for (final raw in (saved?['assignments'] as List?) ?? const []) {
        try {
          final a = CategoryAssignment.fromJson((raw as Map).cast());
          if (a != null) _assignments[a.item.key] = a;
        } catch (_) {
          /* Same. */
        }
      }
    } catch (_) {
      /* An unreadable store starts empty; nothing is overwritten until an edit. */
    }
    _loaded = true;
    _invalidate();
    notifyListeners();
  }

  @override
  List<Category> get categories => _live ??= UnmodifiableListView(
    (_records.values.where((r) => !r.deleted).toList()..sort((a, b) {
          final c = a.createdAt.compareTo(b.createdAt);
          return c != 0 ? c : a.id.compareTo(b.id);
        }))
        .map((r) => r.toCategory()),
  );

  Map<String, Category> get _index =>
      _byId ??= {for (final c in categories) c.id: c};

  @override
  Category? byId(String id) => _index[id];

  @override
  Category? categoryOf(CategoryItemRef item) {
    final id = _assignments[item.key]?.categoryId;
    return id == null ? null : _index[id];
  }

  @override
  List<CategoryItemRef> itemsIn(String categoryId) {
    if (!_index.containsKey(categoryId)) return const [];
    final list =
        _assignments.values.where((a) => a.categoryId == categoryId).toList()
          ..sort((a, b) {
            final c = b.updatedAt.compareTo(a.updatedAt);
            return c != 0 ? c : a.item.key.compareTo(b.item.key);
          });
    return [for (final a in list) a.item];
  }

  /// The trimmed name, or a [FormatException] whose message suits the UI.
  static String validateName(String name) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) throw const FormatException('Enter a name.');
    if (trimmed.length > maxCategoryName) {
      throw const FormatException(
        'Names can be at most $maxCategoryName characters.',
      );
    }
    if (_control.hasMatch(trimmed)) {
      throw const FormatException("Names can't contain control characters.");
    }
    return trimmed;
  }

  static final _control = RegExp(r'[\u0000-\u001f\u007f-\u009f]');

  /// Ids the API takes in a `categoryItem` change. Other items (such as an
  /// article saved before sync, still keyed by its old id) stay on this
  /// device so they cannot fail a batch.
  static bool syncableItem(CategoryItemRef item) => switch (item.type) {
    CategoryItemType.book => item.id.length <= 128 && _bookId.hasMatch(item.id),
    CategoryItemType.article => _articleId.hasMatch(item.id),
  };

  static final _bookId = RegExp(r'^[a-z0-9]+(?:-[a-z0-9]+)*$');
  static final _articleId = RegExp(r'^[a-f0-9]{32}$');

  @override
  Future<Category> create(String name, CategoryColor color) async {
    final trimmed = validateName(name);
    final at = _stamp();
    final record = CategoryRecord(
      id: uuidV4(),
      name: trimmed,
      color: color.name,
      createdAt: at,
      updatedAt: at,
    );
    _records[record.id] = record;
    await _changed();
    return record.toCategory();
  }

  /// A deleted or unknown category is left alone.
  @override
  Future<void> update(String id, {String? name, CategoryColor? color}) async {
    final r = _records[id];
    if (r == null || r.deleted) return;
    final nextName = name == null ? r.name : validateName(name);
    final nextColor = color?.name ?? r.color;
    if (nextName == r.name && nextColor == r.color) return;
    _records[id] = CategoryRecord(
      id: id,
      name: nextName,
      color: nextColor,
      createdAt: r.createdAt,
      updatedAt: _stamp(r.updatedAt),
    );
    await _changed();
  }

  /// Leaves a tombstone and moves this device's items in it back to the
  /// Library home (each one a `categoryId: null` assignment that syncs).
  @override
  Future<void> delete(String id) async {
    final r = _records[id];
    if (r == null || r.deleted) return;
    _records[id] = CategoryRecord(
      id: id,
      name: r.name,
      color: r.color,
      createdAt: r.createdAt,
      updatedAt: _stamp(r.updatedAt),
      deleted: true,
    );
    for (final a in _assignments.values.toList()) {
      if (a.categoryId != id) continue;
      _assignments[a.item.key] = CategoryAssignment(
        item: a.item,
        categoryId: null,
        updatedAt: _stamp(a.updatedAt),
      );
    }
    await _changed();
  }

  /// Throws [ArgumentError] when [categoryId] is not a live category.
  @override
  Future<void> assign(CategoryItemRef item, String? categoryId) async {
    if (categoryId != null && byId(categoryId) == null) {
      throw ArgumentError.value(
        categoryId,
        'categoryId',
        'That category no longer exists.',
      );
    }
    final previous = _assignments[item.key];
    // Nothing to record: already there, or never categorized.
    if ((previous?.categoryId) == categoryId) return;
    _assignments[item.key] = CategoryAssignment(
      item: item,
      categoryId: categoryId,
      updatedAt: _stamp(previous?.updatedAt),
    );
    await _changed();
  }

  /// Applies rows from the cloud, last write wins by `updatedAt`. A
  /// tombstone always wins and a local tombstone is never undone, so a
  /// deleted category cannot come back. Older rows never replace a newer
  /// local edit, which stays queued.
  Future<void> applyRemote({
    List<CategoryRecord> categories = const [],
    List<CategoryAssignment> assignments = const [],
  }) async {
    var changed = false;
    for (final r in categories) {
      final local = _records[r.id];
      if (local != null) {
        if (local.deleted) continue;
        if (!r.deleted && !r.updatedAt.isAfter(local.updatedAt)) continue;
      }
      _records[r.id] = r;
      changed = true;
    }
    for (final a in assignments) {
      final local = _assignments[a.item.key];
      if (local != null && !a.updatedAt.isAfter(local.updatedAt)) continue;
      _assignments[a.item.key] = a;
      changed = true;
    }
    if (changed) await _changed();
  }

  /// Edits always move forward in time, even if the clock went back, so an
  /// edit is never lost to an older copy under last-write-wins. Millisecond
  /// precision, like the server's.
  DateTime _stamp([DateTime? previous]) {
    final ms = _now().millisecondsSinceEpoch;
    final floor = previous == null ? ms : previous.millisecondsSinceEpoch + 1;
    return DateTime.fromMillisecondsSinceEpoch(max(ms, floor), isUtc: true);
  }

  void _invalidate() {
    _live = null;
    _byId = null;
  }

  Future<void> _changed() {
    _invalidate();
    notifyListeners();
    final snapshot = jsonEncode({
      'categories': [for (final r in _records.values) r.toJson()],
      'assignments': [for (final a in _assignments.values) a.toJson()],
    });
    final write = _writes.then((_) => _store.write(_key, snapshot));
    _writes = write.catchError((Object _) {});
    return write;
  }

  Future<void> flush() => _writes;

  /// A random (version 4) UUID, lowercase.
  static String uuidV4() {
    final r = Random.secure();
    final b = List.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final hex = b.map((v) => v.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
