import 'package:flutter/foundation.dart' hide Category;
import 'package:thereader/data/models/category.dart';

/// In-memory [CategoryStore] for widget tests: no persistence, no sync.
class FakeCategoryStore extends ChangeNotifier implements CategoryStore {
  FakeCategoryStore({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;
  final Map<String, Category> _categories = {};

  /// Item key → (category id, assigned at). Insertion order is kept stable.
  final Map<String, (String, DateTime, CategoryItemRef)> _assignments = {};
  int _ids = 0;
  int _ticks = 0;

  /// Strictly increasing timestamps so "newest first" is deterministic.
  DateTime _stamp() => _now().add(Duration(microseconds: _ticks++));

  @override
  bool get loaded => true;

  @override
  List<Category> get categories =>
      _categories.values.toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));

  @override
  Category? byId(String id) => _categories[id];

  @override
  Category? categoryOf(CategoryItemRef item) {
    final id = _assignments[item.key]?.$1;
    return id == null ? null : _categories[id];
  }

  @override
  List<CategoryItemRef> itemsIn(String categoryId) {
    final rows = _assignments.values.where((a) => a.$1 == categoryId).toList()
      ..sort((a, b) => b.$2.compareTo(a.$2));
    return [for (final r in rows) r.$3];
  }

  @override
  Future<Category> create(String name, CategoryColor color) async {
    final at = _stamp();
    final c = Category(
      id: 'cat-${_ids++}',
      name: name.trim(),
      color: color,
      createdAt: at,
      updatedAt: at,
    );
    _categories[c.id] = c;
    notifyListeners();
    return c;
  }

  @override
  Future<void> update(String id, {String? name, CategoryColor? color}) async {
    final c = _categories[id];
    if (c == null) return;
    _categories[id] = Category(
      id: id,
      name: name?.trim() ?? c.name,
      color: color ?? c.color,
      createdAt: c.createdAt,
      updatedAt: _stamp(),
    );
    notifyListeners();
  }

  @override
  Future<void> delete(String id) async {
    _categories.remove(id);
    _assignments.removeWhere((_, a) => a.$1 == id);
    notifyListeners();
  }

  @override
  Future<void> assign(CategoryItemRef item, String? categoryId) async {
    if (categoryId != null && !_categories.containsKey(categoryId)) {
      throw ArgumentError.value(categoryId, 'categoryId', 'That category no longer exists.');
    }
    if (categoryId == null) {
      _assignments.remove(item.key);
    } else {
      _assignments[item.key] = (categoryId, _stamp(), item);
    }
    notifyListeners();
  }
}
