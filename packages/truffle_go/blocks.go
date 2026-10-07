package truffle

// Converts the article's elements into blocks (blocks.ts).

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ------------------------------------------------------------------ TeX

type texMatch struct {
	index, end       int
	texStart, texEnd int
	display          bool
}

// seeker is `text.indexOf(needle, from)` for a from that never decreases: each part of the text is searched once.
type seeker struct {
	text, needle string
	at           int // -2: not searched yet
}

func (s *seeker) find(from int) int {
	if s.at == -2 || (s.at >= 0 && s.at < from) {
		if from > len(s.text) {
			s.at = -1
		} else if i := strings.Index(s.text[from:], s.needle); i >= 0 {
			s.at = from + i
		} else {
			s.at = -1
		}
	}
	return s.at
}

// dollarAt finds the first `$$…$$` (and, with any, `$…$` inline) at or after
// from: `/\$\$([^$]+?)\$\$|\$([^\s$\d](?:[^$\n]{0,300}?[^\s$\\])?)\$(?![\d\w])/g`.
func dollarAt(text string, from int, any bool) (int, int, bool) {
	for p := from; p < len(text); p++ {
		if text[p] != '$' {
			if q := strings.IndexByte(text[p:], '$'); q >= 0 {
				p += q
			} else {
				return 0, 0, false
			}
		}
		// $$…$$: a run of non-dollars between two pairs.
		if p+1 < len(text) && text[p+1] == '$' {
			q := p + 2
			for q < len(text) && text[q] != '$' {
				q++
			}
			if q > p+2 && q+1 < len(text) && text[q+1] == '$' {
				return p, q + 2, true
			}
		}
		if !any {
			continue
		}
		if end, ok := inlineDollarAt(text, p); ok {
			return p, end, true
		}
	}
	return 0, 0, false
}

// inlineDollarAt matches `\$([^\s$\d](?:[^$\n]{0,300}?[^\s$\\])?)\$(?![\d\w])` at p.
func inlineDollarAt(text string, p int) (int, bool) {
	q := p + 1
	if q >= len(text) {
		return 0, false
	}
	c1, s1 := utf8.DecodeRuneInString(text[q:])
	if isJSSpace(c1) || c1 == '$' || (c1 >= '0' && c1 <= '9') {
		return 0, false
	}
	start := q + s1
	closesAt := func(i int) (int, bool) {
		if i < len(text) && text[i] == '$' && !(i+1 < len(text) && isWordChar(rune(text[i+1]))) {
			return i + 1, true
		}
		return 0, false
	}
	// The optional group, shortest middle first: middle chars are [^$\n], then a final [^\s$\\].
	units := 0
	for m := start; ; {
		if m >= len(text) {
			break
		}
		f, fs := utf8.DecodeRuneInString(text[m:])
		if !(isJSSpace(f) || f == '$' || f == '\\') {
			if end, ok := closesAt(m + fs); ok {
				return end, true
			}
		}
		// Extend the middle by this character.
		if f == '$' || f == '\n' {
			break
		}
		if f >= 0x10000 {
			units += 2
		} else {
			units++
		}
		if units > 300 {
			break
		}
		m += fs
	}
	// Without the group.
	return closesAt(start)
}

// texMatches finds TeX left for MathJax/KaTeX, in order: $$…$$ and \[…\]
// display, \(…\) inline, and with dollars also $…$ inline, in linear time.
func texMatches(text string, dollars bool, limit int) []texMatch {
	var out []texMatch
	pairs := []struct {
		open, close *seeker
		display     bool
	}{
		{&seeker{text, `\[`, -2}, &seeker{text, `\]`, -2}, true},
		{&seeker{text, `\(`, -2}, &seeker{text, `\)`, -2}, false},
	}
	searched := false
	dIndex, dEnd, dOk := 0, 0, false
	from := 0
	for {
		if !searched || (dOk && dIndex < from) {
			dIndex, dEnd, dOk = dollarAt(text, from, dollars)
			searched = true
		}
		var first *texMatch
		if dOk {
			display := strings.HasPrefix(text[dIndex:], "$$")
			delimiter := 1
			if display {
				delimiter = 2
			}
			first = &texMatch{dIndex, dEnd, dIndex + delimiter, dEnd - delimiter, display}
		}
		for _, pair := range pairs {
			open := pair.open.find(from)
			if open < 0 || (first != nil && open > first.index) {
				continue
			}
			// `[\s\S]+?`: the first closing delimiter after at least one character.
			if closeAt := pair.close.find(open + 3); closeAt >= 0 {
				first = &texMatch{open, closeAt + 2, open + 2, closeAt, pair.display}
			}
		}
		if first == nil {
			return out
		}
		out = append(out, *first)
		if limit > 0 && len(out) >= limit {
			return out
		}
		from = first.end
	}
}

// ------------------------------------------------------------------ inline building

var tagMark = map[string]Mark{
	"b": MarkBold, "strong": MarkBold, "i": MarkItalic, "em": MarkItalic, "cite": MarkItalic, "dfn": MarkItalic, "var": MarkItalic, "u": MarkUnderline, "ins": MarkUnderline,
	"s": MarkStrike, "del": MarkStrike, "strike": MarkStrike, "code": MarkCode, "tt": MarkCode, "samp": MarkCode, "kbd": MarkKbd, "sub": MarkSub, "sup": MarkSup, "mark": MarkHighlight, "small": MarkSmall,
}

func isInlineTag(tag string) bool {
	switch tag {
	case "a", "abbr", "acronym", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del", "dfn", "em", "font", "i", "img", "ins", "kbd", "label",
		"mark", "math", "math-tex", "nobr", "noscript", "picture", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "small", "span", "strike", "strong", "sub",
		"sup", "svg", "time", "tt", "u", "var", "wbr", "input", "meta", "link", "source", "track":
		return true
	}
	return false
}

func isConvBlockTag(tag string) bool {
	switch tag {
	case "address", "article", "aside", "blockquote", "center", "details", "dialog", "dd", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
		"footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "menu", "nav", "ol", "p", "pre", "section",
		"table", "ul", "iframe", "video", "audio", "summary", "tbody", "thead", "tfoot", "tr", "td", "th", "caption", "xmp", "listing", "plaintext":
		return true
	}
	return false
}

var (
	backlink      = newClassPattern(`(?:^|[\s_-])(?:footnote-backref|reversefootnote|footnote-back|footnote-return|mw-cite-backlink|backlink|fn-back|footnote-backlink|data-footnote-backref)(?:$|[\s_-])`)
	permalink     = newClassPattern(`(?:^|[\s_-])(?:anchor|headerlink|hash-link|permalink|heading-link|anchorjs-link|header-anchor|heading-anchor|anchor-link|deep-link|direct-link|autolink|section-link|copy-link)(?:$|[\s_-])`)
	captionClass  = newClassPattern(`(?:^|[\s_-])(?:caption|wp-caption-text|figcaption|image-caption|photo-caption|img-caption|media-caption|caption-text|imagecaption|figure-caption|credit|image-credit|photo-credit)(?:$|[\s_-])`)
	creditClass   = newClassPattern(`(?:^|[\s_-])(?:credit|credits|copyright|attribution|photographer|image-credit|photo-credit|source|byline)(?:$|[\s_-])`)
	figureLike    = newClassPattern(`(?:^|[\s_-])(?:wp-caption|wp-block-image|image-block|figure|photo|media-image|article-image|inline-image|image-container|image-wrapper|img-wrapper|picture)(?:$|[\s_-])`)
	codeTitle     = newClassPattern(`(?:^|[\s_-])(?:code-?block-?title|code-?title|filename|file-name|codeblock-header|code-header|code-block-header|rehype-code-title|remark-code-title|highlight-title)(?:$|[\s_-])|codeblocktitle`)
	gutter        = newClassPattern(`(?:^|[\s_-])(?:line-?numbers?(?:-rows)?|linenos?|lineno|linenodiv|gutter|ln-num|hljs-ln-n|hljs-ln-numbers|rouge-gutter|blob-num|lnt|code-line-number|react-syntax-highlighter-line-number|line-num|linenumber|line-number-cell)(?:$|[\s_-])`)
	codeChrome    = newClassPattern(`(?:^|[\s_-])(?:code-toolbar|toolbar|code-language|code-lang|lang-label|language-label|language-tag|copy-button|copy-code|clipboard)(?:$|[\s_-])`)
	lineElement   = newClassPattern(`(?:^|[\s_-])(?:line|code-line|cm-line|ec-line|token-line|highlight-line|view-line|line-content)(?:$|[\s_-])`)
	absolutePos   = jsRegexp(`position\s*:\s*absolute`, "i")
	pullQuote     = newClassPattern(`(?:^|[\s_-])(?:pullquote|pull-quote|wp-block-pullquote|pull_quote|blockquote--pull)(?:$|[\s_-])`)
	displayWrap   = newClassPattern(`(?:^|[\s_-])(?:katex-display|math-display|display-math|mathjax_display|mwe-math-element-block|math-block|equation)(?:$|[\s_-])`)
	inlineNoteCls = newClassPattern(`(?:^|[\s_-])(?:footnote|sidenote|marginnote|ltx_note)(?:$|[\s_-])`)
	noteItemCls   = newClassPattern(`(?:^|[\s_-])(?:footnote|endnote)(?:$|[\s_-])`)
	codeWrapper   = newClassPattern(`(?:^|[\s_-])(?:code-?block|highlight|codehilite|sourcecode|code-snippet)(?:$|[\s_-])`)
	noteMark      = newClassPattern(`(?:^|[\s_-])(?:note-?mark|sidenote-number|footnote-number)(?:$|[\s_-])`)
	noteContent   = newClassPattern(`(?:^|[\s_-])(?:note-?content|note-?text|note-?body|footnote-?content|sidenote-?content)(?:$|[\s_-])`)
	calloutTitle  = newClassPattern(`(?:^|[\s_-])(?:admonition-title|callout-title|alert-title|markdown-alert-title|admonitionheading|notecard-title|title|heading)(?:$|[\s_-])|admonitionheading`)
	codeCell      = newClassPattern(`(?:^|[\s_-])(?:code|blob-code|hljs-ln-code|lntd|line-content)(?:$|[\s_-])`)
	codeTableCls  = newClassPattern(`(?:^|[\s_-])(?:highlight|hljs-ln|rouge-table|code-table|lntable|codehilitetable|highlighttable|js-file-line-container|blob-code-table|chroma)(?:$|[\s_-])`)
	codeLineCell  = newClassPattern(`(?:^|[\s_-])(?:blob-code|hljs-ln-code|code-line|line-content)(?:$|[\s_-])`)
	codeClass     = newClassPattern(`(?:^|\s)code(?:\s|$)`)
	fontBold      = jsRegexp(`font-weight\s*:\s*(?:bold|[6-9]00)`, "i")
	fontItalic    = jsRegexp(`font-style\s*:\s*italic`, "i")
	textAlign     = jsRegexp(`text-align\s*:\s*(left|center|right)`, "i")
	noteKeyLabel  = jsRegexp(`^\[?\d{1,3}\]?[:.)]?\s*`, "")
	noteLabelRun  = jsRegexp(`^\s*\[?(\d{1,3})\]?[:.)]?(?:\s+|$)`, "")
	bulletMarker  = jsRegexp(`^\s*(?:[•◦▪▫●○■□‣⁃∙►▸]\s*|[-–*·](?:\s+|$))`, "")
	numberMarker  = jsRegexp(`^\s*(?:(\d{1,4})[.)]|\((\d{1,4})\))(?:\s+|$)`, "")
	creditLead    = jsRegexp(`(?:^\s*|[.!?…”’")]\s+)((?:Photograph|Photo|Image|Picture|Illustration|Credit|Source|Graphic)s?\s*:\s*\S)`, "")
	sentenceAfter = jsRegexp(`[.!?]\s+\p{Lu}`, "u")
	refNumber     = jsRegexp(`^\[?(\d{1,3})\]?$`, "")
	embedAuthor   = jsRegexp(`^[—–-]\s*(\S(?:.*?\S)?)(?:\s*\((@\w+)\))?\s+[A-Z][a-z]+ \d{1,2}, \d{4}$`, "")
	embedAuthor2  = jsRegexp(`^[—–-]\s*(\S.*)$`, "")
)

// stripZeroWidth removes zero-width characters and private-use code points
// (icon-font glyphs that show as boxes without their font): `/[\u200b\ufeff\u2060\ue000-\uf8ff]/g`.
func stripZeroWidth(s string) string {
	// U+200B is E2 80 8B, U+2060 E2 81 A0, U+FEFF EF BB BF; U+E000-U+F8FF are EE 80 80 to EF A3 BF.
	// Most text has E2 (quotes, dashes) but none of these.
	first := -1
	for i := 0; i+2 < len(s); i++ {
		if zeroWidthAt(s, i) {
			first = i
			break
		}
	}
	if first < 0 {
		return s
	}
	b := make([]byte, 0, len(s))
	b = append(b, s[:first]...)
	for i := first; i < len(s); {
		if i+2 < len(s) && zeroWidthAt(s, i) {
			i += 3
			continue
		}
		b = append(b, s[i])
		i++
	}
	return bytesString(b)
}

// zeroWidthAt: s[i:] starts with U+200B, U+2060, U+FEFF or a private-use character (U+E000-U+F8FF), UTF-8.
func zeroWidthAt(s string, i int) bool {
	switch s[i] {
	case 0xe2:
		return s[i+1] == 0x80 && s[i+2] == 0x8b || s[i+1] == 0x81 && s[i+2] == 0xa0
	case 0xee:
		return s[i+1]&0xc0 == 0x80 && s[i+2]&0xc0 == 0x80
	case 0xef:
		return s[i+1] == 0xbb && s[i+2] == 0xbf || s[i+1] >= 0x80 && s[i+1] <= 0xa3 && s[i+2]&0xc0 == 0x80
	}
	return false
}

// isHTMLSpaceOnly: `text.replace(/[\t\n\f\r ]+/g, ”).length === 0`.
func isHTMLSpaceOnly(s string) bool {
	for i := 0; i < len(s); i++ {
		if !isHTMLSpace(s[i]) {
			return false
		}
	}
	return true
}

type ctxT struct {
	marks []Mark
	href  string
}

// inlineBuilder builds inline content with whitespace normalized the way a browser renders it.
type inlineBuilder struct {
	conv  *converter
	out   *[]Block // paragraph mode: a double break ends the paragraph
	nodes []Inline
	// Consecutive line breaks with nothing visible between them.
	breaks int
	// Id of an anchor that opens the current paragraph ("[<a name="f1n">1</a>] ...").
	anchor string
	// An element starts or ends here: text on either side comes from different elements.
	edge bool
}

func hasMark(marks []Mark, m Mark) bool {
	for _, x := range marks {
		if x == m {
			return true
		}
	}
	return false
}

func (b *inlineBuilder) text(value string, ctx ctxT) {
	if value == "" {
		return
	}
	text := stripZeroWidth(value)
	if text == "" {
		return
	}
	if b.conv.tex && (strings.IndexByte(text, '$') >= 0 || strings.IndexByte(text, '\\') >= 0) && !hasMark(ctx.marks, MarkCode) && b.texRuns(text, ctx) {
		return
	}
	b.plain(text, ctx)
}

func (b *inlineBuilder) plain(text string, ctx ctxT) {
	if b.edge {
		b.edge = false
		// Two elements shown as separate lines ("…Western Australia.<small>Photograph: …"): never one glued word.
		if len(b.nodes) > 0 {
			if last, ok := b.nodes[len(b.nodes)-1].(*TextRun); ok && endsSentence(last.Text) && startsUpper(text) && !hasMark(ctx.marks, MarkCode) && !hasMark(last.Marks, MarkCode) {
				last.Text += " "
			}
		}
	}
	if b.breaks > 0 && isHTMLSpaceOnly(text) {
		return
	}
	b.breaks = 0
	run := &TextRun{Text: text, Href: ctx.href}
	if len(ctx.marks) > 0 {
		run.Marks = sortMarks(ctx.marks)
	}
	b.nodes = append(b.nodes, run)
}

func startsUpper(s string) bool {
	r, _ := utf8.DecodeRuneInString(s)
	return unicode.IsUpper(r)
}

// texRuns splits TeX written for a client-side renderer out of text as math; false when there is none.
func (b *inlineBuilder) texRuns(text string, ctx ctxT) bool {
	at := 0
	for _, m := range texMatches(text, b.conv.dollars, 0) {
		if m.index > at {
			b.plain(text[at:m.index], ctx)
		}
		tex := jsTrim(text[m.texStart:m.texEnd])
		if tex != "" {
			node := &InlineMath{Tex: tex, Text: tex}
			if m.display {
				b.conv.displayMath[node] = true
			}
			b.push(node)
		}
		at = m.end
	}
	if at == 0 {
		return false
	}
	if at < len(text) {
		b.plain(text[at:], ctx)
	}
	return true
}

func (b *inlineBuilder) lineBreak() {
	b.edge = false
	b.breaks++
	if b.breaks >= 2 && b.out != nil {
		b.flush()
		b.breaks = 2
		return
	}
	b.nodes = append(b.nodes, &LineBreak{})
}

func (b *inlineBuilder) push(node Inline) {
	b.edge = false
	b.breaks = 0
	// Display math is a block of its own: the sentence around it continues in the next paragraph.
	if m, ok := node.(*InlineMath); ok && b.out != nil && b.conv.displayMath[m] {
		b.flush()
		*b.out = append(*b.out, &MathBlock{Tex: m.Tex, MathML: m.MathML, Text: m.Text})
		return
	}
	b.nodes = append(b.nodes, node)
}

// flush emits the collected paragraph (paragraph mode) and starts a new one.
func (b *inlineBuilder) flush() {
	if b.out == nil {
		return
	}
	content := normalizeInlines(b.nodes)
	anchor := b.anchor
	b.nodes = nil
	b.breaks = 0
	b.anchor = ""
	if len(content) == 0 {
		return
	}
	if anchor != "" && b.conv.anchoredNote(anchor, content, b.out) {
		return
	}
	*b.out = append(*b.out, &Paragraph{Content: content})
}

func (b *inlineBuilder) result() []Inline {
	return normalizeInlines(b.nodes)
}

func sortMarks(marks []Mark) []Mark {
	out := make([]Mark, 0, len(marks))
	for _, m := range MarkOrder {
		if hasMark(marks, m) {
			out = append(out, m)
		}
	}
	return out
}

func sameFormat(a, b *TextRun) bool {
	if a.Href != b.Href || len(a.Marks) != len(b.Marks) {
		return false
	}
	for i := range a.Marks {
		if a.Marks[i] != b.Marks[i] {
			return false
		}
	}
	return true
}

// normalizeInlines collapses whitespace across runs, trims around breaks and block edges, merges equal runs.
func normalizeInlines(nodes []Inline) []Inline {
	out := make([]Inline, 0, len(nodes))
	spaceBefore := true
	// Runs merged into the last one collect in buf and are written once, not
	// copied again with every merge.
	var merging *TextRun
	var buf []byte
	flush := func() {
		if merging != nil {
			merging.Text = string(buf)
			merging = nil
		}
	}
	for _, node := range nodes {
		switch n := node.(type) {
		case *TextRun:
			text := collapseHTMLSpace(n.Text)
			if spaceBefore && strings.HasPrefix(text, " ") {
				text = text[1:]
			}
			if text == "" {
				continue
			}
			spaceBefore = text[len(text)-1] == ' '
			if len(out) > 0 {
				if last, ok := out[len(out)-1].(*TextRun); ok && sameFormat(last, n) {
					if merging != last {
						flush()
						merging = last
						buf = append(buf[:0], last.Text...)
					}
					buf = append(buf, text...)
					continue
				}
			}
			flush()
			if text == n.Text {
				// Every caller drops its input after normalizing, so an unchanged run is reused.
				out = append(out, n)
			} else {
				out = append(out, &TextRun{Text: text, Marks: n.Marks, Href: n.Href})
			}
		case *LineBreak:
			flush()
			out = trimEndInlines(out)
			if len(out) == 0 {
				continue
			}
			if _, isBreak := out[len(out)-1].(*LineBreak); isBreak {
				continue
			}
			out = append(out, n)
			spaceBefore = true
		default:
			flush()
			out = append(out, n)
			spaceBefore = false
		}
	}
	flush()
	out = trimEndInlines(out)
	for len(out) > 0 {
		if _, isBreak := out[len(out)-1].(*LineBreak); !isBreak {
			break
		}
		out = trimEndInlines(out[:len(out)-1])
	}
	// A run of only spaces between two breaks or at the start carries nothing.
	kept := out[:0]
	for _, n := range out {
		if run, ok := n.(*TextRun); ok && run.Text == "" {
			continue
		}
		kept = append(kept, n)
	}
	return kept
}

func trimEndInlines(out []Inline) []Inline {
	for len(out) > 0 {
		last, ok := out[len(out)-1].(*TextRun)
		if !ok {
			return out
		}
		trimmed := strings.TrimRight(last.Text, " ")
		if trimmed != "" {
			last.Text = trimmed
			return out
		}
		out = out[:len(out)-1]
	}
	return out
}

func hasBlock(el *Node) bool {
	if el.blockState >= 0 {
		return el.blockState == 1
	}
	found := false
	for _, child := range el.Children {
		if child.Kind == ElementNode && !child.skip && (isConvBlockTag(child.Tag) || hasBlock(child)) {
			found = true
			break
		}
	}
	if found {
		el.blockState = 1
	} else {
		el.blockState = 0
	}
	return found
}

func isInline(el *Node) bool {
	if isInlineTag(el.Tag) {
		return !hasBlock(el)
	}
	// Custom elements holding only phrasing (<dt-math>, <d-cite>) sit inside the sentence; video placeholders do not.
	return strings.IndexByte(el.Tag, '-') > 0 && !hasBlock(el) && lazyVideo(el) == nil
}

// isDisplayMath: a formula set on its own line, by its own attributes or its renderer's wrapper.
func isDisplayMath(el *Node) bool {
	if el.attrIs("display", "block") || el.attrIs("mode", "display") {
		return true
	}
	p := el.Parent
	for depth := 0; depth < 4 && p != nil; depth, p = depth+1, p.Parent {
		if displayWrap.matchEl(p) || p.attrIs("display", "true") && p.Tag == "mjx-container" {
			return true
		}
		if strings.HasSuffix(p.Tag, "-math") && p.has("block") {
			return true
		}
	}
	return false
}

// isStillOf: the still of a video file drawn right after it (its poster): that video already shows it.
func isStillOf(out []Block, image *Image) bool {
	if len(out) == 0 {
		return false
	}
	v, ok := out[len(out)-1].(*Video)
	return ok && v.Provider == "file" && v.Poster == image.Src
}

// intAttr is parseInt(attr, 10) when finite.
func intAttr(el *Node, name string) (float64, bool) {
	v, ok := el.attr(name)
	if !ok {
		return 0, false
	}
	n := jsParseInt(v)
	if n != n || n > 1e308 || n < -1e308 {
		return 0, false
	}
	return n, true
}

// texFrom trims TeX and unwraps `{\displaystyle …}`.
func texFrom(value *string) (string, bool) {
	if value == nil {
		return "", false
	}
	tex := jsTrim(*value)
	if strings.HasPrefix(tex, `{\`) && strings.HasSuffix(tex, "}") {
		for _, w := range [...]string{"displaystyle", "textstyle", "scriptstyle"} {
			if strings.HasPrefix(tex[2:], w) && len(tex) >= 2+len(w)+1 {
				tex = jsTrim(tex[2+len(w) : len(tex)-1])
				break
			}
		}
	}
	return tex, tex != ""
}

// orderedMap is a JavaScript Map<string, string>: insertion-ordered.
type orderedMap struct {
	keys   []string
	values map[string]string
}

func (m *orderedMap) get(k string) (string, bool) {
	v, ok := m.values[k]
	return v, ok
}

func (m *orderedMap) has(k string) bool {
	_, ok := m.values[k]
	return ok
}

func (m *orderedMap) set(k, v string) {
	if m.values == nil {
		m.values = map[string]string{}
	}
	if _, ok := m.values[k]; !ok {
		m.keys = append(m.keys, k)
	}
	m.values[k] = v
}

func (m *orderedMap) size() int { return len(m.keys) }

type converter struct {
	base string
	// Footnote item ids found in the article, with their labels.
	notes orderedMap
	// Footnote items, and (built on first use) their text with the label stripped, to recognise inline copies.
	noteItems        []*Node
	noteTexts        map[string]bool
	pendingCodeTitle *string
	// Notes written inline at their reference (LaTeXML, sidenotes), listed after the text.
	inlineNotes []*Footnote
	inNote      bool
	// In-page "[n]" links not yet matched to a note: target id -> label.
	pendingRefs orderedMap
	// Provisional refs with the link text they replace if no note turns up.
	provisional map[*FootnoteRef]string
	resolved    map[string]bool
	// The <li> each item of an ordered list after a provisional ref came from.
	itemSources map[*ListItem]*Node
	// Label of the first reference to each listed note.
	refLabels map[string]string
	// Math nodes typeset as display (block) formulas.
	displayMath map[*InlineMath]bool
	// The text holds TeX delimiters, so it is parsed as math; dollars adds $…$ inline.
	tex     bool
	dollars bool
}

func newConverter(base string) *converter {
	return &converter{
		base:        base,
		provisional: map[*FootnoteRef]string{},
		resolved:    map[string]bool{},
		itemSources: map[*ListItem]*Node{},
		refLabels:   map[string]string{},
		displayMath: map[*InlineMath]bool{},
	}
}

func (c *converter) convert(roots []*Node) []Block {
	for _, root := range roots {
		c.scanFootnotes(root)
	}
	for _, root := range roots {
		c.scanTex(root)
	}
	out := []Block{}
	for _, root := range roots {
		if root.skip {
			continue
		}
		if isInline(root) || root.Tag == "p" {
			c.children(root, &out)
		} else {
			c.block(root, &out)
		}
	}
	if len(c.inlineNotes) > 0 {
		out = append(out, &Footnotes{Items: c.inlineNotes})
	}
	if len(c.provisional) > 0 {
		c.resolveRefs(&out)
	}
	return out
}

func (c *converter) isNoteCopy(el *Node) bool {
	if c.noteTexts == nil {
		c.noteTexts = map[string]bool{}
		for _, item := range c.noteItems {
			c.noteTexts[noteKey(rawText(item))] = true
		}
	}
	return c.noteTexts[noteKey(rawText(el))]
}

// anchoredNote: a paragraph opened by the anchor a "[n]" link points at is that note.
func (c *converter) anchoredNote(id string, content []Inline, out *[]Block) bool {
	label, ok := c.pendingRefs.get(id)
	if out == nil || !ok || c.resolved[id] {
		return false
	}
	blocks := []Block{&Paragraph{Content: content}}
	blocks = stripNoteLabel(blocks, label)
	if len(blocks) == 0 {
		return false
	}
	c.resolved[id] = true
	note := &Footnote{ID: id, Label: label, Blocks: blocks}
	if n := len(*out); n > 0 {
		if last, ok := (*out)[n-1].(*Footnotes); ok {
			last.Items = append(last.Items, note)
			return true
		}
	}
	*out = append(*out, &Footnotes{Items: []*Footnote{note}})
	return true
}

// resolveRefs settles provisional refs: an id-less ordered list closing the
// article with one item per unresolved label 1..n is their notes; any ref
// still without a note reverts to its link text.
func (c *converter) resolveRefs(outp *[]Block) {
	out := *outp
	type pendingRef struct{ id, label string }
	var pending []pendingRef
	var open []string
	for _, id := range c.pendingRefs.keys {
		if c.resolved[id] {
			continue
		}
		label := c.pendingRefs.values[id]
		pending = append(pending, pendingRef{id, label})
		if !containsString(open, label) {
			open = append(open, label)
		}
	}
	tail := max(0, len(out)-3)
	for i := len(out) - 1; i >= tail && len(open) > 0; i-- {
		list, ok := out[i].(*List)
		if !ok || !list.Ordered || (list.Start != nil && *list.Start != 1) || len(list.Items) != len(open) {
			continue
		}
		allIn := true
		for _, label := range open {
			n := jsNumber(label)
			if !(n >= 1 && n <= float64(len(open))) {
				allIn = false
				break
			}
		}
		if !allIn {
			break
		}
		// Each ref takes the item holding its own anchor, else the item its number names, unless another ref uses that
		// number too (two anchors, one item: which one it belongs to is unknown).
		index := make([]int, len(pending))
		for j, p := range pending {
			k := -1
			for ki, item := range list.Items {
				li := c.itemSources[item]
				if li != nil && (li.idAttr() == p.id || firstElement(li, func(e *Node) bool { return e.idAttr() == p.id || e.attrIs("name", p.id) }) != nil) {
					k = ki
					break
				}
			}
			if k < 0 {
				shared := false
				for _, o := range pending {
					if o.label == p.label && o.id != p.id {
						shared = true
						break
					}
				}
				if shared {
					k = -1
				} else {
					k = int(jsNumber(p.label)) - 1
				}
			}
			index[j] = k
		}
		covered := true
		for k := range list.Items {
			found := false
			for _, x := range index {
				if x == k {
					found = true
					break
				}
			}
			if !found {
				covered = false
				break
			}
		}
		if !covered {
			break
		}
		var items []*Footnote
		for j, p := range pending {
			if index[j] < 0 {
				continue
			}
			c.resolved[p.id] = true
			items = append(items, &Footnote{ID: p.id, Label: p.label, Blocks: list.Items[index[j]].Blocks})
		}
		if items == nil {
			items = []*Footnote{}
		}
		out[i] = &Footnotes{Items: items}
		break
	}
	// Paragraphs between two runs of anchored notes continue the note before them.
	for i := 0; i < len(out); i++ {
		notes, ok := out[i].(*Footnotes)
		if !ok {
			continue
		}
		j := i + 1
		for j < len(out) && j-i <= 4 {
			if _, isP := out[j].(*Paragraph); !isP {
				break
			}
			j++
		}
		if j == i+1 || j >= len(out) {
			continue
		}
		next, ok := out[j].(*Footnotes)
		if !ok {
			continue
		}
		lastItem := notes.Items[len(notes.Items)-1]
		lastItem.Blocks = append(lastItem.Blocks, out[i+1:j]...)
		notes.Items = append(notes.Items, next.Items...)
		out = append(out[:i+1], out[j+1:]...)
		i--
	}
	eachInlines(out, func(content *[]Inline) {
		changed := false
		list := *content
		for k := 0; k < len(list); k++ {
			ref, ok := list[k].(*FootnoteRef)
			if !ok {
				continue
			}
			if text, ok := c.provisional[ref]; ok && !c.resolved[ref.ID] {
				list[k] = &TextRun{Text: text}
				changed = true
				continue
			}
			// "[" ref "]": the brackets are the reference's own decoration.
			if k > 0 && k+1 < len(list) {
				prev, ok1 := list[k-1].(*TextRun)
				next, ok2 := list[k+1].(*TextRun)
				if ok1 && ok2 && strings.HasSuffix(prev.Text, "[") && strings.HasPrefix(next.Text, "]") {
					prev.Text = prev.Text[:len(prev.Text)-1]
					next.Text = next.Text[1:]
					changed = true
				}
			}
		}
		if changed {
			*content = normalizeInlines(list)
		}
	})
	*outp = out
}

// scanTex: display delimiters ($$, \[) or \( anywhere in the prose mean the page renders TeX client-side.
func (c *converter) scanTex(root *Node) {
	var visit func(el *Node)
	visit = func(el *Node) {
		if c.tex || el.skip || el.Tag == "pre" || el.Tag == "code" || el.Tag == "math" || el.Tag == "math-tex" {
			return
		}
		for _, child := range el.Children {
			if child.Kind == ElementNode {
				visit(child)
			} else if strings.Contains(child.text, "$$") || strings.Contains(child.text, `\(`) || strings.Contains(child.text, `\[`) {
				if len(texMatches(child.text, false, 1)) > 0 {
					c.tex = true
				}
			}
			if c.tex {
				return
			}
		}
	}
	visit(root)
	c.dollars = c.tex
}

// ---------------------------------------------------------------- footnotes

func (c *converter) scanFootnotes(root *Node) {
	counter := c.notes.size()
	walk(root, func(el *Node) bool {
		if el.skip {
			return false
		}
		if el.Tag != "a" && isFootnotes(el) {
			walk(el, func(item *Node) bool {
				if item.skip {
					return false
				}
				if item != el && isNoteItem(item) {
					counter++
					c.notes.set(item.idAttr(), strconv.Itoa(counter))
					c.noteItems = append(c.noteItems, item)
					return false
				}
				return true
			})
			return false
		}
		// Substack-style notes: <div class="footnote"><a class="footnote-number" id="footnote-1">1</a>...
		if footnoteClass.match(el.classAttr()) {
			number := firstElement(el, func(e *Node) bool { return strings.Contains(e.matchString, "footnote-number") && e.idAttr() != "" })
			if number != nil {
				counter++
				label := collapse(rawText(number))
				if label == "" {
					label = strconv.Itoa(counter)
				}
				c.notes.set(number.idAttr(), label)
				return false
			}
			if el.idAttr() != "" {
				counter++
				c.notes.set(el.idAttr(), strconv.Itoa(counter))
				return false
			}
		}
		return true
	})
}

func (c *converter) isFootnoteContainer(el *Node) bool {
	if el.Tag == "a" || c.notes.size() == 0 {
		return false
	}
	return isFootnotes(el)
}

func (c *converter) footnotes(el *Node, out *[]Block) {
	var items []*Footnote
	walk(el, func(item *Node) bool {
		if item.skip {
			return false
		}
		if item != el && isNoteItem(item) && c.notes.has(item.idAttr()) {
			// Sphinx and docutils put the number in a label span; it is the item's label, not text.
			if label := firstElement(item, func(e *Node) bool { return e.hasClass("label") || e.hasClass("fn-label") }); label != nil {
				label.skip = true
			}
			blocks := []Block{}
			c.children(item, &blocks)
			// The number the text shows for this note, else its position.
			shown, ok := c.refLabels[item.idAttr()]
			if !ok {
				shown, _ = c.notes.get(item.idAttr())
			}
			blocks = stripNoteLabel(blocks, shown)
			if len(blocks) > 0 {
				items = append(items, &Footnote{ID: item.idAttr(), Label: shown, Blocks: blocks})
			}
			return false
		}
		return true
	})
	if len(items) > 0 {
		*out = append(*out, &Footnotes{Items: items})
	} else {
		c.children(el, out)
	}
}

func (c *converter) substackFootnote(el *Node, out *[]Block) bool {
	if !footnoteClass.match(el.classAttr()) {
		return false
	}
	number := firstElement(el, func(e *Node) bool { return strings.Contains(e.matchString, "footnote-number") && e.idAttr() != "" })
	id := el.idAttr()
	if number != nil {
		id = number.idAttr()
	}
	if id == "" || !c.notes.has(id) {
		return false
	}
	content := firstElement(el, func(e *Node) bool { return strings.Contains(e.matchString, "footnote-content") })
	if content == nil {
		content = el
	}
	if number != nil {
		number.skip = true
	}
	blocks := []Block{}
	c.children(content, &blocks)
	if len(blocks) == 0 {
		return true
	}
	label, _ := c.notes.get(id)
	note := &Footnote{ID: id, Label: label, Blocks: blocks}
	if n := len(*out); n > 0 {
		if last, ok := (*out)[n-1].(*Footnotes); ok {
			last.Items = append(last.Items, note)
			return true
		}
	}
	*out = append(*out, &Footnotes{Items: []*Footnote{note}})
	return true
}

// ---------------------------------------------------------------- blocks

// children converts a container's children: phrasing runs become paragraphs, blocks convert in place.
func (c *converter) children(el *Node, out *[]Block) {
	if lone := loneCode(el); lone != nil {
		c.code(lone, out)
		return
	}
	inline := &inlineBuilder{conv: c, out: out}
	ctx := ctxT{}
	kids := el.Children
	for i, child := range kids {
		if child.Kind == TextNode {
			inline.text(child.text, ctx)
		} else if child.skip {
			continue
		} else if c.caption(child, out, inline) {
			continue
		} else if isInline(child) {
			c.inline(child, inline, ctx, out)
		} else {
			inline.flush()
			before := len(*out)
			c.block(child, out)
			if len(*out) > before {
				c.attachCaption(*out, kids, i)
			}
		}
	}
	inline.flush()
}

// caption: caption and credit elements outside <figure> are attached to the
// image just emitted, and dropped when no image precedes them.
func (c *converter) caption(el *Node, out *[]Block, inline *inlineBuilder) bool {
	if el.Tag == "img" || el.Tag == "figure" || el.Tag == "picture" || el.Tag == "a" {
		return false
	}
	lowerClass := strings.ToLower(el.classAttr())
	if !(strings.Contains(lowerClass, "caption") || strings.Contains(lowerClass, "credit")) || el.textLen > 400 || hasDescendant(el, "img", 64) || hasDescendant(el, "p", 1) && el.textLen > 200 {
		return false
	}
	lastFigure := func() *Figure {
		if n := len(*out); n > 0 {
			if f, ok := (*out)[n-1].(*Figure); ok {
				return f
			}
		}
		return nil
	}
	if inline != nil && len(inline.nodes) > 0 {
		// Mid-sentence spans are not captions unless an image was just emitted.
		if lastFigure() == nil {
			return false
		}
	}
	if inline != nil {
		inline.flush()
	}
	if last := lastFigure(); last != nil {
		content := c.inlineOnly(el)
		if len(content) > 0 {
			if last.Caption == nil && !strings.Contains(lowerClass, "credit") {
				last.Caption = content
			} else if last.Credit == nil && inlineTextOf(content) != inlineTextOf(last.Caption) {
				last.Credit = content
			}
		}
	}
	return true
}

// attachCaption: a caption element right after an uncaptioned image belongs to it.
func (c *converter) attachCaption(out []Block, kids []*Node, index int) {
	last, ok := out[len(out)-1].(*Figure)
	if !ok || last.Caption != nil {
		return
	}
	for j := index + 1; j < len(kids); j++ {
		next := kids[j]
		if next.Kind == TextNode {
			if !isBlank(next.text) {
				return
			}
			continue
		}
		if next.skip {
			continue
		}
		if captionClass.matchEl(next) && next.Tag != "img" && u16len(collapse(rawText(next))) < 500 {
			if caption := c.inlineOnly(next); len(caption) > 0 {
				last.Caption = caption
			}
			next.skip = true
		}
		return
	}
}

func (c *converter) block(el *Node, out *[]Block) {
	if el.skip {
		return
	}
	switch el.Tag {
	case "p":
		c.children(el, out)
	case "h1", "h2", "h3", "h4", "h5", "h6":
		c.heading(el, out)
	case "ul", "ol", "menu", "dir":
		c.list(el, out)
	case "dl":
		c.definitions(el, out)
	case "blockquote":
		c.quote(el, out)
	case "pre", "xmp", "listing", "plaintext":
		c.code(el, out)
	case "figure":
		c.figure(el, out)
	case "table":
		c.table(el, out)
	case "hr":
		*out = append(*out, &Rule{})
	case "details":
		c.details(el, out)
	case "img", "picture":
		c.standaloneImage(el, out)
	case "iframe":
		if block := frameBlock(el, c.base); block != nil {
			if code, ok := block.(*Code); ok {
				block = c.codeBlock(code.Code, "plaintext")
			}
			*out = append(*out, block)
		}
	case "video", "audio":
		if block := mediaFromElement(el, c.base); block != nil {
			*out = append(*out, block)
		}
	case "math", "math-tex":
		c.mathBlock(el, out)
	case "noscript":
		c.noscript(el, out)
	case "svg", "input", "meta", "link", "title", "source", "track", "colgroup", "col", "br", "summary", "figcaption":
	case "li", "dd", "dt", "td", "th", "tr", "tbody", "thead", "tfoot", "caption":
		c.children(el, out)
	default:
		c.container(el, out)
	}
}

func (c *converter) container(el *Node, out *[]Block) {
	if codeTitle.matchEl(el) && el.textLen < 120 && !hasDescendant(el, "pre", 64) {
		title := plainLabel(el)
		if n := u16len(title); n > 0 && n < 120 {
			c.pendingCodeTitle = &title
		}
		return
	}
	if c.isFootnoteContainer(el) {
		c.footnotes(el, out)
		return
	}
	if c.substackFootnote(el, out) {
		return
	}
	// Margin or hover copies of notes that the footnote list also has.
	if len(c.noteItems) > 0 && (strings.Contains(el.matchString, "footnote") || strings.Contains(el.matchString, "sidenote") || strings.Contains(el.matchString, "marginnote")) && el.textLen < 3000 && c.isNoteCopy(el) {
		return
	}
	if video := lazyVideo(el); video != nil {
		*out = append(*out, video)
		return
	}
	if social := socialProvider(el); social != "" {
		c.embed(el, social, out)
		return
	}
	if isCodeTable(el) {
		c.codeTable(el, out)
		return
	}
	if el.Tag != "body" && isCallout(el) && el.textLen > 0 && el.textLen < 3000 {
		c.callout(el, out)
		return
	}
	if figureLike.matchEl(el) && el.textLen < 600 && hasDescendant(el, "img", 64) && !hasDescendant(el, "p", 2) {
		c.figure(el, out)
		return
	}
	c.children(el, out)
}

// ---------------------------------------------------------------- inline

func (c *converter) inline(el *Node, b *inlineBuilder, ctx ctxT, out *[]Block) {
	if el.skip {
		return
	}
	b.edge = true
	c.inlineElement(el, b, ctx, out)
	b.edge = true
}

// stripBrackets is `.replace(/^\[|\]$/g, ”).trim()`.
func stripBrackets(s string) string {
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	return jsTrim(s)
}

// isPermalinkText is `/^[#¶§🔗]?$/u`.
func isPermalinkText(s string) bool {
	switch s {
	case "", "#", "¶", "§", "🔗":
		return true
	}
	return false
}

func (c *converter) inlineElement(el *Node, b *inlineBuilder, ctx ctxT, out *[]Block) {
	if c.caption(el, out, b) {
		return
	}
	tag := el.Tag
	if tag != "a" && !c.inNote && strings.Contains(el.matchString, "note") && inlineNoteCls.matchEl(el) && c.inlineNote(el, b) {
		return
	}
	if c.notes.size() > 0 && tag != "a" {
		// Script-driven references: <span class="foot-ref" data-footnote="footnote-esb">5</span>.
		target := firstNonNil(el.attrPtr("data-footnote"), el.attrPtr("data-footnote-id"), el.attrPtr("data-fn"), el.attrPtr("data-note"))
		if target != nil && c.notes.has(*target) {
			label := stripBrackets(collapse(rawText(el)))
			if label == "" {
				label, _ = c.notes.get(*target)
			}
			if _, ok := c.refLabels[*target]; !ok {
				c.refLabels[*target] = label
			}
			b.push(&FootnoteRef{ID: *target, Label: label})
			return
		}
	}
	switch tag {
	case "br":
		b.lineBreak()
		return
	case "wbr", "input", "meta", "link", "source", "track", "svg", "rp":
		return
	case "img", "picture":
		img := el
		if tag == "picture" {
			img = firstTag(el, "img")
		}
		if img == nil || strings.Contains(img.classAttr(), "mwe-math-fallback-image") {
			return
		}
		image := imageFrom(img, c.base)
		if image == nil {
			image = c.noscriptImage(img)
		}
		if image == nil || isDecorativeImage(img, image, c.base) {
			return
		}
		if isSmallImage(img, image) {
			b.push(&InlineImage{Src: image.Src, Alt: image.Alt, Width: image.Width, Height: image.Height})
			return
		}
		b.flush()
		if isStillOf(*out, image) {
			return
		}
		// A linked full-size file; mailto:/tel: stay on text.
		if ctx.href != "" && image.Href == "" && ctx.href != image.Src && (hasPrefixFold(ctx.href, "http:") || hasPrefixFold(ctx.href, "https:")) && hasRasterExt(ctx.href) {
			image.Href = ctx.href
		}
		*out = append(*out, &Figure{Images: []*Image{image}})
		return
	case "math", "math-tex":
		node := mathInline(el)
		if node == nil {
			return
		}
		if isDisplayMath(el) {
			c.displayMath[node] = true
		}
		b.push(node)
		return
	case "noscript":
		return
	case "a":
		href, hasHref := el.attr("href")
		if hasHref && strings.HasPrefix(href, "#") {
			id := decodeFragment(href[1:])
			if c.notes.has(id) {
				label := stripBrackets(collapse(rawText(el)))
				if label == "" {
					label, _ = c.notes.get(id)
				}
				if _, ok := c.refLabels[id]; !ok {
					c.refLabels[id] = label
				}
				b.push(&FootnoteRef{ID: id, Label: label})
				return
			}
			linkText := collapse(rawText(el))
			if backlink.matchEl(el) || strings.HasPrefix(linkText, "↩") || strings.HasPrefix(linkText, "↑") || strings.HasPrefix(linkText, "^") {
				return
			}
			// Permalink glyphs go; a permalink wrapping the heading's own words keeps them.
			if isPermalinkText(linkText) {
				return
			}
			// "[1]" pointing at a plain anchor: a note reference until proven otherwise (see resolveRefs).
			if m := refNumber.FindStringSubmatch(linkText); m != nil && id != "" && !c.inNote {
				ref := &FootnoteRef{ID: id, Label: m[1]}
				c.provisional[ref] = linkText
				if !c.pendingRefs.has(id) {
					c.pendingRefs.set(id, m[1])
				}
				b.push(ref)
				return
			}
			// Other in-page links read as plain text.
			c.inlineChildren(el, b, ctx, out)
			return
		}
		// <a id="introduction">Introduction</a> outside a heading: a section anchor whose label is shown only to screen readers or the TOC.
		if !hasHref && el.idAttr() != "" && slug(collapse(rawText(el))) == jsLower(el.idAttr()) && closestHeading(el) == nil {
			return
		}
		if !hasHref && len(b.nodes) <= 1 {
			lead := jsTrim(inlineTextOf(b.nodes))
			if lead == "[" || lead == "(" {
				lead = ""
			}
			if lead == "" {
				anchor := el.idAttr()
				if name, ok := el.attr("name"); ok {
					anchor = name
				}
				if anchor != "" && c.pendingRefs.has(anchor) {
					b.anchor = anchor
				}
			}
		}
		if permalink.matchEl(el) && isPermalinkText(collapse(rawText(el))) {
			return
		}
		linkCtx := ctx
		if hasHref {
			if resolved, ok := resolveURL(href, c.base); ok && isLinkScheme(resolved) {
				linkCtx = ctxT{marks: ctx.marks, href: resolved}
			}
		}
		c.inlineChildren(el, b, linkCtx, out)
		return
	case "q":
		b.text("“", ctx)
		c.inlineChildren(el, b, ctx, out)
		b.text("”", ctx)
		return
	case "sup", "sub":
		ref := firstElement(el, func(e *Node) bool {
			href := e.av("href")
			return e.Tag == "a" && strings.HasPrefix(href, "#") && c.notes.has(decodeFragment(href[1:]))
		})
		if ref != nil {
			c.inlineChildren(el, b, ctx, out)
			return
		}
	case "span", "font":
		if tag == "span" && isAlternative(el) {
			return
		}
		if style, ok := el.attr("style"); ok {
			marks := append([]Mark(nil), ctx.marks...)
			if fontBold.MatchString(style) {
				marks = append(marks, MarkBold)
			}
			if fontItalic.MatchString(style) {
				marks = append(marks, MarkItalic)
			}
			if len(marks) != len(ctx.marks) {
				c.inlineChildren(el, b, ctxT{marks: marks, href: ctx.href}, out)
				return
			}
		}
	}
	if mark, ok := tagMark[tag]; ok && !hasMark(ctx.marks, mark) {
		marks := make([]Mark, len(ctx.marks), len(ctx.marks)+1)
		copy(marks, ctx.marks)
		c.inlineChildren(el, b, ctxT{marks: append(marks, mark), href: ctx.href}, out)
		return
	}
	c.inlineChildren(el, b, ctx, out)
}

// isLinkScheme is `/^(?:https?|mailto|tel):/i`.
func isLinkScheme(url string) bool {
	return hasPrefixFold(url, "http:") || hasPrefixFold(url, "https:") || hasPrefixFold(url, "mailto:") || hasPrefixFold(url, "tel:")
}

// hasRasterExt is `/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i`.
func hasRasterExt(s string) bool {
	for i := strings.IndexByte(s, '.'); i >= 0; {
		rest := s[i+1:]
		for _, ext := range [...]string{"jpg", "jpeg", "png", "webp", "gif", "avif"} {
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

// inlineNote: a note written where it is referenced (LaTeXML, sidenotes)
// becomes a ref, and the note goes to the end.
func (c *converter) inlineNote(el *Node, b *inlineBuilder) bool {
	text := collapse(rawText(el))
	mark := firstElement(el, func(e *Node) bool { return e.Tag == "sup" || noteMark.matchEl(e) })
	label := ""
	if mark != nil {
		label = collapse(rawText(mark))
		label = strings.TrimPrefix(label, "[")
		label = strings.TrimSuffix(label, "]")
	}
	// A bare marker ("1", "[2]") is a reference, not a note.
	if u16len(text) <= u16len(label)+3 || u16len(label) > 4 {
		return false
	}
	content := firstElement(el, func(e *Node) bool { return noteContent.matchEl(e) })
	if content == nil {
		content = el
	}
	// The marker is hidden while the note is read, and only un-hidden if it was shown before.
	hide := mark != nil && !mark.skip && !isAncestor(mark, content)
	if hide {
		mark.skip = true
	}
	c.inNote = true
	inline := c.inlineOnly(content)
	c.inNote = false
	if hide {
		mark.skip = false
	}
	if len(inline) == 0 {
		return false
	}
	blocks := []Block{&Paragraph{Content: inline}}
	n := len(c.inlineNotes) + 1
	noteLabel := label
	if noteLabel == "" {
		noteLabel = strconv.Itoa(n)
	}
	blocks = stripNoteLabel(blocks, noteLabel)
	if len(blocks) == 0 {
		return false
	}
	id := el.idAttr()
	if id == "" {
		id = "note-" + strconv.Itoa(n)
	}
	if c.notes.has(id) {
		id = "inline-" + id
	}
	c.inlineNotes = append(c.inlineNotes, &Footnote{ID: id, Label: noteLabel, Blocks: blocks})
	b.push(&FootnoteRef{ID: id, Label: noteLabel})
	return true
}

func (c *converter) inlineChildren(el *Node, b *inlineBuilder, ctx ctxT, out *[]Block) {
	for _, child := range el.Children {
		if child.Kind == TextNode {
			b.text(child.text, ctx)
		} else if !child.skip {
			if isInline(child) {
				c.inline(child, b, ctx, out)
			} else {
				b.flush()
				c.block(child, out)
			}
		}
	}
}

// inlineOnly is the inline content of an element, flattening any blocks inside it (headings, captions, cells, terms).
func (c *converter) inlineOnly(el *Node) []Inline {
	b := &inlineBuilder{conv: c}
	sink := []Block{}
	var visit func(node *Node, ctx ctxT)
	visit = func(node *Node, ctx ctxT) {
		for _, child := range node.Children {
			if child.Kind == TextNode {
				b.text(child.text, ctx)
				continue
			}
			if child.skip {
				continue
			}
			tag := child.Tag
			if tag == "img" || tag == "picture" {
				img := child
				if tag == "picture" {
					img = firstTag(child, "img")
				}
				if img == nil || strings.Contains(img.classAttr(), "mwe-math-fallback-image") {
					continue
				}
				image := imageFrom(img, c.base)
				if image != nil && !isDecorativeImage(img, image, c.base) && isSmallImage(img, image) {
					b.push(&InlineImage{Src: image.Src, Alt: image.Alt, Width: image.Width, Height: image.Height})
				}
				continue
			}
			if tag == "br" {
				b.lineBreak()
				continue
			}
			if tag == "math" || tag == "math-tex" {
				if m := mathInline(child); m != nil {
					b.push(m)
				}
				continue
			}
			switch tag {
			case "svg", "input", "noscript", "iframe", "video", "audio", "button":
				continue
			}
			block := isConvBlockTag(tag)
			if block && len(b.nodes) > 0 {
				b.lineBreak()
			}
			if isInlineTag(tag) {
				c.inline(child, b, ctx, &sink)
			} else {
				b.edge = true
				visit(child, ctx)
				b.edge = true
			}
			if block {
				b.lineBreak()
			}
		}
	}
	visit(el, ctxT{})
	return b.result()
}

// ---------------------------------------------------------------- headings, lists, quotes

func (c *converter) heading(el *Node, out *[]Block) {
	// Wordless links to a fragment (the heading's permalink icon) are not part of the heading.
	var icons []*Node
	walk(el, func(e *Node) bool {
		if e.Tag == "a" && !e.skip && strings.Contains(e.av("href"), "#") && isBlank(stripZeroWidth(rawText(e))) {
			icons = append(icons, e)
			e.skip = true
			return false
		}
		return true
	})
	content := c.inlineOnly(el)
	for _, icon := range icons {
		icon.skip = false
	}
	if len(content) == 0 {
		return
	}
	block := &Heading{Level: int(el.Tag[1] - '0'), Content: content}
	anchor := el.idAttr()
	if anchor == "" {
		if a := firstElement(el, func(e *Node) bool { return e.idAttr() != "" || (e.Tag == "a" && e.has("name")) }); a != nil {
			anchor = a.idAttr()
			if anchor == "" {
				anchor = a.av("name")
			}
		}
	}
	block.Anchor = anchor
	*out = append(*out, block)
}

func (c *converter) list(el *Node, out *[]Block) {
	var items []*ListItem
	ordered := el.Tag == "ol"
	start, hasStart := intAttr(el, "start")
	number := 1.0
	if hasStart {
		number = start
	}
	for _, child := range el.Children {
		if child.Kind == TextNode {
			if !isBlank(child.text) {
				items = append(items, &ListItem{Blocks: []Block{&Paragraph{Content: normalizeInlines([]Inline{&TextRun{Text: child.text}})}}})
			}
			continue
		}
		if child.skip {
			continue
		}
		blocks := []Block{}
		if child.Tag == "li" {
			if v, ok := intAttr(child, "value"); ok {
				number = v
			}
			// LaTeXML writes the marker as text before the item's paragraphs: <span class="ltx_tag ltx_tag_item">•</span>.
			label := itemLabel(child)
			if label != nil {
				label.skip = true
			}
			c.children(child, &blocks)
			if label != nil {
				label.skip = false
				blocks = prependLabel(blocks, collapse(rawText(label)))
			}
			if ordered {
				blocks = stripItemMarker(blocks, &number)
			} else {
				blocks = stripItemMarker(blocks, nil)
			}
			number++
			if len(blocks) == 0 {
				continue
			}
			item := &ListItem{Blocks: blocks}
			if box := firstElement(child, func(e *Node) bool { return e.Tag == "input" && jsLower(e.av("type")) == "checkbox" }); box != nil {
				checked := box.has("checked")
				item.Checked = &checked
			}
			if c.pendingRefs.size() > 0 && el.Tag == "ol" {
				c.itemSources[item] = child
			}
			items = append(items, item)
		} else {
			c.block(child, &blocks)
			if len(blocks) == 0 {
				continue
			}
			if (child.Tag == "ul" || child.Tag == "ol") && len(items) > 0 {
				prev := items[len(items)-1]
				prev.Blocks = append(prev.Blocks, blocks...)
			} else {
				items = append(items, &ListItem{Blocks: blocks})
			}
		}
	}
	if len(items) == 0 {
		return
	}
	if len(items) > 1 {
		gallery := true
		for _, item := range items {
			if len(item.Blocks) != 1 {
				gallery = false
				break
			}
			if _, ok := item.Blocks[0].(*Figure); !ok {
				gallery = false
				break
			}
		}
		if gallery {
			var images []*Image
			for _, item := range items {
				for _, image := range item.Blocks[0].(*Figure).Images {
					dup := false
					for _, x := range images {
						if x.Src == image.Src {
							dup = true
							break
						}
					}
					if !dup {
						images = append(images, image)
					}
				}
			}
			*out = append(*out, &Figure{Images: images})
			return
		}
	}
	block := &List{Ordered: ordered, Items: items}
	if ordered && hasStart && start != 1 {
		s := int(start)
		block.Start = &s
	}
	*out = append(*out, block)
}

func (c *converter) definitions(el *Node, out *[]Block) {
	var items []*Definition
	var current *Definition
	var visit func(parent *Node)
	visit = func(parent *Node) {
		for _, child := range parent.Children {
			if child.Kind != ElementNode || child.skip {
				continue
			}
			switch child.Tag {
			case "dt":
				current = &Definition{Term: c.inlineOnly(child), Details: []Block{}}
				items = append(items, current)
			case "dd":
				if current == nil {
					current = &Definition{Term: []Inline{}, Details: []Block{}}
					items = append(items, current)
				}
				c.children(child, &current.Details)
			case "div":
				visit(child)
			}
		}
	}
	visit(el)
	var kept []*Definition
	for _, d := range items {
		if len(d.Term) > 0 || len(d.Details) > 0 {
			kept = append(kept, d)
		}
	}
	if len(kept) > 0 {
		*out = append(*out, &DefinitionList{Items: kept})
	}
}

func (c *converter) quote(el *Node, out *[]Block) {
	if social := socialProvider(el); social != "" {
		c.embed(el, social, out)
		return
	}
	var citeEl *Node
	for _, child := range el.Children {
		if child.Kind == ElementNode && !child.skip && (child.Tag == "footer" || child.Tag == "cite") {
			citeEl = child
		}
	}
	blocks := []Block{}
	if citeEl != nil {
		citeEl.skip = true
	}
	c.children(el, &blocks)
	if citeEl != nil {
		citeEl.skip = false
	}
	if len(blocks) == 0 {
		return
	}
	block := &Quote{Blocks: blocks}
	if citeEl != nil {
		if cite := c.inlineOnly(citeEl); len(cite) > 0 {
			block.Cite = cite
		}
	}
	if pullQuote.matchEl(el) || el.Parent != nil && pullQuote.matchEl(el.Parent) {
		block.Pull = true
	}
	*out = append(*out, block)
}

func (c *converter) embed(el *Node, provider string, out *[]Block) {
	var links []string
	walkAll(el, func(e *Node) {
		if e.Tag == "a" {
			if href, ok := e.attr("href"); ok {
				if abs, ok := resolveHTTP(href, c.base); ok {
					links = append(links, abs)
				}
			}
		}
	})
	url, hasURL := "", false
	if provider == "twitter" {
		for i := len(links) - 1; i >= 0; i-- {
			if tweetURL.MatchString(links[i]) {
				url, hasURL = links[i], true
				break
			}
		}
	}
	for _, key := range [...]string{"data-instgrm-permalink", "cite", "data-bluesky-uri", "data-href"} {
		if hasURL {
			break
		}
		if v, ok := el.attr(key); ok {
			url, hasURL = resolveHTTP(v, c.base)
		}
	}
	if !hasURL && len(links) > 0 {
		url, hasURL = links[len(links)-1], true
	}
	blocks := []Block{}
	c.children(el, &blocks)
	author := ""
	if n := len(blocks); n > 0 {
		if last, ok := blocks[n-1].(*Paragraph); ok {
			var text strings.Builder
			for _, node := range last.Content {
				if run, ok := node.(*TextRun); ok {
					text.WriteString(run.Text)
				}
			}
			t := text.String()
			// The name starts and ends on a non-space: a long run of spaces is not retried at every split.
			m := embedAuthor.FindStringSubmatchIndex(t)
			if m == nil {
				m = embedAuthor2.FindStringSubmatchIndex(t)
			}
			if m != nil {
				name, _ := group(t, m, 1)
				author = name
				if len(m) > 5 {
					if handle, ok := group(t, m, 2); ok {
						author = name + " (" + handle + ")"
					}
				}
				blocks = blocks[:n-1]
			}
		}
	}
	if !hasURL {
		*out = append(*out, blocks...)
		return
	}
	block := &Embed{Provider: provider, URL: url, Author: author}
	if len(blocks) > 0 {
		block.Blocks = blocks
	}
	*out = append(*out, block)
}

func (c *converter) callout(el *Node, out *[]Block) {
	m := el.matchString
	containsAny := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(m, w) {
				return true
			}
		}
		return false
	}
	variant := ""
	switch {
	case containsAny("danger", "error", "critical"):
		variant = "danger"
	case containsAny("warning", "caution", "attention", "important"):
		variant = "warning"
	case containsAny("tip", "hint", "success"):
		variant = "tip"
	case containsAny("info", "notice"):
		variant = "info"
	case containsAny("note", "admonition", "callout", "notecard"):
		variant = "note"
	}
	var titleEl *Node
	walk(el, func(e *Node) bool {
		if titleEl != nil || e == el {
			return titleEl == nil
		}
		if calloutTitle.matchEl(e) && e.textLen < 100 {
			titleEl = e
			return false
		}
		return e.Tag == "div" || e.Tag == "p"
	})
	// A short heading opening the box ("Note") is its title (whitespace and skipped elements before it don't count).
	if titleEl == nil {
		for _, child := range el.Children {
			if child.Kind == TextNode {
				if !isBlank(child.text) {
					break
				}
				continue
			}
			if child.skip {
				continue
			}
			if len(child.Tag) == 2 && child.Tag[0] == 'h' && child.Tag[1] >= '2' && child.Tag[1] <= '6' && child.textLen < 60 {
				titleEl = child
			}
			break
		}
	}
	var title []Inline
	if titleEl != nil {
		title = c.inlineOnly(titleEl)
		titleEl.skip = true
	}
	blocks := []Block{}
	c.children(el, &blocks)
	if titleEl != nil {
		titleEl.skip = false
	}
	if len(blocks) == 0 {
		if len(title) > 0 {
			*out = append(*out, &Paragraph{Content: title})
		}
		return
	}
	block := &Callout{Variant: variant, Blocks: blocks}
	// A title that only names the variant ("note", "Warning") repeats what the renderer already shows.
	if len(title) > 0 && !(variant != "" && jsLower(jsTrim(inlineTextOf(title))) == variant) {
		block.Title = title
	}
	*out = append(*out, block)
}

func (c *converter) details(el *Node, out *[]Block) {
	var summaryEl *Node
	for _, child := range el.Children {
		if child.Kind == ElementNode && child.Tag == "summary" && summaryEl == nil {
			summaryEl = child
		}
	}
	summary := []Inline{}
	if summaryEl != nil {
		summary = c.inlineOnly(summaryEl)
	}
	blocks := []Block{}
	c.children(el, &blocks)
	// A disclosure whose body was all chrome (badges, widgets) is chrome too.
	if len(blocks) == 0 {
		return
	}
	*out = append(*out, &Details{Summary: summary, Blocks: blocks})
}

// ---------------------------------------------------------------- code

func (c *converter) code(el *Node, out *[]Block) {
	// Some sites wrap prose in <pre>; a pre full of block markup is not code.
	if hasDescendant(el, "p", 64) && hasDescendant(el, "p", 1) && !hasDescendant(el, "code", 64) {
		c.children(el, out)
		return
	}
	// One listing in several flavours (<code class="language-mjs"> and <code class="language-cjs">): one block each.
	var flavours []*Node
	for _, child := range el.Children {
		if child.Kind == ElementNode && !child.skip && child.Tag == "code" {
			flavours = append(flavours, child)
		}
	}
	if len(flavours) > 1 {
		for _, flavour := range flavours {
			text := codeText(flavour)
			if !isBlank(text) {
				*out = append(*out, c.codeBlock(text, codeLanguage(flavour)))
			}
		}
		return
	}
	code := codeText(el)
	if isBlank(code) {
		return
	}
	*out = append(*out, c.codeBlock(code, codeLanguage(el)))
}

// codeBlock: marked is the language from markup ("" when none).
func (c *converter) codeBlock(code, marked string) Block {
	block := &Code{Code: code}
	if marked != "" && marked != "plaintext" {
		block.Language = marked
		block.LanguageSource = "markup"
	} else if marked == "" {
		if detected := DetectLanguage(code); detected != "" {
			block.Language = detected
			block.LanguageSource = "detected"
		}
	}
	if c.pendingCodeTitle != nil {
		block.Title = c.pendingCodeTitle
		c.pendingCodeTitle = nil
	}
	return block
}

func (c *converter) codeTable(el *Node, out *[]Block) {
	var lines []string
	var preCode *Node
	walk(el, func(e *Node) bool {
		if preCode != nil {
			return false
		}
		if e.Tag == "td" && codeCell.matchEl(e) && !gutter.matchEl(e) {
			pre := firstTag(e, "pre")
			if pre != nil && e.Parent != nil && countTag(el, "tr") <= 2 {
				preCode = pre
				return false
			}
			lines = append(lines, strings.TrimSuffix(codeText(e), "\n"))
			return false
		}
		return true
	})
	if preCode != nil {
		c.code(preCode, out)
		return
	}
	code := jsTrimEnd(strings.TrimLeft(strings.Join(lines, "\n"), "\n"))
	if code == "" {
		c.children(el, out)
		return
	}
	lang := ""
	for p := el; p != nil && lang == ""; p = p.Parent {
		lang = LanguageFromClass(p.classAttr())
		if lang == "" {
			v := p.attrPtr("data-lang")
			if v == nil {
				v = p.attrPtr("data-language")
			}
			if v != nil {
				lang = NormalizeLanguage(*v)
			}
		}
	}
	*out = append(*out, c.codeBlock(code, lang))
}

// ---------------------------------------------------------------- media

func (c *converter) noscriptImage(img *Node) *Image {
	parent := img.Parent
	if parent == nil {
		return nil
	}
	i := indexOf(parent.Children, img)
	for j := i + 1; j < len(parent.Children) && j <= i+3; j++ {
		sibling := parent.Children[j]
		if sibling.Kind == ElementNode && sibling.Tag == "noscript" {
			if inner := firstTag(sibling, "img"); inner != nil {
				sibling.skip = true
				return imageFrom(inner, c.base)
			}
		}
	}
	return nil
}

func (c *converter) noscript(el *Node, out *[]Block) {
	// Lazy-load fallbacks: only used when the lazy image right before it produced nothing.
	img := firstTag(el, "img")
	if img == nil {
		return
	}
	if parent := el.Parent; parent != nil {
		i := indexOf(parent.Children, el)
		for j := i - 1; j >= 0; j-- {
			prev := parent.Children[j]
			if prev.Kind == TextNode {
				if !isBlank(prev.text) {
					break
				}
				continue
			}
			if prev.Tag == "img" || prev.Tag == "picture" || hasDescendant(prev, "img", 64) {
				prevImg := prev
				if prev.Tag != "img" {
					prevImg = firstTag(prev, "img")
				}
				if prevImg != nil && imageFrom(prevImg, c.base) != nil {
					return
				}
			}
			break
		}
	}
	c.standaloneImage(img, out)
}

func (c *converter) standaloneImage(el *Node, out *[]Block) {
	img := el
	if el.Tag == "picture" {
		img = firstTag(el, "img")
	}
	if img == nil || strings.Contains(img.classAttr(), "mwe-math-fallback-image") {
		return
	}
	image := imageFrom(img, c.base)
	if image == nil {
		image = c.noscriptImage(img)
	}
	if image == nil || isDecorativeImage(img, image, c.base) {
		return
	}
	if isStillOf(*out, image) {
		return
	}
	if isSmallImage(img, image) {
		*out = append(*out, &Paragraph{Content: []Inline{&InlineImage{Src: image.Src, Alt: image.Alt, Width: image.Width, Height: image.Height}}})
		return
	}
	*out = append(*out, &Figure{Images: []*Image{image}})
}

func (c *converter) figure(el *Node, out *[]Block) {
	var captionEl *Node
	walk(el, func(e *Node) bool {
		if captionEl != nil || e.skip {
			return false
		}
		if e != el && (e.Tag == "figcaption" || (captionClass.matchEl(e) && e.Tag != "img" && e.Tag != "figure")) {
			captionEl = e
			return false
		}
		return true
	})
	var images []*Image
	var media []Block
	other := false
	// Short texts positioned over a figure with nothing else to show: the labels of a graphic drawn by script.
	var overlays []*Node
	walk(el, func(e *Node) bool {
		if e.skip || e == captionEl {
			return false
		}
		if e != el && e.textLen > 0 && e.textLen < 100 && absolutePos.MatchString(e.av("style")) {
			overlays = append(overlays, e)
		}
		switch e.Tag {
		case "img":
			if strings.Contains(e.classAttr(), "mwe-math-fallback-image") {
				return false
			}
			image := imageFrom(e, c.base)
			if image == nil {
				image = c.noscriptImage(e)
			}
			if image != nil && !isDecorativeImage(e, image, c.base) {
				dup := false
				for _, i := range images {
					if i.Src == image.Src {
						dup = true
						break
					}
				}
				if !dup {
					images = append(images, image)
				}
			}
			return false
		case "noscript":
			return false
		case "iframe":
			if block := frameBlock(e, c.base); block != nil {
				if code, ok := block.(*Code); ok {
					block = c.codeBlock(code.Code, "plaintext")
				}
				media = append(media, block)
			}
			return false
		case "video", "audio":
			if block := mediaFromElement(e, c.base); block != nil {
				media = append(media, block)
			}
			return false
		case "pre", "table", "blockquote", "math", "ul", "ol":
			other = true
			return false
		}
		if e != el {
			if video := lazyVideo(e); video != nil {
				media = append(media, video)
				return false
			}
		}
		return true
	})

	var caption, credit []Inline
	if captionEl != nil {
		creditEl := firstElement(captionEl, func(e *Node) bool { return creditClass.matchEl(e) })
		if creditEl != nil {
			credit = c.inlineOnly(creditEl)
			creditEl.skip = true
		}
		caption = c.inlineOnly(captionEl)
		if creditEl != nil {
			creditEl.skip = false
		}
	}

	// A video file's still drawn as an image (the poster): one video, not a figure and a video.
	if len(media) == 1 && !other {
		if file, ok := media[0].(*Video); ok && file.Provider == "file" {
			if file.Poster == "" && len(images) == 1 {
				file.Poster = images[0].Src
			}
			for i := len(images) - 1; i >= 0; i-- {
				if images[i].Src == file.Poster {
					images = append(images[:i], images[i+1:]...)
				}
			}
		}
	}

	if len(images) == 0 && len(media) == 0 || other {
		// Code listings, tables and quotes in a <figure>: convert the content, keep the caption as text.
		if captionEl != nil {
			captionEl.skip = true
		}
		if !other {
			for _, overlay := range overlays {
				overlay.skip = true
			}
		}
		before := len(*out)
		c.children(el, out)
		if captionEl != nil {
			captionEl.skip = false
		}
		if !other {
			for _, overlay := range overlays {
				overlay.skip = false
			}
		}
		if len(caption) > 0 {
			var first Block
			if len(*out) > before {
				first = (*out)[before]
			}
			single := len(*out) == before+1
			switch f := first.(type) {
			case *Table:
				if single && f.Caption == nil {
					f.Caption = caption
					return
				}
			case *Quote:
				if single && f.Cite == nil {
					f.Cite = caption
					return
				}
			case *Code:
				if single && f.Title == nil && len(caption) == 1 {
					t := textOfInlines(caption)
					f.Title = &t
					return
				}
			}
			*out = append(*out, &Paragraph{Content: caption})
		}
		return
	}
	if len(images) == 0 {
		if len(caption) > 0 {
			switch b := media[0].(type) {
			case *Video:
				b.Caption = caption
			case *Audio:
				b.Caption = caption
			}
		}
		*out = append(*out, media...)
		return
	}
	if len(credit) == 0 && len(caption) > 0 {
		caption, credit = splitCredit(caption)
	}
	figure := &Figure{Images: images}
	if len(caption) > 0 {
		figure.Caption = caption
	}
	if len(credit) > 0 {
		figure.Credit = credit
	}
	*out = append(*out, figure)
	*out = append(*out, media...)
}

func (c *converter) mathBlock(el *Node, out *[]Block) {
	node := mathInline(el)
	if node == nil {
		return
	}
	*out = append(*out, &MathBlock{Tex: node.Tex, MathML: node.MathML, Text: node.Text})
}

// ---------------------------------------------------------------- tables

func (c *converter) table(el *Node, out *[]Block) {
	if isCodeTable(el) {
		c.codeTable(el, out)
		return
	}
	if !isDataTableCached(el) {
		for _, row := range tableRows(el) {
			for _, cell := range row.cells {
				c.children(cell, out)
			}
		}
		for _, child := range el.Children {
			if child.Kind == ElementNode && child.Tag == "caption" && !child.skip {
				c.children(child, out)
			}
		}
		return
	}
	var rows []*TableRow
	headerRows := 0
	counting := true
	for _, row := range tableRows(el) {
		var cells []*TableCell
		allHeader := true
		for _, cellEl := range row.cells {
			cell := &TableCell{Content: c.inlineOnly(cellEl)}
			if cellEl.Tag == "th" || row.head {
				cell.Header = true
			} else {
				allHeader = false
			}
			if colspan, ok := intAttr(cellEl, "colspan"); ok && colspan > 1 {
				cell.Colspan = int(min(colspan, 100))
			}
			if rowspan, ok := intAttr(cellEl, "rowspan"); ok && rowspan > 1 {
				cell.Rowspan = int(min(rowspan, 1000))
			}
			align := cellEl.attrPtr("align")
			var alignValue string
			if align != nil {
				alignValue = *align
			} else if m := textAlign.FindStringSubmatch(cellEl.av("style")); m != nil {
				alignValue = m[1]
			}
			switch a := jsLower(alignValue); a {
			case "left", "center", "right":
				cell.Align = a
			}
			cells = append(cells, cell)
		}
		if len(cells) == 0 {
			continue
		}
		empty := true
		for _, cell := range cells {
			if len(cell.Content) > 0 {
				empty = false
				break
			}
		}
		if empty && len(rows) > 0 {
			continue
		}
		rows = append(rows, &TableRow{Cells: cells})
		if counting && allHeader {
			headerRows++
		} else {
			counting = false
		}
	}
	if len(rows) == 0 {
		return
	}
	block := &Table{Rows: rows}
	for _, child := range el.Children {
		if child.Kind == ElementNode && child.Tag == "caption" && !child.skip {
			if caption := c.inlineOnly(child); len(caption) > 0 {
				block.Caption = caption
			}
			break
		}
	}
	if headerRows > 0 && headerRows < len(rows) {
		block.HeaderRows = headerRows
	} else if headerRows > 0 && headerRows == len(rows) && len(rows) > 1 {
		block.HeaderRows = 1
	}
	*out = append(*out, block)
}

// eachInlines calls visit with every inline array in blocks, nested blocks included.
func eachInlines(blocks []Block, visit func(content *[]Inline)) {
	for _, b := range blocks {
		switch b := b.(type) {
		case *Paragraph:
			visit(&b.Content)
		case *Heading:
			visit(&b.Content)
		case *List:
			for _, item := range b.Items {
				eachInlines(item.Blocks, visit)
			}
		case *Quote:
			eachInlines(b.Blocks, visit)
			if b.Cite != nil {
				visit(&b.Cite)
			}
		case *Callout:
			eachInlines(b.Blocks, visit)
			if b.Title != nil {
				visit(&b.Title)
			}
		case *Details:
			visit(&b.Summary)
			eachInlines(b.Blocks, visit)
		case *DefinitionList:
			for _, item := range b.Items {
				visit(&item.Term)
				eachInlines(item.Details, visit)
			}
		case *Table:
			for _, row := range b.Rows {
				for _, cell := range row.Cells {
					visit(&cell.Content)
				}
			}
			if b.Caption != nil {
				visit(&b.Caption)
			}
		case *Figure:
			if b.Caption != nil {
				visit(&b.Caption)
			}
			if b.Credit != nil {
				visit(&b.Credit)
			}
		case *Footnotes:
			for _, item := range b.Items {
				eachInlines(item.Blocks, visit)
			}
		case *Embed:
			if b.Blocks != nil {
				eachInlines(b.Blocks, visit)
			}
		}
	}
}

// plainLabel is the text of a label without the widgets inside it.
func plainLabel(el *Node) string {
	var out strings.Builder
	var visit func(node *Node)
	visit = func(node *Node) {
		for _, child := range node.Children {
			if child.Kind == TextNode {
				out.WriteString(child.text)
			} else if !child.skip && !isWidget(child) {
				visit(child)
			}
		}
	}
	visit(el)
	return collapse(out.String())
}

func isWidget(el *Node) bool {
	if el.Tag == "label" || el.Tag == "button" || el.Tag == "select" || el.Tag == "input" || el.has("aria-haspopup") {
		return true
	}
	role, ok := el.attr("role")
	return ok && role != "none" && role != "presentation" && role != "heading"
}

// splitClassWords is `s.toLowerCase().split(/[\s_-]+/)`.
func splitClassWords(s string) []string {
	s = jsLower(s)
	var out []string
	start := 0
	for i := 0; i < len(s); {
		sp, size := jsSpaceAt(s, i)
		if sp || s[i] == '_' || s[i] == '-' {
			out = append(out, s[start:i])
			i += size
			for i < len(s) {
				sp2, size2 := jsSpaceAt(s, i)
				if !(sp2 || s[i] == '_' || s[i] == '-') {
					break
				}
				i += size2
			}
			start = i
			continue
		}
		i += size
	}
	return append(out, s[start:])
}

// leadingNumber is `/^\s*([\d.,]+)/` group 1.
func leadingNumber(s string) (string, bool) {
	i := skipJSSpace(s, 0)
	j := i
	for j < len(s) && ((s[j] >= '0' && s[j] <= '9') || s[j] == '.' || s[j] == ',') {
		j++
	}
	return s[i:j], j > i
}

// isAlternative: the second of two glued spans whose classes differ in one
// word ("imperial_word" / "metric_word") and that state the same number.
func isAlternative(el *Node) bool {
	parent := el.Parent
	if parent == nil || el.classAttr() == "" || el.textLen == 0 || el.textLen > 40 {
		return false
	}
	i := indexOf(parent.Children, el)
	if i <= 0 {
		return false
	}
	prev := parent.Children[i-1]
	if prev.Kind != ElementNode || prev.Tag != "span" || prev.skip || prev.textLen == 0 || prev.textLen > 40 {
		return false
	}
	a := splitClassWords(prev.classAttr())
	b := splitClassWords(el.classAttr())
	if len(a) != len(b) || len(a) < 2 {
		return false
	}
	differ := 0
	for k := range a {
		if a[k] != b[k] {
			differ++
		}
	}
	if differ != 1 {
		return false
	}
	// The same quantity in another unit: both open with the same number.
	x, okx := leadingNumber(rawText(prev))
	y, oky := leadingNumber(rawText(el))
	return okx && oky && x == y
}

// slug is `text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ”)`.
func slug(text string) string {
	var b strings.Builder
	dash := false
	for _, r := range jsLower(text) {
		if isLetterOrNumber(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func closestHeading(el *Node) *Node {
	for p := el.Parent; p != nil; p = p.Parent {
		if isHeadingTag(p.Tag) {
			return p
		}
	}
	return nil
}

// loneCode: a multi-line <code> that is all its container holds is a listing
// even without <pre> (figure.code-block > code, styled with white-space: pre).
func loneCode(el *Node) *Node {
	anyCode := false
	for _, child := range el.Children {
		if child.Kind == ElementNode && child.Tag == "code" {
			anyCode = true
			break
		}
	}
	if !anyCode {
		return nil
	}
	var code *Node
	for _, child := range el.Children {
		if child.Kind == TextNode {
			if !isBlank(child.text) {
				return nil
			}
			continue
		}
		if child.skip {
			continue
		}
		if code != nil || child.Tag != "code" {
			// Empty decorations (a language tag, a copy button) do not count.
			if child.Tag != "img" && child.textLen < 20 && isBlank(stripZeroWidth(rawText(child))) && !hasDescendant(child, "img", 64) {
				continue
			}
			return nil
		}
		code = child
	}
	if code == nil {
		return nil
	}
	text := jsTrim(rawText(code))
	// One line is a listing too when the wrapper says so (a figure, a language, a code-block class).
	if strings.IndexByte(text, '\n') > 0 || el.Tag == "figure" || el.has("data-lang") || codeWrapper.matchEl(el) {
		return code
	}
	return nil
}

func isNoteItem(el *Node) bool {
	if el.idAttr() == "" {
		return false
	}
	return el.Tag == "li" || el.attrIs("role", "doc-footnote") || el.attrIs("role", "doc-endnote") || (el.Tag != "a" && noteItemCls.match(el.lowerClassName()))
}

// noteKey: note text compared across copies: whitespace collapsed, a leading "5:" / "[5]" label dropped.
func noteKey(text string) string {
	t := collapse(text)
	if loc := noteKeyLabel.FindStringIndex(t); loc != nil {
		return t[loc[1]:]
	}
	return t
}

// stripNoteLabel: a note that repeats its own number loses it; the label is drawn.
func stripNoteLabel(blocks []Block, label string) []Block {
	if len(blocks) == 0 {
		return blocks
	}
	first, ok := blocks[0].(*Paragraph)
	if !ok {
		return blocks
	}
	for len(first.Content) > 0 {
		run, ok := first.Content[0].(*TextRun)
		if !ok {
			break
		}
		m := noteLabelRun.FindStringSubmatchIndex(run.Text)
		if m == nil {
			break
		}
		if g, _ := group(run.Text, m, 1); g != label {
			break
		}
		run.Text = run.Text[m[1]:]
		if run.Text != "" {
			break
		}
		first.Content = first.Content[1:]
	}
	if len(first.Content) == 0 {
		return blocks[1:]
	}
	return blocks
}

// itemLabel is the marker an item opens with as an element of its own (LaTeXML's ltx_tag_item), or nil.
func itemLabel(li *Node) *Node {
	for _, child := range li.Children {
		if child.Kind == TextNode {
			if !isBlank(child.text) {
				return nil
			}
			continue
		}
		if !child.skip && child.hasClass("ltx_tag_item") {
			return child
		}
		return nil
	}
	return nil
}

// prependLabel reads an item's label into its first line: "(a) The encoder…".
func prependLabel(blocks []Block, label string) []Block {
	if label == "" {
		return blocks
	}
	if len(blocks) > 0 {
		if first, ok := blocks[0].(*Paragraph); ok {
			first.Content = normalizeInlines(append([]Inline{&TextRun{Text: label + " "}}, first.Content...))
			return blocks
		}
	}
	return append([]Block{&Paragraph{Content: []Inline{&TextRun{Text: label}}}}, blocks...)
}

// stripItemMarker: a marker the page typed into an item ("• Point", "3. Step")
// repeats the one the list draws and goes; an ordered item keeps a number that is not its own.
func stripItemMarker(blocks []Block, number *float64) []Block {
	if len(blocks) == 0 {
		return blocks
	}
	first, ok := blocks[0].(*Paragraph)
	if !ok || len(first.Content) == 0 {
		return blocks
	}
	run, ok := first.Content[0].(*TextRun)
	if !ok {
		return blocks
	}
	var m []int
	if number == nil {
		m = bulletMarker.FindStringSubmatchIndex(run.Text)
	} else {
		m = numberMarker.FindStringSubmatchIndex(run.Text)
	}
	if m == nil {
		return blocks
	}
	if number != nil {
		g, ok := group(run.Text, m, 1)
		if !ok {
			g, _ = group(run.Text, m, 2)
		}
		if jsNumber(g) != *number {
			return blocks
		}
	}
	run.Text = run.Text[m[1]:]
	if run.Text == "" {
		first.Content = first.Content[1:]
	}
	if len(first.Content) > 0 {
		if next, ok := first.Content[0].(*TextRun); ok {
			next.Text = jsTrimStart(next.Text)
			if next.Text == "" {
				first.Content = first.Content[1:]
			}
		}
	}
	if len(first.Content) == 0 {
		return blocks[1:]
	}
	return blocks
}

// endsSentence: words ending a sentence: ".", "!" or "?", maybe inside closing
// quotes or brackets, after a space somewhere and not an ellipsis.
func endsSentence(text string) bool {
	i := len(text)
	for i > 0 {
		r, size := utf8.DecodeLastRuneInString(text[:i])
		if !strings.ContainsRune("\"')]”’»", r) {
			break
		}
		i -= size
	}
	if i == 0 {
		return false
	}
	c := text[i-1]
	if c != '.' && c != '!' && c != '?' {
		return false
	}
	if c == '.' && i >= 2 && text[i-2] == '.' {
		return false
	}
	return strings.LastIndexByte(text[:i], ' ') >= 0
}

// splitCredit: a short credit closing a caption, split off: [caption, credit];
// the caption is unchanged when there is none.
func splitCredit(caption []Inline) ([]Inline, []Inline) {
	for i, n := range caption {
		run, ok := n.(*TextRun)
		if !ok {
			continue
		}
		m := creditLead.FindStringSubmatchIndex(run.Text)
		if m == nil {
			continue
		}
		at := m[2]
		rest := append([]Inline{&TextRun{Text: run.Text[at:], Marks: run.Marks, Href: run.Href}}, caption[i+1:]...)
		restText := inlineTextOf(rest)
		if u16len(restText) > 120 || sentenceAfter.MatchString(restText) {
			break
		}
		// Marks every credit run shares are its wrapper's (<small>), not the credit's.
		var shared []Mark
		sharedSet := false
		for _, x := range rest {
			if r, ok := x.(*TextRun); ok {
				if !sharedSet {
					shared = append([]Mark{}, r.Marks...)
					sharedSet = true
				} else {
					kept := shared[:0]
					for _, mk := range shared {
						if hasMark(r.Marks, mk) {
							kept = append(kept, mk)
						}
					}
					shared = kept
				}
			}
		}
		credit := make([]Inline, len(rest))
		for k, x := range rest {
			r, ok := x.(*TextRun)
			if !ok || !sharedSet || len(shared) == 0 {
				credit[k] = x
				continue
			}
			nr := &TextRun{Text: r.Text, Href: r.Href}
			for _, mk := range r.Marks {
				if !hasMark(shared, mk) {
					nr.Marks = append(nr.Marks, mk)
				}
			}
			credit[k] = nr
		}
		before := normalizeInlines(append(append([]Inline{}, caption[:i]...), &TextRun{Text: run.Text[:at], Marks: run.Marks, Href: run.Href}))
		// "Image: Jose Mourinho, left, …" alone is the caption, labelled.
		if len(before) == 0 {
			break
		}
		return before, normalizeInlines(credit)
	}
	return caption, nil
}

func inlineTextOf(content []Inline) string {
	if len(content) == 1 {
		if r, ok := content[0].(*TextRun); ok {
			return r.Text
		}
	}
	var s strings.Builder
	for _, n := range content {
		if r, ok := n.(*TextRun); ok {
			s.WriteString(r.Text)
		}
	}
	return s.String()
}

func textOfInlines(content []Inline) string { return inlineTextOf(content) }

func decodeFragment(value string) string {
	if decoded, ok := jsDecodeURIComponent(value); ok {
		return decoded
	}
	return value
}

func hasDescendant(el *Node, tag string, maxDepth int) bool {
	var visit func(node *Node, depth int) bool
	visit = func(node *Node, depth int) bool {
		if depth > maxDepth {
			return false
		}
		for _, child := range node.Children {
			if child.Kind != ElementNode || child.skip {
				continue
			}
			if child.Tag == tag || visit(child, depth+1) {
				return true
			}
		}
		return false
	}
	return visit(el, 1)
}

func countTag(el *Node, tag string) int {
	n := 0
	walkAll(el, func(e *Node) {
		if e != el && e.Tag == tag {
			n++
		}
	})
	return n
}

type rowInfo struct {
	cells []*Node
	head  bool
}

func tableRows(table *Node) []rowInfo {
	var rows []rowInfo
	var visit func(el *Node, head bool)
	visit = func(el *Node, head bool) {
		for _, child := range el.Children {
			if child.Kind != ElementNode || child.skip {
				continue
			}
			switch child.Tag {
			case "tr":
				var cells []*Node
				for _, cell := range child.Children {
					if cell.Kind == ElementNode && !cell.skip && (cell.Tag == "td" || cell.Tag == "th") {
						cells = append(cells, cell)
					}
				}
				rows = append(rows, rowInfo{cells, head})
			case "thead", "tbody", "tfoot":
				visit(child, child.Tag == "thead")
			}
		}
	}
	visit(table, false)
	return rows
}

func isCodeTable(el *Node) bool {
	if el.Tag != "table" {
		return false
	}
	if codeTableCls.matchEl(el) {
		return true
	}
	code := false
	walk(el, func(e *Node) bool {
		if code {
			return false
		}
		if e.Tag == "td" && codeLineCell.matchEl(e) {
			code = true
		} else if e.Tag == "td" && codeClass.match(e.classAttr()) && hasDescendant(e, "pre", 64) {
			code = true
		}
		return !code
	})
	return code
}

// codeText is verbatim code: <br> as newlines, line-per-element markup joined, gutters dropped.
func codeText(el *Node) string {
	var out strings.Builder
	lastByte := func() byte {
		s := out.String()
		if len(s) == 0 {
			return 0
		}
		return s[len(s)-1]
	}
	var visit func(node *Node)
	visit = func(node *Node) {
		kids := node.Children
		for i, child := range kids {
			if child.Kind == TextNode {
				out.WriteString(child.text)
				continue
			}
			if child.Tag == "br" {
				out.WriteByte('\n')
				continue
			}
			if gutter.matchEl(child) || child.has("data-line-number") && isBlank(rawText(child)) {
				continue
			}
			if child.Tag == "button" || child.Tag == "svg" || child.Tag == "input" || codeChrome.matchEl(child) {
				continue
			}
			line := child.Tag == "div" || child.Tag == "p" || child.Tag == "tr" || child.Tag == "li" || lineElement.matchEl(child)
			visit(child)
			if line && out.Len() > 0 && lastByte() != '\n' {
				if !(i+1 < len(kids) && kids[i+1].Kind == TextNode && strings.HasPrefix(kids[i+1].text, "\n")) {
					out.WriteByte('\n')
				}
			}
		}
	}
	visit(el)
	s := normalizeNewlines(out.String())
	s = strings.ReplaceAll(s, " ", " ")
	s = stripZeroWidth(s)
	// `^(?:[ \t]*\n)+`: blank lines at the start.
	for {
		i := 0
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i < len(s) && s[i] == '\n' {
			s = s[i+1:]
			continue
		}
		break
	}
	return jsTrimEnd(s)
}

// codeLanguage is the language from markup on the block, its <code> child, or wrappers up to three levels.
func codeLanguage(pre *Node) string {
	fromEl := func(e *Node) string {
		v := firstNonNil(e.attrPtr("data-lang"), e.attrPtr("data-language"), e.attrPtr("data-code-language"), e.attrPtr("data-snippet-lang"), e.attrPtr("data-syntax"), e.attrPtr("lang"))
		if v != nil {
			if lang := NormalizeLanguage(*v); lang != "" {
				return lang
			}
		}
		return LanguageFromClass(e.classAttr())
	}
	if lang := fromEl(pre); lang != "" {
		return lang
	}
	if code := firstTag(pre, "code"); code != nil {
		if lang := fromEl(code); lang != "" {
			return lang
		}
	}
	p := pre.Parent
	for depth := 0; depth < 3 && p != nil; depth, p = depth+1, p.Parent {
		v := firstNonNil(p.attrPtr("data-lang"), p.attrPtr("data-language"), p.attrPtr("data-code-language"))
		if v != nil {
			if lang := NormalizeLanguage(*v); lang != "" {
				return lang
			}
		}
		if lang := LanguageFromClass(p.classAttr()); lang != "" {
			return lang
		}
	}
	return ""
}

func mathInline(el *Node) *InlineMath {
	if el.Tag == "math-tex" {
		raw := rawText(el)
		tex, ok := texFrom(&raw)
		if !ok {
			return nil
		}
		return &InlineMath{Tex: tex, Text: tex}
	}
	source := el.attrPtr("data-tex")
	if source == nil {
		source = el.attrPtr("alttext")
	}
	tex, hasTex := texFrom(source)
	mathml := el.av("data-xml")
	text := tex
	if !hasTex {
		text = collapse(rawText(el))
	}
	if text == "" && mathml == "" {
		return nil
	}
	return &InlineMath{Tex: tex, MathML: mathml, Text: text}
}
