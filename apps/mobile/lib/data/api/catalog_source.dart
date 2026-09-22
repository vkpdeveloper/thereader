import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart' show AssetBundle, rootBundle;

import '../models/book.dart';
import 'api_client.dart';

/// Abstracts where books and bytes come from so the UI is identical in sample
/// and API mode while the mode itself stays explicit and visible.
abstract class CatalogSource {
  BookSource get source;

  /// Stable origin string stored on library entries.
  String get origin;

  Future<BookPage> listBooks({int limit = 24, String? cursor, String? query});
  Future<Book> getBook(String id);
  Future<DownloadStream> openDownload(Book book);
  Uri? coverUri(Book book);
}

class ApiCatalogSource implements CatalogSource {
  ApiCatalogSource(this.client);

  final ApiClient client;

  @override
  BookSource get source => BookSource.api;

  @override
  String get origin => client.baseUri.toString();

  @override
  Future<BookPage> listBooks({int limit = 24, String? cursor, String? query}) =>
      client.listBooks(limit: limit, cursor: cursor, query: query);

  @override
  Future<Book> getBook(String id) => client.getBook(id);

  @override
  Future<DownloadStream> openDownload(Book book) => client.openDownload(book);

  @override
  Uri? coverUri(Book book) {
    final c = book.coverUrl;
    if (c == null || c.isEmpty) return null;
    return client.resolve(c);
  }
}

/// Bundled sample catalog. Bytes come from app assets, streamed in chunks so
/// the download/verification pipeline is exercised for real.
class SampleCatalogSource implements CatalogSource {
  SampleCatalogSource({AssetBundle? bundle, this.chunkSize = 64 * 1024}) : _bundle = bundle ?? rootBundle;

  final AssetBundle _bundle;
  final int chunkSize;
  List<Book>? _cache;

  static const String manifestAsset = 'assets/samples/manifest.json';

  @override
  BookSource get source => BookSource.sample;

  @override
  String get origin => 'sample';

  Future<List<Book>> _all() async {
    if (_cache != null) return _cache!;
    final raw = await _bundle.loadString(manifestAsset);
    final json = (jsonDecode(raw) as Map).cast<String, dynamic>();
    _cache = (json['items'] as List<dynamic>)
        .map((e) => Book.fromJson((e as Map).cast<String, dynamic>()))
        .toList(growable: false);
    return _cache!;
  }

  @override
  Future<BookPage> listBooks({int limit = 24, String? cursor, String? query}) async {
    var items = await _all();
    final q = query?.trim().toLowerCase();
    if (q != null && q.isNotEmpty) {
      items = items
          .where((b) =>
              b.title.toLowerCase().contains(q) ||
              b.author.toLowerCase().contains(q) ||
              b.subjects.any((s) => s.toLowerCase().contains(q)))
          .toList(growable: false);
    }
    final start = int.tryParse(cursor ?? '') ?? 0;
    final end = (start + limit).clamp(0, items.length);
    return BookPage(
      items: items.sublist(start.clamp(0, items.length), end),
      nextCursor: end < items.length ? '$end' : null,
    );
  }

  @override
  Future<Book> getBook(String id) async {
    final all = await _all();
    return all.firstWhere(
      (b) => b.id == id,
      orElse: () => throw ApiException('Sample book not found.', code: 'NOT_FOUND', statusCode: 404),
    );
  }

  @override
  Future<DownloadStream> openDownload(Book book) async {
    final data = await _bundle.load('assets/samples/${book.id}.epub');
    final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    return DownloadStream(stream: _chunks(bytes), contentLength: bytes.length);
  }

  Stream<List<int>> _chunks(Uint8List bytes) async* {
    for (var i = 0; i < bytes.length; i += chunkSize) {
      final end = (i + chunkSize).clamp(0, bytes.length);
      yield Uint8List.sublistView(bytes, i, end);
      // Yield to the event loop so progress paints between chunks.
      await Future<void>.delayed(Duration.zero);
    }
  }

  @override
  Uri? coverUri(Book book) => null;
}
