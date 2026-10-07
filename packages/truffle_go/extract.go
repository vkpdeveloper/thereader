package truffle

// The platform-independent pipeline (extract.ts): metadata, content, blocks,
// tidying, and the article.

import (
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Options configure extraction.
type Options struct {
	// URL the HTML was fetched from (after redirects). Resolves relative URLs.
	URL string
	// Markdown also writes the article as Markdown into Article.Markdown.
	Markdown bool
}

// ExtractTree extracts the readable article from a parsed page; nil when the
// page holds no article. The tree is changed (marks, synthetic paragraphs):
// extract each Document once.
func ExtractTree(doc *Document, opts Options) *Article {
	pageURL := opts.URL
	base := pageURL
	if doc.BaseHref != nil {
		if b, ok := resolveHTTP(*doc.BaseHref, pageURL); ok {
			base = b
		}
	}
	meta := readMetadata(doc, pageURL)
	title := chooseTitle(meta, doc.Body, pageURL)
	titleMatched := title != titleFallback(meta, pageURL)
	roots := findContent(doc.Body, meta.articleBody)

	blocks := newConverter(base).convert(roots)
	if !titleMatched {
		title = sectionTitle(blocks, title)
	}
	blocks = tidy(blocks, title, meta)

	if meta.articleBody != nil {
		bodyLen := u16len(*meta.articleBody)
		if bodyLen > 500 && float64(blocksTextLen(blocks)) < float64(bodyLen)*0.3 {
			blocks = paragraphsFrom(*meta.articleBody)
		}
	}
	if len(blocks) == 0 {
		return nil
	}
	if blocksTextLen(blocks) < 50 {
		media := false
		for _, b := range blocks {
			switch b.(type) {
			case *Figure, *Video, *Code, *Embed:
				media = true
			}
		}
		if !media {
			return nil
		}
	}

	blocks = addLeadImage(blocks, meta.leadImage)

	text := BlocksText(blocks)
	wordCount := CountWords(text)
	var subtitle *string
	if meta.subtitle != nil && *meta.subtitle != title {
		subtitle = meta.subtitle
	}
	var byline *string
	if len(meta.authors) > 0 {
		s := strings.Join(meta.authors, ", ")
		byline = &s
	}
	dir := meta.dir
	if dir == "" {
		dir = detectDirection(text)
	}
	article := &Article{
		Schema:         ArticleSchema,
		URL:            meta.url,
		Title:          title,
		Subtitle:       subtitle,
		Byline:         byline,
		Authors:        meta.authors,
		SiteName:       meta.siteName,
		PublishedAt:    meta.publishedAt,
		ModifiedAt:     meta.modifiedAt,
		Language:       meta.language,
		Dir:            dir,
		Excerpt:        excerptOf(meta.excerpt, blocks),
		LeadImage:      meta.leadImage,
		Favicon:        meta.favicon,
		WordCount:      wordCount,
		ReadingMinutes: max(1, int(math.Ceil(float64(wordCount)/230))),
		Blocks:         blocks,
	}
	if opts.Markdown {
		md := ArticleMarkdown(article)
		article.Markdown = &md
	}
	return article
}

// ------------------------------------------------------------------ title

func isTitleSeparatorRune(r rune) bool {
	switch r {
	case '|', '-', '–', '—', '·', '•', '»', ':':
		return true
	}
	return false
}

// titleSeparatorAt matches `/\s+[|\-–—·•»:]{1,2}\s+|\s+\/\s+|\s+::\s+/y` at i.
func titleSeparatorAt(text string, i int) int {
	j := skipJSSpace(text, i)
	if j == i || j >= len(text) {
		return -1
	}
	r1, s1 := utf8.DecodeRuneInString(text[j:])
	if isTitleSeparatorRune(r1) {
		// Two separator characters, then spaces; else one, then spaces.
		if j+s1 < len(text) {
			r2, s2 := utf8.DecodeRuneInString(text[j+s1:])
			if isTitleSeparatorRune(r2) {
				if k := skipJSSpace(text, j+s1+s2); k > j+s1+s2 {
					return k - i
				}
			}
		}
		if k := skipJSSpace(text, j+s1); k > j+s1 {
			return k - i
		}
		return -1
	}
	if r1 == '/' {
		if k := skipJSSpace(text, j+1); k > j+1 {
			return k - i
		}
	}
	return -1
}

func splitTitle(title string) []string {
	return splitAtRuns(title, titleSeparatorAt)
}

// stripTLD is `host.replace(/\.[a-z]+$/, ”)`.
func stripTLD(host string) string {
	i := len(host)
	for i > 0 && host[i-1] >= 'a' && host[i-1] <= 'z' {
		i--
	}
	if i < len(host) && i > 0 && host[i-1] == '.' {
		return host[:i-1]
	}
	return host
}

// CleanTitle removes the site name a <title> carries at either end ("Story | Site", "Site - Story").
func CleanTitle(raw string, siteName *string, host string) string {
	title := collapse(raw)
	parts := splitTitle(title)
	if len(parts) < 2 {
		return title
	}
	site := ""
	if siteName != nil {
		site = comparable(*siteName)
	}
	hostWords := comparable(stripTLD(host))
	siteLen := u16len(site)
	isSite := func(part string) bool {
		c := comparable(part)
		if c == "" {
			return false
		}
		cl := u16len(c)
		return c == site || c == hostWords || strings.ReplaceAll(c, " ", "") == strings.ReplaceAll(hostWords, " ", "") ||
			(site != "" && strings.Contains(site, c) && cl > 3) || (site != "" && strings.Contains(c, site) && cl < siteLen+12)
	}
	start, end := 0, len(parts)
	if isSite(parts[end-1]) {
		end--
	}
	if end-start > 1 && isSite(parts[0]) {
		start++
	}
	if start == 0 && end == len(parts) {
		return title
	}
	// Rebuild from the original string so inner separators survive.
	first := parts[start]
	last := parts[end-1]
	from := strings.Index(title, first)
	to := strings.LastIndex(title, last) + len(last)
	cleaned := title
	if from >= 0 && to > from {
		cleaned = jsTrim(title[from:to])
	}
	if u16len(cleaned) >= 3 {
		return cleaned
	}
	return title
}

// isPermalinkGlyph is `/^[#¶§🔗]$/u`.
func isPermalinkGlyph(s string) bool {
	switch s {
	case "#", "¶", "§", "🔗":
		return true
	}
	return false
}

// headingText is a heading's text without permalink anchors (`¶`, `#`).
func headingText(el *Node) string {
	var out strings.Builder
	var visit func(node *Node)
	visit = func(node *Node) {
		for _, child := range node.Children {
			if child.Kind == TextNode {
				out.WriteString(child.text)
			} else if !(child.Tag == "a" && isPermalinkGlyph(collapse(textOf(child)))) {
				visit(child)
			}
		}
	}
	visit(el)
	text := collapse(out.String())
	if r, size := utf8.DecodeLastRuneInString(text); r == '#' || r == '¶' || r == '§' {
		return jsTrimEnd(text[:len(text)-size])
	}
	return text
}

func countH1(body *Node) int {
	n := 0
	walk(body, func(el *Node) bool {
		if el.Tag == "h1" {
			n++
			return false
		}
		return true
	})
	return n
}

// titleFallback is what chooseTitle falls back to when no heading on the page matches the declared title.
func titleFallback(meta *metadata, pageURL string) string {
	host := hostOf(pageURL)
	for _, t := range meta.rawTitles {
		if cleaned := CleanTitle(t, meta.siteName, host); cleaned != "" {
			return cleaned
		}
	}
	return ""
}

// sectionTitle: a <title> that only names the site or document over a page
// that opens with its own top-level heading sharing a word with it.
func sectionTitle(blocks []Block, title string) string {
	if len(blocks) == 0 {
		return title
	}
	first, ok := blocks[0].(*Heading)
	if !ok {
		return title
	}
	for _, b := range blocks {
		if h, ok := b.(*Heading); ok && h.Level < first.Level {
			return title
		}
	}
	words := strings.Split(comparable(title), " ")
	if len(words) > 3 {
		return title
	}
	heading := collapse(InlineText(first.Content))
	hw := strings.Split(comparable(heading), " ")
	for _, w := range words {
		if u16len(w) > 2 && containsString(hw, w) {
			return heading
		}
	}
	return title
}

func chooseTitle(meta *metadata, body *Node, pageURL string) string {
	host := hostOf(pageURL)
	var cleaned []string
	for _, t := range meta.rawTitles {
		if c := CleanTitle(t, meta.siteName, host); c != "" {
			cleaned = append(cleaned, c)
		}
	}
	var headings, h1s []string
	walk(body, func(el *Node) bool {
		if len(headings) >= 8 {
			return false
		}
		if el.Tag == "h1" || el.Tag == "h2" {
			t := headingText(el)
			if n := u16len(t); n > 0 && n <= 300 && (n >= 3 || el.Tag == "h1") {
				headings = append(headings, t)
				if el.Tag == "h1" {
					h1s = append(h1s, t)
				}
			}
			return false
		}
		return true
	})
	headingKeys := make([]string, len(headings))
	for i, h := range headings {
		headingKeys[i] = comparable(h)
	}
	// The visible heading that matches the page's declared title is the title as written.
	for _, candidate := range cleaned {
		c := comparable(candidate)
		if c == "" {
			continue
		}
		for i, h := range headings {
			if headingKeys[i] == c {
				return h
			}
		}
	}
	// Headings that are the site part of "Story - Site" (a docs menu-bar h1) never stand for the story.
	siteParts := map[string]bool{}
	segmentsOf := func(raw string) []string {
		parts := splitTitle(collapse(raw))
		for i, p := range parts {
			parts[i] = comparable(p)
		}
		return parts
	}
	for _, raw := range meta.rawTitles {
		segments := segmentsOf(raw)
		if len(segments) < 2 {
			continue
		}
		siteParts[segments[len(segments)-1]] = true
		siteParts[segments[0]] = true
	}
	for _, candidate := range cleaned {
		c := comparable(candidate)
		cl := u16len(c)
		if cl < 10 {
			continue
		}
		for i, h := range headings {
			hc := headingKeys[i]
			if siteParts[hc] && hc != c {
				continue
			}
			hl := u16len(hc)
			if hl >= 10 && (strings.Contains(c, hc) && float64(hl) > float64(cl)*0.6 || strings.Contains(hc, c) && float64(cl) > float64(hl)*0.6) {
				return h
			}
		}
	}
	// A heading equal to one segment of "Story - Section - Site".
	for _, raw := range meta.rawTitles {
		segments := segmentsOf(raw)
		if len(segments) < 2 {
			continue
		}
		// The last segment is the site in "Story - Site" titles; never match it.
		for i := 0; i < len(segments)-1; i++ {
			if segments[i] == "" {
				continue
			}
			// Short (often CJK) titles only match the page's h1.
			pool := headings
			if u16len(segments[i]) < 3 {
				pool = h1s
			}
			for _, h := range pool {
				if comparable(h) == segments[i] {
					return h
				}
			}
		}
	}
	// Rewritten headlines: the visible heading that shares most of its words with the declared title.
	best := ""
	hasBest := false
	bestOverlap := 0.6
	for _, candidate := range cleaned {
		words := map[string]bool{}
		for _, w := range strings.Split(comparable(candidate), " ") {
			words[w] = true
		}
		if len(words) < 3 {
			continue
		}
		for i, h := range headings {
			hw := strings.Split(headingKeys[i], " ")
			if len(hw) < 3 {
				continue
			}
			shared := 0
			for _, w := range hw {
				if words[w] {
					shared++
				}
			}
			overlap := float64(shared) / float64(max(len(hw), len(words)))
			if overlap > bestOverlap {
				bestOverlap = overlap
				best = h
				hasBest = true
			}
		}
	}
	if hasBest {
		return best
	}
	// An SEO <title> that shares nothing with the page: its one h1 is the headline as published.
	if len(h1s) == 1 && len(cleaned) > 0 {
		hc := comparable(h1s[0])
		site := ""
		if meta.siteName != nil {
			site = comparable(*meta.siteName)
		}
		if !siteParts[hc] && hc != site && (strings.Index(hc, " ") > 0 || u16len(hc) >= 8) && countH1(body) == 1 {
			return h1s[0]
		}
	}
	if len(cleaned) > 0 {
		return cleaned[0]
	}
	if len(headings) > 0 {
		return headings[0]
	}
	return host
}

// ------------------------------------------------------------------ tidy

func blockPlain(block Block) string {
	switch b := block.(type) {
	case *Heading:
		return InlineText(b.Content)
	case *Paragraph:
		return InlineText(b.Content)
	}
	return ""
}

var (
	dateLine  = jsRegexp(`^(?:(?:published|updated|posted|last updated|modified)\s*:?\s*)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:\d{1,2}\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})(?:,?\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*[ap]\.?m\.?)?(?:\s+[a-z]{2,4})?)?$`, "i")
	dateWords = jsRegexp(`\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|updated|published|posted|last|modified|on|at|am|pm|a\.m|p\.m|[a-z]?[ecmp][sd]t|gmt|utc|bst|cet|cest|ist|aest|jst|hours?|minutes?|days?|ago|original|of)\b`, "g")
	dateChars = jsRegexp(`[\d\s.,:;|/·•@\-–—()]+`, "g")
)

var bylineParticles = [...]string{"de", "da", "van", "von", "der", "le", "la", "bin", "al"}

func isNameChar(r rune) bool {
	return unicode.IsLetter(r) || r == '\'' || r == '’' || r == '.' || r == '-'
}

// isBylineLine is `BYLINE_LINE.test(text)`: "By Jane Doe", "By JANE DOE and Li
// Wei | Reuters" — names after "By", not a sentence. The pattern needs
// lookahead, so its grammar is matched here: "By", spaces, one to five names
// (a capitalised word running to the end of its letters, or a particle),
// lists joined by ",", "and" or "&", then an optional "| ..." tail.
func isBylineLine(text string) bool {
	if !(strings.HasPrefix(text, "By") || strings.HasPrefix(text, "by") || strings.HasPrefix(text, "BY")) {
		return false
	}
	p := skipJSSpace(text, 2)
	if p == 2 {
		return false
	}
	failed := map[[2]int]bool{}
	var names func(pos, n int) bool
	// tokenEnds lists where a name token starting at pos can end.
	tokenEnds := func(pos int) []int {
		var ends []int
		if pos < len(text) {
			r, size := utf8.DecodeRuneInString(text[pos:])
			if unicode.IsUpper(r) {
				for e := pos + size; ; {
					next, nsize := utf8.DecodeRuneInString(text[e:])
					if e >= len(text) || !unicode.IsLetter(next) {
						ends = append(ends, e)
					}
					if e >= len(text) || !isNameChar(next) {
						break
					}
					e += nsize
				}
			}
		}
		for _, particle := range bylineParticles {
			if strings.HasPrefix(text[pos:], particle) {
				ends = append(ends, pos+len(particle))
			}
		}
		return ends
	}
	accept := func(pos int) bool {
		if pos == len(text) {
			return true
		}
		r, size := utf8.DecodeRuneInString(text[pos:])
		switch r {
		case '|', '·', '•', '—', '–', '-':
			// `.*$`: the rest holds no line terminator.
			return lineEnd(text, pos+size) == len(text)
		}
		return false
	}
	names = func(pos, n int) bool {
		key := [2]int{pos, n}
		if failed[key] {
			return false
		}
		if n >= 1 {
			if accept(pos) {
				return true
			}
			// A separator opens the next list of names.
			for _, sep := range [...]string{",", "and", "&"} {
				if strings.HasPrefix(text[pos:], sep) && names(skipJSSpace(text, pos+len(sep)), 0) {
					return true
				}
			}
		}
		if n < 5 {
			for _, e := range tokenEnds(pos) {
				if names(skipJSSpace(text, e), n+1) {
					return true
				}
			}
		}
		failed[key] = true
		return false
	}
	return names(p, 0)
}

// isDateLine: a line made only of dates, times and words like "Updated".
func isDateLine(lower string) bool {
	if u16len(lower) > 100 || !strings.ContainsAny(lower, "0123456789") {
		return false
	}
	rest := dateWords.ReplaceAllLiteralString(lower, "")
	rest = dateChars.ReplaceAllLiteralString(rest, "")
	return u16len(rest) < 3
}

// isShortNumberLine is `/^[\d\s.,/#|·•]{1,6}$/`.
func isShortNumberLine(s string) bool {
	n := 0
	for _, r := range s {
		if !((r >= '0' && r <= '9') || isJSSpace(r) || strings.ContainsRune(".,/#|·•", r)) {
			return false
		}
		n++
	}
	return n >= 1 && n <= 6
}

// isRuleLine is `/^[\s_*~=\-–—•·]{3,}$/`.
func isRuleLine(s string) bool {
	n := 0
	for _, r := range s {
		if !(isJSSpace(r) || strings.ContainsRune("_*~=-–—•·", r)) {
			return false
		}
		n++
	}
	return n >= 3
}

// endsClause: the text (trailing whitespace ignored) ends with `[.!?:;。！？"'”’)\]]`.
func endsClause(s string) bool {
	s = jsTrimEnd(s)
	r, _ := utf8.DecodeLastRuneInString(s)
	return s != "" && strings.ContainsRune(".!?:;。！？\"'”’)]", r)
}

// startsLower is `/^\s*\p{Ll}/u`.
func startsLower(s string) bool {
	s = jsTrimStart(s)
	r, _ := utf8.DecodeRuneInString(s)
	return s != "" && unicode.IsLower(r)
}

var (
	updatedLabel = jsRegexp(`^(?:last updated|updated|published|posted)(?: on)?:?$`, "i")
	topicsLead   = jsRegexp(`^(?:explore more on (?:these|this) topics?|more on (?:this|these) (?:story|stories|topics?)|(?:related )?topics|tags|filed under)\s*:?$`, "i")
	sentenceStop = jsRegexp(`[.!?]["'”’)]?$`, "")
)

func tidy(input []Block, title string, meta *metadata) []Block {
	blocks := make([]Block, 0, len(input))
	for _, b := range input {
		if p, ok := b.(*Paragraph); ok && (len(p.Content) == 0 || isShortNumberLine(InlineText(p.Content))) {
			continue
		}
		blocks = append(blocks, b)
	}
	// A line of underscores, dashes or asterisks is a section break.
	for i, b := range blocks {
		if p, ok := b.(*Paragraph); ok && len(p.Content) == 1 {
			if run, ok := p.Content[0].(*TextRun); ok && u16len(run.Text) < 100 && isRuleLine(run.Text) {
				blocks[i] = &Rule{}
			}
		}
	}

	// The title (and a repeated subtitle) are drawn by the renderer, not the body.
	t := comparable(title)
	tl := u16len(t)
	for i := 0; i < min(len(blocks), 4); i++ {
		b := blocks[i]
		_, isHeading := b.(*Heading)
		_, isParagraph := b.(*Paragraph)
		if !isHeading && !isParagraph {
			continue
		}
		c := comparable(blockPlain(b))
		if c != "" && (c == t || isHeading && tl > 10 && (strings.Contains(c, t) || strings.Contains(t, c) && float64(u16len(c)) > float64(tl)*0.75)) {
			blocks = append(blocks[:i], blocks[i+1:]...)
			break
		}
	}
	// Title set as an image (old sites): a lone inline image whose alt text is the title.
	for i := 0; i < min(len(blocks), 3); i++ {
		if t == "" {
			break
		}
		match := false
		switch b := blocks[i].(type) {
		case *Paragraph:
			if len(b.Content) == 1 {
				if img, ok := b.Content[0].(*InlineImage); ok && comparable(img.Alt) == t {
					match = true
				}
			}
		case *Figure:
			match = len(b.Images) == 1 && b.Caption == nil && comparable(b.Images[0].Alt) == t
		}
		if match {
			blocks = append(blocks[:i], blocks[i+1:]...)
			break
		}
	}
	// The subtitle, or a heading that repeats the page description (a dek set as <h2>), is header too.
	sub := ""
	if meta.subtitle != nil {
		sub = comparable(*meta.subtitle)
	}
	description := ""
	if meta.excerpt != nil {
		description = comparable(*meta.excerpt)
	}
	for i := 0; i < min(len(blocks), 3); i++ {
		b := blocks[i]
		_, isHeading := b.(*Heading)
		_, isParagraph := b.(*Paragraph)
		if !isHeading && !isParagraph {
			continue
		}
		c := comparable(blockPlain(b))
		if c != "" && (c == sub || isHeading && c == description) {
			blocks = append(blocks[:i], blocks[i+1:]...)
			break
		}
	}

	// Bylines and bare dates at the top repeat the header.
	authors := make([]string, len(meta.authors))
	for i, a := range meta.authors {
		authors[i] = jsLower(a)
	}
	for i := 0; i < min(len(blocks), 5); i++ {
		if _, ok := blocks[i].(*Paragraph); !ok {
			continue
		}
		text := collapse(blockPlain(blocks[i]))
		n := u16len(text)
		if n == 0 || n > 120 {
			continue
		}
		lower := jsLower(text)
		isByline := isBylineLine(text) && n < 100
		if !isByline {
			for _, a := range authors {
				if lower == a || lower == "by "+a {
					isByline = true
					break
				}
			}
		}
		if isByline || dateLine.MatchString(text) || isDateLine(lower) {
			// The header's date line is the publication date when the page declares none.
			if !isByline && meta.publishedAt == nil {
				meta.publishedAt = normalizeDate(&text)
			}
			blocks = append(blocks[:i], blocks[i+1:]...)
			i--
		}
	}

	// A sentence split by a block the parser pulled out of it (a link's hover card): the card goes, the sentence is joined again.
	for i := 0; i+2 < len(blocks); i++ {
		first, ok := blocks[i].(*Paragraph)
		if !ok {
			continue
		}
		// Cheap first: only the paragraph's last run decides whether the sentence is unfinished.
		if len(first.Content) == 0 {
			continue
		}
		tail, ok := first.Content[len(first.Content)-1].(*TextRun)
		if !ok || endsClause(tail.Text) {
			continue
		}
		head := jsTrimEnd(InlineText(first.Content))
		if head == "" || endsClause(head) {
			continue
		}
		j := i + 1
		for j < len(blocks) && j-i <= 3 {
			next := blocks[j]
			if _, isH := next.(*Heading); isH {
				j++
				continue
			}
			p, isP := next.(*Paragraph)
			if !isP {
				break
			}
			pt := InlineText(p.Content)
			if u16len(pt) >= 200 {
				break
			}
			if startsLower(pt) && j > i+1 {
				break
			}
			j++
		}
		if j == i+1 || j-i > 3 || j >= len(blocks) {
			continue
		}
		last, ok := blocks[j].(*Paragraph)
		if !ok || !startsLower(InlineText(last.Content)) {
			continue
		}
		hasHeading := false
		for _, b := range blocks[i+1 : j] {
			if _, ok := b.(*Heading); ok {
				hasHeading = true
				break
			}
		}
		if !hasHeading {
			continue
		}
		joined := append(append(append([]Inline{}, first.Content...), &TextRun{Text: " "}), last.Content...)
		first.Content = normalizeInlines(joined)
		blocks = append(blocks[:i+1], blocks[j+1:]...)
	}

	// Labels drawn over a diagram (f(t), ω, "Fig. a") come out as a run of tiny paragraphs after it.
	for i := 0; i < len(blocks); i++ {
		if _, ok := blocks[i].(*Figure); !ok {
			continue
		}
		j := i + 1
		for j < len(blocks) && isLegendLabel(blocks[j]) {
			j++
		}
		if j-i-1 >= 3 {
			blocks = append(blocks[:i+1], blocks[j:]...)
		}
	}
	// A formula alone in its paragraph is set on its own line.
	for i, b := range blocks {
		if p, ok := b.(*Paragraph); ok && len(p.Content) == 1 {
			if m, ok := p.Content[0].(*InlineMath); ok {
				blocks[i] = &MathBlock{Tex: m.Tex, MathML: m.MathML, Text: m.Text}
			}
		}
	}

	// Author bios ("Jane Doe is a reporter covering...") describe the writer, not the story.
	blocks = dropBios(blocks, authors)

	// "Read more:" promos and link-only lines are navigation, not text.
	kept := blocks[:0]
	for _, b := range blocks {
		if p, ok := b.(*Paragraph); ok && isPromo(p.Content) {
			continue
		}
		kept = append(kept, b)
	}
	blocks = kept
	// Calls to action opening the story (a "buy the PDF" box).
	for i := 0; i < min(len(blocks), 3); i++ {
		if isCallToAction(blocks[i]) {
			blocks = append(blocks[:i], blocks[i+1:]...)
			i--
		}
	}
	// Contact lines, calls to action, link lists and promo headings trailing the story (before its notes).
	var notes []Block
	for len(blocks) > 1 {
		if _, ok := blocks[len(blocks)-1].(*Footnotes); !ok {
			break
		}
		notes = append([]Block{blocks[len(blocks)-1]}, notes...)
		blocks = blocks[:len(blocks)-1]
	}
trailing:
	for len(blocks) > 1 {
		last := blocks[len(blocks)-1]
		prev := blocks[len(blocks)-2]
		lastP, lastIsP := last.(*Paragraph)
		lastText := ""
		if lastIsP {
			lastText = collapse(InlineText(lastP.Content))
		}
		lastList, lastIsList := last.(*List)
		_, lastIsHeading := last.(*Heading)
		switch {
		case lastIsP && (isContactLine(lastText) || isDateLine(jsLower(lastText)) || updatedLabel.MatchString(lastText)):
		case lastIsP && topicsLead.MatchString(lastText):
			// The lead of a topic-tag footer whose links are gone ("Explore more on these topics").
		case lastIsP && u16len(lastText) < 100 && linkShare(lastP.Content) >= 0.5 && !sentenceStop.MatchString(lastText):
		case isCallToAction(last):
		case lastIsList && len(lastList.Items) <= 6 && isCallToAction(prev) && listBlocksTextLen(lastList) < 400:
			// The short benefits list under a sign-up pitch.
		case lastIsList && allLinkItems(lastList):
		case lastIsHeading:
		default:
			break trailing
		}
		blocks = blocks[:len(blocks)-1]
	}
	blocks = append(blocks, notes...)

	// Heading levels start at 2 under the title, keeping their relative depth.
	minLevel := 7
	for _, b := range blocks {
		if h, ok := b.(*Heading); ok && h.Level < minLevel {
			minLevel = h.Level
		}
	}
	if minLevel < 7 && minLevel != 2 {
		for _, b := range blocks {
			if h, ok := b.(*Heading); ok {
				h.Level = max(2, min(6, h.Level-minLevel+2))
			}
		}
	}

	// No empty structure, no rules at the edges or back to back, notes merged.
	out := make([]Block, 0, len(blocks))
	for _, b := range blocks {
		var prev Block
		if len(out) > 0 {
			prev = out[len(out)-1]
		}
		switch b := b.(type) {
		case *Rule:
			if prev == nil {
				continue
			}
			switch prev.(type) {
			case *Rule, *Heading:
				continue
			}
		case *Footnotes:
			if p, ok := prev.(*Footnotes); ok {
				p.Items = append(p.Items, b.Items...)
				continue
			}
		case *Heading:
			if p, ok := prev.(*Heading); ok && p.Level == b.Level && InlineText(p.Content) == InlineText(b.Content) {
				continue
			}
		case *Paragraph:
			// The same paragraph or picture twice in a row is a rendering artifact (responsive copies, dek repeated).
			if p, ok := prev.(*Paragraph); ok && len(p.Content) == len(b.Content) && sameFirstText(p.Content, b.Content) {
				bt := InlineText(b.Content)
				if u16len(bt) > 20 && InlineText(p.Content) == bt {
					continue
				}
			}
		case *Figure:
			if p, ok := prev.(*Figure); ok && len(p.Images) == len(b.Images) {
				same := true
				for k, image := range p.Images {
					if image.Src != b.Images[k].Src {
						same = false
						break
					}
				}
				if same {
					continue
				}
			}
		}
		out = append(out, b)
	}
	for len(out) > 0 {
		switch out[len(out)-1].(type) {
		case *Rule, *Heading:
			out = out[:len(out)-1]
			continue
		}
		break
	}
	return out
}

func listBlocksTextLen(list *List) int {
	var blocks []Block
	for _, item := range list.Items {
		blocks = append(blocks, item.Blocks...)
	}
	return blocksTextLen(blocks)
}

func allLinkItems(list *List) bool {
	for _, item := range list.Items {
		if len(item.Blocks) != 1 {
			return false
		}
		p, ok := item.Blocks[0].(*Paragraph)
		if !ok || linkShare(p.Content) <= 0.8 {
			return false
		}
	}
	return true
}

var (
	bioRole   = newWordAlternation(bioRoleSource)
	bioName   = jsRegexp(`^(\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:is|was|has been)\s+(?:a|an|the)\s`, "u")
	bioOrphan = jsRegexp(`^(?:is|was)\s+(?:a|an|the)\s`, "")

// Every role word, for a cheap test before the pattern.
)

// dropBios: bios are short paragraphs naming one of the authors (or orphaned
// from its name, "is a senior reporter...") with a job title, plus bios right next to one.
// bioRoleSource: a bio names a job.
const bioRoleSource = `\b(?:reporter|writer|editor|journalist|correspondent|columnist|contributor|author|producer|critic|fellow|researcher|consultant|engineer|developer|designer|professor|director|founder|photographer|analyst|scientist|lecturer|host|freelancer?|economist|historian|novelist|blogger|speaker|principal)\b`

func dropBios(blocks []Block, authors []string) []Block {
	bio := make([]int, len(blocks))
	any2 := false
	for i, b := range blocks {
		p, ok := b.(*Paragraph)
		if !ok {
			continue
		}
		raw := InlineText(p.Content)
		if u16len(raw) > 900 {
			continue
		}
		head := raw
		if u16len(raw) > 200 {
			head = u16prefix(raw, 200)
		}
		head = collapse(head)
		// A bio names a job: a word search, cheaper than the shape tests.
		if !bioRole.match(u16prefix(head, 160)) {
			continue
		}
		orphan := bioOrphan.MatchString(head)
		var m []string
		if !orphan {
			m = bioName.FindStringSubmatch(head)
		}
		if !orphan && m == nil {
			continue
		}
		if orphan {
			bio[i] = 2
		} else if containsString(authors, jsLower(m[1])) {
			bio[i] = 2
		} else {
			bio[i] = 1
		}
		if bio[i] == 2 {
			any2 = true
		}
	}
	if !any2 {
		return blocks
	}
	// Unnamed bios count only next to a certain one (co-author boxes), across name lines and photos.
	near := func(i, step int) bool {
		for j := i + step; j >= 0 && j < len(blocks); j += step {
			if bio[j] == 2 {
				return true
			}
			switch b := blocks[j].(type) {
			case *Figure:
			case *Paragraph:
				if u16len(InlineText(b.Content)) >= 60 {
					return false
				}
			default:
				return false
			}
		}
		return false
	}
	for pass := 0; pass < 2; pass++ {
		for i := range bio {
			if bio[i] == 1 && (near(i, -1) || near(i, 1)) {
				bio[i] = 2
			}
		}
	}
	out := make([]Block, 0, len(blocks))
	for i, b := range blocks {
		if bio[i] != 2 {
			out = append(out, b)
		}
	}
	return out
}

func sameFirstText(a, b []Inline) bool {
	if len(a) == 0 || len(b) == 0 || a[0].InlineType() != b[0].InlineType() {
		return false
	}
	x, ok := a[0].(*TextRun)
	if !ok {
		return true
	}
	return x.Text == b[0].(*TextRun).Text
}

func isLegendLabel(b Block) bool {
	p, ok := b.(*Paragraph)
	if !ok {
		return false
	}
	if len(p.Content) == 1 {
		if m, ok := p.Content[0].(*InlineMath); ok {
			return u16len(m.Text) < 40
		}
	}
	return u16len(jsTrim(InlineText(p.Content))) <= 12
}

func linkShare(content []Inline) float64 {
	all, linked := 0, 0
	for _, n := range content {
		run, ok := n.(*TextRun)
		if !ok {
			continue
		}
		n := u16len(jsTrim(run.Text))
		all += n
		if run.Href != "" {
			linked += n
		}
	}
	if all == 0 {
		return 0
	}
	return float64(linked) / float64(all)
}

var (
	promo     = jsRegexp(`^(?:see more|read more|read also|also read|related|more|don'?t miss|watch|watch now|recommended|must read|trending|click here|related articles?|related stories|related coverage|more on this|more from|listen|subscribe|sign up|follow us|read next|up next|next)\s*[:|>»\-–—]`, "i")
	promoLine = jsRegexp(`^(?:don'?t miss|read more|related|see also|recommended|more stories|more great .* stories|trending|most popular|you may also like|advertisement|share this( article)?)$`, "i")
)

func isPromo(content []Inline) bool {
	text := collapse(InlineText(content))
	if text == "" {
		return false
	}
	share := linkShare(content)
	n := u16len(text)
	if promoGate.open(text) {
		if promo.MatchString(text) && (share > 0.4 || n < 120) {
			return true
		}
		if promoLine.MatchString(text) {
			return true
		}
	}
	// A short line that is entirely a link to another page, or a stack of them.
	if share >= 0.9 {
		if n < 160 {
			return true
		}
		for _, node := range content {
			if _, ok := node.(*LineBreak); ok {
				return true
			}
		}
	}
	return false
}

// Sign-up, subscribe, app, membership and affiliate pitches, in the languages publishers use most.
var callToAction = jsRegexp(`\b(?:sign(?:ing)? up (?:for|to|here|now|today)|subscribe (?:to|for|now|here|today)|our (?:free |daily |weekly )?newsletter|email list|mailing list|register (?:as|for|now|today)|create (?:a |an )?(?:free )?account|download (?:the|our)|get (?:the|our) (?:\w+ )?app|follow (?:us|topics|authors|the authors)|support (?:us|our)|patreon page|on patreon|donate (?:to|now|today|here)|become a (?:member|patron|subscriber|supporter)|buy it here|we may earn (?:a )?(?:small )?commission|affiliate (?:links?|commission)|purchase through links)\b|suscr[ií]b(?:e|ete|irte)|descarga la|boletín|abonnez-vous|inscrivez-vous|téléchargez|abonnieren sie|jetzt herunterladen|assine|inscreva-se`, "i")

// isCallToAction: a short pitch to sign up, subscribe, download, follow or support.
func isCallToAction(b Block) bool {
	var text string
	switch b := b.(type) {
	case *Paragraph:
		text = InlineText(b.Content)
	case *Callout, *List:
		text = BlocksText([]Block{b})
	default:
		return false
	}
	text = collapse(text)
	if text == "" || u16len(text) >= 300 {
		return false
	}
	// Quoted speech that mentions subscriptions is reporting, not a pitch.
	r, _ := utf8.DecodeRuneInString(text)
	if strings.ContainsRune("\"“„«'‘", r) {
		return false
	}
	return callToActionGate.open(text) && callToAction.MatchString(text)
}

var callToActionGate = newLiteralGate("sign up", "signing up", "subscribe ", "newsletter", "email list", "mailing list", "register ", "account", "download the", "download our", "get the", "get our", "follow us", "follow topics", "follow authors", "follow the authors", "support us", "support our", "patreon", "donate ", "become a ", "buy it here", "commission", "affiliate", "purchase through", "suscr", "descarga la", "bolet", "abonnez-vous", "inscrivez-vous", "chargez", "abonnieren sie", "jetzt herunterladen", "assine", "inscreva-se")

var promoGate = newPrefixGate("see ", "read ", "also read", "related", "more", "don", "watch", "recommended", "must read", "trending", "click here", "listen", "subscribe", "sign up", "follow us", "up next", "next", "advertisement", "share this", "you may also like", "most popular")

var (
	contactEmail  = jsRegexp(`^[\w.+-]+@[\w-]+\.[\w.-]+$`, "")
	contactSocial = jsRegexp(`^(?:https?:\/\/)?(?:www\.)?(?:twitter|x|facebook|instagram|linkedin|threads|bsky)\.(?:com|app|net)\/\S+$`, "i")
	contactHandle = jsRegexp(`^@\w{2,30}$`, "")
	contactFollow = jsRegexp(`^(?:follow|contact|email|reach)\b.{0,80}(?:@|twitter|on x\b)`, "i")
)

func isContactLine(text string) bool {
	if u16len(text) > 120 {
		return false
	}
	return contactEmail.MatchString(text) || contactSocial.MatchString(text) || contactHandle.MatchString(text) || contactFollow.MatchString(text)
}

var (
	paragraphSplit = jsRegexp(`\n\s*\n|\r?\n`, "")
	sentenceChunk  = jsRegexp(`[^.!?。！？]+[.!?。！？]+["'”’)]*\s*|[^.!?。！？]+$`, "g")
)

func paragraphsFrom(text string) []Block {
	var parts []string
	for _, p := range paragraphSplit.Split(text, -1) {
		if c := collapse(p); c != "" {
			parts = append(parts, c)
		}
	}
	if len(parts) == 1 && u16len(parts[0]) > 1500 {
		sentences := sentenceChunk.FindAllString(parts[0], -1)
		if sentences == nil {
			sentences = []string{parts[0]}
		}
		parts = nil
		current := ""
		for _, s := range sentences {
			current += s
			if u16len(current) > 600 {
				parts = append(parts, jsTrim(current))
				current = ""
			}
		}
		if jsTrim(current) != "" {
			parts = append(parts, jsTrim(current))
		}
	}
	out := make([]Block, len(parts))
	for i, p := range parts {
		out[i] = &Paragraph{Content: []Inline{&TextRun{Text: p}}}
	}
	return out
}

var imageKeyPattern = jsRegexp(`\/([^/?#]+?)(?:[-_]\d+x\d+|[-_](?:large|medium|small|thumb|scaled|\d{2,4}w?))?\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])`, "i")

func imageKey(src string) string {
	if m := imageKeyPattern.FindStringSubmatch(src); m != nil {
		return jsLower(m[1])
	}
	return jsLower(src)
}

var placeholderImageWords = []string{"logo", "default", "placeholder", "share", "social", "og-image", "opengraph", "fallback", "favicon", "icon", "avatar", "banner-default"}

// isPlaceholderImage: a file named for a placeholder ("site-logo.png"). Each
// word's scan for the extension stops where the next word starts (that one
// takes over): `/(?:logo|…)(?:(?!logo|…)[\w.-])*\.(?:jpe?g|png|webp|gif|svg)/i`.
func isPlaceholderImage(src string) bool {
	lower := strings.ToLower(src)
	wordAt := func(i int) int {
		for _, w := range placeholderImageWords {
			if strings.HasPrefix(lower[i:], w) {
				return len(w)
			}
		}
		return 0
	}
	for p := 0; p < len(lower); p++ {
		n := wordAt(p)
		if n == 0 {
			continue
		}
		for r := p + n; ; r++ {
			if r < len(lower) && lower[r] == '.' {
				rest := lower[r+1:]
				for _, ext := range [...]string{"jpg", "jpeg", "png", "webp", "gif", "svg"} {
					if strings.HasPrefix(rest, ext) {
						return true
					}
				}
			}
			if r >= len(lower) || !(isWordOrDash(lower[r]) || lower[r] == '.') || wordAt(r) > 0 {
				break
			}
		}
	}
	return false
}

// addLeadImage shows the page's lead image above the text when the body itself opens without one.
func addLeadImage(blocks []Block, lead *Image) []Block {
	if lead == nil {
		return blocks
	}
	if isPlaceholderImage(lead.Src) || hasSVGExtension(lead.Src) {
		return blocks
	}
	if lead.Width != 0 && lead.Width < 400 {
		return blocks
	}
	key := imageKey(lead.Src)
	for _, b := range blocks {
		if f, ok := b.(*Figure); ok {
			for _, i := range f.Images {
				if i.Src == lead.Src || imageKey(i.Src) == key {
					return blocks
				}
			}
		}
	}
	for i := 0; i < min(len(blocks), 3); i++ {
		switch blocks[i].(type) {
		case *Figure, *Video:
			return blocks
		}
	}
	image := &Image{Src: lead.Src, Alt: lead.Alt}
	if lead.Width != 0 && lead.Height != 0 {
		image.Width = lead.Width
		image.Height = lead.Height
	}
	return append([]Block{&Figure{Images: []*Image{image}}}, blocks...)
}

// ------------------------------------------------------------------ details

// dropLastWord is `.replace(/\s+\S*$/, ”)`.
func dropLastWord(s string) string {
	end := len(s)
	// Skip the trailing non-space characters, then require whitespace before them.
	i := end
	for i > 0 {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		if isJSSpace(r) {
			break
		}
		i -= size
	}
	if i == 0 {
		return s
	}
	for i > 0 {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		if !isJSSpace(r) {
			break
		}
		i -= size
	}
	return s[:i]
}

func excerptOf(description *string, blocks []Block) *string {
	if description != nil && u16len(*description) >= 20 {
		if u16len(*description) > 400 {
			s := dropLastWord(u16prefix(*description, 397)) + "…"
			return &s
		}
		return description
	}
	for _, b := range blocks {
		p, ok := b.(*Paragraph)
		if !ok {
			continue
		}
		var raw strings.Builder
		for _, n := range p.Content {
			switch n := n.(type) {
			case *TextRun:
				raw.WriteString(n.Text)
			case *InlineMath:
				raw.WriteString(n.Text)
			case *LineBreak:
				raw.WriteByte(' ')
			}
		}
		text := collapse(raw.String())
		n := u16len(text)
		if n < 40 {
			continue
		}
		if n > 300 {
			text = dropLastWord(u16prefix(text, 297)) + "…"
		}
		return &text
	}
	return description
}

func detectDirection(text string) string {
	rtl, ltr := 0, 0
	units := 0
	for _, c := range text {
		if units >= 3000 {
			break
		}
		if c >= 0x10000 {
			units += 2
			continue
		}
		units++
		if (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff) {
			rtl++
		} else if (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x370 && c <= 0x52f) || (c >= 0x3040 && c <= 0x9fff) {
			ltr++
		}
	}
	if rtl > ltr {
		return "rtl"
	}
	return "ltr"
}
