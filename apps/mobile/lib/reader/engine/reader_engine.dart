import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../../data/models/highlight.dart';
import '../../data/models/library.dart';
import '../../data/models/settings.dart';
import '../../data/storage/book_store.dart';

/// A table-of-contents entry.
class TocEntry {
  const TocEntry({required this.title, required this.href, this.depth = 0});
  final String title;
  final String href;
  final int depth;
}

/// Metadata the engine could read from the package itself.
class PublicationInfo {
  const PublicationInfo({
    required this.title,
    required this.author,
    required this.spineCount,
    required this.toc,
    this.language,
  });
  final String title;
  final String author;
  final int spineCount;
  final List<TocEntry> toc;
  final String? language;
}

/// Controls the reading surface built by [ReaderEngine.buildView].
abstract class ReaderController {
  PublicationInfo get info;
  ValueListenable<ReadingLocator?> get locator;
  Future<void> goTo(ReadingLocator locator);
  Future<void> goToHref(String href);
  Future<bool> next();
  Future<bool> previous();
  void applyPreferences(ReaderPreferences prefs);

  /// Engines whose native view consumes taps expose the user's "toggle
  /// controls" intent here; null means the host handles taps itself.
  ValueListenable<bool>? get controlsToggle => null;

  void dispose();
}

/// Describes an engine and whether it can be used on this platform/build.
class EngineAvailability {
  const EngineAvailability.available(this.name, {this.note}) : available = true;
  const EngineAvailability.unavailable(this.name, this.note) : available = false;

  final String name;
  final bool available;
  final String? note;
}

/// The EPUB engine boundary. UI code never touches an engine's internals; it
/// opens a publication through [ReaderService] and works with
/// [ReaderController] + the widget from [buildView].
abstract class ReaderEngine {
  String get id;
  EngineAvailability get availability;

  Future<ReaderController> open({
    required BookFile file,
    required ReaderPreferences prefs,
    ReadingLocator? initialLocator,
  });

  Widget buildView(BuildContext context, ReaderController controller);
}

/// Chooses an engine. Prefers native Readium when available and falls back to
/// the built-in Dart engine, reporting exactly which one is in use.
class ReaderService {
  ReaderService({required this.engines});

  final List<ReaderEngine> engines;

  /// Available engines, preferred one first. Callers try them in order.
  List<ReaderEngine> candidates(String preferredId) {
    final available = engines.where((e) => e.availability.available).toList();
    if (available.isEmpty) throw StateError('No reader engine is available on this platform.');
    available.sort((a, b) => (a.id == preferredId ? 0 : 1) - (b.id == preferredId ? 0 : 1));
    return available;
  }

  List<EngineAvailability> get report => engines.map((e) => e.availability).toList();
}

/// Optional native publication search capability.
abstract interface class ReaderSearch {
  Future<List<ReaderSearchMatch>> search(String query);
}

class ReaderSearchMatch {
  const ReaderSearchMatch({required this.excerpt, required this.locator});
  final String excerpt;
  final ReadingLocator locator;
}

/// Optional highlight capability: the engine offers a "Highlight" action on
/// selected text, draws saved highlights, and reports taps on them.
abstract interface class ReaderAnnotations {
  /// Text the user chose to highlight.
  Stream<HighlightSelection> get highlightRequests;

  /// Ids of highlights the user tapped.
  Stream<String> get highlightTaps;

  /// Replaces the drawn highlights. Colours follow the active theme.
  void setHighlights(List<Highlight> highlights);
}

class HighlightSelection {
  const HighlightSelection({required this.locator, required this.text});

  /// Engine locator JSON, including the selected text quote.
  final Map<String, dynamic> locator;
  final String text;
}
