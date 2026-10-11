part of pdf_extractor;

const version = '0.3.0';

class PdfException implements Exception {
  final String code, message;
  const PdfException(this.code, this.message);
  @override
  String toString() => '$code: $message';
}

Never _invalid([String message = 'Invalid PDF']) =>
    throw PdfException('INVALID_PDF', message);
Never _limit() =>
    throw const PdfException('RESOURCE_LIMIT', 'PDF resource limit exceeded');
Never _unsupported(String message) =>
    throw PdfException('UNSUPPORTED', message);

class Limits {
  final int inputBytes,
      decodedBytes,
      objects,
      pages,
      operations,
      spans,
      imagePixels,
      assetBytes;
  const Limits({
    this.inputBytes = 64 * 1048576,
    this.decodedBytes = 256 * 1048576,
    this.objects = 200000,
    this.pages = 10000,
    this.operations = 5000000,
    this.spans = 2000000,
    this.imagePixels = 20000000,
    this.assetBytes = 128 * 1048576,
  });
  Limits normalized() => Limits(
    inputBytes: inputBytes > 0 ? inputBytes : 64 * 1048576,
    decodedBytes: decodedBytes > 0 ? decodedBytes : 256 * 1048576,
    objects: objects > 0 ? objects : 200000,
    pages: pages > 0 ? pages : 10000,
    operations: operations > 0 ? operations : 5000000,
    spans: spans > 0 ? spans : 2000000,
    imagePixels: imagePixels > 0 ? imagePixels : 20000000,
    assetBytes: assetBytes > 0 ? assetBytes : 128 * 1048576,
  );
}

class Options {
  final Limits limits;
  final bool keepArtifacts;
  final Duration? timeout;
  final bool Function()? cancelled;
  const Options({
    this.limits = const Limits(),
    this.keepArtifacts = false,
    this.timeout,
    this.cancelled,
  });
}

class Rect {
  final double x, y, width, height;
  const Rect(this.x, this.y, this.width, this.height);
  Map<String, Object?> toJson() => {
    'x': x,
    'y': y,
    'width': width,
    'height': height,
  };
}

class Run {
  String text, link, script, asset;
  bool bold, italic, monochrome;
  double heightEm, depthEm;
  Run({
    this.text = '',
    this.bold = false,
    this.italic = false,
    this.link = '',
    this.script = '',
    this.asset = '',
    this.heightEm = 0,
    this.depthEm = 0,
    this.monochrome = false,
  });
  Run copy() => Run(
    text: text,
    bold: bold,
    italic: italic,
    link: link,
    script: script,
    asset: asset,
    heightEm: heightEm,
    depthEm: depthEm,
    monochrome: monochrome,
  );
  Map<String, Object?> toJson() => {
    'text': text,
    if (bold) 'bold': true,
    if (italic) 'italic': true,
    if (link.isNotEmpty) 'link': link,
    if (script.isNotEmpty) 'script': script,
    if (asset.isNotEmpty) 'asset': asset,
    if (heightEm != 0) 'heightEm': heightEm,
    if (depthEm != 0) 'depthEm': depthEm,
    if (monochrome) 'monochrome': true,
  };
}

class TableCell {
  int row, column, rowSpan, colSpan;
  String text, scope;
  List<Run> runs;
  bool header;
  Rect box;
  TableCell({
    required this.row,
    required this.column,
    this.rowSpan = 1,
    this.colSpan = 1,
    this.text = '',
    this.scope = '',
    List<Run>? runs,
    this.header = false,
    required this.box,
  }) : runs = runs ?? [];
  Map<String, Object?> toJson() => {
    'row': row,
    'column': column,
    'rowSpan': rowSpan,
    'colSpan': colSpan,
    'text': text,
    if (runs.isNotEmpty) 'runs': runs,
    if (header) 'header': true,
    if (scope.isNotEmpty) 'scope': scope,
    'box': box,
  };
}

class Table {
  int rows, columns, headerRows;
  List<TableCell> cells;
  Table({
    required this.rows,
    required this.columns,
    this.headerRows = 0,
    List<TableCell>? cells,
  }) : cells = cells ?? [];
  Map<String, Object?> toJson() => {
    'rows': rows,
    'columns': columns,
    if (headerRows != 0) 'headerRows': headerRows,
    'cells': cells,
  };
}

class Block {
  String kind, text, asset, alt, role, language, representation;
  int level;
  double widthEm;
  bool monochrome;
  List<Run> runs;
  List<List<String>> rows;
  Table? table;
  Rect box;
  Block({
    required this.kind,
    this.text = '',
    List<Run>? runs,
    this.level = 0,
    List<List<String>>? rows,
    this.table,
    this.asset = '',
    this.alt = '',
    this.role = '',
    this.language = '',
    this.representation = '',
    this.widthEm = 0,
    this.monochrome = false,
    required this.box,
  }) : runs = runs ?? [],
       rows = rows ?? [];
  Map<String, Object?> toJson() => {
    'kind': kind,
    if (text.isNotEmpty) 'text': text,
    if (runs.isNotEmpty) 'runs': runs,
    if (level != 0) 'level': level,
    if (rows.isNotEmpty) 'rows': rows,
    if (table != null) 'table': table,
    if (asset.isNotEmpty) 'asset': asset,
    if (alt.isNotEmpty) 'alt': alt,
    if (role.isNotEmpty) 'role': role,
    if (language.isNotEmpty) 'language': language,
    if (representation.isNotEmpty) 'representation': representation,
    if (widthEm != 0) 'widthEm': widthEm,
    if (monochrome) 'monochrome': true,
    'box': box,
  };
}

class Page {
  final int number;
  final double width, height;
  List<Block> blocks;
  bool needsOCR;
  Page({
    required this.number,
    required this.width,
    required this.height,
    List<Block>? blocks,
    this.needsOCR = false,
  }) : blocks = blocks ?? [];
  Map<String, Object?> toJson() => {
    'number': number,
    'width': width,
    'height': height,
    'blocks': blocks,
    if (needsOCR) 'needsOCR': true,
  };
}

class Asset {
  final String name, mediaType;
  final int width, height;
  final Uint8List data;
  Asset(this.name, this.mediaType, this.width, this.height, this.data);
  Map<String, Object?> toJson() => {
    'name': name,
    'mediaType': mediaType,
    'width': width,
    'height': height,
    'data': base64Encode(data),
  };
}

class Outline {
  final String title;
  final int page, level;
  Outline(this.title, this.page, this.level);
  Map<String, Object?> toJson() => {
    'title': title,
    'page': page,
    'level': level,
  };
}

class Warning {
  final String code, message;
  final int page;
  Warning(this.code, this.page, this.message);
  Map<String, Object?> toJson() => {
    'code': code,
    if (page != 0) 'page': page,
    'message': message,
  };
}

class Stats {
  int pages = 0, characters = 0, images = 0, tables = 0, math = 0, headings = 0;
  double durationMs = 0;
  Map<String, Object?> toJson() => {
    'pages': pages,
    'characters': characters,
    'images': images,
    'tables': tables,
    'math': math,
    'headings': headings,
    'durationMs': durationMs,
  };
}

class Document {
  String title = '',
      author = '',
      language = '',
      subject = '',
      keywords = '',
      creator = '',
      created = '',
      sha256 = '',
      markdown = '';
  final List<Page> pages = [];
  final List<Asset> assets = [];
  final List<Outline> outline = [];
  final List<Warning> warnings = [];
  bool complete = true;
  final Stats stats = Stats();
  Map<String, Object?> toJson() => {
    'engine': 'PDF Extractor',
    'version': version,
    'title': title,
    if (author.isNotEmpty) 'author': author,
    if (language.isNotEmpty) 'language': language,
    if (subject.isNotEmpty) 'subject': subject,
    if (keywords.isNotEmpty) 'keywords': keywords,
    if (creator.isNotEmpty) 'creator': creator,
    if (created.isNotEmpty) 'created': created,
    'sha256': sha256,
    'pages': pages,
    'assets': assets,
    'outline': outline,
    'warnings': warnings,
    'complete': complete,
    'markdown': markdown,
    'stats': stats,
  };
}
