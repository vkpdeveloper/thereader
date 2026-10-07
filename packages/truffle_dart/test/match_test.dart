import 'package:test/test.dart';
import 'package:truffle/src/match.dart';

/// [ClassPattern] reduces class/id regexes to literal-word search; it must
/// agree with the `RegExp` on every subject.
void main() {
  const patterns = [
    r'(?:^|[\s_-])(?:footnotes|footnote-list|endnotes|references|refs)(?:$|[\s_-])',
    r'(?:^|[\s_-])(?:line-?numbers?(?:-rows)?|linenos?|lineno|gutter)(?:$|[\s_-])',
    r'(?:^|[\s_-])(?:code-?block-?title|code-?title|filename)(?:$|[\s_-])|codeBlockTitle',
    r'(?:^|[\s_-])(?:avatar|author-(?:photo|image|avatar|img)|profile-(?:pic|photo|image))(?:$|[\s_-])',
    r'(?:^|\s)(?:entry-content|post-content|prose)(?:\s|$)',
    r'(?:^|\s)footnote(?:\s|$)',
    r'(?:\b|_)(?:share|sharedaddy|social|sharing)(?:\b|_)',
    r'-ad-|hidden|^hid$| hid$| hid |^hid |banner|comment|com-',
    r'byline|author|dateline|writtenby|p-author',
  ];
  const subjects = [
    '',
    ' ',
    'refs',
    'xrefs',
    'refs-x',
    'x_refs',
    'x refs',
    'refs x',
    'refs ',
    'a-refsb',
    'references',
    'line-numbers-rows',
    'linenumbers',
    'line-number',
    'linenos',
    'lineno x',
    'xlineno',
    'gutter_',
    'code-block-title',
    'codeblocktitle',
    'code-blocktitle x',
    'codeBlockTitle',
    'xcodeBlockTitley',
    'filename-',
    'author-photo',
    'author-pic',
    'profile-pic',
    'profile-picture',
    'avatar avatar',
    'my-avatar',
    'entry-content',
    'x entry-content',
    'entry-content-x',
    'post-content\t',
    'prose',
    'prosey',
    'footnote',
    'footnotes',
    'a footnote b',
    'footnote\n',
    'share',
    'share-bar',
    'shareable',
    'x_share',
    'xshare',
    'social_links',
    'sharedaddy',
    'sharedaddyx',
    'é-share',
    'hid',
    'a hid',
    'a hid b',
    'hid b',
    'hidx',
    'xhid',
    'hidden',
    'com-x',
    'banner',
    '-ad-',
    'ad',
    'byline',
    'p-author',
    'authorize',
    'nothing here',
  ];
  for (final source in patterns) {
    test(source, () {
      final pattern = ClassPattern(source);
      expect(pattern.isLiteral, isTrue);
      for (final subject in subjects) {
        expect(pattern.hasMatch(subject), RegExp(source).hasMatch(subject), reason: subject);
      }
    });
  }

  test('falls back to the RegExp for other patterns', () {
    final pattern = ClassPattern(r'caption|credit', caseSensitive: false);
    expect(pattern.isLiteral, isFalse);
    expect(pattern.hasMatch('Photo-Credit'), isTrue);
    expect(ClassPattern(r'^h[1-6]$').isLiteral, isFalse);
  });

  group('requiredLiterals', () {
    const cases = {
      r'\b(None|True|False)\b': ['None', 'True', 'False'],
      r'\b(const|let|var)(?:\s+[\w${}\[\],]+|\s[^\S ]* )\s*=': ['const', 'let', 'var'],
      r'^[^\S\n\r\u2028\u2029]*(export\s+)?interface\s+\w+(<.+>)?\s*\{': ['interface'],
      r'#include\s*<\w+\.h>': ['#include'],
      r'(a|b)?c': ['c'],
      r'\$\{?\w+\}?': [r'$'],
      r'===|!==': ['===', '!=='],
      r'x{2,3}y': ['x'],
      r'\bimport type\b': ['import type'],
      r'^[+-](?![+-])': null,
      r'\w+|=': null,
      r'(\w)\1': null,
    };
    cases.forEach((source, expected) {
      test(source, () => expect(requiredLiterals(RegExp(source)), expected));
    });

    test('ignoring case, lowercase', () {
      expect(requiredLiterals(RegExp(r'\bSELECT\b[\s\S]+?\bFROM\b', caseSensitive: false)), ['select']);
      final screen = LiteralScreen('Select * From t');
      expect(screen.containsAny(['select'], ignoreCase: true), isTrue);
      expect(screen.containsAny(['select']), isFalse);
      expect(screen.containsAny(['insert'], ignoreCase: true), isFalse);
    });

    test('a subject without the literals does not match', () {
      const subjects = ['', 'x', 'def f(self):', 'const a = 1', 'SELECT 1', r'${HOME}', 'a === b', 'xxy', '+a'];
      for (final source in cases.keys) {
        final pattern = RegExp(source);
        final literals = requiredLiterals(pattern);
        if (literals == null) continue;
        for (final subject in subjects) {
          if (!LiteralScreen(subject).containsAny(literals)) {
            expect(pattern.hasMatch(subject), isFalse, reason: '$source on $subject');
          }
        }
      }
    });
  });
}
