package truffle

// URL helpers (url.ts). Every link and image of a page is resolved here, so
// url.ts's regular expressions are hand-written scans with the same
// semantics, and a plain reference costs at most one allocation (the
// resolved string).

import "strings"

// resolveURL resolves href against base (`resolveUrl`). It returns an
// http(s), `mailto:` or `tel:` URL, a `data:` value as written (callers keep
// only raster images), or false for empty, malformed and every other scheme.
// Whitespace inside the value is percent-encoded first so both
// implementations agree on sloppy publisher markup.
func resolveURL(href, base string) (string, bool) {
	value := urlCleanReference(href)
	if value == "" {
		return "", false
	}
	if urlHasPrefixFold(value, "data:") {
		return value, true
	}
	url, ok := parseURLHref(value, base)
	if !ok || !urlSafeScheme(url) {
		return "", false
	}
	return url, true
}

// urlSafeScheme is `/^(?:https?|mailto|tel):/i`: the schemes a resolved URL
// may carry, decided after parsing, which strips the control characters
// that hide a scheme.
func urlSafeScheme(url string) bool {
	if url == "" {
		return false
	}
	switch url[0] | 0x20 {
	case 'h':
		return urlHasPrefixFold(url, "https:") || urlHasPrefixFold(url, "http:")
	case 'm':
		return urlHasPrefixFold(url, "mailto:")
	case 't':
		return urlHasPrefixFold(url, "tel:")
	}
	return false
}

// resolveHTTP is resolveURL for http(s) URLs only (`resolveHttp`).
func resolveHTTP(href, base string) (string, bool) {
	url, ok := resolveURL(href, base)
	if !ok || !(urlHasPrefixFold(url, "http://") || urlHasPrefixFold(url, "https://")) {
		return "", false
	}
	return url, true
}

// urlCleanReference is `href.trim()` without tabs and newlines, and with
// spaces as `%20`.
func urlCleanReference(href string) string {
	value := jsTrim(href)
	i := 0
	for i < len(value) && !urlBlank[value[i]] {
		i++
	}
	if i == len(value) {
		return value
	}
	spaces := strings.Count(value[i:], " ")
	var b strings.Builder
	b.Grow(len(value) + 2*spaces)
	b.WriteString(value[:i])
	for ; i < len(value); i++ {
		switch c := value[i]; c {
		case '\t', '\n', '\r':
		case ' ':
			b.WriteString("%20")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// urlBlank marks tabs, newlines and spaces.
var urlBlank = [256]bool{'\t': true, '\n': true, '\r': true, ' ': true}

// urlHasPrefixFold: s starts with the lowercase ASCII prefix, ignoring ASCII
// case (a JavaScript `/^prefix/i` without the `u` flag folds nothing else).
func urlHasPrefixFold(s, prefix string) bool {
	if len(s) < len(prefix) {
		return false
	}
	for i := 0; i < len(prefix); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 32
		}
		if c != prefix[i] {
			return false
		}
	}
	return true
}

// hostOf is the host without `www.` (`hostOf`): the first match of
// `^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/:?#]+)` (case-insensitive),
// lowercased. Userinfo (`https://user:pass@host/`) is not the host.
func hostOf(url string) string {
	if len(url) == 0 || !wgASCIIAlpha(url[0]) {
		return ""
	}
	i := 1
	for i < len(url) {
		c := url[i]
		if !(wgASCIIAlpha(c) || c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-') {
			break
		}
		i++
	}
	if !strings.HasPrefix(url[i:], "://") {
		return ""
	}
	rest := url[i+3:]
	// The authority runs to the first '/', '?' or '#'. The optional userinfo
	// group is greedy: it ends at the last '@' that leaves a host, else an
	// earlier one, else there is none. A host may contain '@' but not ':'.
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority := rest[:end]
	host := ""
	for start := end; ; {
		at := strings.LastIndexByte(authority[:start], '@')
		from := at + 1 // 0 when there is no userinfo left to try
		if from < len(authority) && authority[from] != ':' {
			host = authority[from:]
			if colon := strings.IndexByte(host, ':'); colon >= 0 {
				host = host[:colon]
			}
			break
		}
		if at < 0 {
			return ""
		}
		start = at
	}
	host = jsLower(host)
	if strings.HasPrefix(host, "www.") {
		host = host[4:]
	}
	return host
}

// CanonicalURL is the URL without its fragment and without tracking
// parameters, so the same story saves once (url.ts `canonicalUrl`).
func CanonicalURL(url string) string {
	noHash := url
	if hash := strings.IndexByte(url, '#'); hash >= 0 {
		noHash = url[:hash]
	}
	q := strings.IndexByte(noHash, '?')
	if q < 0 {
		return noHash
	}
	query := noHash[q+1:]
	// Keep the query as is when every pair stays.
	clean := true
	for pairs := query; ; {
		pair, rest, more := strings.Cut(pairs, "&")
		if pair == "" || urlTrackingParam(pair) {
			clean = false
			break
		}
		if !more {
			break
		}
		pairs = rest
	}
	if clean {
		return noHash
	}
	var b strings.Builder
	b.Grow(len(noHash))
	b.WriteString(noHash[:q])
	kept := 0
	for pairs := query; ; {
		pair, rest, more := strings.Cut(pairs, "&")
		if pair != "" && !urlTrackingParam(pair) {
			if kept == 0 {
				b.WriteByte('?')
			} else {
				b.WriteByte('&')
			}
			b.WriteString(pair)
			kept++
		}
		if !more {
			break
		}
		pairs = rest
	}
	return b.String()
}

// urlTrackingParams are the parameter names url.ts's TRACKING pattern lists
// besides `utm_*`.
var urlTrackingParams = [...]string{
	"fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "mc_cid", "mc_eid", "ref", "ref_src", "ref_url",
	"cmpid", "ocid", "smid", "smtyp", "sr_share", "igshid", "_hsenc", "_hsmi", "mkt_tok", "spm", "share",
	"source", "via", "guccounter", "guce_referrer", "guce_referrer_sig",
}

// urlTrackingParam: the name of pair (before its first '=') matches
// `^(?:utm_[a-z_]+|fbclid|…)$/i`, ASCII case-insensitively.
func urlTrackingParam(pair string) bool {
	name := pair
	if eq := strings.IndexByte(pair, '='); eq >= 0 {
		name = pair[:eq]
	}
	if len(name) > 4 && urlHasPrefixFold(name, "utm_") {
		for i := 4; i < len(name); i++ {
			if c := name[i]; !wgASCIIAlpha(c) && c != '_' {
				return false
			}
		}
		return true
	}
	if len(name) < 3 || len(name) > 17 {
		return false
	}
	for _, p := range urlTrackingParams {
		if len(p) == len(name) && urlHasPrefixFold(name, p) {
			return true
		}
	}
	return false
}
