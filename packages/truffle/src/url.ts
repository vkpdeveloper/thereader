/** Schemes a resolved URL may carry; decided after parsing, which strips the control characters that hide a scheme. */
const SAFE_SCHEME = /^(?:https?|mailto|tel):/i;
const TABS_AND_NEWLINES = /[\t\n\r]/g;
const SPACES = / /g;
const DATA = /^data:/i;
/** An address with its own scheme and host: the parser does not read the base for it (`http:x` alone would be relative). */
const ABSOLUTE_HTTP = /^https?:\/\//i;

let checkedBase = '';
let baseIsValid = false;

/** Whether `base` parses as a URL (an invalid base fails every resolution, absolute ones included). Remembers the last base. */
function validBase(base: string): boolean {
  if (base !== checkedBase) {
    checkedBase = base;
    try {
      new URL(base);
      baseIsValid = true;
    } catch {
      baseIsValid = false;
    }
  }
  return baseIsValid;
}

/**
 * Resolves `href` against `base`. Returns an http(s), `mailto:` or `tel:` URL,
 * a `data:` value as written (callers keep only raster images), or null for
 * empty, malformed and every other scheme. Whitespace inside the value is
 * percent-encoded first so both implementations agree on sloppy publisher
 * markup.
 */
export function resolveUrl(href: string, base: string): string | null {
  const value = href.trim().replace(TABS_AND_NEWLINES, '').replace(SPACES, '%20');
  if (value.length === 0) return null;
  if (DATA.test(value)) return value;
  let url: string;
  try {
    // Parsing the base again for an absolute address is half the work of resolving it.
    url = (ABSOLUTE_HTTP.test(value) && validBase(base) ? new URL(value) : new URL(value, base)).href;
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
