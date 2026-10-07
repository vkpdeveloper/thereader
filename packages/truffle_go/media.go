package truffle

// Images, players and embeds (media.ts).

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// isWordOrDash is `[\w-]`.
func isWordOrDash(c byte) bool {
	return c == '-' || c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

var placeholderWords = []string{"placeholder", "blank", "spacer", "transparent", "pixel", "lazyload", "lazy-load", "lazy_load", "1x1", "grey", "gray", "loading", "empty", "dummy", "lqip", "blur"}

// isPlaceholderSrc: placeholder sources lazy loaders put in `src` until the
// real image scrolls into view — a data: GIF/PNG/SVG, or a file name holding
// one of the words. This is
// `/(?:^data:image\/(?:gif|png|svg\+xml)[;,])|(?:^|[^\w-])(?=[\w-]*\.(?:gif|png|svg|jpe?g|webp)(?:$|\?))[\w-]*?(?:placeholder|…)/i`:
// a name (a run of `[\w-]`) followed by an image extension and the end or a
// query, holding one of the words.
func isPlaceholderSrc(v string) bool {
	if hasPrefixFold(v, "data:image/") {
		rest := v[len("data:image/"):]
		for _, t := range [...]string{"gif", "png", "svg+xml"} {
			if hasPrefixFold(rest, t) && len(rest) > len(t) && (rest[len(t)] == ';' || rest[len(t)] == ',') {
				return true
			}
		}
	}
	for q := 0; q < len(v); {
		if q > 0 && isWordOrDash(v[q-1]) {
			q++
			continue
		}
		end := q
		for end < len(v) && isWordOrDash(v[end]) {
			end++
		}
		if end > q && end < len(v) && v[end] == '.' && imageExtThenEnd(v[end+1:]) {
			name := strings.ToLower(v[q:end])
			for _, w := range placeholderWords {
				if strings.Contains(name, w) {
					return true
				}
			}
		}
		if end > q {
			q = end
		} else {
			q++
		}
	}
	return false
}

// imageExtThenEnd is `(?:gif|png|svg|jpe?g|webp)(?:$|\?)` at the start of s.
func imageExtThenEnd(s string) bool {
	for _, ext := range [...]string{"gif", "png", "svg", "jpg", "jpeg", "webp"} {
		if hasPrefixFold(s, ext) && (len(s) == len(ext) || s[len(ext)] == '?') {
			return true
		}
	}
	return false
}

// Attributes lazy loaders use for the real source, most specific first.
var lazySrc = []string{
	"data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src", "data-full-src", "data-original-src",
	"data-src-large", "data-large-src", "data-src-medium", "data-actualsrc", "data-echo", "data-img-src", "data-image", "data-pin-media",
	"data-orig-file", "data-large-file", "data-medium-file", "data-fallback-src", "data-delayed-url", "data-native-src", "data-zoom-src",
}

var lazySrcset = []string{"data-srcset", "data-lazy-srcset", "data-original-srcset", "data-src-set"}

// hasImageExt is `/\.(?:jpe?g|png|webp|gif|avif|bmp|svg|jxl|heic)(?:$|[?#])/i`.
func hasImageExt(s string) bool {
	for i := strings.IndexByte(s, '.'); i >= 0; {
		rest := s[i+1:]
		for _, ext := range [...]string{"jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg", "jxl", "heic"} {
			if hasPrefixFold(rest, ext) && (len(rest) == len(ext) || rest[len(ext)] == '?' || rest[len(ext)] == '#') {
				return true
			}
		}
		next := strings.IndexByte(rest, '.')
		if next < 0 {
			break
		}
		i += 1 + next
	}
	return false
}

type candidate struct {
	url     string
	width   float64
	density float64
}

// isJSSpaceAt reports whether the character at byte offset i is JavaScript whitespace, and its size.
func jsSpaceAt(s string, i int) (bool, int) {
	c := s[i]
	if c < 0x80 {
		return c == ' ' || (c >= 0x09 && c <= 0x0d), 1
	}
	r, size := utf8.DecodeRuneInString(s[i:])
	return isJSSpace(r), size
}

var safeDataImage = jsRegexp(`^data:image\/(?:jpe?g|png|webp|gif)[;,]`, "i")

// parseSrcset parses a srcset the way browsers do: URLs may contain commas, descriptors follow whitespace.
func parseSrcset(value, base string) []candidate {
	var out []candidate
	i := 0
	n := len(value)
	for i < n {
		for i < n {
			if value[i] == ',' {
				i++
				continue
			}
			if sp, size := jsSpaceAt(value, i); sp {
				i += size
				continue
			}
			break
		}
		if i >= n {
			break
		}
		start := i
		for i < n {
			if sp, _ := jsSpaceAt(value, i); sp {
				break
			}
			_, size := jsSpaceAt(value, i)
			i += size
		}
		url := value[start:i]
		descriptor := ""
		if strings.HasSuffix(url, ",") {
			end := len(url) - 1
			for end > 0 && url[end-1] == ',' {
				end--
			}
			url = url[:end]
		} else {
			start = i
			for i < n && value[i] != ',' {
				i++
			}
			descriptor = jsTrim(value[start:i])
		}
		abs, ok := resolveURL(url, base)
		if !ok || (!(hasPrefixFold(abs, "http:") || hasPrefixFold(abs, "https:")) && !safeDataImage.MatchString(abs)) {
			continue
		}
		width := 0.0
		density := 1.0
		// From the start of a number only (from every digit, a long one is rescanned to its end).
		if w, ok := numberBefore(descriptor, 'w', false); ok {
			width = jsNumber(w)
		} else if x, ok := numberBefore(descriptor, 'x', true); ok {
			density = jsNumber(x)
			if density == 0 || density != density {
				density = 1
			}
		}
		out = append(out, candidate{abs, width, density})
	}
	return out
}

// numberBefore is `/(?:^|\D)(\d+)w/` (dots false) or `/(?:^|[^\d.])([\d.]+)x/` (dots true): group 1.
func numberBefore(s string, suffix byte, dots bool) (string, bool) {
	isNum := func(c byte) bool { return (c >= '0' && c <= '9') || (dots && c == '.') }
	try := func(q int) (string, bool) {
		j := q
		for j < len(s) && isNum(s[j]) {
			j++
		}
		if j > q && j < len(s) && s[j] == suffix {
			return s[q:j], true
		}
		return "", false
	}
	for p := 0; p < len(s); p++ {
		if p == 0 && isNum(s[0]) {
			if v, ok := try(0); ok {
				return v, true
			}
			continue
		}
		if !isNum(s[p]) {
			// A multi-byte character is one `\D`; its continuation bytes are never digits.
			if v, ok := try(p + 1); ok {
				return v, true
			}
		}
	}
	return "", false
}

// bestCandidate: the largest candidate up to 1600px wide (or 2x), else the smallest above that.
func bestCandidate(candidates []candidate) *candidate {
	if len(candidates) == 0 {
		return nil
	}
	var byWidth []*candidate
	for i := range candidates {
		if candidates[i].width > 0 {
			byWidth = append(byWidth, &candidates[i])
		}
	}
	if len(byWidth) > 0 {
		var best *candidate
		for _, c := range byWidth {
			if c.width <= 1600 && (best == nil || c.width > best.width) {
				best = c
			}
		}
		if best != nil {
			return best
		}
		for _, c := range byWidth {
			if best == nil || c.width < best.width {
				best = c
			}
		}
		return best
	}
	var best *candidate
	for i := range candidates {
		c := &candidates[i]
		if c.density <= 2 && (best == nil || c.density > best.density) {
			best = c
		}
	}
	if best == nil {
		return &candidates[0]
	}
	return best
}

func normalizeSrcset(candidates []candidate) string {
	if len(candidates) < 2 {
		return ""
	}
	var parts []string
	for _, c := range candidates {
		if strings.HasPrefix(c.url, "data:") {
			continue
		}
		if c.width > 0 {
			parts = append(parts, c.url+" "+jsNumberString(c.width)+"w")
		} else {
			parts = append(parts, c.url+" "+jsNumberString(c.density)+"x")
		}
	}
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts, ", ")
}

// dimension is a positive pixel size below 20000 from `^\s*(\d+)(?:\.\d+)?\s*(?:px\s*)?$`, or 0.
func dimension(value string, ok bool) int {
	if !ok {
		return 0
	}
	i := skipJSSpace(value, 0)
	start := i
	for i < len(value) && value[i] >= '0' && value[i] <= '9' {
		i++
	}
	if i == start {
		return 0
	}
	digits := value[start:i]
	if i+1 < len(value) && value[i] == '.' && value[i+1] >= '0' && value[i+1] <= '9' {
		i++
		for i < len(value) && value[i] >= '0' && value[i] <= '9' {
			i++
		}
	}
	i = skipJSSpace(value, i)
	if strings.HasPrefix(value[i:], "px") {
		i = skipJSSpace(value, i+2)
	}
	if i != len(value) {
		return 0
	}
	n := jsNumber(digits)
	if n > 0 && n < 20000 {
		return int(n)
	}
	return 0
}

func attrDimension(el *Node, name string) int {
	v, ok := el.attr(name)
	return dimension(v, ok)
}

var base64Image = jsRegexp(`^data:image\/(?:jpe?g|png|webp|gif);base64,`, "i")

func usableSrc(value string, ok bool, base string) (string, bool) {
	if !ok {
		return "", false
	}
	v := jsTrim(value)
	if v == "" || isPlaceholderSrc(v) {
		return "", false
	}
	if hasPrefixFold(v, "data:") {
		if base64Image.MatchString(v) && u16len(v) > 2000 {
			return v, true
		}
		return "", false
	}
	return resolveHTTP(v, base)
}

func pictureSources(picture *Node, base string) []candidate {
	for _, source := range picture.Children {
		if source.Kind != ElementNode || source.Tag != "source" {
			continue
		}
		typ := jsLower(source.av("type"))
		if typ == "image/avif" || typ == "image/jxl" {
			continue
		}
		media := source.av("media")
		if strings.Contains(media, "max-width") && !strings.Contains(media, "min-width") {
			continue
		}
		set := source.attrPtr("srcset")
		if set == nil {
			set = source.attrPtr("data-srcset")
		}
		if set == nil {
			set = source.attrPtr("data-src")
		}
		if set != nil {
			if candidates := parseSrcset(*set, base); len(candidates) > 0 {
				return candidates
			}
		}
	}
	return nil
}

var (
	trackingPixel  = jsRegexp(`[/.](?:pixel|beacon|tracking|tracker|spacer)[/.]|\/(?:ads?|pagead)\/`, "i")
	placeholderAlt = jsRegexp(`^\[?(?:uncaptioned image|refer to caption|image|img|photo|picture|untitled|placeholder|alt text|null|undefined)\]?$|^[\w%~+-]+\.(?:jpe?g|png|gif|webp|svg|avif)$`, "i")
	srcsetLike     = jsRegexp(`\.(?:jpe?g|png|webp)\s+\d+[wx]`, "i")
)

// jsKeyOrder is `for (const key in attrs)` order: array-index names first, ascending, then the rest in order.
func jsKeyOrder(attrs []Attr) []Attr {
	indexed := false
	for _, a := range attrs {
		if isArrayIndex(a.Name) {
			indexed = true
			break
		}
	}
	if !indexed {
		return attrs
	}
	var idx, rest []Attr
	for _, a := range attrs {
		if isArrayIndex(a.Name) {
			idx = append(idx, a)
		} else {
			rest = append(rest, a)
		}
	}
	for i := 1; i < len(idx); i++ {
		for j := i; j > 0 && arrayIndexLess(idx[j].Name, idx[j-1].Name); j-- {
			idx[j], idx[j-1] = idx[j-1], idx[j]
		}
	}
	return append(idx, rest...)
}

func isArrayIndex(key string) bool {
	if key == "" || len(key) > 10 {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return false
		}
	}
	if len(key) > 1 && key[0] == '0' {
		return false
	}
	return jsNumber(key) < 4294967295
}

func arrayIndexLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

func linkAround(img *Node) *Node {
	if img.Parent != nil && img.Parent.Tag == "a" {
		return img.Parent
	}
	if img.Parent != nil && img.Parent.Parent != nil && img.Parent.Parent.Tag == "a" {
		return img.Parent.Parent
	}
	return nil
}

// imageFrom is the image an <img> really shows, resolving lazy loading,
// srcset and <picture>; nil for placeholders and tracking pixels.
func imageFrom(img *Node, base string) *Image {
	srcVal, srcOk := img.attr("src")
	src, hasSrc := usableSrc(srcVal, srcOk, base)
	var candidates []candidate
	for _, key := range lazySrcset {
		if v, ok := img.attr(key); ok {
			candidates = parseSrcset(v, base)
			if len(candidates) > 0 {
				break
			}
		}
	}
	if len(candidates) == 0 {
		if v, ok := img.attr("srcset"); ok {
			candidates = parseSrcset(v, base)
		}
	}
	if len(candidates) == 0 && img.Parent != nil && img.Parent.Tag == "picture" {
		candidates = pictureSources(img.Parent, base)
	}

	lazy, hasLazy := "", false
	for _, key := range lazySrc {
		v, ok := img.attr(key)
		lazy, hasLazy = usableSrc(v, ok, base)
		if hasLazy {
			break
		}
	}
	if !hasLazy && !hasSrc && len(candidates) == 0 {
		// Unknown lazy attribute holding an image URL.
		for _, a := range jsKeyOrder(img.Attrs) {
			switch a.Name {
			case "src", "srcset", "alt", "class", "style":
				continue
			}
			value := a.Value
			if hasImageExt(value) && !containsJSSpace(jsTrim(value)) {
				lazy, hasLazy = usableSrc(value, true, base)
				if hasLazy {
					break
				}
			} else if srcsetLike.MatchString(value) {
				candidates = parseSrcset(value, base)
				if len(candidates) > 0 {
					break
				}
			}
		}
	}

	best := bestCandidate(candidates)
	// A real src paired with a srcset: prefer the larger srcset entry; lazy attributes beat a placeholder src.
	var chosen string
	switch {
	case best != nil && (best.width >= 600 || !hasSrc):
		chosen = best.url
	case hasLazy:
		chosen = lazy
	case hasSrc:
		chosen = src
	case best != nil:
		chosen = best.url
	default:
		return nil
	}
	src = chosen

	width := attrDimension(img, "width")
	if width == 0 {
		width = attrDimension(img, "data-width")
	}
	height := attrDimension(img, "height")
	if height == 0 {
		height = attrDimension(img, "data-height")
	}
	if (width != 0 && width <= 2) || (height != 0 && height <= 2) {
		return nil
	}
	if trackingPixelGate.open(src) && trackingPixel.MatchString(src) {
		return nil
	}

	altSource := img.attrPtr("alt")
	if altSource == nil {
		altSource = img.attrPtr("title")
	}
	alt := ""
	if altSource != nil {
		alt = collapse(*altSource)
	}
	// Generator placeholders ("[Uncaptioned image]", "Refer to caption") and file names describe nothing.
	if alt != "" && (len(alt) <= 24 || strings.IndexByte(alt, '.') >= 0) && placeholderAlt.MatchString(alt) {
		alt = ""
	}
	image := &Image{Src: src, Alt: alt}
	if width != 0 && height != 0 {
		image.Width = width
		image.Height = height
	}
	// A density srcset ("a@2x.png 2x") leaves the 1x image in src.
	if len(candidates) > 0 {
		allDensity, hasOne, srcListed := true, false, false
		for _, c := range candidates {
			if c.width != 0 {
				allDensity = false
			}
			if c.density == 1 {
				hasOne = true
			}
			if c.url == src {
				srcListed = true
			}
		}
		if allDensity && !hasOne && !srcListed {
			candidates = append([]candidate{{src, 0, 1}}, candidates...)
		}
	}
	image.Srcset = normalizeSrcset(candidates)
	if link := linkAround(img); link != nil {
		if href, ok := resolveHTTP(link.av("href"), base); ok && hasImageExt(href) && href != src {
			image.Href = href
		}
	}
	return image
}

func containsJSSpace(s string) bool {
	for i := 0; i < len(s); {
		sp, size := jsSpaceAt(s, i)
		if sp {
			return true
		}
		i += size
	}
	return false
}

var trackingPixelGate = newLiteralGate("pixel", "beacon", "tracking", "tracker", "spacer", "/ad", "/pagead")

var smallImageClass = newClassPattern(`(?:^|[\s_-])(?:emoji|wp-smiley|icon|smiley|emoticon|inline-icon|twemoji)(?:$|[\s_-])`)

// isSmallImage: icons, emoji and avatars are small: kept inline, never as figures.
func isSmallImage(img *Node, image *Image) bool {
	w := image.Width
	if w == 0 {
		w = attrDimension(img, "width")
	}
	h := image.Height
	if h == 0 {
		h = attrDimension(img, "height")
	}
	if (w != 0 && w <= 48) || (h != 0 && h <= 48 && (w == 0 || w <= 160)) {
		return true
	}
	return smallImageClass.matchEl(img)
}

var (
	homeLink        = jsRegexp(`^https?:\/\/[^/]+\/?(?:index\.html?)?(?:[?#].*)?$`, "i")
	decorativeClass = newClassPattern(`(?:^|[\s_-])(?:avatar|gravatar|author-(?:photo|image|avatar|img)|logo|site-logo|badge|profile-(?:pic|photo|image)|headshot|byline-image|sponsor-logo|social-icon)(?:$|[\s_-])`)
	portraitAlt     = jsRegexp(`^(?:photo|picture|portrait|headshot|avatar|profile (?:photo|picture)) of\s`, "i")
	// avatarSrc is `/gravatar\.com\/avatar|\/avatars?\//i`.
	avatarSrc         = newLiteralGate("gravatar.com/avatar", "/avatar/", "/avatars/")
	youtubeIDPattern  = jsRegexp(`^[\w-]{11}$`, "")
	videoClass        = jsRegexp(`youtube|yt-|video`, "")
	videoIDInAttrs    = jsRegexp(`"videoId"\s*:\s*"([\w-]{11})"`, "")
	vimeoIDPattern    = jsRegexp(`^\d+$`, "")
	frameSchemeIgnore = jsRegexp(`^(?:about|javascript|data):`, "i")
	protocolRelative  = jsRegexp(`^(?:https?:)?\/\/`, "i")
)

// isDecorativeImage: avatars, logos and badges are chrome, not article images.
func isDecorativeImage(img *Node, image *Image, base string) bool {
	// An image map is a navigation bar drawn as a picture.
	if img.has("usemap") || img.has("ismap") {
		return true
	}
	// An image linking to the site's home page is its logo.
	if link := linkAround(img); link != nil {
		if href, ok := resolveHTTP(link.av("href"), base); ok && homeLink.MatchString(href) {
			return true
		}
	}
	if decorativeClass.matchEl(img) {
		return true
	}
	// Small portraits next to author names ("Photo of Jane Doe").
	if image.Width != 0 && image.Width <= 160 || attrDimension(img, "width") != 0 && attrDimension(img, "width") <= 160 {
		if portraitAlt.MatchString(image.Alt) {
			return true
		}
	}
	return avatarSrc.open(image.Src)
}

// ------------------------------------------------------------------ embeds

// queryPattern is `/head(?:.*&)?param/i`, a query parameter after a URL
// prefix, in linear time: the text is searched for `&param` once, and the
// whole pattern runs only where it matches. others are alternatives without
// the query part (the leftmost match wins).
type queryPattern struct {
	head   *regexp.Regexp
	amp    *regexp.Regexp
	direct *regexp.Regexp
	whole  *regexp.Regexp
	others *regexp.Regexp
}

func newQueryPattern(head, param, others string) *queryPattern {
	q := &queryPattern{
		head:   jsRegexp(head, "gi"),
		amp:    jsRegexp("&"+param, "gi"),
		direct: jsRegexp("^(?:"+param+")", "i"),
		whole:  jsRegexp("^(?:"+head+")(?:.*&)?(?:"+param+")", "i"),
	}
	if others != "" {
		q.others = jsRegexp(others, "i")
	}
	return q
}

// lineEnd is where the line holding from ends: the next line terminator (what `.` does not match), or the end.
func lineEnd(s string, from int) int {
	for i := from; i < len(s); {
		c := s[i]
		if c == '\n' || c == '\r' {
			return i
		}
		if c == 0xe2 && i+2 < len(s) && s[i+1] == 0x80 && (s[i+2] == 0xa8 || s[i+2] == 0xa9) {
			return i
		}
		i++
	}
	return len(s)
}

// exec returns the submatches of the leftmost match (as FindStringSubmatch), or nil.
func (q *queryPattern) exec(s string) []string {
	var other []int
	if q.others != nil {
		other = q.others.FindStringSubmatchIndex(s)
	}
	amp := -2
	end := -1
	for _, m := range q.head.FindAllStringIndex(s, -1) {
		if other != nil && m[0] >= other[0] {
			break
		}
		p := m[1]
		if amp == -2 || (amp >= 0 && amp < p) {
			if loc := q.amp.FindStringIndex(s[p:]); loc != nil {
				amp = p + loc[0]
			} else {
				amp = -1
			}
		}
		if p > end {
			end = lineEnd(s, p)
		}
		if (amp >= 0 && amp < end) || q.direct.MatchString(s[p:]) {
			return q.whole.FindStringSubmatch(s[m[0]:])
		}
	}
	if other == nil {
		return nil
	}
	out := make([]string, len(other)/2)
	for k := range out {
		if other[2*k] >= 0 {
			out[k] = s[other[2*k]:other[2*k+1]]
		}
	}
	return out
}

var (
	youtubeFrame   = newQueryPattern(`youtube(?:-nocookie)?\.com\/watch\?`, `v=([\w-]{11})`, `(?:youtube(?:-nocookie)?\.com\/(?:embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})`)
	vimeoFrame     = jsRegexp(`(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)`, "i")
	dailymotion    = jsRegexp(`dailymotion\.com\/(?:embed\/)?video\/([\w]+)`, "i")
	loomFrame      = jsRegexp(`loom\.com\/(?:embed|share)\/([\w]+)`, "i")
	wistiaFrame    = jsRegexp(`(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([\w]+)`, "i")
	tedFrame       = jsRegexp(`embed\.ted\.com\/talks\/([\w-]+)`, "i")
	twitchFrame    = newQueryPattern(`player\.twitch\.tv\/\?`, `(video|channel)=([\w]+)`, "")
	spotifyFrame   = jsRegexp(`open\.spotify\.com\/(?:embed\/)?(track|episode|show|album|playlist)\/([\w]+)`, "i")
	soundcloud     = newQueryPattern(`w\.soundcloud\.com\/player\/\?`, `url=([^&]+)`, "")
	applePodcasts  = jsRegexp(`embed\.podcasts\.apple\.com\/([^?#]+)`, "i")
	codepenFrame   = jsRegexp(`codepen\.io\/([\w-]+)\/(?:embed|pen)\/(?:preview\/)?([\w]+)`, "i")
	tweetURL       = jsRegexp(`(?:twitter|x)\.com\/(\w+)\/status(?:es)?\/(\d+)`, "i")
	bandcampFrame  = jsRegexp(`bandcamp\.com\/EmbeddedPlayer`, "i")
	streamable     = jsRegexp(`streamable\.com\/(?:e|o|s)\/(\w+)`, "i")
	bilibili       = newQueryPattern(`player\.bilibili\.com\/player\.html\?`, `bvid=(BV\w+)`, "")
	niconico       = jsRegexp(`embed\.nicovideo\.jp\/watch\/((?:sm|nm|so)?\d+)`, "i")
	tweetFrame     = newQueryPattern(`platform\.twitter\.com\/embed\/Tweet\.html\?`, `id=(\d+)`, "")
	instagramFrame = jsRegexp(`instagram\.com\/(p|reel|tv)\/([\w-]+)\/embed`, "i")
	tiktokFrame    = jsRegexp(`tiktok\.com\/embed(?:\/v2)?\/(\d+)`, "i")
)

func youtubeVideo(id, title string) *Video {
	return &Video{
		Provider: "youtube",
		URL:      "https://www.youtube.com/watch?v=" + id,
		EmbedURL: "https://www.youtube-nocookie.com/embed/" + id,
		Poster:   "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg",
		Title:    title,
	}
}

// mediaFromFrame is a player iframe as a video, audio or embed block; nil for
// anything else (ads, widgets). src must already be resolved to http(s).
func mediaFromFrame(src, title string) Block {
	// Every provider's pattern holds its host name: test for it first.
	l := strings.ToLower(src)
	has := func(s string) bool { return strings.Contains(l, s) }
	if !(has("youtu") || has("vimeo.com") || has("dailymotion.com") || has("loom.com") || has("wistia.") || has("embed.ted.com") || has("player.twitch.tv") ||
		has("open.spotify.com") || has("w.soundcloud.com") || has("embed.podcasts.apple.com") || has("codepen.io") || has(".com/") || has("bandcamp.com") ||
		has("streamable.com") || has("player.bilibili.com") || has("embed.nicovideo.jp") || has("instagram.com") || has("tiktok.com")) {
		return nil
	}
	if has("youtu") {
		if m := youtubeFrame.exec(src); m != nil {
			return youtubeVideo(m[1], title)
		}
	}
	if !has("vimeo.com") {
	} else if m := vimeoFrame.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "vimeo", URL: "https://vimeo.com/" + m[1], EmbedURL: "https://player.vimeo.com/video/" + m[1], Title: title}
	}
	if m := dailymotion.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "dailymotion", URL: "https://www.dailymotion.com/video/" + m[1], EmbedURL: "https://www.dailymotion.com/embed/video/" + m[1], Title: title}
	}
	if m := loomFrame.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "loom", URL: "https://www.loom.com/share/" + m[1], EmbedURL: "https://www.loom.com/embed/" + m[1], Title: title}
	}
	if m := wistiaFrame.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "wistia", URL: src, EmbedURL: "https://fast.wistia.net/embed/iframe/" + m[1], Title: title}
	}
	if m := tedFrame.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "ted", URL: "https://www.ted.com/talks/" + m[1], EmbedURL: src, Title: title}
	}
	if m := twitchFrame.exec(src); m != nil {
		url := "https://www.twitch.tv/" + m[2]
		if m[1] == "video" {
			url = "https://www.twitch.tv/videos/" + m[2]
		}
		return &Video{Provider: "twitch", URL: url, EmbedURL: src, Title: title}
	}
	if m := spotifyFrame.FindStringSubmatch(src); m != nil {
		return &Audio{Provider: "spotify", URL: "https://open.spotify.com/" + m[1] + "/" + m[2], EmbedURL: "https://open.spotify.com/embed/" + m[1] + "/" + m[2], Title: title}
	}
	if m := soundcloud.exec(src); m != nil {
		target := m[1]
		if decoded, ok := jsDecodeURIComponent(target); ok {
			target = decoded
		}
		// The track page when the player names an absolute http(s) one, else the player itself.
		url := src
		if hasHTTPPrefix(target) > 0 {
			if resolved, ok := resolveHTTP(target, src); ok {
				url = resolved
			}
		}
		return &Audio{Provider: "soundcloud", URL: url, EmbedURL: src, Title: title}
	}
	if m := applePodcasts.FindStringSubmatch(src); m != nil {
		return &Audio{Provider: "apple-podcasts", URL: "https://podcasts.apple.com/" + m[1], EmbedURL: src, Title: title}
	}
	if m := codepenFrame.FindStringSubmatch(src); m != nil {
		return &Embed{Provider: "codepen", URL: "https://codepen.io/" + m[1] + "/pen/" + m[2]}
	}
	if m := tweetURL.FindStringSubmatch(src); m != nil {
		return &Embed{Provider: "twitter", URL: "https://twitter.com/" + m[1] + "/status/" + m[2]}
	}
	if bandcampFrame.MatchString(src) {
		return &Audio{Provider: "bandcamp", URL: src, EmbedURL: src, Title: title}
	}
	if m := streamable.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "streamable", URL: "https://streamable.com/" + m[1], EmbedURL: "https://streamable.com/e/" + m[1], Title: title}
	}
	if m := bilibili.exec(src); m != nil {
		return &Video{Provider: "bilibili", URL: "https://www.bilibili.com/video/" + m[1], EmbedURL: src, Title: title}
	}
	if m := niconico.FindStringSubmatch(src); m != nil {
		return &Video{Provider: "niconico", URL: "https://www.nicovideo.jp/watch/" + m[1], EmbedURL: src, Title: title}
	}
	if m := tweetFrame.exec(src); m != nil {
		return &Embed{Provider: "twitter", URL: "https://twitter.com/i/status/" + m[1]}
	}
	if m := instagramFrame.FindStringSubmatch(src); m != nil {
		return &Embed{Provider: "instagram", URL: "https://www.instagram.com/" + m[1] + "/" + m[2] + "/"}
	}
	if m := tiktokFrame.FindStringSubmatch(src); m != nil {
		return &Embed{Provider: "tiktok", URL: "https://www.tiktok.com/embed/v2/" + m[1]}
	}
	return nil
}

// Hosts of interactive content (charts, maps, sandboxes, slides, documents) that publishers embed.
var embedHosts = []struct {
	domains  []string
	provider string
}{
	{[]string{"datawrapper.dwcdn.net", "datawrapper.de"}, "datawrapper"},
	{[]string{"flourish.studio", "flo.uri.sh"}, "flourish"},
	{[]string{"infogram.com"}, "infogram"},
	{[]string{"observablehq.com"}, "observable"},
	{[]string{"public.tableau.com"}, "tableau"},
	{[]string{"plotly.com", "plot.ly"}, "plotly"},
	{[]string{"arcgis.com"}, "arcgis"},
	{[]string{"openstreetmap.org"}, "openstreetmap"},
	{[]string{"codesandbox.io"}, "codesandbox"},
	{[]string{"stackblitz.com"}, "stackblitz"},
	{[]string{"jsfiddle.net"}, "jsfiddle"},
	{[]string{"replit.com"}, "replit"},
	{[]string{"glitch.com", "glitch.me"}, "glitch"},
	{[]string{"play.rust-lang.org", "go.dev", "play.golang.org"}, "playground"},
	{[]string{"airtable.com"}, "airtable"},
	{[]string{"figma.com"}, "figma"},
	{[]string{"slideshare.net"}, "slideshare"},
	{[]string{"speakerdeck.com"}, "speakerdeck"},
	{[]string{"scribd.com"}, "scribd"},
	{[]string{"docs.google.com"}, "google-docs"},
}

// hostIs is `/(?:^|\.)domain$/`.
func hostIs(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// Frames that are never content: ads, analytics, comment and chat widgets, forms.
var widgetFrame = jsRegexp(`doubleclick|googlesyndication|googletagmanager|google-analytics|adservice|adsystem|adnxs|criteo|taboola|outbrain|disqus|facebook\.com\/plugins\/(?:like|share|page|follow|comments)|sharethis|addthis|recaptcha|newsletter|subscribe|signup|sign-up|login|consent|cookie|intercom|zendesk|livechat|hotjar|survey|typeform|\/ads?\/`, "i")

var frameSrc = []string{"data-src", "data-lazy-src", "data-cmp-src", "data-original", "data-url"}

// frameSource is the URL a frame loads, including lazy and consent-gated copies.
func frameSource(el *Node) string {
	src := jsTrim(el.av("src"))
	if src != "" && !frameSchemeIgnore.MatchString(src) {
		return src
	}
	for _, key := range frameSrc {
		if v := jsTrim(el.av(key)); protocolRelative.MatchString(v) {
			return v
		}
	}
	for _, a := range jsKeyOrder(el.Attrs) {
		v := jsTrim(a.Value)
		if strings.HasPrefix(a.Name, "data-") && strings.HasSuffix(a.Name, "src") && protocolRelative.MatchString(v) {
			return v
		}
	}
	return ""
}

var (
	mermaid      = jsRegexp(`^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|sankey-beta|C4Context)\b`, "")
	percentHex   = jsRegexp(`%[0-9a-f]{2}`, "i")
	embedHostPre = jsRegexp(`^(?:embed|embeds|player)\.`, "")
	embedPath    = jsRegexp(`\/embed(?:ded)?(?:-[a-z]+)?\/[^?#]`, "i")
)

// frameContent is what a frame's data-content carries: a link-card target URL, or diagram source.
func frameContent(el *Node) (string, bool) {
	value, ok := el.attr("data-content")
	if !ok || value == "" {
		return "", false
	}
	if percentHex.MatchString(value) {
		if decoded, ok := jsDecodeURIComponent(value); ok {
			value = decoded
		}
	}
	value = jsTrim(value)
	if strings.HasPrefix(value, "{") {
		parsed, ok := jsonParse(value)
		if !ok {
			return "", false
		}
		obj, isObj := parsed.(map[string]any)
		if !isObj {
			return "", false
		}
		var inner any
		for _, key := range [...]string{"data", "content", "source", "url"} {
			if v, ok := obj[key]; ok && v != nil {
				inner = v
				break
			}
		}
		if s, ok := inner.(string); ok {
			return jsTrim(s), true
		}
		return "", false
	}
	return value, true
}

// frameBlock: any frame in the article — players and social posts,
// interactive content on known hosts, link cards and other /embed endpoints,
// diagrams shipped as source. nil for ads, widgets, forms and blank frames.
func frameBlock(el *Node, base string) Block {
	raw := frameSource(el)
	if raw == "" {
		return nil
	}
	src, ok := resolveHTTP(raw, base)
	if !ok {
		return nil
	}
	if media := mediaFromFrame(src, el.av("title")); media != nil {
		return media
	}
	if widgetFrame.MatchString(src) {
		return nil
	}
	width, hasW := el.attr("width")
	height, hasH := el.attr("height")
	if hasW && (width == "0" || width == "1") || hasH && (height == "0" || height == "1") {
		return nil
	}
	content, hasContent := frameContent(el)
	if hasContent && mermaid.MatchString(content) {
		return &Code{Code: normalizeNewlines(content)}
	}
	host := hostOf(src)
	for _, h := range embedHosts {
		for _, d := range h.domains {
			if hostIs(host, d) {
				return &Embed{Provider: h.provider, URL: src}
			}
		}
	}
	if embedHostPre.MatchString(host) || embedPath.MatchString(src) {
		url := src
		if hasContent {
			if target, ok := resolveHTTP(content, base); ok {
				url = target
			}
		}
		return &Embed{Provider: "other", URL: url}
	}
	return nil
}

// normalizeNewlines is `.replace(/\r\n?/g, '\n')`.
func normalizeNewlines(s string) string {
	if strings.IndexByte(s, '\r') < 0 {
		return s
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

const noBase = "https://invalid.invalid/"

// isContentFrame: a frame the converter will keep (see frameBlock); usable before the page base is known.
func isContentFrame(el *Node) bool {
	if el.frameState < 0 {
		el.frameState = 0
		if frameBlock(el, noBase) != nil {
			el.frameState = 1
		}
	}
	return el.frameState == 1
}

// mediaFromElement: <video>/<audio> elements with their own files.
func mediaFromElement(el *Node, base string) Block {
	src := el.attrPtr("src")
	if src == nil {
		src = el.attrPtr("data-src")
	}
	if src == nil {
		source := firstElement(el, func(e *Node) bool { return e.Tag == "source" && (e.has("src") || e.has("data-src")) })
		if source != nil {
			src = source.attrPtr("src")
			if src == nil {
				src = source.attrPtr("data-src")
			}
		}
	}
	if src == nil {
		return nil
	}
	url, ok := resolveHTTP(*src, base)
	if !ok {
		return nil
	}
	if frame := mediaFromFrame(url, ""); frame != nil {
		if _, isEmbed := frame.(*Embed); !isEmbed {
			return frame
		}
	}
	if el.Tag == "audio" {
		return &Audio{Provider: "file", URL: url}
	}
	video := &Video{Provider: "file", URL: url}
	if poster, ok := el.attr("poster"); ok {
		if p, ok := resolveHTTP(poster, base); ok {
			video.Poster = p
		}
	}
	return video
}

// lazyVideo: video placeholders that only become players with JavaScript.
func lazyVideo(el *Node) *Video {
	id := firstNonNil(el.attrPtr("videoid"), el.attrPtr("data-youtube-id"), el.attrPtr("data-video-id"), el.attrPtr("data-ytid"))
	if id != nil && youtubeIDPattern.MatchString(*id) && (el.Tag == "lite-youtube" || videoClass.MatchString(el.matchString) || el.has("data-youtube-id")) {
		title := firstNonNil(el.attrPtr("title"), el.attrPtr("playlabel"))
		return youtubeVideo(*id, derefOr(title, ""))
	}
	if attrs, ok := el.attr("data-attrs"); ok && strings.Contains(el.matchString, "youtube") {
		if m := videoIDInAttrs.FindStringSubmatch(attrs); m != nil {
			return youtubeVideo(m[1], "")
		}
	}
	if vimeo, ok := el.attr("videoid"); ok && el.Tag == "lite-vimeo" && vimeoIDPattern.MatchString(vimeo) {
		return &Video{Provider: "vimeo", URL: "https://vimeo.com/" + vimeo, EmbedURL: "https://player.vimeo.com/video/" + vimeo}
	}
	return nil
}

// socialProvider: social posts that publishers embed as blockquotes.
func socialProvider(el *Node) string {
	m := el.matchString
	switch {
	case strings.Contains(m, "twitter-tweet") || strings.Contains(m, "twitter-video"):
		return "twitter"
	case strings.Contains(m, "instagram-media"):
		return "instagram"
	case strings.Contains(m, "tiktok-embed"):
		return "tiktok"
	case strings.Contains(m, "reddit-embed") || strings.Contains(m, "reddit-card"):
		return "reddit"
	case strings.Contains(m, "bluesky-embed"):
		return "bluesky"
	case strings.Contains(m, "text-post-media"):
		return "threads"
	case strings.Contains(m, "mastodon-embed"):
		return "mastodon"
	case strings.Contains(m, "fb-xfbml") || strings.Contains(m, "fb-post"):
		return "facebook"
	}
	return ""
}
