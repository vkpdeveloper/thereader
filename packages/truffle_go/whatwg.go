package truffle

// `new URL(input, base).href` as the TypeScript engine sees it under Bun:
// the WHATWG URL Standard's basic URL parser (url.dart's `whatwgHref`, here
// as the standard's state machine), so links and images resolve exactly
// alike. A page resolves every reference against the same base, and most
// references are plain http(s) URLs and paths: the base is parsed once and
// cached, and those resolve by concatenation and percent-encoding
// (wgBase.resolve). Everything else runs the state machine, including the
// one place WebKit departs from the standard (wgPathStart).
//
// Hosts follow the standard: IPv4 in all its legacy forms, IPv6, opaque
// hosts of non-special schemes, and IDNA. Browsers run UTS #46 on Unicode
// tables the Go standard library lacks (and Bun's are newer than Go's 15.0),
// so non-ASCII labels are mapped by an approximation that covers what pages
// use (wgIDNAMap), with Punycode, CheckBidi and CheckJoiners as specified.
// Hosts that need NFC beyond Hangul, or the rarer compatibility mappings,
// resolve differently: testdata/url/idna.json.gz counts them.

import (
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode"
	"unicode/utf8"
)

// parseURLHref is `new URL(input, base).href`; false where the constructor
// throws (an invalid base included).
func parseURLHref(input, base string) (string, bool) {
	b := wgCachedBase(base)
	if b.url == nil {
		return "", false
	}
	if b.fast != nil {
		if href, ok := b.fast.resolve(input); ok {
			return href, true
		}
	}
	u, ok := wgParse(input, b.url)
	if !ok {
		return "", false
	}
	return u.href(), true
}

// wgBaseEntry is a parsed base. Entries are immutable, so extractions on
// several goroutines share the cache without locking.
type wgBaseEntry struct {
	base string
	url  *wgURL  // nil when the base does not parse
	fast *wgBase // nil when the base is not a plain http(s) URL
}

var wgLastBase atomic.Pointer[wgBaseEntry]

// wgCachedBase parses base, once per run of calls with the same base.
func wgCachedBase(base string) *wgBaseEntry {
	if e := wgLastBase.Load(); e != nil && e.base == base {
		return e
	}
	e := &wgBaseEntry{base: base}
	if u, ok := wgParse(base, nil); ok {
		e.url = u
		e.fast = wgFastBase(u)
	}
	wgLastBase.Store(e)
	return e
}

// ------------------------------------------------------------------ fast path

// wgBase resolves the common relative, scheme-relative and absolute http(s)
// references that need no normalization beyond percent-encoding (no dot
// segments, backslashes or controls, a plain lowercase host) by
// concatenation. Anything else goes to the parser.
type wgBase struct {
	scheme          string // `https:`
	origin          string // `https://host[:port]`
	directory       string // the base path up to its last `/`
	withoutFragment string // the base href without its fragment
}

func wgFastBase(u *wgURL) *wgBase {
	if (u.scheme != "http" && u.scheme != "https") || !u.hasHost || u.opaque || u.username != "" || u.password != "" {
		return nil
	}
	origin := u.scheme + "://" + u.host
	if u.port >= 0 {
		origin += ":" + strconv.Itoa(u.port)
	}
	var dir strings.Builder
	dir.WriteString(origin)
	for i := 0; i < len(u.path)-1; i++ {
		dir.WriteByte('/')
		dir.WriteString(u.path[i])
	}
	dir.WriteByte('/')
	href := u.href()
	if hash := strings.IndexByte(href, '#'); hash >= 0 {
		href = href[:hash]
	}
	return &wgBase{scheme: u.scheme + ":", origin: origin, directory: dir.String(), withoutFragment: href}
}

// resolve is the href of input against the base: what precedes input
// (prefix), the authority it brings (head, kept as is) and its path, query
// and fragment (tail, percent-encoded); false where the parser must decide.
func (b *wgBase) resolve(input string) (string, bool) {
	n := len(input)
	if n == 0 {
		return "", false
	}
	prefix, head, tail := "", "", input
	switch c := input[0]; {
	case c == '#':
		prefix = b.withoutFragment
	case c == '?':
		return "", false
	case c == '/' && n > 1 && input[1] == '/':
		end, ok := wgFastHost(input, 2)
		if !ok {
			return "", false
		}
		prefix, head, tail = b.scheme, input[:end], input[end:]
	case c == '/':
		prefix = b.origin
	case strings.HasPrefix(input, "https://") || strings.HasPrefix(input, "http://"):
		start := 7
		if input[4] == 's' {
			start = 8
		}
		end, ok := wgFastHost(input, start)
		if !ok {
			return "", false
		}
		head, tail = input[:end], input[end:]
	default:
		// A path relative to the base directory; anything with a colon may be a scheme.
		for i := 0; i < n; i++ {
			c := input[i]
			if c == ':' {
				return "", false
			}
			if c == '?' || c == '#' {
				break
			}
		}
		prefix = b.directory
	}
	// An authority without a path gets `/`.
	slash := head != "" && (tail == "" || tail[0] != '/')
	extra, ok := wgFastTail(tail)
	if !ok {
		return "", false
	}
	if extra == 0 {
		switch {
		case prefix == "" && !slash:
			return input, true
		case !slash:
			return prefix + head + tail, true
		}
		return prefix + head + "/" + tail, true
	}
	var out strings.Builder
	out.Grow(len(prefix) + len(head) + 1 + len(tail) + extra)
	out.WriteString(prefix)
	out.WriteString(head)
	if slash {
		out.WriteByte('/')
	}
	class := &wgFastClass[0]
	for i := 0; i < len(tail); i++ {
		c := tail[i]
		switch class[c] {
		case wgFastEncode, wgFastMulti:
			out.WriteByte('%')
			out.WriteByte(wgHex[c>>4])
			out.WriteByte(wgHex[c&0xf])
			continue
		case wgFastQuery:
			class = &wgFastClass[1]
		case wgFastFragment:
			class = &wgFastClass[2]
		}
		out.WriteByte(c)
	}
	return out.String(), true
}

// wgFastHost is the end of a plain host starting at start: lowercase letters,
// digits, '-' and '.', so no port, userinfo, IP address or IDNA label, up to
// the path, query or fragment.
func wgFastHost(s string, start int) (int, bool) {
	i, lastDot := start, start-1
	for ; i < len(s); i++ {
		c := s[i]
		if wgFastHostByte[c] {
			if c == '.' {
				lastDot = i
			}
			continue
		}
		if c == '/' || c == '?' || c == '#' {
			break
		}
		return 0, false
	}
	if i == start || lastDot == i-1 || strings.Contains(s[start:i], "xn--") {
		return 0, false
	}
	// A host ending in a number is an IPv4 address.
	if last := s[lastDot+1]; last >= '0' && last <= '9' {
		return 0, false
	}
	return i, true
}

var wgFastHostByte = func() (t [256]bool) {
	for _, c := range "abcdefghijklmnopqrstuvwxyz0123456789-." {
		t[c] = true
	}
	return t
}()

// Byte classes of the fast path, by part (path, query, fragment).
const (
	wgFastPlain uint8 = iota
	wgFastEncode
	wgFastBail
	wgFastMulti    // a non-ASCII byte
	wgFastPercent  // `%` in the path: maybe an encoded dot
	wgFastSlash    // `/` in the path
	wgFastQuery    // `?` in the path
	wgFastFragment // `#` in the path or query
)

var wgFastClass = func() (t [3][256]uint8) {
	for part, set := range [3]uint8{wgPathSet, wgSpecialQuerySet, wgFragmentSet} {
		for c := 0; c < 256; c++ {
			switch {
			case c >= 0x80:
				t[part][c] = wgFastMulti
			case c <= 0x20 || c == 0x7f:
				t[part][c] = wgFastBail
			case wgSets[c]&set != 0:
				t[part][c] = wgFastEncode
			}
		}
	}
	t[0]['\\'] = wgFastBail // a slash in special URLs
	t[0]['%'] = wgFastPercent
	t[0]['/'] = wgFastSlash
	t[0]['?'] = wgFastQuery
	t[0]['#'] = wgFastFragment
	t[1]['#'] = wgFastFragment
	return t
}()

// wgFastTail checks, in one pass, a path, query and fragment the parser
// would only percent-encode, and counts the bytes encoding adds: false for
// controls, spaces, backslashes in the path, invalid UTF-8 and dot segments
// (`.`, `..`, or a percent-encoded dot anywhere in the path).
func wgFastTail(tail string) (extra int, ok bool) {
	class, seg := &wgFastClass[0], 0
	for i := 0; i < len(tail); i++ {
		c := tail[i]
		k := class[c]
		if k == wgFastPlain {
			continue
		}
		switch k {
		case wgFastEncode:
			extra += 2
		case wgFastBail:
			return 0, false
		case wgFastMulti:
			r, size := utf8.DecodeRuneInString(tail[i:])
			if r == utf8.RuneError && size == 1 {
				return 0, false
			}
			extra += 2 * size
			i += size - 1
		case wgFastPercent:
			if i+2 < len(tail) && tail[i+1] == '2' && tail[i+2]|0x20 == 'e' {
				return 0, false
			}
		default: // the end of a path segment, or of the query
			if s := tail[seg:i]; class == &wgFastClass[0] && (s == "." || s == "..") {
				return 0, false
			}
			seg = i + 1
			if c == '?' {
				class = &wgFastClass[1]
			} else if c == '#' {
				class = &wgFastClass[2]
			}
		}
	}
	if s := tail[seg:]; class == &wgFastClass[0] && (s == "." || s == "..") {
		return 0, false
	}
	return extra, true
}

// ------------------------------------------------------------------ URL record

// wgURL is a URL record. Hosts are kept serialized.
type wgURL struct {
	scheme      string
	username    string
	password    string
	host        string
	hasHost     bool
	port        int // -1: none (or the scheme's default)
	path        []string
	opaque      bool // the path is opaquePath, not segments
	opaquePath  string
	query       string
	hasQuery    bool
	fragment    string
	hasFragment bool
}

func wgSpecial(scheme string) bool {
	switch scheme {
	case "http", "https", "ws", "wss", "ftp", "file":
		return true
	}
	return false
}

func wgDefaultPort(scheme string) int {
	switch scheme {
	case "http", "ws":
		return 80
	case "https", "wss":
		return 443
	case "ftp":
		return 21
	}
	return -1
}

// href is the URL serializer.
func (u *wgURL) href() string {
	size := len(u.scheme) + len(u.username) + len(u.password) + len(u.host) + len(u.opaquePath) + len(u.query) + len(u.fragment) + 16
	for _, s := range u.path {
		size += len(s) + 1
	}
	b := make([]byte, 0, size)
	b = append(b, u.scheme...)
	b = append(b, ':')
	if u.hasHost {
		b = append(b, '/', '/')
		if u.username != "" || u.password != "" {
			b = append(b, u.username...)
			if u.password != "" {
				b = append(b, ':')
				b = append(b, u.password...)
			}
			b = append(b, '@')
		}
		b = append(b, u.host...)
		if u.port >= 0 {
			b = append(b, ':')
			b = strconv.AppendInt(b, int64(u.port), 10)
		}
	}
	if u.opaque {
		b = append(b, u.opaquePath...)
	} else {
		if !u.hasHost && len(u.path) > 1 && u.path[0] == "" {
			b = append(b, '/', '.')
		}
		for _, s := range u.path {
			b = append(b, '/')
			b = append(b, s...)
		}
	}
	if u.hasQuery {
		b = append(b, '?')
		b = append(b, u.query...)
	}
	if u.hasFragment {
		b = append(b, '#')
		b = append(b, u.fragment...)
	}
	return string(b)
}

// shortenPath removes the last segment, except a file URL's drive letter.
func (u *wgURL) shortenPath() {
	if u.scheme == "file" && len(u.path) == 1 && wgNormalizedDriveLetter(u.path[0]) {
		return
	}
	if len(u.path) > 0 {
		u.path = u.path[:len(u.path)-1]
	}
}

// ------------------------------------------------------------------ percent-encoding

// Percent-encode sets, one bit each, for ASCII; every set includes code
// points above U+007E.
const (
	wgC0Set uint8 = 1 << iota
	wgFragmentSet
	wgQuerySet
	wgSpecialQuerySet
	wgPathSet
	wgUserinfoSet
)

var wgSets = func() (t [128]uint8) {
	for c := 0; c < 128; c++ {
		in := func(chars string) bool { return strings.IndexByte(chars, byte(c)) >= 0 }
		var m uint8
		if c < 0x20 || c == 0x7f {
			m = wgC0Set | wgFragmentSet | wgQuerySet | wgSpecialQuerySet | wgPathSet | wgUserinfoSet
		}
		if in(" \"<>`") {
			m |= wgFragmentSet
		}
		if in(" \"#<>") {
			m |= wgQuerySet | wgSpecialQuerySet | wgPathSet | wgUserinfoSet
		}
		if c == '\'' {
			m |= wgSpecialQuerySet
		}
		if in("?^`{}") {
			m |= wgPathSet | wgUserinfoSet
		}
		if in("/:;=@[\\]^|") {
			m |= wgUserinfoSet
		}
		t[c] = m
	}
	return t
}()

const wgHex = "0123456789ABCDEF"

// wgEncode appends the UTF-8 percent-encoding of s (valid UTF-8) in set.
func wgEncode(dst []byte, s string, set uint8) []byte {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x80 && wgSets[c]&set == 0 {
			dst = append(dst, c)
		} else {
			dst = append(dst, '%', wgHex[c>>4], wgHex[c&0xf])
		}
	}
	return dst
}

// ------------------------------------------------------------------ parser

type wgState uint8

const (
	wgSchemeStart wgState = iota
	wgScheme
	wgNoScheme
	wgSpecialRelativeOrAuthority
	wgPathOrAuthority
	wgRelative
	wgRelativeSlash
	wgSpecialAuthoritySlashes
	wgSpecialAuthorityIgnoreSlashes
	wgAuthority
	wgHost
	wgPort
	wgFile
	wgFileSlash
	wgFileHost
	wgPathStart
	wgPath
	wgOpaquePath
	wgQuery
	wgFragment
)

const wgEOF = -1

// wgClean strips leading and trailing C0 controls and spaces, removes tabs
// and newlines, and replaces invalid UTF-8 (a JavaScript string has none)
// with U+FFFD.
func wgClean(s string) string {
	start, end := 0, len(s)
	for start < end && s[start] <= 0x20 {
		start++
	}
	for end > start && s[end-1] <= 0x20 {
		end--
	}
	s = s[start:end]
	if strings.ContainsAny(s, "\t\n\r") {
		b := make([]byte, 0, len(s))
		for i := 0; i < len(s); i++ {
			if c := s[i]; c != '\t' && c != '\n' && c != '\r' {
				b = append(b, c)
			}
		}
		s = string(b)
	}
	if !utf8.ValidString(s) {
		b := make([]byte, 0, len(s)+8)
		for _, r := range s {
			b = utf8.AppendRune(b, r)
		}
		s = string(b)
	}
	return s
}

// wgParse is the basic URL parser (no state override).
func wgParse(raw string, base *wgURL) (*wgURL, bool) {
	input := wgClean(raw)
	n := len(input)
	u := &wgURL{port: -1}
	var buf, query, fragment, opaque []byte
	state := wgSchemeStart
	special := false
	atSignSeen, insideBrackets, passwordTokenSeen := false, false, false
	// remaining reports whether the code point after the current one is ch.
	p, size := 0, 0
	remaining := func(ch byte) bool { return p+size < n && input[p+size] == ch }
	setScheme := func(s string) {
		u.scheme = s
		special = wgSpecial(s)
	}
	copyBase := func(withPath, withQuery bool) {
		u.username, u.password = base.username, base.password
		u.host, u.hasHost, u.port = base.host, base.hasHost, base.port
		if withPath {
			u.path = append([]string(nil), base.path...)
		}
		if withQuery {
			query = append(query[:0], base.query...)
			u.hasQuery = base.hasQuery
		}
	}
	for {
		c := rune(wgEOF)
		size = 0
		if p < n {
			if b := input[p]; b < 0x80 {
				c, size = rune(b), 1
			} else {
				c, size = utf8.DecodeRuneInString(input[p:])
			}
		}
		raw := input[p : p+size]
		again := false // re-run the next state on this code point ("decrease pointer")
		switch state {
		case wgSchemeStart:
			if c < 0x80 && c >= 0 && wgASCIIAlpha(byte(c)) {
				buf = append(buf, byte(c)|0x20)
				state = wgScheme
			} else {
				state, again = wgNoScheme, true
			}

		case wgScheme:
			switch {
			case c >= 0 && c < 0x80 && (wgASCIIAlpha(byte(c)) || c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'):
				if c >= 'A' && c <= 'Z' {
					c += 32
				}
				buf = append(buf, byte(c))
			case c == ':':
				setScheme(string(buf))
				buf = buf[:0]
				switch {
				case u.scheme == "file":
					state = wgFile
				case special && base != nil && base.scheme == u.scheme:
					state = wgSpecialRelativeOrAuthority
				case special:
					state = wgSpecialAuthoritySlashes
				case remaining('/'):
					state = wgPathOrAuthority
					p++
				default:
					u.opaque = true
					state = wgOpaquePath
				}
			default:
				buf = buf[:0]
				state = wgNoScheme
				p, size, again = 0, 0, true
			}

		case wgNoScheme:
			switch {
			case base == nil || (base.opaque && c != '#'):
				return nil, false
			case base.opaque:
				setScheme(base.scheme)
				u.opaque, u.opaquePath = true, base.opaquePath
				query, u.hasQuery = append(query[:0], base.query...), base.hasQuery
				u.hasFragment = true
				state = wgFragment
			case base.scheme != "file":
				state, again = wgRelative, true
			default:
				state, again = wgFile, true
			}

		case wgSpecialRelativeOrAuthority:
			if c == '/' && remaining('/') {
				state = wgSpecialAuthorityIgnoreSlashes
				p++
			} else {
				state, again = wgRelative, true
			}

		case wgPathOrAuthority:
			if c == '/' {
				state = wgAuthority
			} else {
				state, again = wgPath, true
			}

		case wgRelative:
			setScheme(base.scheme)
			if c == '/' || (special && c == '\\') {
				state = wgRelativeSlash
				break
			}
			copyBase(true, true)
			switch c {
			case '?':
				query, u.hasQuery = query[:0], true
				state = wgQuery
			case '#':
				u.hasFragment = true
				state = wgFragment
			case wgEOF:
			default:
				query, u.hasQuery = query[:0], false
				u.shortenPath()
				state, again = wgPath, true
			}

		case wgRelativeSlash:
			switch {
			case special && (c == '/' || c == '\\'):
				state = wgSpecialAuthorityIgnoreSlashes
			case c == '/':
				state = wgAuthority
			default:
				copyBase(false, false)
				state, again = wgPath, true
			}

		case wgSpecialAuthoritySlashes:
			if c == '/' && remaining('/') {
				state = wgSpecialAuthorityIgnoreSlashes
				p++
			} else {
				state, again = wgSpecialAuthorityIgnoreSlashes, true
			}

		case wgSpecialAuthorityIgnoreSlashes:
			if c != '/' && c != '\\' {
				state, again = wgAuthority, true
			}

		case wgAuthority:
			switch {
			case c == '@':
				if atSignSeen {
					buf = append([]byte("%40"), buf...)
				}
				atSignSeen = true
				// The buffer holds raw input: the first ':' ever seen starts the password.
				user, pass := []byte(u.username), []byte(u.password)
				for i := 0; i < len(buf); i++ {
					if buf[i] == ':' && !passwordTokenSeen {
						passwordTokenSeen = true
					} else if passwordTokenSeen {
						pass = wgEncode(pass, string(buf[i:i+1]), wgUserinfoSet)
					} else {
						user = wgEncode(user, string(buf[i:i+1]), wgUserinfoSet)
					}
				}
				u.username, u.password = string(user), string(pass)
				buf = buf[:0]
			case c == wgEOF || c == '/' || c == '?' || c == '#' || (special && c == '\\'):
				if atSignSeen && len(buf) == 0 {
					return nil, false
				}
				p -= len(buf)
				size = 0
				buf = buf[:0]
				state, again = wgHost, true
			default:
				buf = append(buf, raw...)
			}

		case wgHost:
			switch {
			case c == ':' && !insideBrackets:
				if len(buf) == 0 {
					return nil, false
				}
				host, ok := wgParseHost(string(buf), !special)
				if !ok {
					return nil, false
				}
				u.host, u.hasHost = host, true
				buf = buf[:0]
				state = wgPort
			case c == wgEOF || c == '/' || c == '?' || c == '#' || (special && c == '\\'):
				if special && len(buf) == 0 {
					return nil, false
				}
				host, ok := wgParseHost(string(buf), !special)
				if !ok {
					return nil, false
				}
				u.host, u.hasHost = host, true
				buf = buf[:0]
				state, again = wgPathStart, true
			default:
				if c == '[' {
					insideBrackets = true
				} else if c == ']' {
					insideBrackets = false
				}
				buf = append(buf, raw...)
			}

		case wgPort:
			switch {
			case c >= '0' && c <= '9':
				buf = append(buf, byte(c))
			case c == wgEOF || c == '/' || c == '?' || c == '#' || (special && c == '\\'):
				if len(buf) > 0 {
					port := 0
					for _, d := range buf {
						port = port*10 + int(d-'0')
						if port > 65535 {
							return nil, false
						}
					}
					if port == wgDefaultPort(u.scheme) {
						port = -1
					}
					u.port = port
					buf = buf[:0]
				}
				state, again = wgPathStart, true
			default:
				return nil, false
			}

		case wgFile:
			setScheme("file")
			u.host, u.hasHost = "", true
			switch {
			case c == '/' || c == '\\':
				state = wgFileSlash
			case base != nil && base.scheme == "file":
				u.host, u.hasHost = base.host, base.hasHost
				u.path = append([]string(nil), base.path...)
				query, u.hasQuery = append(query[:0], base.query...), base.hasQuery
				switch c {
				case '?':
					query, u.hasQuery = query[:0], true
					state = wgQuery
				case '#':
					u.hasFragment = true
					state = wgFragment
				case wgEOF:
				default:
					query, u.hasQuery = query[:0], false
					if !wgStartsWithDriveLetter(input[p:]) {
						u.shortenPath()
					} else {
						u.path = u.path[:0]
					}
					state, again = wgPath, true
				}
			default:
				state, again = wgPath, true
			}

		case wgFileSlash:
			if c == '/' || c == '\\' {
				state = wgFileHost
				break
			}
			if base != nil && base.scheme == "file" {
				u.host, u.hasHost = base.host, base.hasHost
				if !wgStartsWithDriveLetter(input[p:]) && len(base.path) > 0 && wgNormalizedDriveLetter(base.path[0]) {
					u.path = append(u.path, base.path[0])
				}
			}
			state, again = wgPath, true

		case wgFileHost:
			if c == wgEOF || c == '/' || c == '\\' || c == '?' || c == '#' {
				again = true
				switch {
				case wgDriveLetter(string(buf)):
					// The buffer stays: the path state takes it as the first segment.
					state = wgPath
				case len(buf) == 0:
					u.host, u.hasHost = "", true
					state = wgPathStart
				default:
					host, ok := wgParseHost(string(buf), false)
					if !ok {
						return nil, false
					}
					if host == "localhost" {
						host = ""
					}
					u.host, u.hasHost = host, true
					buf = buf[:0]
					state = wgPathStart
				}
			} else {
				buf = append(buf, raw...)
			}

		case wgPathStart:
			switch {
			case special:
				state = wgPath
				again = c != '/' && c != '\\'
			case c == '?' || c == '#':
				// WebKit (Bun) gives an empty path a segment after an authority
				// with an '@': `foo://u@h?x` is `foo://u@h/?x`. The standard
				// (and V8) keep `foo://u@h?x`; the TypeScript engine runs on Bun.
				if atSignSeen {
					u.path = append(u.path, "")
				}
				if c == '?' {
					query, u.hasQuery = query[:0], true
					state = wgQuery
				} else {
					u.hasFragment = true
					state = wgFragment
				}
			case c != wgEOF:
				state = wgPath
				again = c != '/'
			}

		case wgPath:
			slash := c == '/' || (special && c == '\\')
			if c == wgEOF || slash || c == '?' || c == '#' {
				seg := string(buf)
				switch {
				case wgDoubleDot(seg):
					u.shortenPath()
					if !slash {
						u.path = append(u.path, "")
					}
				case wgSingleDot(seg):
					if !slash {
						u.path = append(u.path, "")
					}
				default:
					if u.scheme == "file" && len(u.path) == 0 && wgDriveLetter(seg) {
						seg = seg[:1] + ":"
					}
					u.path = append(u.path, seg)
				}
				buf = buf[:0]
				if c == '?' {
					query, u.hasQuery = query[:0], true
					state = wgQuery
				} else if c == '#' {
					u.hasFragment = true
					state = wgFragment
				}
			} else {
				buf = wgEncode(buf, raw, wgPathSet)
			}

		case wgOpaquePath:
			switch c {
			case '?':
				query, u.hasQuery = query[:0], true
				state = wgQuery
			case '#':
				u.hasFragment = true
				state = wgFragment
			case ' ':
				if remaining('?') || remaining('#') {
					opaque = append(opaque, "%20"...)
				} else {
					opaque = append(opaque, ' ')
				}
			case wgEOF:
			default:
				opaque = wgEncode(opaque, raw, wgC0Set)
			}

		case wgQuery:
			switch c {
			case '#':
				u.hasFragment = true
				state = wgFragment
			case wgEOF:
			default:
				set := wgQuerySet
				if special {
					set = wgSpecialQuerySet
				}
				query = wgEncode(query, raw, set)
			}

		case wgFragment:
			if c != wgEOF {
				fragment = wgEncode(fragment, raw, wgFragmentSet)
			}
		}
		if again {
			continue
		}
		if c == wgEOF {
			break
		}
		p += size
	}
	if u.opaque && u.opaquePath == "" {
		u.opaquePath = string(opaque)
	}
	if u.hasQuery {
		u.query = string(query)
	}
	if u.hasFragment {
		u.fragment = string(fragment)
	}
	return u, true
}

func wgASCIIAlpha(c byte) bool { return c|0x20 >= 'a' && c|0x20 <= 'z' }

// wgSingleDot: `.` or `%2e`.
func wgSingleDot(s string) bool {
	return s == "." || (len(s) == 3 && s[0] == '%' && s[1] == '2' && s[2]|0x20 == 'e')
}

// wgDoubleDot: `..`, `.%2e`, `%2e.` or `%2e%2e`.
func wgDoubleDot(s string) bool {
	switch len(s) {
	case 2:
		return s == ".."
	case 4:
		return (s[0] == '.' && wgSingleDot(s[1:])) || (wgSingleDot(s[:3]) && s[3] == '.')
	case 6:
		return wgSingleDot(s[:3]) && wgSingleDot(s[3:])
	}
	return false
}

// wgDriveLetter: a Windows drive letter (`c:` or `c|`).
func wgDriveLetter(s string) bool {
	return len(s) == 2 && wgASCIIAlpha(s[0]) && (s[1] == ':' || s[1] == '|')
}

// wgNormalizedDriveLetter: `c:`.
func wgNormalizedDriveLetter(s string) bool {
	return len(s) == 2 && wgASCIIAlpha(s[0]) && s[1] == ':'
}

// wgStartsWithDriveLetter: s starts with a drive letter followed by nothing
// or a path, query or fragment delimiter.
func wgStartsWithDriveLetter(s string) bool {
	if len(s) < 2 || !wgDriveLetter(s[:2]) {
		return false
	}
	if len(s) == 2 {
		return true
	}
	switch s[2] {
	case '/', '\\', '?', '#':
		return true
	}
	return false
}

// ------------------------------------------------------------------ hosts

// wgForbiddenHost marks forbidden host code points; wgForbiddenDomain adds
// C0 controls, `%` and DEL.
var wgForbiddenHost, wgForbiddenDomain = func() (host, domain [128]bool) {
	for _, c := range "\x00\t\n\r #/:<>?@[\\]^|" {
		host[c] = true
		domain[c] = true
	}
	for c := 0; c < 0x20; c++ {
		domain[c] = true
	}
	domain['%'] = true
	domain[0x7f] = true
	return host, domain
}()

// wgParseHost is the host parser; the result is serialized.
func wgParseHost(input string, opaque bool) (string, bool) {
	if strings.HasPrefix(input, "[") {
		if !strings.HasSuffix(input, "]") || len(input) < 2 {
			return "", false
		}
		return wgIPv6(input[1 : len(input)-1])
	}
	if opaque {
		for i := 0; i < len(input); i++ {
			if c := input[i]; c < 0x80 && wgForbiddenHost[c] {
				return "", false
			}
		}
		return string(wgEncode(nil, input, wgC0Set)), true
	}
	domain := wgPercentDecode(input)
	// Invalid UTF-8 decodes to U+FFFD, which IDNA disallows.
	if !utf8.ValidString(domain) {
		return "", false
	}
	ascii, ok := wgDomainToASCII(domain)
	if !ok || ascii == "" {
		return "", false
	}
	for i := 0; i < len(ascii); i++ {
		if c := ascii[i]; c >= 0x80 || wgForbiddenDomain[c] {
			return "", false
		}
	}
	if wgEndsInNumber(ascii) {
		return wgIPv4(ascii)
	}
	return ascii, true
}

// wgPercentDecode decodes `%XX` sequences; a `%` without two hex digits stays.
func wgPercentDecode(s string) string {
	if strings.IndexByte(s, '%') < 0 {
		return s
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' && i+2 < len(s) {
			if hi, lo := hexValue(s[i+1]), hexValue(s[i+2]); hi >= 0 && lo >= 0 {
				b = append(b, byte(hi<<4|lo))
				i += 2
				continue
			}
		}
		b = append(b, c)
	}
	return string(b)
}

// wgEndsInNumber: the last label (before a trailing dot) is all digits or a
// valid IPv4 number, so the host is an IPv4 address.
func wgEndsInNumber(s string) bool {
	if strings.HasSuffix(s, ".") {
		if len(s) == 1 {
			return false
		}
		s = s[:len(s)-1]
	}
	last := s[strings.LastIndexByte(s, '.')+1:]
	if last == "" {
		return false
	}
	digits := true
	for i := 0; i < len(last); i++ {
		if last[i] < '0' || last[i] > '9' {
			digits = false
			break
		}
	}
	if digits {
		return true
	}
	_, ok := wgIPv4Number(last)
	return ok
}

// wgIPv4Number parses a decimal, `0x` hex or `0` octal part; values past
// 2^32 saturate (they only ever fail the range checks).
func wgIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	radix := uint64(10)
	if len(s) >= 2 && s[0] == '0' && s[1]|0x20 == 'x' {
		radix, s = 16, s[2:]
	} else if len(s) >= 2 && s[0] == '0' {
		radix, s = 8, s[1:]
	}
	var v uint64
	for i := 0; i < len(s); i++ {
		d := hexValue(s[i])
		if d < 0 || uint64(d) >= radix {
			return 0, false
		}
		if v < 1<<40 {
			v = v*radix + uint64(d)
		}
	}
	return v, true
}

// wgIPv4 is the IPv4 parser, serialized.
func wgIPv4(s string) (string, bool) {
	parts := strings.Split(s, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	var numbers [4]uint64
	for i, part := range parts {
		v, ok := wgIPv4Number(part)
		if !ok {
			return "", false
		}
		if i < len(parts)-1 && v > 255 {
			return "", false
		}
		numbers[i] = v
	}
	last := numbers[len(parts)-1]
	if last >= 1<<(8*(5-len(parts))) {
		return "", false
	}
	ipv4 := last
	for i := 0; i < len(parts)-1; i++ {
		ipv4 += numbers[i] << (8 * (3 - i))
	}
	b := make([]byte, 0, 15)
	for shift := 24; shift >= 0; shift -= 8 {
		b = strconv.AppendUint(b, ipv4>>shift&0xff, 10)
		if shift > 0 {
			b = append(b, '.')
		}
	}
	return string(b), true
}

// wgIPv6 is the IPv6 parser, serialized with brackets.
func wgIPv6(s string) (string, bool) {
	var address [8]uint16
	pieceIndex, compress := 0, -1
	p, n := 0, len(s)
	at := func(i int) int {
		if i < n {
			return int(s[i])
		}
		return wgEOF
	}
	if at(p) == ':' {
		if at(p+1) != ':' {
			return "", false
		}
		p += 2
		pieceIndex++
		compress = pieceIndex
	}
	for at(p) != wgEOF {
		if pieceIndex == 8 {
			return "", false
		}
		if at(p) == ':' {
			if compress >= 0 {
				return "", false
			}
			p++
			pieceIndex++
			compress = pieceIndex
			continue
		}
		value, length := 0, 0
		for length < 4 && at(p) != wgEOF && hexValue(s[p]) >= 0 {
			value = value*16 + hexValue(s[p])
			p++
			length++
		}
		if at(p) == '.' {
			if length == 0 {
				return "", false
			}
			p -= length
			if pieceIndex > 6 {
				return "", false
			}
			numbersSeen := 0
			for at(p) != wgEOF {
				piece := -1
				if numbersSeen > 0 {
					if at(p) == '.' && numbersSeen < 4 {
						p++
					} else {
						return "", false
					}
				}
				if c := at(p); c < '0' || c > '9' {
					return "", false
				}
				for c := at(p); c >= '0' && c <= '9'; c = at(p) {
					number := c - '0'
					switch piece {
					case -1:
						piece = number
					case 0:
						return "", false
					default:
						piece = piece*10 + number
					}
					if piece > 255 {
						return "", false
					}
					p++
				}
				address[pieceIndex] = address[pieceIndex]*0x100 + uint16(piece)
				numbersSeen++
				if numbersSeen == 2 || numbersSeen == 4 {
					pieceIndex++
				}
			}
			if numbersSeen != 4 {
				return "", false
			}
			break
		} else if at(p) == ':' {
			p++
			if at(p) == wgEOF {
				return "", false
			}
		} else if at(p) != wgEOF {
			return "", false
		}
		address[pieceIndex] = uint16(value)
		pieceIndex++
	}
	if compress >= 0 {
		swaps := pieceIndex - compress
		pieceIndex = 7
		for pieceIndex != 0 && swaps > 0 {
			address[pieceIndex], address[compress+swaps-1] = address[compress+swaps-1], address[pieceIndex]
			pieceIndex--
			swaps--
		}
	} else if pieceIndex != 8 {
		return "", false
	}
	// Serialize: the first longest run of two or more zero pieces compresses to `::`.
	best, bestLen := -1, 1
	for i := 0; i < 8; {
		if address[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && address[j] == 0 {
			j++
		}
		if j-i > bestLen {
			best, bestLen = i, j-i
		}
		i = j
	}
	b := make([]byte, 0, 41)
	b = append(b, '[')
	for i := 0; i < 8; i++ {
		if i == best {
			if i == 0 {
				b = append(b, ':')
			}
			b = append(b, ':')
			i += bestLen - 1
			continue
		}
		b = strconv.AppendUint(b, uint64(address[i]), 16)
		if i < 7 {
			b = append(b, ':')
		}
	}
	return string(append(b, ']')), true
}

// ------------------------------------------------------------------ IDNA

// wgDomainToASCII is UTS #46 ToASCII as browsers run it on URL hosts:
// nontransitional, CheckBidi and CheckJoiners, no STD3 rules or DNS length
// limits. An ASCII domain without an ACE (`xn--`) label is only lowercased.
func wgDomainToASCII(domain string) (string, bool) {
	for i := 0; i < len(domain); i++ {
		if domain[i] >= 0x80 {
			return wgIDNA(domain)
		}
	}
	lower := wgASCIILower(domain)
	if wgHasACELabel(lower) {
		return wgIDNA(lower)
	}
	return lower, true
}

// wgASCIILower lowercases ASCII letters, allocating only when there are any.
func wgASCIILower(s string) string {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 32
				}
			}
			return string(b)
		}
	}
	return s
}

// wgHasACELabel: some label of the lowercase domain starts with `xn--`.
func wgHasACELabel(s string) bool {
	for i := 0; ; {
		if strings.HasPrefix(s[i:], "xn--") {
			return true
		}
		dot := strings.IndexByte(s[i:], '.')
		if dot < 0 {
			return false
		}
		i += dot + 1
	}
}

// wgIDNA maps, validates and Punycode-encodes each label.
func wgIDNA(domain string) (string, bool) {
	mapped := make([]rune, 0, len(domain))
	for _, r := range domain {
		var ok bool
		if mapped, ok = wgIDNAMap(r, mapped); !ok {
			return "", false
		}
	}
	mapped = wgComposeHangul(mapped)
	out := make([]byte, 0, len(domain)+8)
	var labels [][]rune // the Unicode form of each label, for CheckBidi
	bidi := false
	for start := 0; start <= len(mapped); {
		end := start
		for end < len(mapped) && mapped[end] != '.' {
			end++
		}
		label := mapped[start:end]
		if start > 0 {
			out = append(out, '.')
		}
		ascii := true
		for _, r := range label {
			if r >= 0x80 {
				ascii = false
				break
			}
		}
		uni := label
		ace := len(label) >= 4 && label[0] == 'x' && label[1] == 'n' && label[2] == '-' && label[3] == '-'
		if ace && !ascii {
			return "", false
		}
		if ace {
			decoded, ok := wgPunycodeDecode(label[4:])
			if !ok || len(decoded) == 0 {
				return "", false
			}
			nonASCII := false
			for _, r := range decoded {
				if r >= 0x80 {
					nonASCII = true
				}
				// Only valid (or deviation) code points: nothing the mapping would change.
				if m, ok := wgIDNAMap(r, nil); !ok || len(m) != 1 || m[0] != r {
					return "", false
				}
			}
			// A decoded label must be in NFC (checked for Hangul only).
			if !nonASCII || len(wgComposeHangul(append([]rune(nil), decoded...))) != len(decoded) {
				return "", false
			}
			uni = decoded
			for _, r := range label {
				out = append(out, byte(r))
			}
		} else if ascii {
			for _, r := range label {
				out = append(out, byte(r))
			}
		} else {
			out = append(out, "xn--"...)
			out = wgPunycodeEncode(out, label)
		}
		if !ascii || ace {
			if len(uni) > 0 && unicode.In(uni[0], unicode.Mn, unicode.Mc, unicode.Me) {
				return "", false
			}
			if !wgJoinersValid(uni) {
				return "", false
			}
		}
		for _, r := range uni {
			if c := wgBidiClass(r); c == wgBidiR || c == wgBidiAL || c == wgBidiAN {
				bidi = true
			}
		}
		labels = append(labels, uni)
		start = end + 1
	}
	if bidi {
		for _, label := range labels {
			if !wgBidiValid(label) {
				return "", false
			}
		}
	}
	return string(out), true
}

// wgIDNAMap appends the UTS #46 mapping of r; false where r is disallowed.
// An approximation of the mapping table: ASCII and full-width forms
// lowercase, ignored characters vanish, letters case-fold, the common
// compatibility forms (superscripts, Roman numerals, ligatures, circled,
// parenthesized and mathematical letters) decompose, blocks whose mappings
// take tables are rejected (wgIDNAMappedElsewhere), and unassigned code
// points, controls, spaces and format characters are disallowed.
func wgIDNAMap(r rune, out []rune) ([]rune, bool) {
	switch {
	case r < 0x80:
		if r >= 'A' && r <= 'Z' {
			r += 32
		}
		return append(out, r), true
	case r == 0xad, r == 0x34f, r == 0x115f, r == 0x1160, r == 0x17b4, r == 0x17b5, r >= 0x180b && r <= 0x180f,
		r == 0x200b, r >= 0x2060 && r <= 0x2064, r >= 0x206a && r <= 0x206f, r == 0x3164, r >= 0xfe00 && r <= 0xfe0f,
		r == 0xfeff, r == 0xffa0, r >= 0x1bca0 && r <= 0x1bca3, r >= 0x1d173 && r <= 0x1d17a, r >= 0xe0100 && r <= 0xe01ef:
		return out, true // ignored
	case r == 0x3002 || r == 0xff61:
		return append(out, '.'), true
	case r >= 0xff01 && r <= 0xff5e:
		return wgIDNAMap(r-0xfee0, out)
	case r == 0xdf || r == 0x3c2 || r == 0x200c || r == 0x200d:
		return append(out, r), true // deviations: valid in nontransitional processing
	case r == 0x130:
		return append(out, 'i', 0x307), true
	case r == 0x1e9e:
		return append(out, 0xdf), true
	case r == 0x17f:
		return append(out, 's'), true
	case r == 0x131 || (r >= 0x13a0 && r <= 0x13f5):
		return append(out, r), true
	case r >= 0x13f8 && r <= 0x13fd:
		return append(out, r-8), true // Cherokee folds to uppercase
	case r >= 0xab70 && r <= 0xabbf:
		return append(out, r-0xab70+0x13a0), true
	case r >= 0x2ebf0 && r <= 0x2ee5d, r >= 0x323b0 && r <= 0x33479:
		return append(out, r), true // CJK ideographs newer than Go's tables
	case r == 0xfffd, r == 0xfffc, r >= 0x2024 && r <= 0x2026, r >= 0x2488 && r <= 0x249b, r == 0x1f100,
		r == 0xfe12, r == 0xfe13, r == 0xfe16, r == 0xfe19, r == 0xfe52, r == 0xa8, r == 0xaf, r == 0xb4, r == 0xb8, r >= 0x2d8 && r <= 0x2dd:
		// Disallowed, or mapped to a sequence with a dot, space or forbidden host code point.
		return out, false
	}
	if s := wgIDNACompat(r); s != "" {
		for _, c := range s {
			out = append(out, c)
		}
		return out, true
	}
	if wgIDNAMappedElsewhere(r) {
		return out, false
	}
	if !unicode.In(r, unicode.L, unicode.M, unicode.N, unicode.P, unicode.S) {
		// Unassigned, controls, format characters, spaces, surrogates, private use.
		return out, false
	}
	if l := unicode.ToLower(r); l != r {
		r = l
	} else if up := unicode.ToUpper(r); up != r && up >= 0x80 {
		// A lowercase letter with its own case folding (µ, ϐ, ẛ).
		if l := unicode.ToLower(up); l >= 0x80 {
			r = l
		}
	}
	return append(out, r), true
}

// wgComposeHangul is NFC's composition of conjoining jamo into syllables,
// in place: the one part of NFC that needs no tables. Other decomposed text
// (a letter and a combining accent) stays as it is.
func wgComposeHangul(s []rune) []rune {
	const sBase, lBase, vBase, tBase, lCount, vCount, tCount = 0xac00, 0x1100, 0x1161, 0x11a7, 19, 21, 28
	out := s[:0]
	for _, r := range s {
		if n := len(out); n > 0 {
			last := out[n-1]
			if l, v := last-lBase, r-vBase; l >= 0 && l < lCount && v >= 0 && v < vCount {
				out[n-1] = sBase + (l*vCount+v)*tCount
				continue
			}
			if si, t := last-sBase, r-tBase; si >= 0 && si < lCount*vCount*tCount && si%tCount == 0 && t > 0 && t < tCount {
				out[n-1] = last + t
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// wgIDNAMappedElsewhere: r is in a block of compatibility characters whose
// mappings take tables (Kangxi radicals, Hangul compatibility jamo,
// enclosed and squared CJK, CJK compatibility ideographs, Hebrew and Arabic
// presentation forms, half-width forms). They are rejected: an ACE label
// holding one is invalid, as in browsers; a Unicode host fails where a
// browser would map it.
func wgIDNAMappedElsewhere(r rune) bool {
	switch {
	case r < 0x2f00:
		return false
	case r <= 0x2fd5, r >= 0x3131 && r <= 0x318e, r >= 0x3200 && r <= 0x33ff && !(r >= 0x3248 && r <= 0x324f) && r != 0x327f,
		r >= 0xff62 && r <= 0xffee:
		return true
	case r >= 0xf900 && r <= 0xfad9:
		// Except the unified ideographs among them.
		switch r {
		case 0xfa0e, 0xfa0f, 0xfa11, 0xfa13, 0xfa14, 0xfa1f, 0xfa21, 0xfa23, 0xfa24, 0xfa27, 0xfa28, 0xfa29:
			return false
		}
		return true
	case r >= 0x2f800 && r <= 0x2fa1d:
		return true
	case r == 0xfb1d, r >= 0xfb1f && r <= 0xfb4f, r >= 0xfb50 && r <= 0xfdfb && r != 0xfd3e && r != 0xfd3f && !(r >= 0xfdd0 && r <= 0xfdef),
		r >= 0xfe70 && r <= 0xfefc && r != 0xfe73:
		return true
	}
	return false
}

// wgIDNACompat is the mapping of the common compatibility characters, "" for
// the rest.
func wgIDNACompat(r rune) string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	switch {
	case r < 0xa0:
		return ""
	case r >= 0x2160 && r <= 0x217f:
		return [...]string{"i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "l", "c", "d", "m"}[(r-0x2160)%16]
	case r >= 0x2460 && r <= 0x2473:
		return strconv.Itoa(int(r-0x2460) + 1)
	case r >= 0x2474 && r <= 0x2487:
		return "(" + strconv.Itoa(int(r-0x2474)+1) + ")"
	case r >= 0x249c && r <= 0x24b5:
		return "(" + letters[r-0x249c:r-0x249c+1] + ")"
	case r >= 0x24b6 && r <= 0x24e9:
		return letters[(r-0x24b6)%26 : (r-0x24b6)%26+1]
	case r >= 0x1f101 && r <= 0x1f10a:
		return string(rune('0'+r-0x1f101)) + ","
	case r >= 0x1f110 && r <= 0x1f129:
		return "(" + letters[r-0x1f110:r-0x1f110+1] + ")"
	case r >= 0x1f130 && r <= 0x1f149:
		return letters[r-0x1f130 : r-0x1f130+1]
	case r >= 0x1d400 && r <= 0x1d6a3:
		// Mathematical letters: alphabets of 52, holes unassigned.
		if !unicode.IsLetter(r) {
			return ""
		}
		i := (r - 0x1d400) % 52 % 26
		return letters[i : i+1]
	case r >= 0x1d7ce && r <= 0x1d7ff:
		return string(rune('0' + (r-0x1d7ce)%10))
	case r >= 0x2150 && r <= 0x215f:
		return [...]string{"1⁄7", "1⁄9", "1⁄10", "1⁄3", "2⁄3", "1⁄5", "2⁄5", "3⁄5", "4⁄5", "1⁄6", "5⁄6", "1⁄8", "3⁄8", "5⁄8", "7⁄8", "1⁄"}[r-0x2150]
	case r >= 0x2074 && r <= 0x2079:
		return string(rune('4' + r - 0x2074))
	case r >= 0x2080 && r <= 0x2089:
		return string(rune('0' + r - 0x2080))
	case r >= 0x2090 && r <= 0x209c:
		return [...]string{"a", "e", "o", "x", "ə", "h", "k", "l", "m", "n", "p", "s", "t"}[r-0x2090]
	case r >= 0x2b0 && r <= 0x2b8:
		return [...]string{"h", "ɦ", "j", "r", "ɹ", "ɻ", "ʁ", "w", "y"}[r-0x2b0]
	case r >= 0x2e0 && r <= 0x2e4:
		return [...]string{"ɣ", "l", "s", "x", "ʕ"}[r-0x2e0]
	case r >= 0x1c4 && r <= 0x1c6:
		return "dž"
	case r >= 0x1c7 && r <= 0x1c9:
		return "lj"
	case r >= 0x1ca && r <= 0x1cc:
		return "nj"
	case r >= 0x1f1 && r <= 0x1f3:
		return "dz"
	case r >= 0xfb00 && r <= 0xfb06:
		return [...]string{"ff", "fi", "fl", "ffi", "ffl", "st", "st"}[r-0xfb00]
	case r >= 0xfe50 && r <= 0xfe6b:
		// Small form variants; U+FE52 (a dot) is disallowed, U+FE53 and U+FE67 unassigned.
		return [...]string{",", "、", "", "", ";", ":", "?", "!", "—", "(", ")", "{", "}", "〔", "〕", "#",
			"&", "*", "+", "-", "<", ">", "=", "", "\\", "$", "%", "@"}[r-0xfe50]
	}
	switch r {
	case 0xaa:
		return "a"
	case 0xba:
		return "o"
	case 0xb2:
		return "2"
	case 0xb3:
		return "3"
	case 0xb9:
		return "1"
	case 0xbc:
		return "1⁄4"
	case 0xbd:
		return "1⁄2"
	case 0xbe:
		return "3⁄4"
	case 0x132, 0x133:
		return "ij"
	case 0x13f, 0x140:
		return "l·"
	case 0x149:
		return "ʼn"
	case 0x2070:
		return "0"
	case 0x2071, 0x2110, 0x2111, 0x2139, 0x2148:
		return "i"
	case 0x207f, 0x2115:
		return "n"
	case 0x24ea:
		return "0"
	case 0x1d6a4:
		return "ı"
	case 0x1d6a5:
		return "ȷ"
	case 0x2102, 0x212d:
		return "c"
	case 0x2107:
		return "ɛ"
	case 0x210a:
		return "g"
	case 0x210b, 0x210c, 0x210d, 0x210e:
		return "h"
	case 0x210f:
		return "ħ"
	case 0x2112, 0x2113:
		return "l"
	case 0x2116:
		return "no"
	case 0x2119:
		return "p"
	case 0x211a:
		return "q"
	case 0x211b, 0x211c, 0x211d:
		return "r"
	case 0x2120:
		return "sm"
	case 0x2121:
		return "tel"
	case 0x2122:
		return "tm"
	case 0x2124, 0x2128:
		return "z"
	case 0x212c:
		return "b"
	case 0x212f, 0x2130, 0x2147:
		return "e"
	case 0x2131:
		return "f"
	case 0x2133:
		return "m"
	case 0x2134:
		return "o"
	case 0x2145, 0x2146:
		return "d"
	case 0x2149:
		return "j"
	case 0xfe10:
		return ","
	case 0xfe11:
		return "、"
	case 0xfe14:
		return ";"
	case 0xfe15:
		return "!"
	case 0xfe17:
		return "〖"
	case 0xfe18:
		return "〗"
	}
	return ""
}

const (
	wgPunyBase = 36
	wgPunyTMin = 1
	wgPunyTMax = 26
	wgPunySkew = 38
	wgPunyDamp = 700
	wgPunyMax  = 0x7fffffff // ICU decodes in 32-bit integers
)

func wgPunyAdapt(delta, points int, first bool) int {
	if first {
		delta /= wgPunyDamp
	} else {
		delta /= 2
	}
	delta += delta / points
	k := 0
	for delta > (wgPunyBase-wgPunyTMin)*wgPunyTMax/2 {
		delta /= wgPunyBase - wgPunyTMin
		k += wgPunyBase
	}
	return k + (wgPunyBase-wgPunyTMin+1)*delta/(delta+wgPunySkew)
}

func wgPunyThreshold(k, bias int) int {
	switch {
	case k <= bias:
		return wgPunyTMin
	case k >= bias+wgPunyTMax:
		return wgPunyTMax
	}
	return k - bias
}

func wgPunyDigit(d int) byte {
	if d < 26 {
		return byte('a' + d)
	}
	return byte('0' + d - 26)
}

// wgPunycodeEncode appends the Punycode (RFC 3492) of label. Each delta counts
// the code points below the one encoded that come before it; a Fenwick tree
// over the positions counts them, where the RFC's loop over the whole label
// for every distinct code point is quadratic in a long label.
func wgPunycodeEncode(out []byte, label []rune) []byte {
	n := len(label)
	basic := 0
	for _, r := range label {
		if r < 0x80 {
			out = append(out, byte(r))
			basic++
		}
	}
	if basic > 0 {
		out = append(out, '-')
	}
	// The positions of each non-basic code point, by code point.
	order := make([]int, 0, n-basic)
	for j, r := range label {
		if r >= 0x80 {
			order = append(order, j)
		}
	}
	slices.SortFunc(order, func(a, b int) int {
		if label[a] != label[b] {
			return int(label[a] - label[b])
		}
		return a - b
	})
	tree := make([]int, n+1)
	mark := func(j int) {
		for k := j + 1; k <= n; k += k & -k {
			tree[k]++
		}
	}
	before := func(j int) int {
		count := 0
		for k := j; k > 0; k -= k & -k {
			count += tree[k]
		}
		return count
	}
	for j, r := range label {
		if r < 0x80 {
			mark(j)
		}
	}
	cp, delta, bias, handled := 0x80, 0, 72, basic
	for g := 0; g < len(order); {
		m := int(label[order[g]])
		end := g
		for end < len(order) && int(label[order[end]]) == m {
			end++
		}
		delta += (m - cp) * (handled + 1)
		cp = m
		// The RFC's delta++ for each smaller code point, counted between this one's occurrences.
		marked, previous := handled, 0
		for _, j := range order[g:end] {
			below := before(j)
			delta += below - previous
			previous = below
			q := delta
			for k := wgPunyBase; ; k += wgPunyBase {
				t := wgPunyThreshold(k, bias)
				if q < t {
					break
				}
				out = append(out, wgPunyDigit(t+(q-t)%(wgPunyBase-t)))
				q = (q - t) / (wgPunyBase - t)
			}
			out = append(out, wgPunyDigit(q))
			bias = wgPunyAdapt(delta, handled+1, handled == basic)
			delta = 0
			handled++
		}
		delta += marked - previous
		for _, j := range order[g:end] {
			mark(j)
		}
		delta++
		cp++
		g = end
	}
	return out
}

// wgPunycodeDecode decodes an ACE label's Punycode as ICU does: basic code
// points end at the last `-` unless it is the first character. Decoding
// records where each code point is inserted; the final order follows from
// those positions in reverse, with a Fenwick tree finding the free slots, so
// a long label is not quadratic.
func wgPunycodeDecode(s []rune) ([]rune, bool) {
	basic := 0
	for j := len(s) - 1; j >= 0; j-- {
		if s[j] == '-' {
			basic = j
			break
		}
	}
	values := make([]rune, 0, len(s))
	positions := make([]int, 0, len(s))
	for j := 0; j < basic; j++ {
		values = append(values, s[j])
		positions = append(positions, j)
	}
	in := 0
	if basic > 0 {
		in = basic + 1
	}
	n, i, bias := 0x80, 0, 72
	for in < len(s) {
		old, w := i, 1
		for k := wgPunyBase; ; k += wgPunyBase {
			if in >= len(s) {
				return nil, false
			}
			c := s[in]
			in++
			d := -1
			switch {
			case c >= 'a' && c <= 'z':
				d = int(c - 'a')
			case c >= '0' && c <= '9':
				d = int(c-'0') + 26
			}
			if d < 0 || d > (wgPunyMax-i)/w {
				return nil, false
			}
			i += d * w
			t := wgPunyThreshold(k, bias)
			if d < t {
				break
			}
			if w > wgPunyMax/(wgPunyBase-t) {
				return nil, false
			}
			w *= wgPunyBase - t
		}
		count := len(values) + 1
		bias = wgPunyAdapt(i-old, count, old == 0)
		if i/count > wgPunyMax-n {
			return nil, false
		}
		n += i / count
		i %= count
		if n > unicode.MaxRune || (n >= 0xd800 && n <= 0xdfff) {
			return nil, false
		}
		values = append(values, rune(n))
		positions = append(positions, i)
		i++
	}
	// Place the last insertion first: it sits in the (position+1)-th free slot.
	total := len(values)
	tree := make([]int, total+1)
	for k := 1; k <= total; k++ {
		tree[k]++
		if parent := k + k&-k; parent <= total {
			tree[parent] += tree[k]
		}
	}
	top := 1
	for top*2 <= total {
		top *= 2
	}
	out := make([]rune, total)
	for k := total - 1; k >= 0; k-- {
		rank, slot := positions[k]+1, 0
		for step := top; step > 0; step /= 2 {
			if next := slot + step; next <= total && tree[next] < rank {
				slot = next
				rank -= tree[next]
			}
		}
		out[slot] = values[k]
		for j := slot + 1; j <= total; j += j & -j {
			tree[j]--
		}
	}
	return out, true
}

// wgJoinersValid is CheckJoiners (RFC 5892, appendix A): a ZWJ follows a
// virama; a ZWNJ follows a virama or joins two letters that connect across it.
func wgJoinersValid(label []rune) bool {
	for i, r := range label {
		if r != 0x200c && r != 0x200d {
			continue
		}
		if i > 0 && wgVirama(label[i-1]) {
			continue
		}
		if r == 0x200d {
			return false
		}
		j := i - 1
		for j >= 0 && wgJoiningType(label[j]) == 'T' {
			j--
		}
		if j < 0 {
			return false
		}
		if t := wgJoiningType(label[j]); t != 'L' && t != 'D' {
			return false
		}
		k := i + 1
		for k < len(label) && wgJoiningType(label[k]) == 'T' {
			k++
		}
		if k == len(label) {
			return false
		}
		if t := wgJoiningType(label[k]); t != 'R' && t != 'D' {
			return false
		}
	}
	return true
}

// wgVirama: Canonical_Combining_Class Virama.
func wgVirama(r rune) bool {
	switch r {
	case 0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd3b, 0xd3c, 0xd4d, 0xdca, 0xe3a, 0xeba, 0xf84,
		0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2, 0x1bf3, 0x2d7f,
		0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x11070, 0x1107f, 0x110b9,
		0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6,
		0x1172b, 0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34, 0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45,
		0x11d97, 0x11f41, 0x11f42:
		return true
	}
	return false
}

// wgJoiningType approximates the Arabic joining types: T for marks, R for
// the right-joining Arabic and Syriac letters, D for other letters of the
// joining scripts, U otherwise.
func wgJoiningType(r rune) byte {
	switch {
	case unicode.In(r, unicode.Mn, unicode.Me):
		return 'T'
	case r >= 0x622 && r <= 0x625, r == 0x627, r == 0x629, r >= 0x62f && r <= 0x632, r == 0x648,
		r >= 0x671 && r <= 0x673, r >= 0x675 && r <= 0x677, r >= 0x688 && r <= 0x699, r == 0x6c0,
		r >= 0x6c3 && r <= 0x6cb, r == 0x6cd, r == 0x6cf, r == 0x6d2, r == 0x6d3, r == 0x6d5, r == 0x6ee,
		r == 0x6ef, r >= 0x759 && r <= 0x75b, r == 0x76b, r == 0x76c, r == 0x771, r == 0x773, r == 0x774,
		r == 0x778, r == 0x779, r == 0x8aa, r == 0x8ab, r == 0x8ac, r == 0x8ae, r == 0x8b1, r == 0x8b2, r == 0x8b9,
		r == 0x710, r >= 0x715 && r <= 0x719, r == 0x71e, r == 0x728, r == 0x72a, r == 0x72c, r == 0x72f, r == 0x74d:
		return 'R'
	case r == 0x621 || r == 0x674:
		return 'U'
	case unicode.IsLetter(r) && unicode.In(r, unicode.Arabic, unicode.Syriac, unicode.Nko, unicode.Mongolian,
		unicode.Phags_Pa, unicode.Mandaic, unicode.Manichaean, unicode.Adlam, unicode.Hanifi_Rohingya,
		unicode.Sogdian, unicode.Psalter_Pahlavi):
		return 'D'
	}
	return 'U'
}

// Bidi classes CheckBidi distinguishes.
const (
	wgBidiL uint8 = iota
	wgBidiR
	wgBidiAL
	wgBidiAN
	wgBidiEN
	wgBidiES
	wgBidiCS
	wgBidiET
	wgBidiON
	wgBidiBN
	wgBidiNSM
)

// wgBidiClass approximates Bidi_Class from scripts and general categories.
func wgBidiClass(r rune) uint8 {
	if r < 0x80 {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			return wgBidiL
		case r >= '0' && r <= '9':
			return wgBidiEN
		case r == '+' || r == '-':
			return wgBidiES
		case r == ',' || r == '.' || r == '/' || r == ':':
			return wgBidiCS
		case r == '#' || r == '$' || r == '%':
			return wgBidiET
		case r < 0x20 || r == 0x7f:
			return wgBidiBN
		}
		return wgBidiON
	}
	switch {
	case unicode.In(r, unicode.Mn, unicode.Me):
		return wgBidiNSM
	case r >= 0x600 && r <= 0x605, r >= 0x660 && r <= 0x669, r == 0x66b, r == 0x66c, r == 0x6dd, r == 0x8e2,
		r >= 0x10d30 && r <= 0x10d39, r >= 0x10e60 && r <= 0x10e7e:
		return wgBidiAN
	case r >= 0x6f0 && r <= 0x6f9, r == 0xb2, r == 0xb3, r == 0xb9, r == 0x2070, r >= 0x2074 && r <= 0x2079,
		r >= 0x2080 && r <= 0x2089, r >= 0x2488 && r <= 0x249b, r >= 0x1d7ce && r <= 0x1d7ff:
		return wgBidiEN
	case r >= 0x600 && r <= 0x7bf, r >= 0x860 && r <= 0x8ff, r >= 0xfb50 && r <= 0xfdff, r >= 0xfe70 && r <= 0xfeff,
		r >= 0x10d00 && r <= 0x10d3f, r >= 0x10ec0 && r <= 0x10eff, r >= 0x10f30 && r <= 0x10f6f,
		r >= 0x1ee00 && r <= 0x1eeff:
		return wgBidiAL
	case r >= 0x590 && r <= 0x5ff, r >= 0x7c0 && r <= 0x85f, r >= 0xfb1d && r <= 0xfb4f,
		r >= 0x10800 && r <= 0x10fff, r >= 0x1e800 && r <= 0x1efff:
		return wgBidiR
	case unicode.In(r, unicode.L, unicode.Mc, unicode.Nd, unicode.Nl):
		return wgBidiL
	case unicode.Is(unicode.Sc, r) || r == 0xb0 || r == 0xb1:
		return wgBidiET
	case unicode.Is(unicode.Cf, r):
		return wgBidiBN
	}
	return wgBidiON
}

// wgBidiValid applies the six rules of RFC 5893, section 2, to a label of a
// domain that has right-to-left labels.
func wgBidiValid(label []rune) bool {
	if len(label) == 0 {
		return true
	}
	first := wgBidiClass(label[0])
	if first != wgBidiL && first != wgBidiR && first != wgBidiAL {
		return false
	}
	last := -1
	for i := len(label) - 1; i >= 0; i-- {
		if c := wgBidiClass(label[i]); c != wgBidiNSM {
			last = int(c)
			break
		}
	}
	if first == wgBidiL {
		for _, r := range label {
			switch wgBidiClass(r) {
			case wgBidiR, wgBidiAL, wgBidiAN:
				return false
			}
		}
		return last == int(wgBidiL) || last == int(wgBidiEN)
	}
	en, an := false, false
	for _, r := range label {
		switch wgBidiClass(r) {
		case wgBidiL:
			return false
		case wgBidiEN:
			en = true
		case wgBidiAN:
			an = true
		}
	}
	if en && an {
		return false
	}
	switch uint8(last) {
	case wgBidiR, wgBidiAL, wgBidiEN, wgBidiAN:
		return true
	}
	return false
}
