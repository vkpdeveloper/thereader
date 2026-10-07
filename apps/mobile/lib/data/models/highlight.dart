import 'package:flutter/foundation.dart';

/// Semantic highlight colours. The key is what is stored and synced; each
/// theme resolves it to a tint (see `highlight_colors.dart`).
enum HighlightColor {
  yellow,
  green,
  blue,
  pink,
  purple;

  static const fallback = HighlightColor.yellow;

  /// Unknown keys (a newer build's colour) render as [fallback].
  static HighlightColor parse(String? key) {
    for (final c in values) {
      if (c.name == key) return c;
    }
    return fallback;
  }
}

/// One passage the reader highlighted, pinned to an edition by [sha256].
/// [locator] is the engine's raw locator JSON, which carries the text
/// quote/range the engine needs to re-anchor it. Deletes are tombstones so
/// they propagate to other devices.
@immutable
class Highlight {
  const Highlight({
    required this.id,
    required this.bookId,
    required this.sha256,
    required this.origin,
    required this.locator,
    required this.text,
    required this.color,
    this.note,
    required this.createdAt,
    required this.updatedAt,
    this.deleted = false,
  });

  final String id;
  final String bookId;
  final String sha256;

  /// API origin the edition came from; highlights sync only within it.
  final String origin;
  final Map<String, dynamic> locator;
  final String text;

  /// Colour key as written; may be unknown to this build.
  final String color;
  final String? note;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool deleted;

  HighlightColor get colorKey => HighlightColor.parse(color);
  String get href => locator['href'] as String? ?? '';

  /// Chapter title recorded by the engine when the highlight was made.
  String? get chapter => locator['title'] as String?;

  /// A note that is only whitespace counts as none.
  String? get noteText {
    final n = note?.trim();
    return n == null || n.isEmpty ? null : note;
  }

  /// [note] is replaced when given; [clearNote] removes it.
  Highlight copyWith({
    String? color,
    DateTime? updatedAt,
    bool? deleted,
    String? bookId,
    String? note,
    bool clearNote = false,
  }) => Highlight(
    id: id,
    bookId: bookId ?? this.bookId,
    sha256: sha256,
    origin: origin,
    locator: locator,
    text: text,
    color: color ?? this.color,
    note: clearNote ? null : note ?? this.note,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    deleted: deleted ?? this.deleted,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'bookId': bookId,
    'sha256': sha256,
    'origin': origin,
    'locator': locator,
    'text': text,
    'color': color,
    if (note != null) 'note': note,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
    'deleted': deleted,
  };

  factory Highlight.fromJson(Map<String, dynamic> json) => Highlight(
    id: json['id'] as String,
    bookId: json['bookId'] as String,
    sha256: json['sha256'] as String,
    origin: json['origin'] as String? ?? '',
    locator: (json['locator'] as Map).cast<String, dynamic>(),
    text: json['text'] as String? ?? '',
    color: json['color'] as String? ?? HighlightColor.fallback.name,
    note: json['note'] as String?,
    createdAt: DateTime.parse(json['createdAt'] as String),
    updatedAt: DateTime.parse(json['updatedAt'] as String),
    deleted: json['deleted'] as bool? ?? false,
  );
}
