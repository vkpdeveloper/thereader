/** Schemes a resolved URL may carry; decided after parsing, which strips the control characters that hide a scheme. */
const SAFE_SCHEME = /^(?:https?|mailto|tel):/i;

/**
 * Resolves `href` against `base`. Returns an http(s), `mailto:` or `tel:` URL,
 * a `data:` value as written (callers keep only raster images), or null for
 * empty, malformed and every other scheme. Whitespace inside the value is
 * percent-encoded first so both implementations agree on sloppy publisher
 * markup.
 */
export function resolveUrl(href: string, base: string): string | null {
  const value = href.trim().replace(/[\t\n\r]/g, '').replace(/ /g, '%20');
  if (value.length === 0) return null;
  if (/^data:/i.test(value)) return value;
  let url: string;
  try {
    url = new URL(value, base).href;
  } catch {
    return null;
  }
  return SAFE_SCHEME.test(url) ? url : null;
}

/** http(s) only. */
export function resolveHttp(href: string, base: string): string | null {
  const url = resolveUrl(href, base);
  return url !== null && /^https?:\/\//i.test(url) ? url : null;
}

/** Host without `www.`; userinfo (`https://user:pass@host/`) is not the host. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/:?#]+)/i.exec(url);
  return m === null ? '' : m[1]!.toLowerCase().replace(/^www\./, '');
}

const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|ref|ref_src|ref_url|cmpid|ocid|smid|smtyp|sr_share|igshid|_hsenc|_hsmi|mkt_tok|spm|share|source|via|guccounter|guce_referrer|guce_referrer_sig)$/i;

/** The URL without its fragment and without tracking parameters, so the same story saves once. */
export function canonicalUrl(url: string): string {
  const hash = url.indexOf('#');
  const noHash = hash >= 0 ? url.slice(0, hash) : url;
  const q = noHash.indexOf('?');
  if (q < 0) return noHash;
  const kept = noHash
    .slice(q + 1)
    .split('&')
    .filter((pair) => pair.length > 0 && !TRACKING.test(pair.split('=')[0]!));
  return kept.length > 0 ? noHash.slice(0, q) + '?' + kept.join('&') : noHash.slice(0, q);
}
