/**
 * Which archive entries are comic pages, and in what order. The API (cover),
 * this app and the Flutter app (`comic_pages.dart`) apply the same rules;
 * see docs/comics.md.
 */

const PAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];

/** `\` → `/` and no leading slash. */
export function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function isPageName(name: string): boolean {
  const normalized = normalizeEntryName(name);
  if (normalized === '' || normalized.endsWith('/')) return false;
  if (normalized.split('/').some((segment) => segment.startsWith('.') || segment === '__MACOSX')) return false;
  const lower = normalized.toLowerCase();
  return PAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

const RUNS = /[0-9]+|[^0-9]+/g;
const isDigits = (run: string): boolean => run.charCodeAt(0) >= 48 && run.charCodeAt(0) <= 57;

function compareUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Natural order on lower-cased names; code-unit order of the originals breaks ties. */
export function comparePageNames(a: string, b: string): number {
  const runsA = a.toLowerCase().match(RUNS) ?? [];
  const runsB = b.toLowerCase().match(RUNS) ?? [];
  const shared = Math.min(runsA.length, runsB.length);
  for (let index = 0; index < shared; index += 1) {
    const x = runsA[index]!;
    const y = runsB[index]!;
    const digitsX = isDigits(x);
    const digitsY = isDigits(y);
    if (digitsX !== digitsY) return digitsX ? -1 : 1;
    if (digitsX) {
      const valueX = x.replace(/^0+/, '') || '0';
      const valueY = y.replace(/^0+/, '') || '0';
      if (valueX.length !== valueY.length) return valueX.length - valueY.length;
      const byValue = compareUnits(valueX, valueY);
      if (byValue !== 0) return byValue;
      if (x.length !== y.length) return x.length - y.length;
    } else {
      const byText = compareUnits(x, y);
      if (byText !== 0) return byText;
    }
  }
  if (runsA.length !== runsB.length) return runsA.length - runsB.length;
  return compareUnits(a, b);
}

/** Page names among `names` (already normalized), in reading order. */
export function orderPages(names: Iterable<string>): string[] {
  return [...names].filter(isPageName).sort(comparePageNames);
}

/** The `ComicInfo.xml` a repack keeps: the shallowest, then code-unit order. */
export function pickComicInfo(names: Iterable<string>): string | null {
  const candidates = [...names].filter((name) => (name.split('/').pop() ?? '').toLowerCase() === 'comicinfo.xml');
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || compareUnits(a, b));
  return candidates[0] ?? null;
}
