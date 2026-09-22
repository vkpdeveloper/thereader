import 'package:flutter/foundation.dart';

/// Catalog book as described by the API contract (`docs/api-contract.md`).
@immutable
class Book {
  const Book({
    required this.id,
    required this.version,
    required this.title,
    required this.author,
    required this.description,
    required this.language,
    required this.subjects,
    required this.coverUrl,
    required this.downloadUrl,
    required this.fileSize,
    required this.sha256,
    required this.updatedAt,
  });

  final String id;
  final String version;
  final String title;
  final String author;
  final String description;
  final String language;
  final List<String> subjects;
  final String? coverUrl;
  final String downloadUrl;
  final int fileSize;
  final String sha256;
  final DateTime updatedAt;

  /// Identifies a file edition: `id@version`.
  String get editionKey => '$id@$version';

  factory Book.fromJson(Map<String, dynamic> json) {
    final subjects = (json['subjects'] as List<dynamic>? ?? const [])
        .map((e) => e.toString())
        .toList(growable: false);
    return Book(
      id: json['id'] as String,
      version: (json['version'] ?? '1').toString(),
      title: json['title'] as String? ?? 'Untitled',
      author: json['author'] as String? ?? 'Unknown',
      description: json['description'] as String? ?? '',
      language: json['language'] as String? ?? 'en',
      subjects: subjects,
      coverUrl: json['coverUrl'] as String?,
      downloadUrl: json['downloadUrl'] as String,
      fileSize: (json['fileSize'] as num).toInt(),
      sha256: (json['sha256'] as String).toLowerCase(),
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'version': version,
        'title': title,
        'author': author,
        'description': description,
        'language': language,
        'subjects': subjects,
        'coverUrl': coverUrl,
        'downloadUrl': downloadUrl,
        'fileSize': fileSize,
        'sha256': sha256,
        'updatedAt': updatedAt.toUtc().toIso8601String(),
      };

  @override
  bool operator ==(Object other) =>
      other is Book && other.id == id && other.version == version && other.sha256 == sha256;

  @override
  int get hashCode => Object.hash(id, version, sha256);
}

/// Where a book's metadata and bytes came from.
enum BookSource { sample, api }

extension BookSourceLabel on BookSource {
  String get label => switch (this) { BookSource.sample => 'Sample', BookSource.api => 'API' };
}
