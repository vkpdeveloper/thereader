/// Comic metadata from `ComicInfo.xml`, else the file name (docs/comics.md,
/// "Metadata").
library;

import 'package:xml/xml.dart';

/// Book metadata fields for an imported comic, in the shape `Book.fromJson`
/// and `POST /v1/uploads/prepare` take.
Map<String, dynamic> comicMetadata({
  String? comicInfoXml,
  required String fileName,
}) {
  final info = _parse(comicInfoXml);
  String field(String name, int limit) => _clean(info[name] ?? '', limit);

  final series = field('Series', 300);
  final number = field('Number', 50);
  final issueTitle = field('Title', 300);
  var title = series.isEmpty
      ? issueTitle
      : [
          number.isEmpty ? series : '$series #$number',
          if (issueTitle.isNotEmpty) issueTitle,
        ].join(': ');
  if (title.isEmpty) title = titleFromFileName(fileName);
  final author = [
    field('Writer', 300),
    field('Penciller', 300),
  ].firstWhere((name) => name.isNotEmpty, orElse: () => 'Unknown');
  final language = field('LanguageISO', 32);
  final subjects = <String>{
    'Comics',
    for (final genre in (info['Genre'] ?? '').split(','))
      if (_clean(genre, 100) case final g when g.isNotEmpty) g,
  }.take(32).toList();
  return {
    'title': _clean(title, 300),
    'author': author,
    'description': field('Summary', 4000),
    'language': _languageTag.hasMatch(language) ? language : 'en',
    'subjects': subjects,
  };
}

/// The file name without its extension, `_` → space, trimmed.
String titleFromFileName(String fileName) {
  final base = fileName.split(RegExp(r'[/\\]')).last;
  final dot = base.lastIndexOf('.');
  final stem = dot > 0 ? base.substring(0, dot) : base;
  final title = _clean(stem.replaceAll('_', ' '), 300);
  return title.isEmpty ? 'Untitled' : title;
}

final _languageTag = RegExp(r'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$');

/// Top-level child elements of `<ComicInfo>` by local name; the first
/// non-empty value of each wins. Malformed XML means no metadata.
Map<String, String> _parse(String? xml) {
  if (xml == null) return const {};
  // Reject DTDs outright: ComicInfo never needs entities.
  if (xml.contains('<!DOCTYPE') || xml.contains('<!ENTITY')) return const {};
  try {
    final root = XmlDocument.parse(xml).rootElement;
    if (root.name.local != 'ComicInfo') return const {};
    final fields = <String, String>{};
    for (final element in root.childElements) {
      final text = element.innerText.trim();
      if (text.isNotEmpty) fields.putIfAbsent(element.name.local, () => text);
    }
    return fields;
  } on XmlException {
    return const {};
  }
}

String _clean(String text, int limit) {
  var result = text
      .replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  if (result.length > limit) {
    result = result.substring(0, limit);
    final last = result.codeUnitAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      result = result.substring(0, result.length - 1);
    }
  }
  return result;
}
