/// Article extraction for The Reader: HTML in, a structured, renderable
/// article out. A line-for-line port of `packages/truffle` (TypeScript), the
/// reference implementation: for the same page tree both produce the same
/// JSON.
library;

export 'src/dom.dart' show fromDocument;
export 'src/extract.dart' show cleanTitle, extractArticle, extractHtml, extractTree;
export 'src/languages.dart' show detectLanguage, languageFromClass, normalizeLanguage;
export 'src/model.dart';
export 'src/text.dart' show articleText, blocksText, countWords, inlineText;
export 'src/tree.dart' show VDocument, VElement, VNode, VText;
export 'src/url.dart' show canonicalUrl;
