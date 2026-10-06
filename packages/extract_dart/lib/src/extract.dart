import 'dart:math' as math;

import 'package:html/dom.dart';
import 'package:html/parser.dart' as html_parser;

import 'model.dart';
import 'text.dart';

final _space = RegExp(r'\s+');
final _asciiSpace = RegExp(r'[\t\n\f\r ]+');
final _edgeSpace = RegExp(r'^\s+|\s+$');

/// PLACEHOLDER mirroring `packages/extract/src/extract.ts` until the engine is
/// ported: keeps every `<p>` longer than 40 characters as a plain paragraph.
/// Returns null when nothing qualifies.
Article? extractArticle(String html, Uri url) {
  final doc = html_parser.parse(html);
  final blocks = <Block>[];
  for (final p in doc.querySelectorAll('p')) {
    final text = p.text.replaceAll(_space, ' ').replaceAll(_edgeSpace, '');
    if (text.length > 40) blocks.add(ParagraphBlock([TextRun(text)]));
  }
  if (blocks.isEmpty) return null;
  final title = _documentTitle(doc).replaceAll(_edgeSpace, '');
  final wordCount = countWords(blocksText(blocks));
  return Article(
    url: url.toString(),
    title: title.isNotEmpty ? title : url.host,
    language: doc.documentElement?.attributes['lang'],
    wordCount: wordCount,
    readingMinutes: math.max(1, (wordCount + 229) ~/ 230),
    blocks: blocks,
  );
}

/// `document.title` before trimming: the first `<title>`'s child text with
/// ASCII whitespace collapsed.
String _documentTitle(Document doc) {
  final title = doc.querySelector('title');
  if (title == null) return '';
  final text = title.nodes.whereType<Text>().map((t) => t.data).join();
  return text.replaceAll(_asciiSpace, ' ');
}
