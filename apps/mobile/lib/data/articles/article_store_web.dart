import 'article_store.dart';

Future<ArticleStore> createArticleStore() async => MemoryArticleStore();

/// In-memory store used by the browser preview and by tests. Not durable.
class MemoryArticleStore implements ArticleStore {
  final Map<String, String> files = {};

  @override
  bool get isDurable => false;

  @override
  Future<void> write(String id, String json) async => files[id] = json;

  @override
  Future<String?> read(String id) async => files[id];

  @override
  Future<bool> exists(String id) async => files.containsKey(id);

  @override
  Future<void> delete(String id) async => files.remove(id);
}
