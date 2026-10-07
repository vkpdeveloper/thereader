/// Markdown of an article, for consumers that render it themselves
/// (`markdown.ts`). The output is GitHub Flavored Markdown (CommonMark plus
/// pipe tables, task lists, strikethrough and `[^label]` footnotes), with
/// `$…$` / `$$…$$` math as GitHub, remark-math and KaTeX read it and callouts
/// as GitHub alerts (`> [!NOTE]`). It holds no raw HTML, so renderers that
/// strip HTML lose nothing.
///
/// Text is escaped wherever it could read as syntax, and emphasis that a
/// CommonMark parser would not see as emphasis (a delimiter between a letter
/// and punctuation, as in `x**(y)**`) is written as plain text, so every
/// renderer shows the article's words and nothing else.
///
/// Single-character tests the TypeScript engine writes as regular expressions
/// (`/\s/`, `/[\p{P}\p{S}]/u`, the escape set) are code-unit checks here, with
/// the same results: Dart's `\s` is JavaScript's, and the Unicode classes are
/// looked up once per code unit.
library;

import 'dart:math' as math;

import 'js.dart';
import 'model.dart';

/// The article as Markdown: the title as a level-1 heading, then the body.
String articleMarkdown(Article article) {
  final body = blocksMarkdown(article.blocks);
  final title = article.title.isNotEmpty ? _heading(1, _escapeText(article.title, false)) : '';
  if (title.isEmpty) return body;
  return body.isEmpty ? '$title\n' : '$title\n\n$body';
}

/// Body blocks as Markdown, ending with one newline (empty when nothing renders).
String blocksMarkdown(List<Block> blocks) {
  final writer = _Writer(blocks);
  final out = writer.blocks(blocks, '\n\n', true);
  return out.isEmpty ? '' : '$out\n';
}

// ------------------------------------------------------------------ inline

const _bold = 1;
const _italic = 2;
const _strike = 4;
const _link = 8;
const _markBits = [_bold, _italic, _strike];

/// One piece of a line: escaped text, a code span, an image, math, a footnote call or a break.
class _Atom {
  _Atom(this.md, this.marks, this.href, [this.code]);

  String md;
  final int marks;
  final String? href;

  /// Source of a code span.
  String? code;
}

final _whitespace = RegExp(r'\s');
final _punctuation = RegExp(r'[\p{P}\p{S}]', unicode: true);

/// `/\s/.test(ch)` for a character from [_firstChar] / [_lastChar].
bool _isSpace(String ch) {
  if (ch.isEmpty) return false;
  return ch.length == 1 ? isJsSpace(ch.codeUnitAt(0)) : _whitespace.hasMatch(ch);
}

/// CommonMark character classes for flanking: 0 whitespace or line edge, 1 punctuation, 2 anything else.
int _charClass(String ch) {
  if (ch.isEmpty || _isSpace(ch)) return 0;
  // Two code units: a surrogate pair, or a lone surrogate and its neighbour (tested as the string, as in JavaScript).
  return (ch.length == 1 ? isPunctuationOrSymbol(ch.codeUnitAt(0)) : _punctuation.hasMatch(ch)) ? 1 : 2;
}

String _firstChar(String s) {
  if (s.isEmpty) return '';
  final code = s.codeUnitAt(0);
  return code >= 0xd800 && code <= 0xdbff ? jsSlice(s, 0, 2) : s[0];
}

String _lastChar(String s) {
  if (s.isEmpty) return '';
  final code = s.codeUnitAt(s.length - 1);
  return code >= 0xdc00 && code <= 0xdfff ? (s.length >= 2 ? s.substring(s.length - 2) : s) : s[s.length - 1];
}

/// First and last character the latest [_spans] or [_wrap] call wrote ('' when
/// it wrote nothing). Tracked as the text is written, because reading a
/// character of a string still being concatenated would flatten it each time.
var _headChar = '';
var _tailChar = '';

/// Lays out marks over a run of atoms as properly nested delimiters: at each
/// point the mark that lasts longest opens first, so `**a *b***` rather than
/// crossed spans. [before] and [after] are the characters around the run.
String _spans(List<_Atom> atoms, int from, int to, int mask, String before, String after) {
  // The output is usually one piece: a buffer only once there is a second.
  String? only;
  StringBuffer? out;
  var head = '';
  var tail = '';
  // Plain text whose last character is the tail, read only when needed.
  String? tailOf;
  var k = from;
  while (k < to) {
    final atom = atoms[k];
    final open = atom.marks & ~mask;
    final link = (mask & _link) == 0 && atom.href != null;
    if (open == 0 && !link) {
      if (atom.md.isNotEmpty) {
        if (only == null) {
          only = atom.md;
        } else {
          (out ??= StringBuffer(only)).write(atom.md);
        }
        if (head.isEmpty) head = _firstChar(atom.md);
        tailOf = atom.md;
      }
      k++;
      continue;
    }
    var mark = 0;
    var end = k;
    if (link) {
      end = k + 1;
      while (end < to && atoms[end].href == atom.href) {
        end++;
      }
      mark = _link;
    }
    for (final bit in _markBits) {
      if ((open & bit) == 0) continue;
      var e = k + 1;
      while (e < to && (atoms[e].marks & bit) != 0) {
        e++;
      }
      if (e > end) {
        end = e;
        mark = bit;
      }
    }
    final next = end < to ? _leadingChar(atoms[end], mask) : after;
    if (tailOf != null) {
      tail = _lastChar(tailOf);
      tailOf = null;
    }
    final md = _wrap(atoms, k, end, mask, mark, atom.href, tail.isNotEmpty ? tail : before, next);
    if (md.isNotEmpty) {
      if (only == null) {
        only = md;
      } else {
        (out ??= StringBuffer(only)).write(md);
      }
      if (head.isEmpty) head = _headChar;
      tail = _tailChar;
    }
    k = end;
  }
  _headChar = head;
  _tailChar = tailOf != null ? _lastChar(tailOf) : tail;
  return out?.toString() ?? only ?? '';
}

/// First character an atom puts down at this level: a delimiter (punctuation) when it opens a mark.
String _leadingChar(_Atom atom, int mask) {
  if ((atom.marks & ~mask) != 0 || ((mask & _link) == 0 && atom.href != null)) return '*';
  return _firstChar(atom.md);
}

String _wrap(List<_Atom> atoms, int from, int to, int mask, int mark, String? href, String prev, String next) {
  final inner = mark == _link
      ? _spans(atoms, from, to, mask | _link, '[', ']')
      : _spans(atoms, from, to, mask | mark, '*', '*');
  if (inner.isEmpty) return inner;
  var lead = '';
  var trail = '';
  var core = inner;
  var coreHead = _headChar;
  var coreTail = _tailChar;
  if (_isSpace(coreHead) || _isSpace(coreTail)) {
    lead = inner.substring(0, _leadingSpace(inner));
    if (lead.length == inner.length) return inner; // headChar and tailChar already describe it
    trail = inner.substring(_trailingSpace(inner));
    core = inner.substring(lead.length, inner.length - trail.length);
    coreHead = _firstChar(core);
    coreTail = _lastChar(core);
  }
  if (mark == _link) {
    final auto = core == href && _autolink.matchAsPrefix(href!) != null;
    _headChar = lead.isNotEmpty ? _firstChar(lead) : (auto ? '<' : '[');
    _tailChar = trail.isNotEmpty ? _lastChar(trail) : (auto ? '>' : ')');
    return '$lead${auto ? '<$href>' : '[$core](${_destination(href!)})'}$trail';
  }
  final delimiter = mark == _bold ? '**' : (mark == _italic ? '*' : '~~');
  final p = _charClass(lead.isNotEmpty ? _lastChar(lead) : prev);
  final q = _charClass(trail.isNotEmpty ? _firstChar(trail) : next);
  // Left-flanking opener, right-flanking closer (CommonMark 6.2).
  final opens = _charClass(coreHead) != 1 || p != 2;
  final closes = _charClass(coreTail) != 1 || q != 2;
  if (opens && closes) {
    _headChar = lead.isNotEmpty ? _firstChar(lead) : delimiter[0];
    _tailChar = trail.isNotEmpty ? _lastChar(trail) : delimiter[0];
    return '$lead$delimiter$core$delimiter$trail';
  }
  // No parser would read these delimiters as emphasis here: keep the words without the mark.
  return _spans(atoms, from, to, mask | mark, prev, next);
}

/// Length of `/^\s+/.exec(s)?.[0] ?? ''`.
int _leadingSpace(String s) {
  var i = 0;
  while (i < s.length && isJsSpace(s.codeUnitAt(i))) {
    i++;
  }
  return i;
}

/// Start of `/\s+$/.exec(s)?.[0] ?? ''` (`s.length` when there is none).
int _trailingSpace(String s) {
  var i = s.length;
  while (i > 0 && isJsSpace(s.codeUnitAt(i - 1))) {
    i--;
  }
  return i;
}

/// `/[\\`*_[\]<&~$]/`.
bool _isSpecial(int c) => c < 0x80 && _special[c];

final _special = List<bool>.generate(0x80, (c) => r'\`*_[]<&~$'.codeUnits.contains(c), growable: false);

/// `/[\p{L}\p{N}]/u.test(text.charAt(i))`.
bool _isWord(String text, int i) => i >= 0 && i < text.length && isLetterOrNumber(text.codeUnitAt(i));

/// `/[A-Za-z/!?]/.test(text.charAt(i))`.
bool _isTagStart(String text, int i) {
  final c = charCodeAt(text, i);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c == 0x2f || c == 0x21 || c == 0x3f;
}

final _entity = RegExp(r'&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});');

/// Backslash-escapes what Markdown would read as syntax inside a line. `_`
/// between two letters stays bare (it cannot delimit emphasis there), `<` only
/// before a tag or autolink, `&` only before an entity. A trailing `!` is
/// escaped when something follows (it would turn a following link into an image).
/// Outside links, a bare URL is left as written: GFM links it as it stands, and
/// a backslash inside it would become part of the address.
String _escapeText(String text, bool followed, [bool linked = false]) {
  String out;
  // One pass finds what the escaping needs: whether the text holds an address
  // (`text.indexOf('://') > 0 || text.indexOf('www.') >= 0`) and where the first syntax character is.
  final n = text.length;
  var special = -1;
  var address = false;
  var schemeSeen = false;
  for (var i = 0; i < n; i++) {
    final c = text.codeUnitAt(i);
    if (c == 0x3a) {
      if (!schemeSeen && i + 2 < n && text.codeUnitAt(i + 1) == 0x2f && text.codeUnitAt(i + 2) == 0x2f) {
        schemeSeen = true;
        if (i > 0 && !linked) {
          address = true;
          break;
        }
      }
    } else if (c == 0x77) {
      if (!linked &&
          i + 3 < n &&
          text.codeUnitAt(i + 1) == 0x77 &&
          text.codeUnitAt(i + 2) == 0x77 &&
          text.codeUnitAt(i + 3) == 0x2e) {
        address = true;
        break;
      }
    } else if (special < 0 && _isSpecial(c)) {
      special = i;
      if (linked) break;
    }
  }
  if (address) {
    final buffer = StringBuffer();
    var last = 0;
    var lastIndex = 0;
    for (var m = _execFrom(_urlLiteral, text, 0); m != null; m = _execFrom(_urlLiteral, text, lastIndex)) {
      lastIndex = m.end;
      final scheme = m[0]!.codeUnitAt(0) == 104;
      if (m.start > 0 &&
          (scheme ? _isAsciiLetter(text.codeUnitAt(m.start - 1)) : _isUrlBeforeWww(text.codeUnitAt(m.start - 1))) ==
              scheme) {
        continue;
      }
      final url = _literalExtent(m[0]!);
      buffer.write(_escapeSyntax(text.substring(last, m.start)));
      last = m.start + url.length;
      // A backslash right after the address would extend it: close it with `<…>`, or leave that character bare.
      if (last < text.length && _escapeSyntax(text[last]).length > 1) {
        if (scheme) {
          buffer.write('<$url>');
        } else {
          buffer
            ..write(url)
            ..write(text[last++]);
        }
      } else {
        buffer.write(url);
      }
      lastIndex = last;
    }
    buffer.write(_escapeSyntax(text.substring(last)));
    out = buffer.toString();
  } else {
    out = special < 0 ? text : _escapeSyntax(text, special);
  }
  return followed && charCodeAt(out, out.length - 1) == 33 ? '${out.substring(0, out.length - 1)}\\!' : out;
}

/// `re.exec(text)` with `re.lastIndex = start` for a global [re].
RegExpMatch? _execFrom(RegExp re, String text, int start) {
  if (start > text.length) return null;
  final matches = re.allMatches(text, start).iterator;
  return matches.moveNext() ? matches.current : null;
}

/// [from], when known, is the index of the first syntax character.
String _escapeSyntax(String text, [int from = -1]) {
  var i = from;
  if (i < 0) {
    i = 0;
    while (i < text.length && !_isSpecial(text.codeUnitAt(i))) {
      i++;
    }
  }
  if (i == text.length) return text;
  final out = StringBuffer(text.substring(0, i));
  var start = i;
  for (; i < text.length; i++) {
    final c = text.codeUnitAt(i);
    if (!_isSpecial(c)) continue;
    String? replacement;
    switch (c) {
      case 0x5f: // _
        if (!(_isWord(text, i - 1) && _isWord(text, i + 1))) replacement = r'\_';
      case 0x3c: // <
        if (_isTagStart(text, i + 1)) replacement = r'\<';
      case 0x26: // &
        if (_entity.matchAsPrefix(text, i) != null) replacement = r'\&';
      default:
        replacement = '\\${text[i]}';
    }
    if (replacement == null) continue;
    out
      ..write(text.substring(start, i))
      ..write(replacement);
    start = i + 1;
  }
  out.write(text.substring(start));
  return out.toString();
}

/// A GFM autolink literal (`http://`, `https://`, `www.`), and what may stand before one.
final _urlLiteral = RegExp(r'(?:https?:\/\/|www\.)[^\s<]+');

/// `/[A-Za-z]/`.
bool _isAsciiLetter(int c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/// `/[\s(*_~]/`.
bool _isUrlBeforeWww(int c) => isJsSpace(c) || c == 0x28 || c == 0x2a || c == 0x5f || c == 0x7e;

/// `/[?!.,:;*_~'"\]]$/`.
bool _isUrlTrailing(int c) =>
    c == 0x3f ||
    c == 0x21 ||
    c == 0x2e ||
    c == 0x2c ||
    c == 0x3a ||
    c == 0x3b ||
    c == 0x2a ||
    c == 0x5f ||
    c == 0x7e ||
    c == 0x27 ||
    c == 0x22 ||
    c == 0x5d;

/// The part of a URL-like run GFM links: trailing punctuation and an unmatched `)` stay outside.
String _literalExtent(String url) {
  var end = url.length;
  for (;;) {
    final tail = url.substring(0, end);
    if (tail.isNotEmpty && _isUrlTrailing(tail.codeUnitAt(tail.length - 1))) {
      end--;
    } else if (tail.endsWith(')') && _count(tail, '(') < _count(tail, ')')) {
      end--;
    } else {
      return tail;
    }
  }
}

int _count(String text, String ch) {
  var n = 0;
  for (var i = text.indexOf(ch); i >= 0; i = text.indexOf(ch, i + 1)) {
    n++;
  }
  return n;
}

/// Longest run of the code unit [c] (`/`+/g`, `/~+/g`).
int _longestRun(String text, int c) {
  var longest = 0;
  var run = 0;
  for (var i = 0; i < text.length; i++) {
    if (text.codeUnitAt(i) == c) {
      if (++run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

String _codeSpan(String text) {
  final fence = '`' * (!text.contains('`') ? 1 : _longestRun(text, 0x60) + 1);
  // One space each side is stripped by the parser, so pad when the code starts or ends with a backtick or a space.
  final first = charCodeAt(text, 0);
  final last = charCodeAt(text, text.length - 1);
  final pad = first == 96 || last == 96 || (first == 32 && last == 32 && !isBlank(text)) ? ' ' : '';
  return '$fence$pad$text$pad$fence';
}

final _spaceRun = RegExp(r' {2,}');

String _mathSpan(String tex, bool cell) {
  var flat = jsTrim(collapseJsSpace(tex));
  // A table cell ends at `|`, and `\|` stays as written inside math: spell the bars as commands.
  if (cell && flat.contains('|')) {
    flat = jsTrim(flat.replaceAll(r'\|', r'\Vert ').replaceAll('|', r'\vert ').replaceAll(_spaceRun, ' '));
  }
  return !flat.contains(r'$') ? '\$$flat\$' : '\$\$$flat\$\$';
}

final _destinationEntity = RegExp(r'&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)');
final _angle = RegExp(r'[<>]');

/// `s.replace(_destinationEntity, '\\&')`: a backslash before every `&` that
/// starts a character reference (`&#38;`, `&#x26;`, `&amp;`).
String _escapeEntities(String s) {
  StringBuffer? out;
  var from = 0;
  for (var i = s.indexOf('&'); i >= 0; i = s.indexOf('&', i + 1)) {
    if (!_startsReference(s, i + 1)) continue;
    (out ??= StringBuffer())
      ..write(s.substring(from, i))
      ..write(r'\');
    from = i;
  }
  final result = out == null ? s : (out..write(s.substring(from))).toString();
  assert(result == s.replaceAll(_destinationEntity, r'\&'), 'entities in $s');
  return result;
}

/// `(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});` at [i].
bool _startsReference(String s, int i) {
  bool digit(int c) => c >= 0x30 && c <= 0x39;
  bool hex(int c) => digit(c) || (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66;
  bool letter(int c) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
  int run(int from, bool Function(int) test, int max) {
    var j = from;
    while (j < s.length && j - from < max && test(s.codeUnitAt(j))) {
      j++;
    }
    return j;
  }

  bool semicolonAt(int j) => j < s.length && s.codeUnitAt(j) == 0x3b;
  if (i >= s.length) return false;
  final c = s.codeUnitAt(i);
  if (c == 0x23) {
    final decimal = run(i + 1, digit, 7);
    if (decimal > i + 1 && semicolonAt(decimal)) return true;
    if (i + 1 < s.length && (s.codeUnitAt(i + 1) | 0x20) == 0x78) {
      final end = run(i + 2, hex, 6);
      return end > i + 2 && semicolonAt(end);
    }
    return false;
  }
  if (!letter(c)) return false;
  final end = run(i + 1, (c) => letter(c) || digit(c), 31);
  return end > i + 1 && semicolonAt(end);
}

/// A link or image destination: bare, or in `<…>` when it holds spaces, angle brackets or unbalanced parentheses.
String _destination(String url) {
  // One pass over the address decides everything; most need nothing.
  var depth = 0;
  var bracket = false;
  var escape = false;
  for (var i = 0; i < url.length; i++) {
    final c = url.codeUnitAt(i);
    if (c > 62) {
      if (c == 92) escape = true;
    } else if (c <= 32 || c == 60 || c == 62) {
      bracket = true;
    } else if (c == 40) {
      depth++;
    } else if (c == 41) {
      if (--depth < 0) bracket = true;
    } else if (c == 38) {
      escape = true;
    }
  }
  var out = url;
  if (escape) {
    out = out.replaceAll(r'\', r'\\');
    out = _escapeEntities(out);
  }
  if (!bracket && depth == 0) return out;
  return '<${out.replaceAllMapped(_angle, (m) => '\\${m[0]}')}>';
}

/// `imageMarkdown(image)`: an [ArticleImage] or an [InlineImage] (which has no link).
String _imageMarkdown(String src, String alt, [String? href]) {
  final md = '![${_escapeText(jsTrim(collapseJsSpace(alt)), false)}](${_destination(src)})';
  return href == null ? md : '[$md](${_destination(href)})';
}

String _figureImageMarkdown(ArticleImage image) => _imageMarkdown(image.src, image.alt, image.href);

/// `<url>` when the URL is a valid autolink, else a link labeled with the URL.
final _autolink = RegExp(r'^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$');

String _bareLink(String url) =>
    _autolink.matchAsPrefix(url) != null ? '<$url>' : '[${_escapeText(url, false)}](${_destination(url)})';

// ------------------------------------------------------------------ line starts

final _lineStart = RegExp(r'^(?:#{1,6}(?=\s|$)|>|[-+](?=\s|$)|(?:-[ \t]*)+$|=+[ \t]*$)');
final _orderedStart = RegExp(r'^(\d{1,9})([.)])(?=\s|$)');

/// Escapes a line that would otherwise start a heading, quote, list or setext underline.
String _escapeLineStart(String line) {
  final c = charCodeAt(line, 0);
  // # + - = > and digits
  if (c == 35 || c == 43 || c == 45 || c == 61 || c == 62) {
    return _lineStart.matchAsPrefix(line) != null ? '\\$line' : line;
  }
  if (c >= 48 && c <= 57) {
    final m = _orderedStart.matchAsPrefix(line);
    return m == null ? line : '${m[1]}\\${m[2]}${line.substring(m.end)}';
  }
  return line;
}

String _escapeLines(String text) {
  if (!text.contains('\n')) return _escapeLineStart(text);
  return jsSplit(text, '\n').map(_escapeLineStart).join('\n');
}

// ------------------------------------------------------------------ blocks

final _closingSequence = RegExp(r'(^|\s)(#+)$');

String _heading(int level, String text) {
  // A trailing `#` run after a space would be read as a closing sequence.
  final closing = _closingSequence.firstMatch(text);
  final body = closing == null ? text : '${text.substring(0, closing.start + closing[1]!.length)}\\${closing[2]}';
  return '${'#' * level} $body';
}

final _setextUnderline = RegExp(r'^(?:-+|=+)[ \t]*(?:\n|$)');

/// [line], then [content] on the next line, or after a blank line where it would underline [line] into a heading.
String _afterLine(String line, String content) {
  if (content.isEmpty) return line;
  return line + (_setextUnderline.matchAsPrefix(content) != null ? '\n\n' : '\n') + content;
}

/// Prefixes the first line and every following non-empty line.
String _indent(String text, String first, String rest) {
  final lines = jsSplit(text, '\n');
  final out = StringBuffer(first)..write(lines[0]);
  for (var i = 1; i < lines.length; i++) {
    if (lines[i].isEmpty) {
      out.write('\n');
    } else {
      out
        ..write('\n')
        ..write(rest)
        ..write(lines[i]);
    }
  }
  return out.toString();
}

String _quote(String text) => jsSplit(text, '\n').map((line) => line.isEmpty ? '>' : '> $line').join('\n');

const _alert = {
  CalloutVariant.note: 'NOTE',
  CalloutVariant.tip: 'TIP',
  CalloutVariant.info: 'NOTE',
  CalloutVariant.warning: 'WARNING',
  CalloutVariant.danger: 'CAUTION',
};

final _footnoteLabel = RegExp(r'[^A-Za-z0-9_-]+');

class _Writer {
  _Writer(List<Block> blocks) {
    final used = <String>{};
    void visit(List<Block> list) {
      for (final block in list) {
        if (block is FootnotesBlock) {
          for (final item in block.items) {
            if (_notes.containsKey(item.id)) continue;
            var label = _clean(item.label);
            if (label.isEmpty || used.contains(label)) label = _clean(item.id);
            if (label.isEmpty) label = 'note';
            if (used.contains(label)) {
              var n = 2;
              while (used.contains('$label-$n')) {
                n++;
              }
              label = '$label-$n';
            }
            used.add(label);
            _notes[item.id] = label;
          }
        } else if (block is ListBlock) {
          for (final item in block.items) {
            visit(item.blocks);
          }
        } else if (block is QuoteBlock) {
          visit(block.blocks);
        } else if (block is DetailsBlock) {
          visit(block.blocks);
        } else if (block is CalloutBlock) {
          visit(block.blocks);
        } else if (block is DefinitionListBlock) {
          for (final item in block.items) {
            visit(item.details);
          }
        }
      }
    }

    visit(blocks);
  }

  /// Footnote id → label written in `[^label]`.
  final _notes = <String, String>{};

  /// Footnote ids with a `[^label]` call written so far.
  final _called = <String>{};

  /// Footnote ids written as plain text (no call yet) by the latest pass over the footnotes.
  final _uncalled = <String>[];

  /// Inline content. [line] writes breaks as spaces (headings, table cells, terms); [mask] marks already applied around it.
  String inline(List<Inline> content, [bool line = false, int mask = 0, bool cell = false]) {
    if (content.length == 1) {
      final only = content[0];
      if (only is TextRun && only.marks == null && only.href == null) return _escapeText(only.text, false);
    }
    final atoms = <_Atom>[];
    for (var i = 0; i < content.length; i++) {
      final node = content[i];
      switch (node) {
        case TextRun():
          var marks = 0;
          var code = false;
          for (final m in node.marks ?? const <Mark>[]) {
            if (m == Mark.bold) {
              marks |= _bold;
            } else if (m == Mark.italic) {
              marks |= _italic;
            } else if (m == Mark.strike) {
              marks |= _strike;
            } else if (m == Mark.code || m == Mark.kbd) {
              code = true;
            }
          }
          final last = atoms.isEmpty ? null : atoms.last;
          if (code && last != null && last.code != null && last.marks == marks && last.href == node.href) {
            // Neighbouring code spans would run their backticks together: one span holds both.
            last.code = last.code! + node.text;
            last.md = _codeSpan(last.code!);
            break;
          }
          final md = code ? _codeSpan(node.text) : _escapeText(node.text, i < content.length - 1, node.href != null);
          atoms.add(_Atom(md, marks, node.href, code ? node.text : null));
        case LineBreak():
          atoms.add(_Atom(line ? ' ' : '\\\n', 0, null));
        case InlineImage():
          atoms.add(_Atom(_imageMarkdown(node.src, node.alt), 0, null));
        case InlineMath():
          final tex = node.tex;
          atoms.add(
            _Atom(tex != null && !isBlank(tex) ? _mathSpan(tex, cell) : _escapeText(node.text, false), 0, null),
          );
        case FootnoteRef():
          final label = _notes[node.id];
          if (label != null) _called.add(node.id);
          atoms.add(_Atom(label != null ? '[^$label]' : _escapeText(node.label, false), 0, null));
      }
    }
    final edge = mask != 0 ? '*' : '';
    return _spans(atoms, 0, atoms.length, mask, edge, edge);
  }

  String paragraph(List<Inline> content) {
    final md = inline(content);
    // A line of only no-break or ideographic spaces is not blank to a parser: it would be an empty-looking paragraph.
    if (md.isEmpty || (isJsSpace(md.codeUnitAt(0)) && isBlank(md))) return '';
    return _escapeLines(md);
  }

  /// Bold line (definition terms, summaries, callout titles).
  String strong(List<Inline> content) {
    final text = jsTrim(inline(content, true, _bold));
    return text.isEmpty ? '' : _escapeLineStart('**$text**');
  }

  /// Blocks joined by [separator]. At the top level footnotes are written last: a note
  /// nothing calls is invisible as a GFM definition, so it becomes plain text instead.
  String blocks(List<Block> blocks, String separator, [bool top = false]) {
    final parts = <String>[];
    final deferred = <int>[];
    ListBlock? previous;
    var alternate = false;
    for (var i = 0; i < blocks.length; i++) {
      final block = blocks[i];
      String md;
      if (block is ListBlock) {
        // Two lists in a row would merge: the second switches its marker (`-` / `*`, `.` / `)`).
        alternate = previous != null && previous.ordered == block.ordered ? !alternate : false;
        md = list(block, alternate);
      } else if (top && block is FootnotesBlock) {
        deferred.add(i);
        md = '';
      } else {
        md = this.block(block);
      }
      parts.add(md);
      if (md.isNotEmpty || (deferred.isNotEmpty && deferred.last == i)) previous = block is ListBlock ? block : null;
    }
    if (deferred.isNotEmpty) {
      _uncalled.clear();
      for (final i in deferred) {
        parts[i] = footnotes(blocks[i] as FootnotesBlock);
      }
      // A note written as text before a later note called it: write them again now that every call is known.
      if (_uncalled.any(_called.contains)) {
        for (final i in deferred) {
          parts[i] = footnotes(blocks[i] as FootnotesBlock);
        }
      }
    }
    return parts.where((md) => md.isNotEmpty).join(separator);
  }

  String block(Block block) {
    switch (block) {
      case HeadingBlock():
        final text = inline(block.content, true);
        return text.isEmpty ? '' : _heading(block.level, text);
      case ParagraphBlock():
        return paragraph(block.content);
      case ListBlock():
        return list(block, false);
      case QuoteBlock():
        var inner = blocks(block.blocks, '\n\n');
        if (block.cite != null) {
          final cite = inline(block.cite!);
          if (cite.isNotEmpty) inner = '${inner.isNotEmpty ? '$inner\n\n' : ''}— $cite';
        }
        return inner.isEmpty ? '' : _quote(inner);
      case CodeBlock():
        return _codeBlock(block);
      case FigureBlock():
        final parts = block.images.map(_figureImageMarkdown).toList();
        if (block.caption != null) parts.add(paragraph(block.caption!));
        if (block.credit != null) parts.add(paragraph(block.credit!));
        return parts.where((part) => part.isNotEmpty).join('\n\n');
      case VideoBlock():
        final title = block.title != null ? _escapeText(block.title!, false) : '';
        String md;
        if (block.poster != null) {
          md = '[![$title](${_destination(block.poster!)})](${_destination(block.url)})';
        } else {
          md = title.isNotEmpty ? '[$title](${_destination(block.url)})' : _bareLink(block.url);
        }
        final caption = block.caption != null ? paragraph(block.caption!) : '';
        return caption.isNotEmpty ? '$md\n\n$caption' : md;
      case AudioBlock():
        final title = block.title != null ? _escapeText(block.title!, false) : '';
        final md = title.isNotEmpty ? '[$title](${_destination(block.url)})' : _bareLink(block.url);
        final caption = block.caption != null ? paragraph(block.caption!) : '';
        return caption.isNotEmpty ? '$md\n\n$caption' : md;
      case EmbedBlock():
        final source = (block.author != null ? '${_escapeText(block.author!, false)}, ' : '') + _bareLink(block.url);
        final inner = blocks(block.blocks ?? const [], '\n\n');
        return inner.isEmpty ? _escapeLineStart(source) : _quote('$inner\n\n— $source');
      case TableBlock():
        return table(block);
      case RuleBlock():
        return '---';
      case MathBlock():
        final raw = block.tex;
        final tex = raw == null ? null : jsTrimEnd(raw.replaceAll(_mathEdgeLines, ''));
        if (tex != null && !isBlank(tex)) return '\$\$\n$tex\n\$\$';
        return _escapeLines(_escapeText(block.text, false));
      case DefinitionListBlock():
        return block.items
            .map((item) {
              final term = strong(item.term);
              final details = blocks(item.details, '\n\n');
              return term.isNotEmpty && details.isNotEmpty ? '$term\n\n$details' : term + details;
            })
            .where((part) => part.isNotEmpty)
            .join('\n\n');
      case DetailsBlock():
        final summary = strong(block.summary);
        final inner = blocks(block.blocks, '\n\n');
        return summary.isNotEmpty && inner.isNotEmpty ? '$summary\n\n$inner' : summary + inner;
      case CalloutBlock():
        final title = block.title != null ? strong(block.title!) : '';
        var inner = blocks(block.blocks, '\n\n');
        if (title.isNotEmpty) inner = inner.isNotEmpty ? '$title\n\n$inner' : title;
        if (block.variant != null) return _quote(_afterLine('[!${_alert[block.variant]}]', inner));
        return inner.isEmpty ? '' : _quote(inner);
      case FootnotesBlock():
        return footnotes(block);
    }
  }

  String list(ListBlock list, bool alternate) {
    // Tight unless an item holds blocks that need a blank line between them.
    final tight = list.items.every((item) {
      final blocks = item.blocks;
      if (blocks.length <= 1) return true;
      if (blocks.length != 2 || blocks[0] is! ParagraphBlock || blocks[1] is! ListBlock) return false;
      // Only a bullet list or one starting at 1 may interrupt a paragraph.
      final nested = blocks[1] as ListBlock;
      return (!nested.ordered || (nested.start ?? 1) == 1) &&
          nested.items.isNotEmpty &&
          nested.items[0].blocks.isNotEmpty;
    });
    final listStart = list.start;
    final start = listStart != null && listStart >= 0 && listStart <= 999999999 - list.items.length ? listStart : 1;
    final out = <String>[];
    for (var i = 0; i < list.items.length; i++) {
      final item = list.items[i];
      final marker = list.ordered ? '${start + i}${alternate ? ')' : '.'}' : (alternate ? '*' : '-');
      var content = blocks(item.blocks, tight ? '\n' : '\n\n');
      if (item.checked != null) {
        final box = item.checked! ? '[x]' : '[ ]';
        content = item.blocks.isNotEmpty && item.blocks[0] is ParagraphBlock && content.isNotEmpty
            ? '$box $content'
            : _afterLine(box, content);
      }
      out.add(content.isEmpty ? marker : _indent(content, '$marker ', ' ' * (marker.length + 1)));
    }
    return out.join(tight ? '\n' : '\n\n');
  }

  String table(TableBlock table) {
    // Lay the cells on a grid: spanned positions stay empty, as GFM tables have no spans.
    // Rows are sparse JavaScript arrays: null is a hole, and the length counts holes.
    final grid = <List<String?>>[];
    final align = <int, CellAlign>{};
    var width = 0;
    void put(List<String?> row, int index, String value) {
      while (row.length <= index) {
        row.add(null);
      }
      row[index] = value;
    }

    List<String?> rowAt(int r) {
      while (grid.length <= r) {
        grid.add(<String?>[]);
      }
      return grid[r];
    }

    for (var r = 0; r < table.rows.length; r++) {
      final row = rowAt(r);
      var c = 0;
      for (final cell in table.rows[r].cells) {
        while (c < row.length && row[c] != null) {
          c++;
        }
        final md = inline(cell.content, true, 0, true);
        final text = !md.contains('|') ? md : md.replaceAll('|', r'\|');
        final colspan = math.min(math.max(cell.colspan ?? 1, 1), 1000);
        final rowspan = math.min(math.max(cell.rowspan ?? 1, 1), table.rows.length - r);
        if (r == 0 && cell.align != null) align[c] = cell.align!;
        for (var dr = 0; dr < rowspan; dr++) {
          final target = rowAt(r + dr);
          for (var dc = 0; dc < colspan; dc++) {
            put(target, c + dc, dr == 0 && dc == 0 ? text : '');
          }
        }
        c += colspan;
      }
      if (row.length > width) width = row.length;
    }
    if (width == 0) return '';
    String line(List<String?> cells) {
      final out = StringBuffer('|');
      for (var c = 0; c < width; c++) {
        final cell = (c < cells.length ? cells[c] : null) ?? '';
        if (cell.isEmpty) {
          out.write('  |');
        } else {
          out
            ..write(' ')
            ..write(cell)
            ..write(' |');
        }
      }
      return out.toString();
    }

    final header = (table.headerRows ?? 0) > 0 ? grid[0] : const <String?>[];
    final delimiter = StringBuffer('|');
    for (var c = 0; c < width; c++) {
      final a = align[c];
      delimiter.write(
        a == CellAlign.center
            ? ' :-: |'
            : a == CellAlign.right
            ? ' --: |'
            : a == CellAlign.left
            ? ' :-- |'
            : ' --- |',
      );
    }
    final rows = [line(header), delimiter.toString()];
    for (var r = header.isNotEmpty ? 1 : 0; r < grid.length; r++) {
      rows.add(line(grid[r]));
    }
    final md = rows.join('\n');
    final caption = table.caption != null ? paragraph(table.caption!) : '';
    return caption.isNotEmpty ? '$caption\n\n$md' : md;
  }

  String footnotes(FootnotesBlock block) {
    final out = <String>[];
    for (final item in block.items) {
      final content = blocks(item.blocks, '\n\n');
      if (_called.contains(item.id)) {
        final label = _notes[item.id]!;
        out.add(content.isEmpty ? '[^$label]:' : _indent(content, '[^$label]: ', '    '));
      } else {
        _uncalled.add(item.id);
        final label = _escapeText('[${item.label}]', false);
        out.add(
          content.isEmpty
              ? label
              : item.blocks.isNotEmpty && item.blocks[0] is ParagraphBlock
              ? '$label $content'
              : '$label\n\n$content',
        );
      }
    }
    return out.join('\n\n');
  }
}

final _edgeDashes = RegExp(r'^-+|-+$');

String _clean(String label) => label.replaceAll(_footnoteLabel, '-').replaceAll(_edgeDashes, '');

/// `/^\s*\n|\n\s*$/g`: blank lines before and after a display formula.
final _mathEdgeLines = RegExp(r'^\s*\n|\n\s*$');

final _quoteOrBackslash = RegExp(r'[\\"]');

String _codeBlock(CodeBlock block) {
  var info = block.language ?? '';
  if (block.title != null) {
    final title = jsTrim(collapseJsSpace(block.title!));
    if (title.isNotEmpty) {
      info =
          '${info.isNotEmpty ? info : 'text'} title="${title.replaceAllMapped(_quoteOrBackslash, (m) => '\\${m[0]}')}"';
    }
  }
  // Backtick fences cannot carry a backtick in their info string; tildes can.
  final tilde = info.contains('`');
  final fence = tilde
      ? '~' * math.max(3, _longestRun(block.code, 0x7e) + 1)
      : '`' * math.max(3, _longestRun(block.code, 0x60) + 1);
  final code = block.code.isEmpty || block.code.endsWith('\n') ? block.code : '${block.code}\n';
  return '$fence$info\n$code$fence';
}
