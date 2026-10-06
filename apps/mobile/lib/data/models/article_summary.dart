import 'package:flutter/foundation.dart';

/// Where a reader is in an article: the top-level block at the top of the
/// view, how far into it (0..1), and the share of the text read so far.
@immutable
class ArticleProgress {
  const ArticleProgress({required this.block, required this.offset, required this.percent});

  final int block;
  final double offset;
  final double percent;

  bool get finished => percent >= 0.995;

  Map<String, dynamic> toJson() => {'block': block, 'offset': offset, 'percent': percent};

  factory ArticleProgress.fromJson(Map<String, dynamic> json) => ArticleProgress(
        block: (json['block'] as num).toInt(),
        offset: (json['offset'] as num).toDouble(),
        percent: (json['percent'] as num).toDouble(),
      );
}

/// What the library shows for a saved article without opening its document.
@immutable
class ArticleSummary {
  const ArticleSummary({
    required this.id,
    required this.url,
    required this.sourceUrl,
    required this.title,
    required this.readingMinutes,
    required this.addedAt,
    this.siteName,
    this.leadImage,
    this.rtl = false,
    this.lastOpenedAt,
    this.progress,
  });

  /// Stable file key derived from [url].
  final String id;

  /// The article's own (canonical) URL.
  final String url;

  /// The address that was saved, after redirects. Used to find duplicates.
  final String sourceUrl;
  final String title;
  final int readingMinutes;
  final DateTime addedAt;
  final String? siteName;
  final String? leadImage;
  final bool rtl;
  final DateTime? lastOpenedAt;
  final ArticleProgress? progress;

  /// Site name, else the host without `www.`.
  String get site {
    final name = siteName;
    if (name != null && name.isNotEmpty) return name;
    final host = Uri.tryParse(url)?.host ?? '';
    return host.startsWith('www.') ? host.substring(4) : host;
  }

  ArticleSummary copyWith({DateTime? lastOpenedAt, ArticleProgress? progress}) => ArticleSummary(
        id: id,
        url: url,
        sourceUrl: sourceUrl,
        title: title,
        readingMinutes: readingMinutes,
        addedAt: addedAt,
        siteName: siteName,
        leadImage: leadImage,
        rtl: rtl,
        lastOpenedAt: lastOpenedAt ?? this.lastOpenedAt,
        progress: progress ?? this.progress,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'url': url,
        'sourceUrl': sourceUrl,
        'title': title,
        'readingMinutes': readingMinutes,
        'addedAt': addedAt.toUtc().toIso8601String(),
        if (siteName != null) 'siteName': siteName,
        if (leadImage != null) 'leadImage': leadImage,
        if (rtl) 'rtl': true,
        if (lastOpenedAt != null) 'lastOpenedAt': lastOpenedAt!.toUtc().toIso8601String(),
        if (progress != null) 'progress': progress!.toJson(),
      };

  factory ArticleSummary.fromJson(Map<String, dynamic> json) => ArticleSummary(
        id: json['id'] as String,
        url: json['url'] as String,
        sourceUrl: json['sourceUrl'] as String,
        title: json['title'] as String,
        readingMinutes: (json['readingMinutes'] as num).toInt(),
        addedAt: DateTime.parse(json['addedAt'] as String),
        siteName: json['siteName'] as String?,
        leadImage: json['leadImage'] as String?,
        rtl: json['rtl'] as bool? ?? false,
        lastOpenedAt: json['lastOpenedAt'] == null ? null : DateTime.parse(json['lastOpenedAt'] as String),
        progress: json['progress'] == null
            ? null
            : ArticleProgress.fromJson((json['progress'] as Map).cast<String, dynamic>()),
      );
}
