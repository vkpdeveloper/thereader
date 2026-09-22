import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../data/models/library.dart';
import '../../data/models/settings.dart';
import '../../data/storage/book_store.dart';
import '../engine/reader_engine.dart';
import 'dart_reader_view.dart';
import 'epub_package.dart';

/// Built-in reflowable EPUB engine written in Dart. It parses the real
/// package (container, OPF, spine, TOC) and renders each spine document's
/// XHTML with app typography. Scrolled flow only; pagination and advanced
/// CSS fidelity are what the native Readium engine is for.
class DartReaderEngine implements ReaderEngine {
  const DartReaderEngine();

  static const String engineId = 'dart';

  @override
  String get id => engineId;

  @override
  EngineAvailability get availability => const EngineAvailability.available(
        'Built-in EPUB engine (Dart)',
        note: 'Reflowable EPUB 2/3, scrolled flow, app typography. No pagination or full CSS fidelity.',
      );

  @override
  Future<ReaderController> open({
    required BookFile file,
    required ReaderPreferences prefs,
    ReadingLocator? initialLocator,
  }) async {
    final package = await EpubPackage.open(file);
    return DartReaderController(package: package, prefs: prefs, initial: initialLocator);
  }

  @override
  Widget buildView(BuildContext context, ReaderController controller) =>
      DartReaderView(controller: controller as DartReaderController);
}

class DartReaderController implements ReaderController {
  DartReaderController({required this.package, required ReaderPreferences prefs, ReadingLocator? initial})
      : prefs = ValueNotifier(prefs) {
    final start = initial;
    final item = start == null ? null : package.spineItemFor(start.href);
    _chapter = ValueNotifier(item?.index ?? 0);
    _pendingProgression = item == null ? 0 : start!.progression;
    _locator = ValueNotifier(_makeLocator(_chapter.value, _pendingProgression));
  }

  final EpubPackage package;
  final ValueNotifier<ReaderPreferences> prefs;
  late final ValueNotifier<int> _chapter;
  late final ValueNotifier<ReadingLocator?> _locator;
  double _pendingProgression = 0;

  /// Fraction to scroll to once the current chapter has laid out.
  double get pendingProgression => _pendingProgression;
  ValueListenable<int> get chapter => _chapter;

  @override
  PublicationInfo get info => package.info;

  @override
  ValueListenable<ReadingLocator?> get locator => _locator;

  @override
  ValueListenable<bool>? get controlsToggle => null;

  SpineItem get currentItem => package.spine[_chapter.value];

  ReadingLocator _makeLocator(int index, double progression) {
    final item = package.spine[index];
    final total = (index + progression.clamp(0, 1)) / package.spine.length;
    return ReadingLocator(
      href: item.href,
      progression: progression.clamp(0, 1),
      totalProgression: total.clamp(0, 1),
      title: _titleFor(item.href),
      engine: DartReaderEngine.engineId,
    );
  }

  String? _titleFor(String href) {
    for (final t in package.info.toc) {
      if (t.href.split('#').first == href) return t.title;
    }
    return null;
  }

  /// Called by the view as the user scrolls.
  void reportProgression(double progression) {
    _pendingProgression = progression;
    final next = _makeLocator(_chapter.value, progression);
    final cur = _locator.value;
    if (cur == null || cur.href != next.href || (cur.progression - next.progression).abs() > 0.002) {
      _locator.value = next;
    }
  }

  void _jump(int index, double progression) {
    _pendingProgression = progression;
    if (_chapter.value == index) {
      // Same chapter: force the view to re-seek.
      _chapter.value = -1;
    }
    _chapter.value = index;
    _locator.value = _makeLocator(index, progression);
  }

  @override
  Future<void> goTo(ReadingLocator locator) async {
    final item = package.spineItemFor(locator.href);
    if (item != null) _jump(item.index, locator.progression);
  }

  @override
  Future<void> goToHref(String href) async {
    final item = package.spineItemFor(href);
    if (item != null) _jump(item.index, 0);
  }

  @override
  Future<bool> next() async {
    if (_chapter.value + 1 >= package.spine.length) return false;
    _jump(_chapter.value + 1, 0);
    return true;
  }

  @override
  Future<bool> previous() async {
    if (_chapter.value <= 0) return false;
    _jump(_chapter.value - 1, 0);
    return true;
  }

  @override
  void applyPreferences(ReaderPreferences next) => prefs.value = next;

  @override
  void dispose() {
    prefs.dispose();
    _chapter.dispose();
    _locator.dispose();
  }
}
