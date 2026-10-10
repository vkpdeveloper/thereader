import 'dart:async';
import 'dart:collection';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

import 'comic_archive.dart';

/// A decoded page: its intrinsic size and an image at display resolution.
class DecodedComicPage {
  const DecodedComicPage(this.intrinsic, this.image);
  final ui.Size intrinsic;
  final ui.Image image;
}

typedef ComicPageDecoder =
    Future<DecodedComicPage> Function(
      Uint8List bytes,
      ui.Size Function(ui.Size intrinsic) targetFor,
    );

/// Decodes straight to the requested size; never upscales.
Future<DecodedComicPage> decodeComicPage(
  Uint8List bytes,
  ui.Size Function(ui.Size intrinsic) targetFor,
) async {
  var intrinsic = ui.Size.zero;
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final codec = await ui.instantiateImageCodecWithSize(
    buffer,
    getTargetSize: (w, h) {
      intrinsic = ui.Size(w.toDouble(), h.toDouble());
      final target = targetFor(intrinsic);
      if (target.width >= w || target.height >= h) return const ui.TargetImageSize();
      return ui.TargetImageSize(
        width: target.width.round().clamp(1, w),
        height: target.height.round().clamp(1, h),
      );
    },
  );
  try {
    final frame = await codec.getNextFrame();
    return DecodedComicPage(intrinsic, frame.image);
  } finally {
    codec.dispose();
  }
}

/// Loads, decodes and evicts page images for one open comic. Reads run a
/// couple at a time, nearest the reader's position first; a failed read is
/// retried quietly and never holds up the other pages.
class ComicPageStore extends ChangeNotifier {
  ComicPageStore({
    required this.pageCount,
    required Future<Uint8List> Function(int page) read,
    ComicPageDecoder decode = decodeComicPage,
    this.maxConcurrent = 2,
  }) : _read = read,
       _decode = decode;

  factory ComicPageStore.forArchive(ComicArchive archive, {ComicPageDecoder? decode}) =>
      ComicPageStore(
        pageCount: archive.pages.length,
        read: archive.readPage,
        decode: decode ?? decodeComicPage,
      );

  final int pageCount;
  final Future<Uint8List> Function(int page) _read;
  final ComicPageDecoder _decode;
  final int maxConcurrent;

  /// Automatic retries before a page shows its retry button.
  static const autoRetries = 3;

  /// Encoded bytes kept for re-decoding at a new size (rotation, zoom).
  static const _bytesBudget = 48 << 20;

  final Map<int, ui.Size> _sizes = {};
  final Map<int, ui.Image> _images = {};

  /// Width each page was last decoded for, so a source smaller than asked
  /// for isn't decoded again and again.
  final Map<int, double> _decodedFor = {};
  final Set<int> _loading = {};
  final Map<int, int> _failures = {};
  final Map<int, String> _errors = {};
  final Map<int, Timer> _retryTimers = {};
  final LinkedHashMap<int, Uint8List> _bytes = LinkedHashMap();
  int _bytesSize = 0;

  List<int> _wanted = const [];
  Set<int> _keep = const {};
  ui.Size Function(int page, ui.Size intrinsic) _target = (_, s) => s;
  bool _disposed = false;

  /// Bumps whenever a page turns out to be wider than tall, which is the only
  /// discovery that changes how pages pair into spreads.
  int get wideRevision => _wideRevision;
  int _wideRevision = 0;

  ui.Size? sizeOf(int page) => _sizes[page];
  ui.Image? imageOf(int page) => _images[page];
  bool isLoading(int page) => _loading.contains(page) || _retryTimers.containsKey(page);

  /// Set once automatic retries are exhausted or the page can't be decoded.
  String? errorOf(int page) => _errors[page];

  /// Pages with an image in memory (for tests and diagnostics).
  Iterable<int> get decodedPages => _images.keys;

  bool isWide(int page) {
    final s = _sizes[page];
    return s != null && s.width > s.height;
  }

  /// [wanted] in priority order; every image outside [keep] is released.
  /// [target] gives the pixel size a page should be decoded at.
  void request(
    List<int> wanted, {
    required Set<int> keep,
    required ui.Size Function(int page, ui.Size intrinsic) target,
  }) {
    if (_disposed) return;
    _wanted = wanted;
    _keep = {...keep, ...wanted};
    _target = target;
    for (final page in _images.keys.where((p) => !_keep.contains(p)).toList()) {
      _images.remove(page)!.dispose();
      _decodedFor.remove(page);
    }
    _pump();
  }

  /// Clears a page's failure state and tries again now.
  void retry(int page) {
    _errors.remove(page);
    _failures.remove(page);
    _retryTimers.remove(page)?.cancel();
    notifyListeners();
    _pump();
  }

  bool _needsDecode(int page) {
    if (_loading.contains(page) || _errors.containsKey(page)) return false;
    if (_retryTimers.containsKey(page)) return false;
    final image = _images[page];
    if (image == null) return true;
    final intrinsic = _sizes[page]!;
    final target = _target(page, intrinsic);
    // Sharper only when meaningfully larger and the source has the pixels.
    return target.width > (_decodedFor[page] ?? 0) * 1.15 && image.width < intrinsic.width;
  }

  void _pump() {
    if (_disposed) return;
    for (final page in _wanted) {
      if (_loading.length >= maxConcurrent) return;
      if (page < 0 || page >= pageCount || !_needsDecode(page)) continue;
      _loading.add(page);
      unawaited(_load(page));
    }
  }

  Future<void> _load(int page) async {
    try {
      final bytes = _bytes[page] ?? await _read(page);
      if (_disposed) return;
      _remember(page, bytes);
      final DecodedComicPage decoded;
      var requested = 0.0;
      try {
        decoded = await _decode(bytes, (intrinsic) {
          final target = _target(page, intrinsic);
          requested = target.width;
          return target;
        });
      } catch (e) {
        _errors[page] = "This page can't be shown.";
        return;
      }
      if (!_disposed) _recordSize(page, decoded.intrinsic);
      if (_disposed || !_keep.contains(page)) {
        decoded.image.dispose();
        return;
      }
      _images.remove(page)?.dispose();
      _images[page] = decoded.image;
      _decodedFor[page] = requested;
      _failures.remove(page);
    } on ComicFormatException catch (e) {
      _errors[page] = e.message;
    } catch (e) {
      if (_disposed) return;
      final failures = (_failures[page] ?? 0) + 1;
      _failures[page] = failures;
      if (failures > autoRetries) {
        _errors[page] = "Couldn't load this page.";
      } else {
        _retryTimers[page] = Timer(Duration(milliseconds: 600 * (1 << failures)), () {
          _retryTimers.remove(page);
          _pump();
        });
      }
    } finally {
      _loading.remove(page);
      if (!_disposed) {
        notifyListeners();
        _pump();
      }
    }
  }

  void _recordSize(int page, ui.Size size) {
    final known = _sizes[page];
    _sizes[page] = size;
    if (size.width > size.height && (known == null || known.width <= known.height)) {
      _wideRevision++;
    }
  }

  void _remember(int page, Uint8List bytes) {
    final old = _bytes.remove(page);
    if (old != null) _bytesSize -= old.length;
    _bytes[page] = bytes;
    _bytesSize += bytes.length;
    while (_bytesSize > _bytesBudget && _bytes.length > 1) {
      final first = _bytes.keys.first;
      _bytesSize -= _bytes.remove(first)!.length;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    for (final t in _retryTimers.values) {
      t.cancel();
    }
    _retryTimers.clear();
    for (final image in _images.values) {
      image.dispose();
    }
    _images.clear();
    _bytes.clear();
    super.dispose();
  }
}
