/// Article extraction for The Reader: HTML in, a structured, renderable
/// article out. Mirrors `packages/extract` (TypeScript), which is the
/// reference implementation.
library;

export 'src/extract.dart' show extractArticle;
export 'src/model.dart';
export 'src/text.dart' show articleText, blocksText, countWords, inlineText;
