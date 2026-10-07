import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// Categories: named, coloured groups of books and saved articles. See
/// docs/categories.md for the behaviour and sync contract.

/// Twelve semantic colours in picker order; hues match the web app.
enum CategoryColor {
  red(Color(0xFFFF6166)),
  orange(Color(0xFFFF9907)),
  amber(Color(0xFFF5C518)),
  lime(Color(0xFFA3E635)),
  green(Color(0xFF62C073)),
  teal(Color(0xFF2DD4BF)),
  cyan(Color(0xFF1DA9B0)),
  blue(Color(0xFF52A8FF)),
  indigo(Color(0xFF818CF8)),
  purple(Color(0xFFC472FB)),
  pink(Color(0xFFF75F8F)),
  gray(Color(0xFFA1A1A1));

  const CategoryColor(this.hue);

  final Color hue;

  /// Unknown keys (a newer build's colour) render as gray.
  static CategoryColor parse(String? key) => values.firstWhere(
    (c) => c.name == key,
    orElse: () => CategoryColor.gray,
  );

  /// First colour no live category uses yet, else blue.
  static CategoryColor next(Iterable<CategoryColor> used) {
    final taken = used.toSet();
    return values.firstWhere(
      (c) => !taken.contains(c),
      orElse: () => CategoryColor.blue,
    );
  }
}

const maxCategoryName = 60;

enum CategoryItemType { book, article }

/// A book (`Book.id`) or a saved article (32-hex article id).
@immutable
class CategoryItemRef {
  const CategoryItemRef(this.type, this.id);

  const CategoryItemRef.book(this.id) : type = CategoryItemType.book;
  const CategoryItemRef.article(this.id) : type = CategoryItemType.article;

  final CategoryItemType type;
  final String id;

  String get key => '${type.name}:$id';

  @override
  bool operator ==(Object other) =>
      other is CategoryItemRef && other.type == type && other.id == id;

  @override
  int get hashCode => Object.hash(type, id);

  @override
  String toString() => key;
}

@immutable
class Category {
  const Category({
    required this.id,
    required this.name,
    required this.color,
    required this.createdAt,
    required this.updatedAt,
  });

  /// Client-generated UUID.
  final String id;
  final String name;
  final CategoryColor color;
  final DateTime createdAt;
  final DateTime updatedAt;
}

/// What the UI needs from categories. `CategoryRepository` implements it
/// with local persistence and sync; widget tests can use an in-memory fake.
abstract class CategoryStore implements Listenable {
  bool get loaded;

  /// Live categories, oldest first.
  List<Category> get categories;

  Category? byId(String id);

  /// The item's live category, or null when it is uncategorized (including
  /// assignments to a deleted or unknown category).
  Category? categoryOf(CategoryItemRef item);

  /// Items in the category, newest assignment first.
  List<CategoryItemRef> itemsIn(String categoryId);

  Future<Category> create(String name, CategoryColor color);

  Future<void> update(String id, {String? name, CategoryColor? color});

  /// Deletes the category; its items return to the Library home.
  Future<void> delete(String id);

  /// Moves [item] into [categoryId], or out of any category with null.
  Future<void> assign(CategoryItemRef item, String? categoryId);
}
