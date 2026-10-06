import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'article_store.dart';

Future<ArticleStore> createArticleStore() async {
  final support = await getApplicationSupportDirectory();
  return IoArticleStore(Directory(p.join(support.path, 'articles')));
}

class IoArticleStore implements ArticleStore {
  IoArticleStore(this.root);

  final Directory root;

  File _file(String id) {
    if (!RegExp(r'^[a-z0-9]+$').hasMatch(id)) throw ArgumentError('Invalid article id');
    return File(p.join(root.path, '$id.json'));
  }

  @override
  bool get isDurable => true;

  /// Written beside the target and renamed, so a crash never leaves half a
  /// document behind.
  @override
  Future<void> write(String id, String json) async {
    await root.create(recursive: true);
    final target = _file(id);
    final part = File('${target.path}.part');
    await part.writeAsString(json, flush: true);
    await part.rename(target.path);
  }

  @override
  Future<String?> read(String id) async {
    final f = _file(id);
    return await f.exists() ? f.readAsString() : null;
  }

  @override
  Future<bool> exists(String id) => _file(id).exists();

  @override
  Future<void> delete(String id) async {
    final f = _file(id);
    if (await f.exists()) await f.delete();
  }
}
