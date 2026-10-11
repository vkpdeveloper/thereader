import { describe, expect, test } from 'bun:test';
import { isPageName, orderPages, pickComicInfo } from './pages';

describe('comic pages', () => {
  test('natural order matches the shared vector in docs/comics.md', () => {
    const names = ['p1.jpg', 'p01.jpg', 'p001.jpg', 'p2.jpg', 'P3.jpg', 'p10.jpg', 'a/p9.jpg', 'a/p10.jpg', 'b/p1.jpg', 'cover.jpg', 'x 2.jpg', 'x 10.jpg'];
    expect(orderPages([...names].reverse())).toEqual([
      'a/p9.jpg', 'a/p10.jpg', 'b/p1.jpg', 'cover.jpg', 'p1.jpg', 'p01.jpg', 'p001.jpg', 'p2.jpg', 'P3.jpg', 'p10.jpg', 'x 2.jpg', 'x 10.jpg',
    ]);
  });

  test('selection skips hidden files, macOS forks and non-images', () => {
    const names = [
      'Comic/ComicInfo.xml', 'Comic/page10.jpg', 'Comic/page2.JPG', 'Comic/page02b.png', 'Comic/Cover.webp',
      'Comic/__MACOSX/._page2.jpg', 'Comic/.hidden.jpg', 'Comic/notes.txt', 'Comic/extras/001.jpg', 'Comic/',
    ];
    expect(orderPages(names)).toEqual([
      'Comic/Cover.webp', 'Comic/extras/001.jpg', 'Comic/page2.JPG', 'Comic/page02b.png', 'Comic/page10.jpg',
    ]);
    expect(isPageName('a\\b.AVIF')).toBe(true);
    expect(isPageName('.thumbs/b.jpg')).toBe(false);
  });

  test('the shallowest ComicInfo.xml wins', () => {
    expect(pickComicInfo(['b/ComicInfo.xml', 'x/y/comicinfo.XML', 'a/COMICINFO.xml'])).toBe('a/COMICINFO.xml');
    expect(pickComicInfo(['page.jpg'])).toBeNull();
  });
});
