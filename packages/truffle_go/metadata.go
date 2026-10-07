package truffle

// Metadata from <head>, JSON-LD, microdata and well-known byline markup (metadata.ts).

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

type metadata struct {
	url string
	// Title as written in <title>/og:title, before cleaning. Used to recognise the in-page heading.
	rawTitles   []string
	subtitle    *string
	authors     []string
	siteName    *string
	publishedAt *string
	modifiedAt  *string
	language    *string
	dir         string // "ltr", "rtl" or "" (null)
	excerpt     *string
	leadImage   *Image
	favicon     *string
	// schema.org articleBody, when the page ships its text as structured data.
	articleBody *string
}

var articleTypes = map[string]bool{
	"article": true, "newsarticle": true, "blogposting": true, "techarticle": true, "scholarlyarticle": true, "report": true, "reportagenewsarticle": true,
	"analysisnewsarticle": true, "opinionnewsarticle": true, "reviewnewsarticle": true, "backgroundnewsarticle": true, "liveblogposting": true, "socialmediaposting": true, "discussionforumposting": true, "medicalscholarlyarticle": true, "advertisercontentarticle": true,
	"satiricalarticle": true, "askpublicnewsarticle": true, "review": true, "howto": true, "recipe": true, "creativework": true, "posting": true,
}

var (
	jsonLdCDataOpen  = jsRegexp(`^\s*\/\/\s*<!\[CDATA\[`, "")
	jsonLdCDataClose = jsRegexp(`\/\/\s*\]\]>\s*$`, "")
	trailingComma    = jsRegexp(`,\s*([}\]])`, "g")
)

// parseJSONLD is JSON.parse with the cleanup publishers' JSON-LD needs.
func parseJSONLD(source string) (any, bool) {
	text := jsTrim(source)
	text = strings.TrimPrefix(text, "<!--")
	text = strings.TrimSuffix(text, "-->")
	text = jsonLdCDataOpen.ReplaceAllLiteralString(text, "")
	text = jsonLdCDataClose.ReplaceAllLiteralString(text, "")
	if v, ok := jsonParse(text); ok {
		return v, true
	}
	// Common publisher mistakes: raw newlines in strings, trailing commas.
	var b strings.Builder
	b.Grow(len(text))
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c < 0x20 {
			for i+1 < len(text) && text[i+1] < 0x20 {
				i++
			}
			b.WriteByte(' ')
			continue
		}
		b.WriteByte(c)
	}
	fixed := trailingComma.ReplaceAllString(b.String(), "$1")
	return jsonParse(fixed)
}

func typesOf(node map[string]any) []string {
	switch t := node["@type"].(type) {
	case string:
		return []string{jsLower(t)}
	case []any:
		var out []string
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, jsLower(s))
			}
		}
		return out
	}
	return nil
}

func jsonObjects(value any, out []map[string]any, depth int) []map[string]any {
	if depth > 6 || value == nil {
		return out
	}
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			out = jsonObjects(item, out, depth+1)
		}
	case map[string]any:
		out = append(out, v)
		if graph, ok := v["@graph"]; ok {
			out = jsonObjects(graph, out, depth+1)
		}
		if main, ok := v["mainEntity"]; ok {
			switch main.(type) {
			case map[string]any, []any:
				out = jsonObjects(main, out, depth+1)
			}
		}
	}
	return out
}

// jstr is metadata.ts `str`: a collapsed non-empty string, or a number as JavaScript prints it.
func jstr(value any) *string {
	switch v := value.(type) {
	case string:
		s := collapse(decodeEntities(v))
		if s == "" {
			return nil
		}
		return &s
	case float64:
		s := jsNumberString(v)
		return &s
	}
	return nil
}

func names(value any, out []string) []string {
	switch v := value.(type) {
	case nil:
	case string:
		if s := jstr(v); s != nil {
			out = append(out, *s)
		}
	case []any:
		for _, item := range v {
			out = names(item, out)
		}
	case map[string]any:
		if n := jstr(v["name"]); n != nil {
			out = append(out, *n)
		} else {
			given := jstr(v["givenName"])
			family := jstr(v["familyName"])
			if given != nil || family != nil {
				g, f := "", ""
				if given != nil {
					g = *given
				}
				if family != nil {
					f = *family
				}
				out = append(out, collapse(g+" "+f))
			}
		}
	}
	return out
}

func imageURL(value any) *string {
	switch v := value.(type) {
	case string:
		s := jsTrim(v)
		if s == "" {
			return nil
		}
		return &s
	case []any:
		for _, item := range v {
			if u := imageURL(item); u != nil {
				return u
			}
		}
		return nil
	case map[string]any:
		if s := jstr(v["url"]); s != nil {
			return s
		}
		if s := jstr(v["contentUrl"]); s != nil {
			return s
		}
		return jstr(v["@id"])
	}
	return nil
}

// decodeEntities decodes the handful of entities publishers double-encode
// into metadata strings: `/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi`.
func decodeEntities(value string) string {
	amp := strings.IndexByte(value, '&')
	if amp < 0 {
		return value
	}
	var b strings.Builder
	b.Grow(len(value))
	last := 0
	for i := amp; i < len(value); i++ {
		if value[i] != '&' {
			continue
		}
		j := i + 1
		kind := 0 // 1 hex, 2 decimal, 3 name
		switch {
		case j+1 < len(value) && value[j] == '#' && (value[j+1] == 'x' || value[j+1] == 'X'):
			k := j + 2
			for k < len(value) && hexValue(value[k]) >= 0 {
				k++
			}
			if k > j+2 && k < len(value) && value[k] == ';' {
				kind = 1
				j = k
			} else {
				// `#x` without hex digits may still be... no: `#[0-9]+` needs a digit after '#'.
				kind = 0
			}
		case j < len(value) && value[j] == '#':
			k := j + 1
			for k < len(value) && value[k] >= '0' && value[k] <= '9' {
				k++
			}
			if k > j+1 && k < len(value) && value[k] == ';' {
				kind = 2
				j = k
			}
		default:
			k := j
			for k < len(value) && ((value[k] >= 'a' && value[k] <= 'z') || (value[k] >= 'A' && value[k] <= 'Z')) {
				k++
			}
			if k > j && k < len(value) && value[k] == ';' {
				kind = 3
				j = k
			}
		}
		if kind == 0 {
			continue
		}
		match := value[i : j+1]
		entity := value[i+1 : j]
		var replacement string
		replaced := false
		if kind == 3 {
			switch jsLower(entity) {
			case "amp":
				replacement, replaced = "&", true
			case "lt":
				replacement, replaced = "<", true
			case "gt":
				replacement, replaced = ">", true
			case "quot":
				replacement, replaced = "\"", true
			case "apos":
				replacement, replaced = "'", true
			case "nbsp":
				replacement, replaced = " ", true
			}
		} else {
			var code float64
			if kind == 1 {
				code = parseHexFloat(entity[2:])
			} else {
				code = jsParseInt(entity[1:])
			}
			if code > 0 && code <= 0x10ffff {
				replacement, replaced = codePointString(int(code)), true
			}
		}
		b.WriteString(value[last:i])
		if replaced {
			b.WriteString(replacement)
		} else {
			b.WriteString(match)
		}
		last = j + 1
		i = j
	}
	b.WriteString(value[last:])
	return b.String()
}

func parseHexFloat(s string) float64 {
	v := 0.0
	for i := 0; i < len(s); i++ {
		v = v*16 + float64(hexValue(s[i]))
	}
	return v
}

// codePointString is String.fromCodePoint for one code point (a lone surrogate becomes U+FFFD in UTF-8).
func codePointString(cp int) string {
	return string(rune(cp))
}

var months = map[string]int{
	"jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6,
	"jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11,
	"dec": 12, "december": 12,
}

func pad2(n int) string {
	if n < 10 && n >= 0 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

var (
	isoDate     = jsRegexp(`^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?`, "")
	compactDate = jsRegexp(`^(\d{4})(\d{2})(\d{2})(?:T?(\d{2})(\d{2})(\d{2})?)?$`, "")
	mdyDate     = jsRegexp(`([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})`, "")
	dmyDate     = jsRegexp(`(\d{1,2})(?:st|nd|rd|th)?\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})`, "")
)

// group is `m[k]`: the text of a capture group and whether it matched.
func group(s string, m []int, k int) (string, bool) {
	if m == nil || m[2*k] < 0 {
		return "", false
	}
	return s[m[2*k]:m[2*k+1]], true
}

// normalizeDate returns ISO 8601 when the value is (or plainly spells) a date; otherwise nil.
func normalizeDate(value *string) *string {
	if value == nil {
		return nil
	}
	v := jsTrim(*value)
	if m := isoDate.FindStringSubmatchIndex(v); m != nil {
		y, _ := group(v, m, 1)
		mo, _ := group(v, m, 2)
		d, _ := group(v, m, 3)
		date := y + "-" + mo + "-" + d
		h, ok := group(v, m, 4)
		if !ok {
			return &date
		}
		mi, _ := group(v, m, 5)
		sec, ok := group(v, m, 6)
		if !ok {
			sec = "00"
		}
		zone, _ := group(v, m, 7)
		if len(zone) == 5 {
			zone = zone[:3] + ":" + zone[3:]
		}
		out := date + "T" + h + ":" + mi + ":" + sec + zone
		return &out
	}
	if m := compactDate.FindStringSubmatchIndex(v); m != nil {
		y, _ := group(v, m, 1)
		mo, _ := group(v, m, 2)
		d, _ := group(v, m, 3)
		out := y + "-" + mo + "-" + d
		return &out
	}
	if m := mdyDate.FindStringSubmatchIndex(v); m != nil {
		name, _ := group(v, m, 1)
		if month, ok := months[jsLower(name)]; ok {
			day, _ := group(v, m, 2)
			year, _ := group(v, m, 3)
			out := year + "-" + pad2(month) + "-" + pad2(int(jsNumber(day)))
			return &out
		}
	}
	if m := dmyDate.FindStringSubmatchIndex(v); m != nil {
		name, _ := group(v, m, 2)
		if month, ok := months[jsLower(name)]; ok {
			day, _ := group(v, m, 1)
			year, _ := group(v, m, 3)
			out := year + "-" + pad2(month) + "-" + pad2(int(jsNumber(day)))
			return &out
		}
	}
	return nil
}

var metaLanguage = jsRegexp(`^\s*([A-Za-z]{2,3})(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z]{2}|\d{3}))?`, "")

// normalizeMetaLanguage is metadata.ts `normalizeLanguage` (a BCP 47 tag from lang attributes and metadata).
func normalizeMetaLanguage(value *string) *string {
	if value == nil {
		return nil
	}
	v := *value
	m := metaLanguage.FindStringSubmatchIndex(v)
	if m == nil {
		return nil
	}
	first, _ := group(v, m, 1)
	tag := jsLower(first)
	if script, ok := group(v, m, 2); ok {
		tag += "-" + asciiUpper(script[:1]) + jsLower(script[1:])
	}
	if region, ok := group(v, m, 3); ok {
		tag += "-" + asciiUpper(region)
	}
	return &tag
}

var (
	bylinePrefix  = jsRegexp(`^(?:by|written by|posted by|words by|author|authors|von|par|por|di|door|av|af|przez|автор|от|作者|著者|筆者|文|撰文|글|المؤلف|بقلم|מאת)(?:\s*[:：\-]\s*|\s+)`, "i")
	twoDigits     = jsRegexp(`\d{2,}`, "")
	authorJunk    = jsRegexp(`affiliation|email|e-mail|profile|follow|subscribe|message`, "i")
	httpScheme    = jsRegexp(`^https?:\/\/`, "i")
	authorTrailer = "|·•,"
)

func cleanAuthor(value string) *string {
	s := collapse(value)
	if loc := bylinePrefix.FindStringIndex(s); loc != nil {
		s = s[loc[1]:]
	}
	if httpScheme.MatchString(s) || strings.IndexByte(s, '@') >= 0 || twoDigits.MatchString(s) || authorJunk.MatchString(s) {
		return nil
	}
	if strings.Count(s, " ")+1 > 8 {
		return nil
	}
	// `.replace(/\s*[|·•,]\s*$/, '')`, without retrying `\s*` from every space of a long run.
	end := jsTrimEnd(s)
	if end != "" {
		r, size := utf8.DecodeLastRuneInString(end)
		if strings.ContainsRune(authorTrailer, r) {
			s = end[:len(end)-size]
		}
	}
	s = jsTrim(s)
	if n := u16len(s); n < 2 || n > 100 {
		return nil
	}
	return &s
}

// authorSeparatorAt matches `/\s*(?:,|;|\band\b|&|\bund\b|\bet\b|\by\b|،)\s*/y` at i; -1 when it does not.
func authorSeparatorAt(text string, i int) int {
	j := skipJSSpace(text, i)
	k := -1
	switch {
	case strings.HasPrefix(text[j:], ","), strings.HasPrefix(text[j:], ";"), strings.HasPrefix(text[j:], "&"):
		k = j + 1
	case strings.HasPrefix(text[j:], "،"):
		k = j + len("،")
	default:
		for _, w := range [...]string{"and", "und", "et", "y"} {
			if strings.HasPrefix(text[j:], w) && wordBoundary(text, j) && wordBoundary(text, j+len(w)) {
				k = j + len(w)
				break
			}
		}
	}
	if k < 0 {
		return -1
	}
	return skipJSSpace(text, k) - i
}

// wordBoundary is `\b` at byte offset i (ASCII word characters, as in JavaScript without the u flag).
func wordBoundary(text string, i int) bool {
	before := i > 0 && text[i-1] < 0x80 && isWordChar(rune(text[i-1]))
	after := i < len(text) && text[i] < 0x80 && isWordChar(rune(text[i]))
	return before != after
}

func skipJSSpace(text string, i int) int {
	for i < len(text) {
		c := text[i]
		if c < 0x80 {
			if c == ' ' || (c >= 0x09 && c <= 0x0d) {
				i++
				continue
			}
			return i
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if !isJSSpace(r) {
			return i
		}
		i += size
	}
	return i
}

// splitAtRuns is `text.split(separator)` for a sticky, group-free separator
// that opens with `\s*` or `\s+`: such a match never starts inside a run of
// whitespace, only where the run starts, so it is tried only there.
// matchAt returns the match length at a byte offset, or -1.
func splitAtRuns(text string, matchAt func(text string, i int) int) []string {
	var parts []string
	start := 0
	prevSpace := false
	for i := 0; i < len(text); {
		r, size := rune(text[i]), 1
		if r >= 0x80 {
			r, size = utf8.DecodeRuneInString(text[i:])
		}
		if i != start && prevSpace {
			prevSpace = isJSSpace(r)
			i += size
			continue
		}
		n := matchAt(text, i)
		if n <= 0 {
			prevSpace = isJSSpace(r)
			i += size
			continue
		}
		parts = append(parts, text[start:i])
		start = i + n
		i = start
		prevSpace = false
	}
	return append(parts, text[start:])
}

func addAuthors(raw []string, out []string) []string {
	for _, value := range raw {
		for _, part := range splitAtRuns(value, authorSeparatorAt) {
			name := cleanAuthor(part)
			if name == nil {
				continue
			}
			lower := jsLower(*name)
			dup := false
			for _, n := range out {
				if jsLower(n) == lower {
					dup = true
					break
				}
			}
			if !dup {
				out = append(out, *name)
			}
		}
	}
	return out
}

// hasHTTPPrefix is `/^https?:\/\//i`; it returns the length of the prefix (0 when absent).
func hasHTTPPrefix(url string) int {
	if len(url) >= 7 && strings.EqualFold(url[:7], "http://") {
		return 7
	}
	if len(url) >= 8 && strings.EqualFold(url[:8], "https://") {
		return 8
	}
	return 0
}

func isAbsoluteHTTP(url *string) bool {
	return url != nil && hasHTTPPrefix(*url) > 0
}

// hasUserinfo: userinfo (`https://user:pass@host/`) can dress any host up as another.
func hasUserinfo(url string) bool {
	p := hasHTTPPrefix(url)
	if p == 0 {
		return false
	}
	end := strings.IndexAny(url[p:], "/?#")
	rest := url[p:]
	if end >= 0 {
		rest = rest[:end]
	}
	return strings.IndexByte(rest, '@') >= 0
}

// httpHost is `/^https?:\/\/(?:[^/?#]*@)?([^/:?#]+)/i` group 1 ("" when it does not match).
func httpHost(u string) string {
	p := hasHTTPPrefix(u)
	if p == 0 {
		return ""
	}
	rest := u[p:]
	auth := rest
	if end := strings.IndexAny(rest, "/?#"); end >= 0 {
		auth = rest[:end]
	}
	hostAt := func(from int) string {
		end := strings.IndexAny(rest[from:], "/:?#")
		if end < 0 {
			return rest[from:]
		}
		return rest[from : from+end]
	}
	// The greedy userinfo group ends at the last '@' that leaves a non-empty host, else it is skipped.
	for at := strings.LastIndexByte(auth, '@'); at >= 0; at = strings.LastIndexByte(auth[:at], '@') {
		if h := hostAt(at + 1); h != "" {
			return h
		}
	}
	return hostAt(0)
}

func sameSite(a, b string) bool {
	host := func(u string) string {
		h := httpHost(u)
		if h == "" {
			return ""
		}
		parts := strings.Split(jsLower(h), ".")
		if len(parts) > 2 {
			parts = parts[len(parts)-2:]
		}
		return strings.Join(parts, ".")
	}
	ha := host(a)
	return ha != "" && ha == host(b)
}

// keepHTTPS: a canonical URL on the page's own host that only drops the https it was fetched over keeps https.
func keepHTTPS(url, pageURL string) string {
	if !(len(url) >= 7 && strings.EqualFold(url[:7], "http://")) || !(len(pageURL) >= 8 && strings.EqualFold(pageURL[:8], "https://")) {
		return url
	}
	host := func(u string) string {
		p := hasHTTPPrefix(u)
		rest := u[p:]
		if end := strings.IndexAny(rest, "/?#"); end >= 0 {
			rest = rest[:end]
		}
		return jsLower(rest)
	}
	if host(url) == host(pageURL) {
		return "https://" + url[7:]
	}
	return url
}

// pathOf is the path of an http(s) URL ("/" when empty).
func pathOf(url string) string {
	p := hasHTTPPrefix(url)
	if p == 0 {
		return "/"
	}
	rest := url[p:]
	// [^/?#]+ needs at least one character.
	end := strings.IndexAny(rest, "/?#")
	if end == 0 || rest == "" {
		return "/"
	}
	if end < 0 {
		return "/"
	}
	path := rest[end:]
	if q := strings.IndexAny(path, "?#"); q >= 0 {
		path = path[:q]
	}
	if path == "" {
		return "/"
	}
	return path
}

// readMetadata reads metadata from <head>, JSON-LD, microdata and well-known byline markup.
func readMetadata(doc *Document, pageURL string) *metadata {
	meta := map[string]string{}
	var links []*Node
	var titleTag *string

	readMeta := func(el *Node) {
		switch el.Tag {
		case "meta":
			var key string
			for _, name := range [...]string{"property", "name", "itemprop", "http-equiv"} {
				if v, ok := el.attr(name); ok {
					key = v
					break
				}
			}
			key = jsTrim(jsLower(key))
			content, ok := el.attr("content")
			if key != "" && ok && !isBlank(content) {
				if _, seen := meta[key]; !seen {
					meta[key] = collapse(decodeEntities(content))
				}
			}
		case "link":
			links = append(links, el)
		case "title":
			if titleTag == nil {
				t := textOf(el)
				titleTag = &t
			}
		}
	}
	if doc.Head != nil {
		walkAll(doc.Head, readMeta)
	}
	bodyMeta := func(el *Node) {
		if el.Tag == "meta" || el.Tag == "link" {
			readMeta(el)
		} else if el.Tag == "title" && titleTag == nil {
			t := textOf(el)
			titleTag = &t
		}
	}
	if doc.hasBodyMeta {
		for _, el := range doc.bodyMeta {
			bodyMeta(el)
		}
	} else {
		walkAll(doc.Body, bodyMeta)
	}

	// JSON-LD: the article node, plus the page's publisher.
	var article, webPage map[string]any
	var siteNode *string
	siteNodeSet := false
	for _, source := range doc.JSONLD {
		parsed, ok := parseJSONLD(source)
		if !ok {
			continue
		}
		objects := jsonObjects(parsed, nil, 0)
		for _, obj := range objects {
			types := typesOf(obj)
			if article == nil && anyOf(types, func(t string) bool { return articleTypes[t] }) {
				article = obj
			} else if webPage == nil && anyOf(types, func(t string) bool {
				return t == "webpage" || t == "itempage" || t == "aboutpage" || t == "collectionpage"
			}) {
				webPage = obj
			}
			if !siteNodeSet && anyOf(types, func(t string) bool { return t == "website" || t == "organization" || t == "newsmediaorganization" }) {
				siteNode = jstr(obj["name"])
				siteNodeSet = siteNode != nil
			}
		}
	}
	ld := article
	if ld == nil {
		ld = webPage
	}

	m := func(key string) *string {
		if v, ok := meta[key]; ok {
			return &v
		}
		return nil
	}
	ldStr := func(key string) *string {
		if ld == nil {
			return nil
		}
		return jstr(ld[key])
	}

	// Site name.
	var publisher *string
	if ld != nil {
		if p, ok := ld["publisher"].(map[string]any); ok {
			publisher = jstr(p["name"])
		}
	}
	titleForSite := titleTag
	if titleForSite == nil {
		titleForSite = m("og:title")
	}
	siteName := firstNonNil(m("og:site_name"), titleSite(titleForSite, pageURL), publisher, siteNode, m("application-name"), m("apple-mobile-web-app-title"), m("twitter:site:name"))

	// Authors.
	var rawAuthors []string
	if ld != nil {
		rawAuthors = names(ld["author"], rawAuthors)
	}
	if len(rawAuthors) == 0 && ld != nil {
		rawAuthors = names(ld["creator"], rawAuthors)
	}
	for _, key := range [...]string{"author", "article:author", "parsely-author", "sailthru.author", "dc.creator", "dcterms.creator", "byl", "twitter:creator:name", "citation_author"} {
		if len(rawAuthors) > 0 {
			break
		}
		if v := m(key); v != nil {
			rawAuthors = append(rawAuthors, *v)
		}
	}
	if len(rawAuthors) == 0 {
		if found := findByline(doc.Body); found != nil {
			rawAuthors = append(rawAuthors, *found)
		}
	}
	authors := addAuthors(rawAuthors, []string{})
	if siteName != nil {
		site := jsLower(*siteName)
		for i := len(authors) - 1; i >= 0; i-- {
			if jsLower(authors[i]) == site {
				authors = append(authors[:i], authors[i+1:]...)
			}
		}
	}

	// Dates.
	published := normalizeDate(firstNonNil(ldStr("datePublished"), ldStr("dateCreated")))
	for _, key := range [...]string{"article:published_time", "og:article:published_time", "published_time", "datepublished", "pubdate", "publishdate", "publish-date", "date", "dc.date.issued", "dc.date", "dcterms.created", "parsely-pub-date", "sailthru.date", "citation_publication_date", "citation_date", "article.published", "og:updated_time"} {
		if published != nil {
			break
		}
		published = normalizeDate(m(key))
	}
	if published == nil {
		published = findTime(doc.Body)
	}
	modified := normalizeDate(firstNonNil(ldStr("dateModified"), m("article:modified_time"), m("og:updated_time"), m("datemodified"), m("dcterms.modified")))

	// Title.
	var rawTitles []string
	for _, t := range [...]*string{m("og:title"), ldStr("headline"), m("twitter:title"), titleTag, ldStr("name"), m("dc.title"), m("citation_title"), m("parsely-title"), m("sailthru.title")} {
		if t != nil && *t != "" && !containsString(rawTitles, *t) {
			rawTitles = append(rawTitles, decodeEntities(*t))
		}
	}

	// Language and direction.
	htmlLang := doc.Root.attrPtr("lang")
	if htmlLang == nil {
		htmlLang = doc.Root.attrPtr("xml:lang")
	}
	if htmlLang == nil {
		htmlLang = doc.Body.attrPtr("lang")
	}
	language := normalizeMetaLanguage(firstNonNil(htmlLang, m("content-language"), m("og:locale"), ldStr("inLanguage"), m("language"), m("dc.language")))
	dirAttr := doc.Root.attrPtr("dir")
	if dirAttr == nil {
		dirAttr = doc.Body.attrPtr("dir")
	}
	dir := ""
	if dirAttr != nil {
		switch jsLower(*dirAttr) {
		case "rtl":
			dir = "rtl"
		case "ltr":
			dir = "ltr"
		}
	}

	// Canonical URL.
	url := CanonicalURL(pageURL)
	var canonicalHref *string
	for _, l := range links {
		if hasTokenFold(l.av("rel"), "canonical") {
			if href, ok := l.attr("href"); ok && href != "" {
				canonicalHref = &href
				break
			}
		}
	}
	for _, candidate := range [...]*string{canonicalHref, m("og:url")} {
		if candidate == nil {
			continue
		}
		abs, ok := resolveURL(*candidate, pageURL)
		if ok && isAbsoluteHTTP(&abs) && !hasUserinfo(abs) && sameSite(abs, pageURL) && !(pathOf(abs) == "/" && pathOf(pageURL) != "/") {
			url = keepHTTPS(CanonicalURL(abs), pageURL)
			break
		}
	}

	// Lead image.
	var leadImage *Image
	imageCandidate := firstNonNil(m("og:image:secure_url"), m("og:image"), m("og:image:url"), m("twitter:image"), m("twitter:image:src"))
	if imageCandidate == nil && ld != nil {
		imageCandidate = firstNonNil(imageURL(ld["image"]), imageURL(ld["thumbnailUrl"]))
	}
	if imageCandidate == nil {
		for _, l := range links {
			if jsLower(l.av("rel")) == "image_src" {
				imageCandidate = l.attrPtr("href")
				break
			}
		}
	}
	if imageCandidate == nil {
		imageCandidate = m("thumbnail")
	}
	if imageCandidate != nil {
		if src, ok := resolveURL(*imageCandidate, pageURL); ok && isAbsoluteHTTP(&src) {
			alt := firstNonNil(m("og:image:alt"), m("twitter:image:alt"))
			leadImage = &Image{Src: src}
			if alt != nil {
				leadImage.Alt = *alt
			}
			w := jsNumber(derefOr(m("og:image:width"), ""))
			h := jsNumber(derefOr(m("og:image:height"), ""))
			if w > 0 && h > 0 && jsIsInteger(w) && jsIsInteger(h) {
				leadImage.Width = int(w)
				leadImage.Height = int(h)
			}
		}
	}

	// Favicon: the largest declared icon; apple-touch icons are usually 180px.
	var favicon *string
	best := -1.0
	for _, l := range links {
		rel := jsLower(l.av("rel"))
		href, ok := l.attr("href")
		if !ok || href == "" || !(hasToken(rel, "icon") || hasToken(rel, "apple-touch-icon") || hasToken(rel, "apple-touch-icon-precomposed")) {
			continue
		}
		var size float64
		if n, ok := iconSize(l.av("sizes")); ok {
			size = jsNumber(n)
		} else if strings.Contains(rel, "apple-touch-icon") {
			size = 180
		} else {
			size = 16
		}
		if hasSVGExtension(href) || l.attrIs("type", "image/svg+xml") {
			size = 120
		}
		if size > 256 {
			size = 64
		}
		abs, ok := resolveURL(href, pageURL)
		if ok && isAbsoluteHTTP(&abs) && size > best {
			best = size
			a := abs
			favicon = &a
		}
	}
	if favicon == nil {
		if p := hasHTTPPrefix(pageURL); p > 0 {
			rest := pageURL[p:]
			end := strings.IndexAny(rest, "/?#")
			if end < 0 {
				end = len(rest)
			}
			if end > 0 {
				f := pageURL[:p+end] + "/favicon.ico"
				favicon = &f
			}
		}
	}

	description := firstNonNil(m("og:description"), m("description"), m("twitter:description"), ldStr("description"), m("dc.description"))
	var articleBody *string
	if article != nil {
		if s, ok := article["articleBody"].(string); ok {
			articleBody = &s
		}
	}

	subtitle := ldStr("alternativeHeadline")
	if subtitle == nil {
		subtitle = findDek(doc.Body, description)
	}
	if siteName != nil {
		s := decodeEntities(*siteName)
		siteName = &s
	}
	return &metadata{
		url:         url,
		rawTitles:   rawTitles,
		subtitle:    subtitle,
		authors:     authors,
		siteName:    siteName,
		publishedAt: published,
		modifiedAt:  modified,
		language:    language,
		dir:         dir,
		excerpt:     description,
		leadImage:   leadImage,
		favicon:     favicon,
		articleBody: articleBody,
	}
}

// iconSize is `/(?:^|\D)(\d+)x\d+/.exec(sizes)?.[1]`: from the start of a number only.
func iconSize(s string) (string, bool) {
	try := func(q int) (string, bool) {
		j := q
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		if j > q && j+1 < len(s) && s[j] == 'x' && s[j+1] >= '0' && s[j+1] <= '9' {
			return s[q:j], true
		}
		return "", false
	}
	for p := 0; p < len(s); p++ {
		if p == 0 && s[0] >= '0' && s[0] <= '9' {
			if n, ok := try(0); ok {
				return n, true
			}
			continue
		}
		if !(s[p] >= '0' && s[p] <= '9') {
			if n, ok := try(p + 1); ok {
				return n, true
			}
		}
	}
	return "", false
}

// hasSVGExtension is `/\.svg(?:$|\?)/i`.
func hasSVGExtension(s string) bool {
	for i := 0; i+4 <= len(s); i++ {
		if s[i] == '.' && strings.EqualFold(s[i+1:i+4], "svg") && (i+4 == len(s) || s[i+4] == '?') {
			return true
		}
	}
	return false
}

// hasTokenFold is `/(?:^|\s)word(?:\s|$)/i`.
func hasTokenFold(s, word string) bool {
	for _, t := range splitJSSpace(s) {
		if strings.EqualFold(t, word) && len(t) == len(word) {
			return true
		}
	}
	return false
}

func anyOf(list []string, test func(string) bool) bool {
	for _, s := range list {
		if test(s) {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// firstNonNil is `a ?? b ?? ...`.
func firstNonNil(values ...*string) *string {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func derefOr(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

// titleSeparatorAt matches `/\s+[|\-–—·•»]\s+/y` at i.
func titleSiteSeparatorAt(text string, i int) int {
	j := skipJSSpace(text, i)
	if j == i || j >= len(text) {
		return -1
	}
	r, size := utf8.DecodeRuneInString(text[j:])
	if !strings.ContainsRune("|-–—·•»", r) {
		return -1
	}
	k := skipJSSpace(text, j+size)
	if k == j+size {
		return -1
	}
	return k - i
}

// titleSite: "Story - Wikipedia" on en.wikipedia.org: the last title segment, when it names the host.
func titleSite(title *string, pageURL string) *string {
	if title == nil {
		return nil
	}
	parts := splitAtRuns(collapse(decodeEntities(*title)), titleSiteSeparatorAt)
	if len(parts) < 2 {
		return nil
	}
	last := parts[len(parts)-1]
	var key strings.Builder
	for _, r := range jsLower(last) {
		if isLetterOrNumber(r) {
			key.WriteRune(r)
		}
	}
	k := key.String()
	if u16len(k) < 3 || u16len(last) > 40 {
		return nil
	}
	host := ""
	if p := hasHTTPPrefix(pageURL); p > 0 {
		rest := pageURL[p:]
		end := strings.IndexAny(rest, "/:?#")
		if end < 0 {
			end = len(rest)
		}
		if end > 0 {
			var h strings.Builder
			for _, c := range []byte(jsLower(rest[:end])) {
				if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
					h.WriteByte(c)
				}
			}
			host = h.String()
		}
	}
	if strings.Contains(host, k) {
		return &last
	}
	return nil
}

var (
	bylineClass = newClassPattern(`(?:^|[\s_-])(?:byline|by-line|author|authors|author-name|authorname|writer|contributor|byline__name|post-author|entry-author|article-author|meta-author|c-byline)(?:$|[\s_-])`)
	bylineName  = newClassPattern(`(?:^|[\s_-])(?:name|username|user-name|author-name|authorname|fn|byline__name|ltx_personname|nickname)(?:$|[\s_-])`)
	fourDigits  = jsRegexp(`\d{4}`, "")
	dekClass    = newClassPattern(`(?:^|[\s_-])(?:subtitle|sub-title|subhead|subheading|subheadline|dek|deck|standfirst|strapline|tagline|article-summary|post-subtitle|lede)(?:$|[\s_-])`)
)

func findByline(body *Node) *string {
	var found *string
	walk(body, func(el *Node) bool {
		if found != nil {
			return false
		}
		rel, hasRel := el.attr("rel")
		itemprop, hasItemprop := el.attr("itemprop")
		isAuthor := (hasRel && hasToken(rel, "author")) || (hasItemprop && hasToken(itemprop, "author")) || bylineClass.matchEl(el)
		if !isAuthor {
			return true
		}
		// Prefer the name inside a byline widget (avatar, karma and buttons are not the name).
		target := el
		walk(el, func(child *Node) bool {
			if target != el {
				return false
			}
			if child != el && (child.attrIs("itemprop", "name") || bylineName.matchEl(child)) {
				target = child
				return false
			}
			return true
		})
		var text strings.Builder
		for _, child := range target.Children {
			if child.Kind == ElementNode && (child.Tag == "br" || child.Tag == "div" || child.Tag == "p") {
				if !isBlank(text.String()) {
					break
				}
				continue
			}
			if child.Kind == TextNode {
				text.WriteString(child.text)
			} else {
				text.WriteString(textOf(child))
				text.WriteByte(' ')
			}
		}
		t := collapse(text.String())
		if n := u16len(t); n > 1 && n < 100 && !fourDigits.MatchString(t) && cleanAuthor(t) != nil {
			found = &t
		}
		return found == nil
	})
	return found
}

// findDek: the standfirst under the headline: among the first elements after
// the h1, one marked as a subtitle/dek, or one whose text is the page description.
func findDek(body *Node, description *string) *string {
	want := ""
	if description != nil {
		want = jsLower(collapse(*description))
	}
	seenH1 := false
	after := 0
	var found *string
	walk(body, func(el *Node) bool {
		if found != nil || after > 40 {
			return false
		}
		if el.Tag == "h1" {
			if seenH1 {
				after = 41
				return false
			}
			seenH1 = true
			return false
		}
		if !seenH1 {
			return true
		}
		after++
		dek := dekClass.matchEl(el)
		// A plain paragraph equal to the description is the article's own first paragraph, not a dek.
		if (el.Tag == "p" || el.Tag == "h2" || el.Tag == "div" || el.Tag == "span") && (dek || el.Tag != "p" && want != "" && isLeafText(el)) {
			text := collapse(textOf(el))
			if n := u16len(text); n >= 10 && n <= 300 && (dek || jsLower(text) == want) {
				found = &text
				return false
			}
		}
		return true
	})
	return found
}

// isLeafText: no block-level element inside (a dek is one run of text).
func isLeafText(el *Node) bool {
	for _, child := range el.Children {
		if child.Kind == ElementNode {
			switch child.Tag {
			case "div", "p", "section", "article", "ul", "ol", "figure", "table":
				return false
			}
		}
	}
	return true
}

func findTime(body *Node) *string {
	var found *string
	walk(body, func(el *Node) bool {
		if found != nil {
			return false
		}
		if el.attrIs("itemprop", "datePublished") {
			v := firstNonNil(el.attrPtr("datetime"), el.attrPtr("content"))
			if v == nil {
				t := textOf(el)
				v = &t
			}
			found = normalizeDate(v)
		} else if el.Tag == "time" {
			v := el.attrPtr("datetime")
			if v == nil {
				t := textOf(el)
				v = &t
			}
			found = normalizeDate(v)
		}
		return found == nil
	})
	return found
}
