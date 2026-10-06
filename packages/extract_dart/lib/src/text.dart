import 'model.dart';

/// Plain text of inline content. Breaks become newlines.
String inlineText(List<Inline> content) {
  final out = StringBuffer();
  for (final node in content) {
    switch (node) {
      case TextRun(:final text):
        out.write(text);
      case LineBreak():
        out.write('\n');
      case InlineImage():
        break;
      case InlineMath(:final text):
        out.write(text);
      case FootnoteRef(:final label):
        out.write(label);
    }
  }
  return out.toString();
}

void _blockText(Block block, List<String> out) {
  switch (block) {
    case HeadingBlock(:final content):
    case ParagraphBlock(:final content):
      out.add(inlineText(content));
    case ListBlock(:final items):
      for (final item in items) {
        for (final child in item.blocks) {
          _blockText(child, out);
        }
      }
    case QuoteBlock(:final blocks, :final cite):
      for (final child in blocks) {
        _blockText(child, out);
      }
      if (cite != null) out.add(inlineText(cite));
    case CodeBlock(:final code):
      out.add(code);
    case FigureBlock():
    case VideoBlock():
    case AudioBlock():
      break;
    case EmbedBlock(:final blocks):
      for (final child in blocks ?? const <Block>[]) {
        _blockText(child, out);
      }
    case TableBlock(:final caption, :final rows):
      if (caption != null) out.add(inlineText(caption));
      for (final row in rows) {
        out.add(row.cells.map((cell) => inlineText(cell.content)).join('\t'));
      }
    case RuleBlock():
      break;
    case MathBlock(:final text):
      out.add(text);
    case DefinitionListBlock(:final items):
      for (final item in items) {
        out.add(inlineText(item.term));
        for (final child in item.details) {
          _blockText(child, out);
        }
      }
    case DetailsBlock(:final summary, :final blocks):
      out.add(inlineText(summary));
      for (final child in blocks) {
        _blockText(child, out);
      }
    case CalloutBlock(:final title, :final blocks):
      if (title != null) out.add(inlineText(title));
      for (final child in blocks) {
        _blockText(child, out);
      }
    case FootnotesBlock(:final items):
      for (final item in items) {
        for (final child in item.blocks) {
          _blockText(child, out);
        }
      }
  }
}

/// Body text of an article (title excluded), one block per paragraph. Media
/// captions belong to their media, not the running text (schema.org
/// `articleBody` semantics).
String blocksText(List<Block> blocks) {
  final out = <String>[];
  for (final block in blocks) {
    _blockText(block, out);
  }
  return out.where((part) => part.isNotEmpty).join('\n\n');
}

String articleText(Article article) => blocksText(article.blocks);

final _cjk = RegExp('[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]');
final _edgeSpace = RegExp(r'^\s+|\s+$');
final _space = RegExp(r'\s+');

/// Words for reading time: whitespace-separated tokens, CJK characters
/// counted at two per word. Whitespace follows JavaScript's `\s`, as in the
/// TypeScript engine.
int countWords(String text) {
  final cjkChars = _cjk.allMatches(text).length;
  final rest = text.replaceAll(_cjk, ' ').replaceAll(_edgeSpace, '');
  final words = rest.isEmpty ? 0 : rest.split(_space).length;
  return words + (cjkChars + 1) ~/ 2;
}
