import 'package:flutter_test/flutter_test.dart';
import 'package:thereader/data/comic/comic_pages.dart';
import 'package:thereader/data/models/book.dart';

void main() {
  test('natural order matches the shared vector in docs/comics.md', () {
    const names = ['p1.jpg', 'p01.jpg', 'p001.jpg', 'p2.jpg', 'P3.jpg', 'p10.jpg', 'a/p9.jpg', 'a/p10.jpg', 'b/p1.jpg', 'cover.jpg', 'x 2.jpg', 'x 10.jpg'];
    expect(orderPages(names.reversed), [
      'a/p9.jpg', 'a/p10.jpg', 'b/p1.jpg', 'cover.jpg', 'p1.jpg', 'p01.jpg', 'p001.jpg', 'p2.jpg', 'P3.jpg', 'p10.jpg', 'x 2.jpg', 'x 10.jpg',
    ]);
  });

  test('selection skips hidden files, macOS forks and non-images', () {
    const names = [
      'Comic/ComicInfo.xml', 'Comic/page10.jpg', 'Comic/page2.JPG', 'Comic/page02b.png', 'Comic/Cover.webp',
      'Comic/__MACOSX/._page2.jpg', 'Comic/.hidden.jpg', 'Comic/notes.txt', 'Comic/extras/001.jpg', 'Comic/',
    ];
    expect(orderPages(names), [
      'Comic/Cover.webp', 'Comic/extras/001.jpg', 'Comic/page2.JPG', 'Comic/page02b.png', 'Comic/page10.jpg',
    ]);
    expect(isPageName(r'a\b.AVIF'), isTrue);
    expect(isPageName('.thumbs/b.jpg'), isFalse);
  });

  test('the shallowest ComicInfo.xml wins', () {
    expect(pickComicInfo(['b/ComicInfo.xml', 'x/y/comicinfo.XML', 'a/COMICINFO.xml']), 'a/COMICINFO.xml');
    expect(pickComicInfo(['page.jpg']), isNull);
  });

  test('books default to EPUB and round-trip the comic format', () {
    final json = {
      'id': 'comic-${'a' * 64}',
      'downloadUrl': '/v1/books/x/download',
      'fileSize': 10,
      'sha256': 'a' * 64,
    };
    expect(Book.fromJson(json).format, BookFormat.epub);
    final comic = Book.fromJson({...json, 'format': 'comic'});
    expect(comic.isComic, isTrue);
    expect(Book.fromJson(comic.toJson()).format, BookFormat.comic);
  });
}
