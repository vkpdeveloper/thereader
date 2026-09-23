import 'package:flutter_readium/flutter_readium.dart' as rd;
import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/models/library.dart';
import 'package:thereader/reader/readium_engine/readium_reader_engine.dart';

void main() {
  const publication = rd.Publication(
    metadata: rd.Metadata(localizedTitle: rd.LocalizedString()),
    readingOrder: [
      rd.Link(href: 'OEBPS/01_intro.xhtml', type: 'application/xhtml+xml'),
      rd.Link(href: 'OEBPS/11_maths.xhtml', type: 'application/xhtml+xml'),
    ],
    resources: [rd.Link(href: 'OEBPS/images/eq1.png', type: 'image/png')],
  );

  rd.Locator? resolve(ReadingLocator l) =>
      ReadiumReaderController.resolveLocator(publication, l);

  ReadingLocator readium(String href, {double progression = 0.4}) => ReadingLocator(
    href: href,
    progression: progression,
    engine: ReadiumReaderEngine.engineId,
    raw: {
      'href': href,
      'type': 'application/xhtml+xml',
      'locations': {'progression': progression},
    },
  );

  test('a saved Readium locator in the reading order is kept', () {
    final l = resolve(readium('OEBPS/11_maths.xhtml'));
    expect(l?.href, 'OEBPS/11_maths.xhtml');
    expect(l?.locations?.progression, 0.4);
  });

  test('a locator outside the reading order opens at the start', () {
    expect(resolve(readium('OEBPS/removed_chapter.xhtml')), isNull);
    expect(resolve(readium('OEBPS/images/eq1.png')), isNull);
    expect(resolve(readium('')), isNull);
    expect(resolve(const ReadingLocator(href: 'gone.xhtml', progression: 0.5)), isNull);
  });

  test('a built-in engine locator resolves by path and clamps progression', () {
    final l = resolve(const ReadingLocator(href: '/OEBPS/01_intro.xhtml#s2', progression: 3));
    expect(l?.href, 'OEBPS/01_intro.xhtml');
    expect(l?.locations?.progression, 1.0);

    final nan = resolve(const ReadingLocator(href: '01_intro.xhtml', progression: double.nan));
    expect(nan?.href, 'OEBPS/01_intro.xhtml');
    expect(nan?.locations?.progression, 0.0);
  });

  test('a partial file name does not match a longer one', () {
    expect(resolve(const ReadingLocator(href: '1_maths.xhtml', progression: 0)), isNull);
  });
}
