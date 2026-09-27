/** Container-path helpers. Paths are posix, no leading slash, percent-decoded. */

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Splits `a/b.xhtml#frag` (or with a `?query`) into path and fragment. */
export function splitHref(href: string): { path: string; fragment: string | null } {
  const hash = href.indexOf('#');
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const q = beforeHash.indexOf('?');
  return {
    path: q < 0 ? beforeHash : beforeHash.slice(0, q),
    fragment: hash < 0 ? null : safeDecode(href.slice(hash + 1)) || null,
  };
}

export function isExternal(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/**
 * Resolves `ref` found inside the document at container path `from`.
 * Returns the container path plus fragment, or null for external/data URLs.
 */
export function resolveRef(from: string, ref: string): { path: string; fragment: string | null } | null {
  const trimmed = ref.trim();
  if (trimmed === '' || isExternal(trimmed) || trimmed.startsWith('//')) return null;
  const { path, fragment } = splitHref(trimmed);
  if (path === '') return { path: from, fragment };
  const decoded = safeDecode(path);
  const joined = decoded.startsWith('/') ? decoded : `${dirname(from)}/${decoded}`;
  return { path: normalizePath(joined), fragment };
}
