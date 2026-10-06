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

/// What the library shows for a saved article without opening its document,
/// plus the metadata sync sends so other devices can list it too.
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
    this.progressUpdatedAt,
    this.stored = true,
    this.byline,
    this.excerpt,
    this.favicon,
    this.language,
    this.wordCount = 0,
    this.publishedAt,
    this.blockCount = 0,
    this.bodySha256,
    this.bodySize,
  });

  /// Derived from [url] (`ArticleRepository.idFor`), the same on every device.
  final String id;

  /// The article's own (canonical) URL.
  final String url;

  /// The address that was saved, after redirects. Used to find duplicates.
  final String sourceUrl;
  final String title;
  final int readingMinutes;

  /// When it was saved; orders saves and deletions between devices.
  final DateTime addedAt;
  final String? siteName;
  final String? leadImage;
  final bool rtl;
  final DateTime? lastOpenedAt;
  final ArticleProgress? progress;

  /// When [progress] last changed; orders positions between devices.
  final DateTime? progressUpdatedAt;

  /// False while only the cloud has the document (saved on another device
  /// and not opened here yet); it downloads when opened.
  final bool stored;
  final String? byline;
  final String? excerpt;
  final String? favicon;
  final String? language;
  final int wordCount;
  final String? publishedAt;

  /// Top-level blocks, to translate reading positions between devices.
  final int blockCount;

  /// SHA-256 and byte size of the document JSON every device shares.
  final String? bodySha256;
  final int? bodySize;

  /// Site name, else the host without `www.`.
  String get site {
    final name = siteName;
    if (name != null && name.isNotEmpty) return name;
    final host = Uri.tryParse(url)?.host ?? '';
    return host.startsWith('www.') ? host.substring(4) : host;
  }

  ArticleSummary copyWith({
    String? id,
    DateTime? lastOpenedAt,
    ArticleProgress? progress,
    DateTime? progressUpdatedAt,
    bool? stored,
    DateTime? addedAt,
  }) => ArticleSummary(
    id: id ?? this.id,
    url: url,
    sourceUrl: sourceUrl,
    title: title,
    readingMinutes: readingMinutes,
    addedAt: addedAt ?? this.addedAt,
    siteName: siteName,
    leadImage: leadImage,
    rtl: rtl,
    lastOpenedAt: lastOpenedAt ?? this.lastOpenedAt,
    progress: progress ?? this.progress,
    progressUpdatedAt: progressUpdatedAt ?? this.progressUpdatedAt,
    stored: stored ?? this.stored,
    byline: byline,
    excerpt: excerpt,
    favicon: favicon,
    language: language,
    wordCount: wordCount,
    publishedAt: publishedAt,
    blockCount: blockCount,
    bodySha256: bodySha256,
    bodySize: bodySize,
  );

  /// This summary with another device's metadata for the same article (saved
  /// again there later). This device keeps its own document, if it has one.
  ArticleSummary withRemote(ArticleSummary remote) => ArticleSummary(
    id: id,
    url: remote.url,
    sourceUrl: sourceUrl,
    title: remote.title,
    readingMinutes: remote.readingMinutes,
    addedAt: remote.addedAt,
    siteName: remote.siteName,
    leadImage: remote.leadImage,
    rtl: remote.rtl,
    lastOpenedAt: lastOpenedAt,
    progress: progress,
    progressUpdatedAt: progressUpdatedAt,
    stored: stored,
    byline: remote.byline,
    excerpt: remote.excerpt,
    favicon: remote.favicon,
    language: remote.language,
    wordCount: remote.wordCount,
    publishedAt: remote.publishedAt,
    blockCount: stored ? blockCount : remote.blockCount,
    bodySha256: stored ? bodySha256 : remote.bodySha256,
    bodySize: stored ? bodySize : remote.bodySize,
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
    if (progressUpdatedAt != null) 'progressUpdatedAt': progressUpdatedAt!.toUtc().toIso8601String(),
    if (!stored) 'stored': false,
    if (byline != null) 'byline': byline,
    if (excerpt != null) 'excerpt': excerpt,
    if (favicon != null) 'favicon': favicon,
    if (language != null) 'language': language,
    if (wordCount != 0) 'wordCount': wordCount,
    if (publishedAt != null) 'publishedAt': publishedAt,
    if (blockCount != 0) 'blockCount': blockCount,
    if (bodySha256 != null) 'bodySha256': bodySha256,
    if (bodySize != null) 'bodySize': bodySize,
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
    progressUpdatedAt: DateTime.tryParse(json['progressUpdatedAt'] as String? ?? ''),
    stored: json['stored'] as bool? ?? true,
    byline: json['byline'] as String?,
    excerpt: json['excerpt'] as String?,
    favicon: json['favicon'] as String?,
    language: json['language'] as String?,
    wordCount: (json['wordCount'] as num?)?.toInt() ?? 0,
    publishedAt: json['publishedAt'] as String?,
    blockCount: (json['blockCount'] as num?)?.toInt() ?? 0,
    bodySha256: json['bodySha256'] as String?,
    bodySize: (json['bodySize'] as num?)?.toInt(),
  );
}
