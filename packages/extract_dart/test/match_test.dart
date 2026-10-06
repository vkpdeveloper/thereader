import 'package:test/test.dart';
import 'package:thereader_extract/src/match.dart';

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
    '', ' ', 'refs', 'xrefs', 'refs-x', 'x_refs', 'x refs', 'refs x', 'refs ', 'a-refsb', 'references',
    'line-numbers-rows', 'linenumbers', 'line-number', 'linenos', 'lineno x', 'xlineno', 'gutter_',
    'code-block-title', 'codeblocktitle', 'code-blocktitle x', 'codeBlockTitle', 'xcodeBlockTitley', 'filename-',
    'author-photo', 'author-pic', 'profile-pic', 'profile-picture', 'avatar avatar', 'my-avatar',
    'entry-content', 'x entry-content', 'entry-content-x', 'post-content\t', 'prose', 'prosey',
    'footnote', 'footnotes', 'a footnote b', 'footnote\n',
    'share', 'share-bar', 'shareable', 'x_share', 'xshare', 'social_links', 'sharedaddy', 'sharedaddyx', 'é-share',
    'hid', 'a hid', 'a hid b', 'hid b', 'hidx', 'xhid', 'hidden', 'com-x', 'banner', '-ad-', 'ad',
    'byline', 'p-author', 'authorize', 'nothing here',
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
}
