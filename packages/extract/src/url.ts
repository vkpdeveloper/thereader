/**
 * Resolves `href` against `base`. Returns null for empty, script and
 * malformed values. Whitespace inside the value is percent-encoded first so
 * both implementations agree on sloppy publisher markup.
 */
export function resolveUrl(href: string, base: string): string | null {
  const value = href.trim().replace(/[\t\n\r]/g, '').replace(/ /g, '%20');
  if (value.length === 0 || /^(?:javascript|vbscript|about|blob):/i.test(value)) return null;
  if (/^data:/i.test(value)) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/** http(s) only. */
export function resolveHttp(href: string, base: string): string | null {
  const url = resolveUrl(href, base);
  return url !== null && /^https?:\/\//i.test(url) ? url : null;
}

/** Host without `www.`. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(url);
  return m === null ? '' : m[1]!.toLowerCase().replace(/^www\./, '');
}
