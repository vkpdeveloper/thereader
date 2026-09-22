import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/catalog_source.dart';
import '../models/book.dart';

enum CatalogStatus { idle, loading, ready, error }

/// Remote (or sample) catalog browsing state: search, paging, errors.
class CatalogRepository extends ChangeNotifier {
  CatalogRepository(this._source);

  CatalogSource _source;
  CatalogSource get source => _source;

  final List<Book> _items = [];
  String? _nextCursor;
  String _query = '';
  CatalogStatus _status = CatalogStatus.idle;
  ApiException? _error;
  bool _loadingMore = false;
  int _requestId = 0;
  Timer? _debounce;

  List<Book> get items => List.unmodifiable(_items);
  String get query => _query;
  CatalogStatus get status => _status;
  ApiException? get error => _error;
  bool get hasMore => _nextCursor != null;
  bool get isLoadingMore => _loadingMore;

  /// All subjects seen in the loaded items; used for local filter chips.
  List<String> get subjects {
    final set = <String>{};
    for (final b in _items) {
      set.addAll(b.subjects);
    }
    final list = set.toList()..sort();
    return list;
  }

  void replaceSource(CatalogSource source) {
    if (identical(source, _source)) return;
    _source = source;
    _items.clear();
    _nextCursor = null;
    _status = CatalogStatus.idle;
    _error = null;
    notifyListeners();
  }

  Future<void> refresh() => _load(reset: true);

  void search(String query) {
    _query = query;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () => _load(reset: true));
    notifyListeners();
  }

  Future<void> loadMore() async {
    if (_loadingMore || _nextCursor == null || _status != CatalogStatus.ready) return;
    _loadingMore = true;
    notifyListeners();
    final id = ++_requestId;
    try {
      final page = await _source.listBooks(cursor: _nextCursor, query: _query);
      if (id != _requestId) return;
      _items.addAll(page.items);
      _nextCursor = page.nextCursor;
    } on ApiException catch (e) {
      if (id != _requestId) return;
      _error = e;
    } finally {
      if (id == _requestId) {
        _loadingMore = false;
        notifyListeners();
      }
    }
  }

  Future<void> _load({required bool reset}) async {
    final id = ++_requestId;
    _status = CatalogStatus.loading;
    _error = null;
    if (reset) {
      _items.clear();
      _nextCursor = null;
    }
    notifyListeners();
    try {
      final page = await _source.listBooks(query: _query);
      if (id != _requestId) return;
      _items
        ..clear()
        ..addAll(page.items);
      _nextCursor = page.nextCursor;
      _status = CatalogStatus.ready;
    } on ApiException catch (e) {
      if (id != _requestId) return;
      _error = e;
      _status = CatalogStatus.error;
    } catch (e) {
      if (id != _requestId) return;
      _error = ApiException('Unexpected error: $e', code: 'UNEXPECTED');
      _status = CatalogStatus.error;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }
}
