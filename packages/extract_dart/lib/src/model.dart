/// The article document model: the Dart mirror of
/// `packages/extract/src/model.ts`. `toJson` writes the keys the TypeScript
/// engine writes, in the same order, and omits absent optionals, so stored
/// documents round-trip between the two implementations. Optional lists stay
/// null when absent so an explicit value is never confused with a missing one.
///
/// Types whose TypeScript names collide with Dart or Flutter (`List`, `Image`,
/// `Table`, ...) carry a `Block`, `Article` or `Data` affix. Most fields are
/// mutable because the extractor builds documents in place, as the
/// TypeScript engine does; consumers treat them as read-only. Text runs are
/// immutable (the extractor replaces them), so they can be `const`.
library;

typedef Json = Map<String, Object?>;

const int articleSchema = 1;

/// Inline formatting. Runs list their marks in this order.
enum Mark { bold, italic, underline, strike, code, sub, sup, highlight, small, kbd }

enum ArticleDirection { ltr, rtl }

enum LanguageSource { markup, detected }

enum CellAlign { left, center, right }

enum CalloutVariant { note, tip, info, warning, danger }

sealed class Inline {
  const Inline();

  String get type;

  Json toJson();

  factory Inline.fromJson(Json json) => switch (json['type']) {
    'text' => TextRun.fromJson(json),
    'break' => const LineBreak(),
    'image' => InlineImage.fromJson(json),
    'math' => InlineMath.fromJson(json),
    'ref' => FootnoteRef.fromJson(json),
    final type => throw FormatException('Unknown inline type: $type'),
  };
}

/// A run of text with formatting.
final class TextRun extends Inline {
  const TextRun(this.text, {this.marks, this.href});

  final String text;
  final List<Mark>? marks;

  /// Absolute link target.
  final String? href;

  @override
  String get type => 'text';

  bool has(Mark mark) => marks?.contains(mark) ?? false;

  factory TextRun.fromJson(Json json) => TextRun(
    json['text'] as String,
    marks: _optList(json['marks'], (e) => Mark.values.byName(e as String)),
    href: json['href'] as String?,
  );

  @override
  Json toJson() => {
    'type': type,
    'text': text,
    if (marks != null) 'marks': [for (final m in marks!) m.name],
    if (href != null) 'href': href,
  };
}

final class LineBreak extends Inline {
  const LineBreak();

  @override
  String get type => 'break';

  @override
  Json toJson() => {'type': type};
}

/// A small image inside a line (emoji, icons, inline formulas as images).
final class InlineImage extends Inline {
  InlineImage({required this.src, required this.alt, this.width, this.height});

  String src;
  String alt;
  num? width;
  num? height;

  @override
  String get type => 'image';

  factory InlineImage.fromJson(Json json) => InlineImage(
    src: json['src'] as String,
    alt: json['alt'] as String,
    width: json['width'] as num?,
    height: json['height'] as num?,
  );

  @override
  Json toJson() => {
    'type': type,
    'src': src,
    'alt': alt,
    if (width != null) 'width': width,
    if (height != null) 'height': height,
  };
}

final class InlineMath extends Inline {
  InlineMath({this.tex, this.mathml, required this.text});

  /// LaTeX source when the page provided it.
  String? tex;

  /// Serialized `<math>` element when the page provided MathML.
  String? mathml;

  /// Text fallback.
  String text;

  @override
  String get type => 'math';

  factory InlineMath.fromJson(Json json) =>
      InlineMath(tex: json['tex'] as String?, mathml: json['mathml'] as String?, text: json['text'] as String);

  /// Keys in the order the TypeScript engine writes them: TeX-only math
  /// (`<script type="math/tex">`) is built as `{type, tex, text}`, MathML as
  /// `{type, text, tex?, mathml}`.
  @override
  Json toJson() => mathml == null
      ? {'type': type, if (tex != null) 'tex': tex, 'text': text}
      : {'type': type, 'text': text, if (tex != null) 'tex': tex, 'mathml': mathml};
}

/// A footnote reference; [id] matches a [Footnote].
final class FootnoteRef extends Inline {
  FootnoteRef({required this.id, required this.label});

  String id;
  String label;

  @override
  String get type => 'ref';

  factory FootnoteRef.fromJson(Json json) => FootnoteRef(id: json['id'] as String, label: json['label'] as String);

  @override
  Json toJson() => {'type': type, 'id': id, 'label': label};
}

class ArticleImage {
  ArticleImage({required this.src, required this.alt, this.width, this.height, this.srcset, this.href});

  /// Best available source (largest reasonable candidate).
  String src;
  String alt;
  num? width;
  num? height;

  /// Normalized absolute `srcset`, when the page offered several sizes.
  String? srcset;

  /// Link target when the image itself is a link.
  String? href;

  factory ArticleImage.fromJson(Json json) => ArticleImage(
    src: json['src'] as String,
    alt: json['alt'] as String,
    width: json['width'] as num?,
    height: json['height'] as num?,
    srcset: json['srcset'] as String?,
    href: json['href'] as String?,
  );

  Json toJson() => {
    'src': src,
    'alt': alt,
    if (width != null) 'width': width,
    if (height != null) 'height': height,
    if (srcset != null) 'srcset': srcset,
    if (href != null) 'href': href,
  };
}

sealed class Block {
  const Block();

  String get type;

  Json toJson();

  factory Block.fromJson(Json json) => switch (json['type']) {
    'heading' => HeadingBlock.fromJson(json),
    'paragraph' => ParagraphBlock.fromJson(json),
    'list' => ListBlock.fromJson(json),
    'quote' => QuoteBlock.fromJson(json),
    'code' => CodeBlock.fromJson(json),
    'figure' => FigureBlock.fromJson(json),
    'video' => VideoBlock.fromJson(json),
    'audio' => AudioBlock.fromJson(json),
    'embed' => EmbedBlock.fromJson(json),
    'table' => TableBlock.fromJson(json),
    'rule' => const RuleBlock(),
    'math' => MathBlock.fromJson(json),
    'definitions' => DefinitionListBlock.fromJson(json),
    'details' => DetailsBlock.fromJson(json),
    'callout' => CalloutBlock.fromJson(json),
    'footnotes' => FootnotesBlock.fromJson(json),
    final type => throw FormatException('Unknown block type: $type'),
  };
}

final class HeadingBlock extends Block {
  HeadingBlock({required this.level, required this.content, this.anchor});

  /// 2..6. The article title is the only level-1 heading and is not a block.
  int level;
  List<Inline> content;

  /// Original element id, for in-article links.
  String? anchor;

  @override
  String get type => 'heading';

  factory HeadingBlock.fromJson(Json json) =>
      HeadingBlock(level: json['level'] as int, content: _inlines(json['content']), anchor: json['anchor'] as String?);

  @override
  Json toJson() => {
    'type': type,
    'level': level,
    'content': _inlinesJson(content),
    if (anchor != null) 'anchor': anchor,
  };
}

final class ParagraphBlock extends Block {
  ParagraphBlock(this.content);

  List<Inline> content;

  @override
  String get type => 'paragraph';

  factory ParagraphBlock.fromJson(Json json) => ParagraphBlock(_inlines(json['content']));

  @override
  Json toJson() => {'type': type, 'content': _inlinesJson(content)};
}

class ListItem {
  ListItem({required this.blocks, this.checked});

  List<Block> blocks;

  /// Task-list state.
  bool? checked;

  factory ListItem.fromJson(Json json) => ListItem(blocks: _blocks(json['blocks']), checked: json['checked'] as bool?);

  Json toJson() => {'blocks': _blocksJson(blocks), if (checked != null) 'checked': checked};
}

final class ListBlock extends Block {
  ListBlock({required this.ordered, this.start, required this.items});

  bool ordered;

  /// First number of an ordered list when not 1.
  int? start;
  List<ListItem> items;

  @override
  String get type => 'list';

  factory ListBlock.fromJson(Json json) => ListBlock(
    ordered: json['ordered'] as bool,
    start: json['start'] as int?,
    items: [for (final e in json['items'] as List) ListItem.fromJson(e as Json)],
  );

  @override
  Json toJson() => {
    'type': type,
    'ordered': ordered,
    'items': [for (final i in items) i.toJson()],
    if (start != null) 'start': start,
  };
}

final class QuoteBlock extends Block {
  QuoteBlock({required this.blocks, this.cite, this.pull});

  List<Block> blocks;

  /// Attribution (`<cite>`, `<footer>` inside the quote).
  List<Inline>? cite;

  /// Pull quote: a decorative repeat of article text.
  bool? pull;

  @override
  String get type => 'quote';

  factory QuoteBlock.fromJson(Json json) =>
      QuoteBlock(blocks: _blocks(json['blocks']), cite: _optInlines(json['cite']), pull: json['pull'] as bool?);

  @override
  Json toJson() => {
    'type': type,
    'blocks': _blocksJson(blocks),
    if (cite != null) 'cite': _inlinesJson(cite!),
    if (pull != null) 'pull': pull,
  };
}

final class CodeBlock extends Block {
  CodeBlock({required this.code, required this.language, this.languageSource, this.title});

  /// Verbatim source: line-number gutters and prompts removed, tabs kept.
  String code;

  /// Lowercase canonical language id, or null if unknown.
  String? language;

  /// Where [language] came from: page markup, or the detector.
  LanguageSource? languageSource;

  /// File name or title shown above the block.
  String? title;

  @override
  String get type => 'code';

  factory CodeBlock.fromJson(Json json) => CodeBlock(
    code: json['code'] as String,
    language: json['language'] as String?,
    languageSource: _optEnum(LanguageSource.values, json['languageSource']),
    title: json['title'] as String?,
  );

  @override
  Json toJson() => {
    'type': type,
    'code': code,
    'language': language,
    if (languageSource != null) 'languageSource': languageSource!.name,
    if (title != null) 'title': title,
  };
}

/// One image, or a gallery when [images] has several.
final class FigureBlock extends Block {
  FigureBlock({required this.images, this.caption, this.credit});

  List<ArticleImage> images;
  List<Inline>? caption;
  List<Inline>? credit;

  @override
  String get type => 'figure';

  factory FigureBlock.fromJson(Json json) => FigureBlock(
    images: [for (final e in json['images'] as List) ArticleImage.fromJson(e as Json)],
    caption: _optInlines(json['caption']),
    credit: _optInlines(json['credit']),
  );

  @override
  Json toJson() => {
    'type': type,
    'images': [for (final i in images) i.toJson()],
    if (caption != null) 'caption': _inlinesJson(caption!),
    if (credit != null) 'credit': _inlinesJson(credit!),
  };
}

final class VideoBlock extends Block {
  VideoBlock({required this.provider, required this.url, this.embedUrl, this.poster, this.title, this.caption});

  /// youtube, vimeo, dailymotion, twitch, loom, wistia, ted, file, other.
  String provider;

  /// Page a reader can open (watch page or file URL).
  String url;

  /// Embeddable player URL, when the provider has one.
  String? embedUrl;
  String? poster;
  String? title;
  List<Inline>? caption;

  @override
  String get type => 'video';

  factory VideoBlock.fromJson(Json json) => VideoBlock(
    provider: json['provider'] as String,
    url: json['url'] as String,
    embedUrl: json['embedUrl'] as String?,
    poster: json['poster'] as String?,
    title: json['title'] as String?,
    caption: _optInlines(json['caption']),
  );

  @override
  Json toJson() => {
    'type': type,
    'provider': provider,
    'url': url,
    if (embedUrl != null) 'embedUrl': embedUrl,
    if (poster != null) 'poster': poster,
    if (title != null) 'title': title,
    if (caption != null) 'caption': _inlinesJson(caption!),
  };
}

final class AudioBlock extends Block {
  AudioBlock({required this.provider, required this.url, this.embedUrl, this.title, this.caption});

  String provider;
  String url;
  String? embedUrl;
  String? title;
  List<Inline>? caption;

  @override
  String get type => 'audio';

  factory AudioBlock.fromJson(Json json) => AudioBlock(
    provider: json['provider'] as String,
    url: json['url'] as String,
    embedUrl: json['embedUrl'] as String?,
    title: json['title'] as String?,
    caption: _optInlines(json['caption']),
  );

  @override
  Json toJson() => {
    'type': type,
    'provider': provider,
    'url': url,
    if (embedUrl != null) 'embedUrl': embedUrl,
    if (title != null) 'title': title,
    if (caption != null) 'caption': _inlinesJson(caption!),
  };
}

/// A social post or other third-party embed kept as readable content.
final class EmbedBlock extends Block {
  EmbedBlock({required this.provider, required this.url, this.author, this.blocks});

  /// twitter, mastodon, bluesky, instagram, threads, reddit, tiktok, facebook,
  /// linkedin, codepen, gist, other.
  String provider;
  String url;
  String? author;

  /// The embed's own text, when the page carried it.
  List<Block>? blocks;

  @override
  String get type => 'embed';

  factory EmbedBlock.fromJson(Json json) => EmbedBlock(
    provider: json['provider'] as String,
    url: json['url'] as String,
    author: json['author'] as String?,
    blocks: _optList(json['blocks'], (e) => Block.fromJson(e as Json)),
  );

  @override
  Json toJson() => {
    'type': type,
    'provider': provider,
    'url': url,
    if (author != null) 'author': author,
    if (blocks != null) 'blocks': _blocksJson(blocks!),
  };
}

class TableCellData {
  TableCellData({required this.content, this.header, this.colspan, this.rowspan, this.align});

  List<Inline> content;
  bool? header;
  int? colspan;
  int? rowspan;
  CellAlign? align;

  factory TableCellData.fromJson(Json json) => TableCellData(
    content: _inlines(json['content']),
    header: json['header'] as bool?,
    colspan: json['colspan'] as int?,
    rowspan: json['rowspan'] as int?,
    align: _optEnum(CellAlign.values, json['align']),
  );

  Json toJson() => {
    'content': _inlinesJson(content),
    if (header != null) 'header': header,
    if (colspan != null) 'colspan': colspan,
    if (rowspan != null) 'rowspan': rowspan,
    if (align != null) 'align': align!.name,
  };
}

class TableRowData {
  TableRowData(this.cells);

  List<TableCellData> cells;

  factory TableRowData.fromJson(Json json) =>
      TableRowData([for (final e in json['cells'] as List) TableCellData.fromJson(e as Json)]);

  Json toJson() => {
    'cells': [for (final c in cells) c.toJson()],
  };
}

final class TableBlock extends Block {
  TableBlock({this.caption, required this.rows, this.headerRows});

  List<Inline>? caption;

  /// Rows in order; header rows first.
  List<TableRowData> rows;

  /// Number of leading rows that form the header.
  int? headerRows;

  @override
  String get type => 'table';

  factory TableBlock.fromJson(Json json) => TableBlock(
    caption: _optInlines(json['caption']),
    rows: [for (final e in json['rows'] as List) TableRowData.fromJson(e as Json)],
    headerRows: json['headerRows'] as int?,
  );

  @override
  Json toJson() => {
    'type': type,
    'rows': [for (final r in rows) r.toJson()],
    if (caption != null) 'caption': _inlinesJson(caption!),
    if (headerRows != null) 'headerRows': headerRows,
  };
}

final class RuleBlock extends Block {
  const RuleBlock();

  @override
  String get type => 'rule';

  @override
  Json toJson() => {'type': type};
}

final class MathBlock extends Block {
  MathBlock({this.tex, this.mathml, required this.text});

  String? tex;
  String? mathml;
  String text;

  @override
  String get type => 'math';

  factory MathBlock.fromJson(Json json) =>
      MathBlock(tex: json['tex'] as String?, mathml: json['mathml'] as String?, text: json['text'] as String);

  @override
  Json toJson() => {'type': type, 'text': text, if (tex != null) 'tex': tex, if (mathml != null) 'mathml': mathml};
}

class Definition {
  Definition({required this.term, required this.details});

  List<Inline> term;
  List<Block> details;

  factory Definition.fromJson(Json json) => Definition(term: _inlines(json['term']), details: _blocks(json['details']));

  Json toJson() => {'term': _inlinesJson(term), 'details': _blocksJson(details)};
}

final class DefinitionListBlock extends Block {
  DefinitionListBlock(this.items);

  List<Definition> items;

  @override
  String get type => 'definitions';

  factory DefinitionListBlock.fromJson(Json json) =>
      DefinitionListBlock([for (final e in json['items'] as List) Definition.fromJson(e as Json)]);

  @override
  Json toJson() => {
    'type': type,
    'items': [for (final i in items) i.toJson()],
  };
}

final class DetailsBlock extends Block {
  DetailsBlock({required this.summary, required this.blocks});

  List<Inline> summary;
  List<Block> blocks;

  @override
  String get type => 'details';

  factory DetailsBlock.fromJson(Json json) =>
      DetailsBlock(summary: _inlines(json['summary']), blocks: _blocks(json['blocks']));

  @override
  Json toJson() => {'type': type, 'summary': _inlinesJson(summary), 'blocks': _blocksJson(blocks)};
}

/// Admonitions; [variant] is null when unstyled.
final class CalloutBlock extends Block {
  CalloutBlock({required this.variant, this.title, required this.blocks});

  CalloutVariant? variant;
  List<Inline>? title;
  List<Block> blocks;

  @override
  String get type => 'callout';

  factory CalloutBlock.fromJson(Json json) => CalloutBlock(
    variant: _optEnum(CalloutVariant.values, json['variant']),
    title: _optInlines(json['title']),
    blocks: _blocks(json['blocks']),
  );

  @override
  Json toJson() => {
    'type': type,
    'variant': variant?.name,
    'blocks': _blocksJson(blocks),
    if (title != null) 'title': _inlinesJson(title!),
  };
}

class Footnote {
  Footnote({required this.id, required this.label, required this.blocks});

  String id;
  String label;
  List<Block> blocks;

  factory Footnote.fromJson(Json json) =>
      Footnote(id: json['id'] as String, label: json['label'] as String, blocks: _blocks(json['blocks']));

  Json toJson() => {'id': id, 'label': label, 'blocks': _blocksJson(blocks)};
}

final class FootnotesBlock extends Block {
  FootnotesBlock(this.items);

  List<Footnote> items;

  @override
  String get type => 'footnotes';

  factory FootnotesBlock.fromJson(Json json) =>
      FootnotesBlock([for (final e in json['items'] as List) Footnote.fromJson(e as Json)]);

  @override
  Json toJson() => {
    'type': type,
    'items': [for (final i in items) i.toJson()],
  };
}

class Article {
  Article({
    this.schema = articleSchema,
    required this.url,
    required this.title,
    this.subtitle,
    this.byline,
    this.authors = const [],
    this.siteName,
    this.publishedAt,
    this.modifiedAt,
    this.language,
    this.dir = ArticleDirection.ltr,
    this.excerpt,
    this.leadImage,
    this.favicon,
    required this.wordCount,
    required this.readingMinutes,
    required this.blocks,
  });

  int schema;

  /// Canonical URL when the page declares one on the same site, else the
  /// fetched URL.
  String url;
  String title;

  /// Standfirst / dek.
  String? subtitle;

  /// Display byline, e.g. "Jane Doe and John Roe".
  String? byline;
  List<String> authors;
  String? siteName;

  /// ISO 8601.
  String? publishedAt;
  String? modifiedAt;

  /// BCP 47 tag, e.g. `en`, `pt-BR`.
  String? language;
  ArticleDirection dir;

  /// One or two sentences: the page description or the opening of the text.
  String? excerpt;
  ArticleImage? leadImage;
  String? favicon;
  int wordCount;

  /// Rounded up, at least 1.
  int readingMinutes;
  List<Block> blocks;

  factory Article.fromJson(Json json) {
    final lead = json['leadImage'];
    return Article(
      schema: json['schema'] as int,
      url: json['url'] as String,
      title: json['title'] as String,
      subtitle: json['subtitle'] as String?,
      byline: json['byline'] as String?,
      authors: [for (final a in json['authors'] as List) a as String],
      siteName: json['siteName'] as String?,
      publishedAt: json['publishedAt'] as String?,
      modifiedAt: json['modifiedAt'] as String?,
      language: json['language'] as String?,
      dir: ArticleDirection.values.byName(json['dir'] as String),
      excerpt: json['excerpt'] as String?,
      leadImage: lead == null ? null : ArticleImage.fromJson(lead as Json),
      favicon: json['favicon'] as String?,
      wordCount: json['wordCount'] as int,
      readingMinutes: json['readingMinutes'] as int,
      blocks: _blocks(json['blocks']),
    );
  }

  Json toJson() => {
    'schema': schema,
    'url': url,
    'title': title,
    'subtitle': subtitle,
    'byline': byline,
    'authors': authors,
    'siteName': siteName,
    'publishedAt': publishedAt,
    'modifiedAt': modifiedAt,
    'language': language,
    'dir': dir.name,
    'excerpt': excerpt,
    'leadImage': leadImage?.toJson(),
    'favicon': favicon,
    'wordCount': wordCount,
    'readingMinutes': readingMinutes,
    'blocks': _blocksJson(blocks),
  };
}

List<Inline> _inlines(Object? raw) => [for (final e in raw as List) Inline.fromJson(e as Json)];

List<Inline>? _optInlines(Object? raw) => raw == null ? null : _inlines(raw);

List<Block> _blocks(Object? raw) => [for (final e in raw as List) Block.fromJson(e as Json)];

List<T>? _optList<T>(Object? raw, T Function(Object? e) parse) =>
    raw == null ? null : [for (final e in raw as List) parse(e)];

T? _optEnum<T extends Enum>(List<T> values, Object? name) => name == null ? null : values.byName(name as String);

List<Json> _inlinesJson(List<Inline> content) => [for (final i in content) i.toJson()];

List<Json> _blocksJson(List<Block> blocks) => [for (final b in blocks) b.toJson()];
