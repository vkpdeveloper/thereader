import 'article_store_stub.dart'
    if (dart.library.io) 'article_store_io.dart'
    if (dart.library.js_interop) 'article_store_web.dart'
    as impl;

/// Saved article documents, one JSON file per article. Native platforms keep
/// them in the application support directory; the browser preview keeps them
/// in memory for the session and says so via [isDurable].
abstract class ArticleStore {
  bool get isDurable;
  Future<void> write(String id, String json);
  Future<String?> read(String id);
  Future<bool> exists(String id);
  Future<void> delete(String id);

  static Future<ArticleStore> create() => impl.createArticleStore();
}
