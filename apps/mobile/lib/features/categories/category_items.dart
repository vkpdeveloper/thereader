import '../../app_scope.dart';
import '../../data/models/article_summary.dart';
import '../../data/models/book.dart';
import '../../data/models/category.dart';
import '../../data/models/library.dart';

/// A category member found on this device: a library book or a saved article.
sealed class FiledItem {
  const FiledItem();
  CategoryItemRef get ref;
  String get title;
}

class FiledBook extends FiledItem {
  const FiledBook(this.entry);
  final LibraryEntry entry;

  @override
  CategoryItemRef get ref => CategoryItemRef.book(entry.book.id);

  @override
  String get title => entry.book.title;
}

class FiledArticle extends FiledItem {
  const FiledArticle(this.summary);
  final ArticleSummary summary;

  @override
  CategoryItemRef get ref => CategoryItemRef.article(summary.id);

  @override
  String get title => summary.title;
}

/// The category's members that exist here, newest assignment first. Members
/// that have not reached this device yet (or were removed) are skipped, so
/// counts always match what the category screen can show.
List<FiledItem> filedItems(AppServices services, String categoryId) {
  final store = services.categories;
  if (store == null) return const [];
  final books = <String, LibraryEntry>{};
  for (final e in services.library.entries) {
    final seen = books[e.book.id];
    if (seen == null || e.addedAt.isAfter(seen.addedAt)) books[e.book.id] = e;
  }
  final articles = services.articles;
  return [
    for (final ref in store.itemsIn(categoryId))
      if (ref.type == CategoryItemType.book && books[ref.id] != null)
        FiledBook(books[ref.id]!)
      else if (ref.type == CategoryItemType.article && articles?.byId(ref.id) != null)
        FiledArticle(articles!.byId(ref.id)!),
  ];
}

/// True when the item lives in a category and so stays off the Library home.
bool isFiled(CategoryStore? store, CategoryItemRef ref) => store?.categoryOf(ref) != null;

/// Cover for library entries that came from the API; imports and samples
/// resolve their artwork locally.
Uri? coverUriFor(AppServices services, LibraryEntry entry) =>
    entry.source == BookSource.api ? services.sourceForEntry(entry).coverUri(entry.book) : null;

String itemCount(int n) => n == 1 ? '1 item' : '$n items';

/// "3 books · 2 articles", or just one side when the other is empty.
String itemBreakdown(List<FiledItem> items) {
  final books = items.whereType<FiledBook>().length;
  final articles = items.length - books;
  if (books == 0 && articles == 0) return 'Empty';
  return [
    if (books > 0) books == 1 ? '1 book' : '$books books',
    if (articles > 0) articles == 1 ? '1 article' : '$articles articles',
  ].join(' · ');
}
