package truffle

// Finds the article body (content.ts). The scoring follows Mozilla
// Readability's model (paragraph scores flowing to ancestors, class weights,
// link density, sibling joining, conditional cleaning) over the compact tree,
// with statistics computed in one bottom-up pass per attempt. Removals are
// marks (`skip`), so a retry with relaxed rules does not re-parse the page.

import (
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	unlikely     = newClassPattern(`-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo`)
	unlikelyHard = newClassPattern(`-ad-|ai2html|breadcrumbs|combx|comment|community|disqus|footer|gdpr|menu|related|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|ad-break|pagination|pager|popup|yom-remote|newsletter|subscribe|cookie|consent|signup|outbrain|taboola|recirc|trending|most-popular|mostpopular|promo`)
	maybe        = newClassPattern(`and|article|body|column|content|main|mathjax|shadow|story|post-text|entry`)
	positive     = newClassPattern(`article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story|prose|markdown|rich-text|richtext`)
	negative     = newClassPattern(`-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget|newsletter|subscribe|taboola|recirc|byline|author-bio|toolbar|breadcrumb|disclaimer|caption-credit`)
	bylineWords  = newClassPattern(`byline|author|dateline|writtenby|p-author`)
	share        = newClassPattern(`(?:\b|_)(?:share|sharedaddy|social|sharing)(?:\b|_)`)
	adWords      = jsRegexp(`^(?:ad(?:vertising|vertisement)?|pub(?:licité)?|werb(?:ung)?|广告|Реклама|Anuncio)$`, "i")
	loadingWords = jsRegexp(`^(?:(?:loading|正在加载|Загрузка|chargement|cargando)(?:…|\.\.\.)?)$`, "i")
	// Strong signals that an element is the article body (publisher templates,
	// CMSs, doc generators and schema.org). A boost, never a blind choice.
	contentHint       = newClassPattern(`(?:^|\s)(?:entry-content|post-content|article-content|article-body|articlebody|article__body|article__content|article-text|articletext|story-body|storybody|story-content|story__body|post-body|postbody|post__content|post-entry|blog-post-content|blog-content|entry-body|content-body|body-text|bodytext|markdown-body|gh-content|available-content|mw-parser-output|ltx_page_content|theme-doc-markdown|md-content__inner|vp-doc|rich-text|richtext|c-entry-content|td-post-content|single-post-content|article-body-text|news-content|news-body|text-content|main-content-body|post-article|articlecontent|field-name-body|field--name-body|single-content|paywall-content|caas-body|wysiwyg|prose)(?:\s|$)`)
	footnoteContainer = newClassPattern(`(?:^|[\s_-])(?:footnotes|footnote-list|footnotes-list|endnotes|references|reflist|refs|footnote-definitions|notes-list|fn-list)(?:$|[\s_-])`)
	calloutClass      = newClassPattern(`(?:^|[\s_-])(?:note|tip|warning|caution|important|admonition|callout|alert|info|danger|notice|hint|notecard|callout(?:wrapper|box|container|block)|admonition(?:wrapper|box|container|block))(?:$|[\s_-])`)
	// Boilerplate inside an article: removed regardless of score when small relative to the article.
	boilerplate  = newClassPattern(`(?:^|[\s_-])(?:mw-editsection|editsection|edit-section|mw-jump-link|catlinks|printfooter|navbox|vertical-navbox|ambox|hatnote|noprint|share|sharing|social|social-links|sharedaddy|share-buttons|newsletter|subscribe|subscription|signup|sign-up|optin|opt-in|related|related-posts|related-articles|recommended|recommendations|more-stories|read-more|readmore|read-next|also-read|further-reading-promo|promo|promoted|sponsored|advert|advertisement|ad-container|ad-slot|ad-unit|ad-wrapper|adsbygoogle|dfp|gpt-ad|comments|comment-list|commentlist|disqus|breadcrumb|breadcrumbs|pagination|post-tags|entry-tags|tag-list|tags-list|article-tags|toc|table-of-contents|tableofcontents|cookie|consent|gdpr|regwall|inline-cta|cta|author-bio|about-author|author-box|authorbox|post-author-bio|byline|dateline|print|skip-link|toolbar|nav|navigation|navbar|sticky|floating|modal|popup|overlay|outbrain|taboola|jp-relatedposts|wp-block-buttons|follow-us|listen|audio-player|article-audio|podcast-player|rating|reactions|clap|kudos)(?:$|[\s_-])`)
	maybeContent = newClassPattern(`(?:^|[\s_-])(?:article-body|articlebody|entry-content|post-content|story-body|main-content|article-content|post-body)(?:$|[\s_-])`)
	// Short stand-alone text that is UI, not prose.
	uiText        = jsRegexp(`^(?:text size|caption|image \d+ of \/? ?\d+|\d+ of \d+|photos?|gallery|enlarge( this image)?|view (full )?gallery|advertisement|ad|sponsored|share( this)?( article| story| post)?|tweet|email|print|copy link|copy|copied!?|loading\.*|read more|continue reading|subscribe|sign up|follow|listen( to this article)?|save|bookmark|comments?|reply|related|related articles|you may also like|recommended|more from .*|skip (to )?(main )?content|back to top|top|close|menu|toggle navigation|show more|load more|see more|×)$`, "i")
	sentenceEnd   = jsRegexp(`[.!?。！？](?:["'”’)\]]|\[\d+\])*(?:\s|$)`, "g")
	footnoteClass = newClassPattern(`(?:^|\s)footnote(?:\s|$)`)
)

var unlikelyRoles = map[string]bool{"menu": true, "menubar": true, "complementary": true, "navigation": true, "alert": true, "alertdialog": true, "dialog": true, "banner": true, "contentinfo": true, "search": true, "tooltip": true}

func isPhrasingTag(tag string) bool {
	switch tag {
	case "abbr", "audio", "b", "bdo", "bdi", "br", "button", "canvas", "cite", "code", "data", "datalist", "dfn", "em", "embed", "i",
		"img", "input", "kbd", "label", "mark", "math", "math-tex", "meter", "noscript", "object", "output", "progress", "q", "ruby",
		"rb", "rt", "rtc", "rp", "samp", "select", "small", "span", "strong", "sub", "sup", "textarea", "time", "var", "wbr", "u", "s", "strike",
		"tt", "font", "big", "svg", "picture", "nobr", "acronym":
		return true
	}
	return false
}

// isBlockTag: elements that make a container "not a paragraph".
func isBlockTag(tag string) bool {
	switch tag {
	case "blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul", "section", "article", "figure", "h1", "h2", "h3", "h4",
		"h5", "h6", "header", "footer", "aside", "nav", "main", "hr", "details", "video", "iframe", "form", "fieldset", "address",
		"center", "picture", "figcaption", "li", "dd", "dt", "audio":
		return true
	}
	return false
}

func isHeadingTag(tag string) bool {
	return len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6'
}

type flags struct {
	stripUnlikely      bool
	weightClasses      bool
	cleanConditionally bool
}

func isWhitespaceNode(node *Node) bool {
	if node.Kind == TextNode {
		return isBlank(node.text)
	}
	return node.Tag == "br"
}

func isPhrasing(node *Node) bool {
	if node.Kind == TextNode {
		return true
	}
	if isPhrasingTag(node.Tag) {
		return true
	}
	if node.Tag == "a" || node.Tag == "del" || node.Tag == "ins" || strings.IndexByte(node.Tag, '-') > 0 {
		for _, c := range node.Children {
			if !isPhrasing(c) {
				return false
			}
		}
		return true
	}
	return false
}

// hasBlockChild runs post-order: children were visited first, so their containsBlock is known.
func hasBlockChild(el *Node) bool {
	for _, child := range el.Children {
		if child.Kind == ElementNode && (isBlockTag(child.Tag) || child.containsBlock) {
			return true
		}
	}
	return false
}

// measure computes bottom-up statistics over non-skipped nodes.
func measure(el *Node) {
	text := 0
	link := 0.0
	commas := 0
	for _, child := range el.Children {
		if child.Kind == TextNode {
			text += child.length()
			commas += child.commaCount()
		} else if !child.skip {
			measure(child)
			text += child.textLen
			link += child.linkLen
			commas += child.commas
		}
	}
	el.textLen = text
	el.commas = commas
	if el.Tag == "a" {
		// In-page links (footnotes, anchors) weigh less than links away.
		if isInPageLink(el) {
			el.linkLen = float64(text) * 0.3
		} else {
			el.linkLen = float64(text)
		}
	} else {
		el.linkLen = link
	}
}

// isInPageLink: a link to a fragment of this page. A bare "#" is a script button, not a place.
func isInPageLink(a *Node) bool {
	href := a.av("href")
	return len(href) > 1 && href[0] == '#'
}

func linkDensity(el *Node) float64 {
	if el.textLen == 0 {
		return 0
	}
	return math.Min(1, el.linkLen/float64(el.textLen))
}

func classWeight(el *Node, f flags) int {
	if !f.weightClasses {
		return 0
	}
	weight := 0
	cls, id := el.lower()
	if cls != "" {
		if negative.match(cls) {
			weight -= 25
		}
		if positive.match(cls) {
			weight += 25
		}
	}
	if id != "" {
		if negative.match(id) {
			weight -= 25
		}
		if positive.match(id) {
			weight += 25
		}
	}
	if contentHint.match(cls) || el.attrIs("itemprop", "articleBody") || el.attrIs("itemprop", "articlebody") {
		weight += 30
	}
	return weight
}

func initialize(el *Node, f flags) {
	score := 0
	switch el.Tag {
	case "div":
		if !el.has("data-x-as-p") {
			score = 5
		}
	case "pre", "td", "blockquote":
		score = 3
	case "address", "ol", "ul", "dl", "dd", "dt", "li", "form":
		score = -3
	case "h1", "h2", "h3", "h4", "h5", "h6", "th":
		score = -5
	case "article":
		score = 8
	}
	el.score = float64(score + classWeight(el, f))
	el.scored = true
}

// normalize is the one-time normalization Readability performs inside its
// scoring loop: inline runs inside block containers become synthetic
// paragraphs, divs with only inline content act as paragraphs.
func normalize(body *Node) {
	var visit func(el *Node)
	visit = func(el *Node) {
		for i := 0; i < len(el.Children); i++ {
			if child := el.Children[i]; child.Kind == ElementNode {
				visit(child)
			}
		}
		el.containsBlock = hasBlockChild(el)
		switch el.Tag {
		case "div", "section", "article", "main", "center", "form", "body":
		default:
			return
		}
		if !el.containsBlock {
			if el.Tag == "div" {
				el.setAttr("data-x-as-p", "")
			}
			return
		}
		// Wrap phrasing runs between blocks in synthetic paragraphs.
		out := make([]*Node, 0, len(el.Children))
		var p *Node
		for _, child := range el.Children {
			if isPhrasing(child) {
				if p != nil {
					p.appendChild(child)
				} else if !isWhitespaceNode(child) {
					p = NewElement("p", []Attr{{"data-x-synthetic", ""}})
					p.Parent = el
					p.appendChild(child)
					out = append(out, p)
				} else {
					out = append(out, child)
				}
			} else {
				if p != nil {
					for len(p.Children) > 0 && isWhitespaceNode(p.Children[len(p.Children)-1]) {
						ws := p.Children[len(p.Children)-1]
						p.Children = p.Children[:len(p.Children)-1]
						ws.Parent = el
						out = append(out, ws)
					}
				}
				p = nil
				out = append(out, child)
			}
		}
		el.Children = out
	}
	visit(body)
}

func isEmptyContainer(el *Node) bool {
	switch el.Tag {
	case "div", "section", "header", "h1", "h2", "h3", "h4", "h5", "h6":
	default:
		return false
	}
	for _, child := range el.Children {
		if child.Kind == TextNode {
			if !isBlank(child.text) {
				return false
			}
		} else if child.Tag != "br" && child.Tag != "hr" {
			return false
		}
	}
	return true
}

func hasAncestorTag(el *Node, test func(tag string) bool) bool {
	depth := 0
	for p := el.Parent; p != nil && depth < 64; p, depth = p.Parent, depth+1 {
		if test(p.Tag) {
			return true
		}
	}
	return false
}

func isTableOrCode(tag string) bool { return tag == "table" || tag == "code" || tag == "pre" }

// markUnlikely is pass 1 of an attempt: unlikely candidates, bylines and empty wrappers are skipped.
func markUnlikely(body *Node, f flags) {
	totalProse := proseLength(body)
	bylineRemoved := false
	walk(body, func(el *Node) bool {
		if el == body {
			return true
		}
		// A heading's id is a slug of its own words ("highlighting-with-comments"): judge headings by class.
		match := el.matchString
		heading := isHeadingTag(el.Tag)
		if heading {
			match = el.lowerClassName()
		}
		test := func(p *classPattern) bool {
			if heading {
				return p.match(match)
			}
			return p.matchEl(el)
		}
		if el.attrIs("aria-modal", "true") && el.attrIs("role", "dialog") {
			el.skip = true
			return false
		}
		if !bylineRemoved && u16len(match) > 1 && isByline(el, test(bylineWords)) {
			bylineRemoved = true
			el.skip = true
			return false
		}
		if f.stripUnlikely {
			if test(unlikely) && !test(maybe) && el.Tag != "a" && el.Tag != "body" && el.Tag != "article" && el.Tag != "main" && !hasAncestorTag(el, isTableOrCode) && !(el.Tag == "table" && isDataTableCached(el)) {
				// "header", "banner", "extra": weak signals that real prose overrides (MDN puts intros in a header).
				// A layout wrapper holding most of the page's prose ("with-sidebar") is never unlikely.
				prose := proseLength(el)
				// Headings carry no prose of their own; only the hard words drop them ("header-anchor" is not chrome).
				// A header holding the page's h1 and real prose is the article's own header (title, standfirst, intro).
				if (test(unlikelyHard) || prose < 400 && !isHeadingTag(el.Tag) && !(prose >= 100 && linkDensity(el) < 0.3 && hasH1(el))) && prose <= totalProse*0.5 {
					el.skip = true
					return false
				}
			}
			if role, ok := el.attr("role"); ok && unlikelyRoles[role] {
				el.skip = true
				return false
			}
			if el.Tag == "nav" || el.Tag == "aside" && !isCallout(el) && !isNoteMarkup(el) {
				el.skip = true
				return false
			}
			// Several articles inside an article are a feed of other posts or comments.
			if el.Tag == "article" && el.Parent != nil && countNestedArticles(el.Parent) >= 2 && hasAncestorTag(el, func(t string) bool { return t == "article" }) {
				el.skip = true
				return false
			}
		}
		if isEmptyContainer(el) {
			el.skip = true
			return false
		}
		return true
	})
}

func hasH1(el *Node) bool {
	if el.Tag == "h1" {
		return true
	}
	return firstTag(el, "h1") != nil
}

func countNestedArticles(parent *Node) int {
	n := 0
	for _, child := range parent.Children {
		if child.Kind == ElementNode && child.Tag == "article" {
			n++
		}
	}
	return n
}

// proseLength is the text of paragraphs inside el that is not link text (uses the attempt's fresh measure).
func proseLength(el *Node) float64 {
	n := 0.0
	walk(el, func(e *Node) bool {
		if e.skip {
			return false
		}
		if e.Tag == "p" {
			n += float64(e.textLen) - e.linkLen
			return false
		}
		return true
	})
	return n
}

// isByline: wordsMatch is whether the element's class (and id) has a byline word.
func isByline(el *Node, wordsMatch bool) bool {
	itemprop, hasItemprop := el.attr("itemprop")
	if !(el.attrIs("rel", "author") || (hasItemprop && strings.Contains(itemprop, "author")) || wordsMatch) {
		return false
	}
	n := visibleLength(textOf(el))
	return n > 0 && n < 100
}

func isFootnotes(el *Node) bool {
	if el.notesState < 0 {
		if isFootnoteList(el) {
			el.notesState = 1
		} else {
			el.notesState = 0
		}
	}
	return el.notesState == 1
}

// isFootnoteList: footnote and endnote lists (Pandoc, Sphinx, Hugo, GitHub, Wikipedia, Substack).
func isFootnoteList(el *Node) bool {
	if el.attrIs("role", "doc-endnotes") || el.has("data-footnotes") {
		return true
	}
	// Every container word has "note", "ref" or "fn" in it: skip the pattern for everything else.
	m := el.matchString
	if !strings.Contains(m, "note") && !strings.Contains(m, "ref") && !strings.Contains(m, "fn") {
		return false
	}
	if footnoteContainer.match(m) {
		return true
	}
	// Python-Markdown: <div class="footnote"><hr><ol><li id="fn:1">.
	if !el.hasClass("footnote") {
		return false
	}
	for _, child := range el.Children {
		if child.Kind == ElementNode && child.Tag == "ol" {
			return true
		}
	}
	return false
}

// isNoteMarkup: a footnote list or one of its notes: kept even when marked up as <aside>.
func isNoteMarkup(el *Node) bool {
	return isFootnotes(el) || el.attrIs("role", "doc-footnote") || el.attrIs("role", "doc-endnote") || footnoteClass.match(el.classAttr())
}

func isCallout(el *Node) bool {
	return calloutClass.matchEl(el)
}

func ancestors(el *Node, max int) []*Node {
	var out []*Node
	for p := el.Parent; p != nil && len(out) < max; p = p.Parent {
		out = append(out, p)
	}
	return out
}

type attempt struct {
	roots      []*Node
	textLength int
}

func grab(body *Node, f flags, articleBody *string) attempt {
	resetMarks(body)
	measure(body)
	markUnlikely(body, f)
	measure(body)

	var toScore []*Node
	walk(body, func(el *Node) bool {
		if el.skip {
			return false
		}
		switch el.Tag {
		case "section", "h2", "h3", "h4", "h5", "h6", "p", "td", "pre":
			toScore = append(toScore, el)
		default:
			if el.has("data-x-as-p") {
				toScore = append(toScore, el)
			}
		}
		return true
	})

	var candidates []*Node
	for _, el := range toScore {
		if el.Parent == nil || el.textLen < 25 {
			continue
		}
		var upsBuf [5]*Node
		ups := upsBuf[:0]
		for p := el.Parent; p != nil && len(ups) < 5; p = p.Parent {
			ups = append(ups, p)
		}
		if len(ups) == 0 {
			continue
		}
		score := float64(1 + (el.commas + 1) + min(el.textLen/100, 3))
		for level, a := range ups {
			if a.Parent == nil {
				break
			}
			if !a.scored {
				initialize(a, f)
				candidates = append(candidates, a)
			}
			divider := 1.0
			switch {
			case level == 1:
				divider = 2
			case level > 1:
				divider = float64(level * 3)
			}
			a.score += score / divider
		}
	}

	var top []*Node
	for _, c := range candidates {
		c.score *= 1 - linkDensity(c)
		if c.Tag == "body" || c.Tag == "html" {
			continue
		}
		i := 0
		for i < len(top) && top[i].score >= c.score {
			i++
		}
		if i < 5 {
			top = append(top, nil)
			copy(top[i+1:], top[i:])
			top[i] = c
			if len(top) > 5 {
				top = top[:5]
			}
		}
	}

	var topCandidate *Node
	if len(top) > 0 {
		topCandidate = top[0]
	}
	// Flat pages (specs, old sites) keep their paragraphs directly in <body>: it wins outright.
	topScore := 0.0
	if topCandidate != nil {
		topScore = topCandidate.score
	}
	if body.scored && body.score >= 2*topScore {
		topCandidate = body
	}
	if articleBody != nil {
		topCandidate = alignWithStructuredBody(body, topCandidate, *articleBody)
	}

	if topCandidate == nil {
		measure(body)
		return attempt{[]*Node{body}, body.textLen}
	}
	if topCandidate.Tag == "body" {
		// The page header of a flat page is chrome.
		for _, child := range body.Children {
			if child.Kind == ElementNode && child.Tag == "header" {
				child.skip = true
			}
		}
		trimTrailingChrome(body)
		prepare(body, f)
		if !f.cleanConditionally {
			measure(body)
		}
		return attempt{[]*Node{body}, body.textLen}
	}

	// Several strong candidates under one ancestor: the ancestor is the article.
	var alternatives [][]*Node
	for i := 1; i < len(top); i++ {
		if top[i].score/topCandidate.score >= 0.75 && !isAncestor(topCandidate, top[i]) {
			alternatives = append(alternatives, ancestors(top[i], 64))
		}
	}
	if len(alternatives) >= 3 {
		for p := topCandidate.Parent; p != nil && p.Tag != "body"; p = p.Parent {
			lists := 0
			for _, list := range alternatives {
				if indexOf(list, p) >= 0 {
					lists++
				}
			}
			if lists >= 3 {
				topCandidate = p
				break
			}
		}
	}
	if !topCandidate.scored {
		initialize(topCandidate, f)
	}

	// Climb while the parent scores higher.
	lastScore := topCandidate.score
	threshold := lastScore / 3
	for p := topCandidate.Parent; p != nil && p.Tag != "body"; p = p.Parent {
		if !p.scored {
			continue
		}
		if p.score < threshold {
			break
		}
		if p.score > lastScore {
			topCandidate = p
			break
		}
		lastScore = p.score
	}
	topCandidate = joinSplitBody(topCandidate, candidates)

	// An only child says nothing on its own.
	for p := topCandidate.Parent; p != nil && p.Tag != "body" && liveChildren(p) == 1; p = p.Parent {
		topCandidate = p
	}
	if !topCandidate.scored {
		initialize(topCandidate, f)
	}

	topCandidate = galleryContainer(topCandidate)
	if !topCandidate.scored {
		initialize(topCandidate, f)
	}

	// Join siblings that look like more of the same.
	var roots []*Node
	parent := topCandidate.Parent
	if parent == nil {
		roots = append(roots, topCandidate)
	} else {
		siblingThreshold := math.Max(10, topCandidate.score*0.2)
		for _, sibling := range parent.Children {
			if sibling.Kind != ElementNode || sibling.skip {
				continue
			}
			appendIt := sibling == topCandidate
			if !appendIt {
				bonus := 0.0
				if sibling.classAttr() != "" && sibling.classAttr() == topCandidate.classAttr() {
					bonus = topCandidate.score * 0.2
				}
				if sibling.scored && sibling.score+bonus >= siblingThreshold {
					appendIt = true
				} else if bonus > 0 && sibling.textLen > 50 && linkDensity(sibling) < 0.3 {
					// Same component class as the body (CMS "text block" wrappers): more of the same.
					appendIt = true
				} else if sibling.Tag == "p" || sibling.has("data-x-as-p") {
					density := linkDensity(sibling)
					n := sibling.textLen
					if n > 80 && density < 0.25 {
						appendIt = true
					} else if n < 80 && n > 0 && density == 0 && hasSentenceDot(textOf(sibling)) {
						appendIt = true
					}
				} else if isLeadMedia(sibling, topCandidate) || isAdjacentProse(sibling, topCandidate) {
					appendIt = true
				}
			}
			if appendIt {
				roots = append(roots, sibling)
			}
		}
		roots = fillBetween(parent, roots)
	}

	for _, root := range roots {
		prepare(root, f)
	}
	length := 0
	for _, root := range roots {
		if !f.cleanConditionally {
			measure(root)
		}
		length += root.textLen
	}
	return attempt{roots, length}
}

// hasSentenceDot is `/\.( |$)/`.
func hasSentenceDot(s string) bool {
	return strings.Contains(s, ". ") || strings.HasSuffix(s, ".")
}

// trimTrailingChrome: a flat page ends with its own chrome (copyright,
// discussion links) right in <body>: trailing wrappers that are not article
// structure, and short link lines.
func trimTrailingChrome(body *Node) {
	kids := body.Children
	for k := len(kids) - 1; k >= 0; k-- {
		child := kids[k]
		if child.Kind == TextNode || child.skip || child.Tag == "br" || child.Tag == "hr" {
			continue
		}
		if !isStructureTag(child.Tag) && child.textLen < 500 && !hasMedia(child) {
			child.skip = true
			continue
		}
		// At most one link line ("Discussion on ...") right before the chrome.
		if child.Tag == "p" && child.textLen < 100 && linkDensity(child) > 0.3 {
			child.skip = true
		}
		return
	}
}

// galleryContainer: photo galleries' text is a short standfirst plus the
// photo captions. A short body next to three or more captioned figures
// widens to the container they share, when the captions are most of its text.
func galleryContainer(top *Node) *Node {
	if top.textLen >= 1000 {
		return top
	}
	p := top.Parent
	for level := 0; level < 3 && p != nil && p.Tag != "body"; level, p = level+1, p.Parent {
		figures := 0
		captions := 0.0
		walk(p, func(e *Node) bool {
			if e.skip {
				return false
			}
			if e.Tag != "figure" {
				return true
			}
			caption := firstLiveChild(e, "figcaption")
			if caption != nil && caption.textLen > 0 && hasMedia(e) {
				figures++
				captions += float64(caption.textLen) - caption.linkLen
			}
			return false
		})
		if figures >= 3 && float64(top.textLen)+captions >= (float64(p.textLen)-p.linkLen)*0.6 {
			return p
		}
	}
	return top
}

func firstLiveChild(el *Node, tag string) *Node {
	for _, child := range el.Children {
		if child.Kind == ElementNode && !child.skip && child.Tag == tag {
			return child
		}
	}
	return nil
}

// joinSplitBody: bodies split into several containers by ads or "chunks"
// climb to the nearest ancestor (up to three levels) whose text is almost all
// strong candidates.
func joinSplitBody(top *Node, candidates []*Node) *Node {
	var strong []*Node
	for _, c := range candidates {
		if c != top && c.textLen >= 200 && c.score >= top.score*0.3 && !isAncestor(top, c) && !isAncestor(c, top) {
			strong = append(strong, c)
		}
	}
	if len(strong) == 0 {
		return top
	}
	// Outermost strong candidates only, so nested ones are not counted twice.
	var outer []*Node
	for _, c := range strong {
		nested := false
		for _, o := range strong {
			if o != c && isAncestor(o, c) {
				nested = true
				break
			}
		}
		if !nested {
			outer = append(outer, c)
		}
	}
	ancestor := top.Parent
	for level := 0; level < 3 && ancestor != nil && ancestor.Tag != "body"; level, ancestor = level+1, ancestor.Parent {
		if ancestor.textLen == 0 || linkDensity(ancestor) > 0.25 {
			continue
		}
		covered := top.textLen
		others := 0
		for _, c := range outer {
			if isAncestor(ancestor, c) {
				covered += c.textLen
				others++
			}
		}
		if others > 0 && float64(covered) >= float64(ancestor.textLen)*0.8 {
			return ancestor
		}
	}
	return top
}

func isStructureTag(tag string) bool {
	switch tag {
	case "h1", "h2", "h3", "h4", "h5", "h6", "figure", "pre", "table", "blockquote", "p", "hr", "picture", "details", "dl", "ul", "ol":
		return true
	}
	return false
}

// fillBetween: joined siblings imply the parent is the article: headings,
// figures, code and prose between them (and a heading right before the first)
// belong to it too.
func fillBetween(parent *Node, roots []*Node) []*Node {
	if len(roots) < 2 {
		return roots
	}
	kids := parent.Children
	first := indexOf(kids, roots[0])
	last := indexOf(kids, roots[len(roots)-1])
	for k := first - 1; k >= 0; k-- {
		prev := kids[k]
		if prev.Kind == TextNode {
			if !isBlank(prev.text) {
				break
			}
			continue
		}
		if !prev.skip && isHeadingTag(prev.Tag) {
			first = k
		}
		break
	}
	var out []*Node
	for k := first; k <= last; k++ {
		child := kids[k]
		if child.Kind != ElementNode || child.skip {
			continue
		}
		if indexOf(roots, child) >= 0 {
			out = append(out, child)
			continue
		}
		if negative.matchEl(child) || boilerplate.matchEl(child) {
			continue
		}
		if !isStructureTag(child.Tag) && !(child.textLen < 400 && hasMedia(child)) {
			continue
		}
		if (child.Tag == "ul" || child.Tag == "ol" || child.Tag == "dl") && linkDensity(child) > 0.5 {
			continue
		}
		out = append(out, child)
	}
	return out
}

func isMediaTag(tag string) bool {
	switch tag {
	case "figure", "img", "picture", "pre", "table", "video", "iframe", "audio", "math", "blockquote":
		return true
	}
	return false
}

// hasMedia: a wrapper of an image, video, table or code listing (CMS media blocks between text blocks).
func hasMedia(el *Node) bool {
	found := false
	walk(el, func(e *Node) bool {
		if found || e.skip {
			return false
		}
		if e != el && isMediaTag(e.Tag) {
			found = true
		}
		return !found
	})
	return found
}

// isLeadMedia: a figure or heading directly before the body (lead image, section title) belongs to it.
func isLeadMedia(sibling, top *Node) bool {
	parent := top.Parent
	if parent == nil {
		return false
	}
	i := indexOf(parent.Children, sibling)
	j := indexOf(parent.Children, top)
	if i < 0 || j < 0 || i > j {
		return false
	}
	for k := i + 1; k < j; k++ {
		between := parent.Children[k]
		if between.Kind == ElementNode && !between.skip {
			return false
		}
	}
	if sibling.Tag == "figure" || sibling.Tag == "picture" {
		return true
	}
	if sibling.textLen < 200 && linkDensity(sibling) < 0.3 {
		images := 0
		walk(sibling, func(e *Node) bool {
			if e.Tag == "img" {
				images++
			}
			return !e.skip
		})
		return images == 1 && !negative.matchEl(sibling)
	}
	return false
}

// isAdjacentProse: a container of plain paragraphs right next to the body (an intro split from it).
func isAdjacentProse(sibling, top *Node) bool {
	// The article's own header (with the h1) needs only a standfirst's worth of prose.
	minLen := 200
	if sibling.textLen >= 100 && hasH1(sibling) {
		minLen = 100
	}
	if sibling.textLen < minLen || linkDensity(sibling) > 0.25 || negative.matchEl(sibling) || boilerplate.matchEl(sibling) {
		return false
	}
	parent := top.Parent
	if parent == nil {
		return false
	}
	kids := parent.Children
	i := indexOf(kids, sibling)
	j := indexOf(kids, top)
	step := 1
	if i > j {
		step = -1
	}
	for k := i + step; k != j; k += step {
		between := kids[k]
		// Only chrome may sit between them (a contents box between the preamble and the text).
		if between.Kind == ElementNode && !between.skip && !(boilerplate.matchEl(between) || linkDensity(between) > 0.5) {
			return false
		}
	}
	prose := proseLength(sibling)
	return prose >= float64(sibling.textLen)*0.5 && prose >= float64(minLen)
}

func liveChildren(el *Node) int {
	n := 0
	for _, child := range el.Children {
		if child.Kind == ElementNode && !child.skip {
			n++
		}
	}
	return n
}

func resetMarks(el *Node) {
	el.skip = false
	el.scored = false
	el.score = 0
	for _, child := range el.Children {
		if child.Kind == ElementNode {
			resetMarks(child)
		}
	}
}

// ------------------------------------------------------------- structured body

// alignWithStructuredBody: when the page publishes its text as schema.org
// articleBody, the element whose text best matches it (high recall, then the
// smallest such element) is a better root than scoring alone.
func alignWithStructuredBody(body *Node, current *Node, articleBody string) *Node {
	target := lettersAndNumbers(jsLower(articleBody))
	if len(target) < 80 {
		return current
	}
	// Words become ids and a trigram three ids in one integer: the same set
	// as the TypeScript engine's "a b c" strings, without a string per trigram.
	ids := make(map[string]uint64, len(target))
	id := func(w string) uint64 {
		v, ok := ids[w]
		if !ok {
			v = uint64(len(ids)) + 1
			ids[w] = v
		}
		return v
	}
	trigram := func(a, b, c uint64) uint64 { return a<<42 | b<<21 | c }
	set := make(map[uint64]struct{}, len(target))
	for i := 0; i+2 < len(target); i++ {
		set[trigram(id(target[i]), id(target[i+1]), id(target[i+2]))] = struct{}{}
	}
	// 21 bits per id: room for two million distinct words, far more than any articleBody holds.
	if len(set) < 50 {
		return current
	}
	seen := map[uint64]struct{}{}
	var w []uint64
	words := newBodyWords(body, ids)
	recallOf := func(el *Node) (float64, float64) {
		w = w[:0]
		if span, ok := words.span(el); ok {
			w = words.ids(span, ids, w)
		} else {
			for _, word := range lettersAndNumbers(jsLower(textOf(el))) {
				// A word the structured text never uses can be in no trigram of it.
				w = append(w, ids[word])
			}
		}
		hit := 0
		clear(seen)
		for i := 0; i+2 < len(w); i++ {
			if w[i] == 0 || w[i+1] == 0 || w[i+2] == 0 {
				continue
			}
			k := trigram(w[i], w[i+1], w[i+2])
			if _, ok := set[k]; ok {
				if _, dup := seen[k]; !dup {
					seen[k] = struct{}{}
					hit++
				}
			}
		}
		total := max(1, len(w)-2)
		return float64(hit) / float64(len(set)), float64(hit) / float64(total)
	}

	if current != nil {
		recall, precision := recallOf(current)
		if recall > 0.8 && precision > 0.6 {
			return current
		}
	}
	// Smallest element holding most of the structured text. A descendant never
	// recalls more than its ancestor, so failing subtrees are pruned.
	var best *Node
	bestLen := math.MaxInt
	minLen := int(math.Floor(float64(u16len(articleBody)) * 0.6))
	walk(body, func(el *Node) bool {
		if el.skip || el.textLen < minLen {
			return false
		}
		recall, precision := recallOf(el)
		if recall <= 0.85 {
			return false
		}
		if precision > 0.4 && el.textLen < bestLen {
			best = el
			bestLen = el.textLen
		}
		return true
	})
	if best != nil {
		return best
	}
	return current
}

// bodyWords is the body's text lowercased once, split into words (as ids of
// the structured text's words, 0 for others), with each element's span in
// it: an element's words are the words inside its span, and the two its edges
// cut, without building its text. Lowercasing is per character except for a
// final sigma, whose form depends on its neighbours: a page with a "Σ" keeps
// the per-element path.
type bodyWords struct {
	text   []byte
	spans  map[*Node][2]int
	starts []int
	ends   []int
	wids   []uint64
	ok     bool
}

func newBodyWords(body *Node, ids map[string]uint64) *bodyWords {
	bw := &bodyWords{spans: map[*Node][2]int{}, ok: true}
	var visit func(el *Node)
	visit = func(el *Node) {
		start := len(bw.text)
		for _, child := range el.Children {
			if !bw.ok {
				return
			}
			if child.Kind == TextNode {
				if strings.Contains(child.text, "Σ") {
					bw.ok = false
					return
				}
				bw.text = appendLower(bw.text, child.text)
			} else if !child.skip {
				visit(child)
			}
		}
		bw.spans[el] = [2]int{start, len(bw.text)}
	}
	if !body.skip {
		visit(body)
	}
	if !bw.ok {
		return bw
	}
	text := bw.text
	start := -1
	for i := 0; i < len(text); {
		r, size := rune(text[i]), 1
		if r >= 0x80 {
			r, size = utf8.DecodeRune(text[i:])
		}
		if isLetterOrNumber(r) {
			if start < 0 {
				start = i
			}
		} else if start >= 0 {
			bw.add(start, i, ids)
			start = -1
		}
		i += size
	}
	if start >= 0 {
		bw.add(start, len(text), ids)
	}
	return bw
}

func (bw *bodyWords) add(start, end int, ids map[string]uint64) {
	bw.starts = append(bw.starts, start)
	bw.ends = append(bw.ends, end)
	bw.wids = append(bw.wids, ids[string(bw.text[start:end])])
}

func (bw *bodyWords) span(el *Node) ([2]int, bool) {
	if !bw.ok {
		return [2]int{}, false
	}
	s, ok := bw.spans[el]
	return s, ok
}

// ids appends the word ids of the text in span to w.
func (bw *bodyWords) ids(span [2]int, ids map[string]uint64, w []uint64) []uint64 {
	a, b := span[0], span[1]
	// The first word ending after a.
	k := sort.SearchInts(bw.ends, a+1)
	for ; k < len(bw.starts) && bw.starts[k] < b; k++ {
		s, e := max(bw.starts[k], a), min(bw.ends[k], b)
		if s == bw.starts[k] && e == bw.ends[k] {
			w = append(w, bw.wids[k])
		} else {
			w = append(w, ids[string(bw.text[s:e])])
		}
	}
	return w
}

// appendLower is jsLower for text without a "Σ", appended to dst.
func appendLower(dst []byte, s string) []byte {
	for i := 0; i < len(s); {
		c := s[i]
		if c < 0x80 {
			if c >= 'A' && c <= 'Z' {
				c += 32
			}
			dst = append(dst, c)
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == 0x130 {
			dst = append(dst, "i\u0307"...)
		} else if r == utf8.RuneError && size == 1 {
			dst = append(dst, c)
		} else {
			dst = utf8.AppendRune(dst, unicode.ToLower(r))
		}
		i += size
	}
	return dst
}

// ------------------------------------------------------------------ cleaning

func isDataTable(table *Node) bool {
	if table.attrIs("role", "presentation") || table.attrIs("datatable", "0") {
		return false
	}
	if table.av("summary") != "" {
		return true
	}
	caption, headerish, nested := false, false, false
	rows := 0
	columns := 0.0
	walk(table, func(e *Node) bool {
		if e == table {
			return true
		}
		switch e.Tag {
		case "table":
			nested = true
			return false
		case "caption":
			if len(e.Children) > 0 {
				caption = true
			}
		case "col", "colgroup", "tfoot", "thead", "th":
			headerish = true
		case "tr":
			rows++
			cols := 0.0
			for _, cell := range e.Children {
				if cell.Kind == ElementNode && (cell.Tag == "td" || cell.Tag == "th") {
					span := math.NaN()
					if v, ok := cell.attr("colspan"); ok {
						span = jsNumber(v)
					}
					if span > 0 {
						cols += span
					} else {
						cols++
					}
				}
			}
			columns = math.Max(columns, cols)
		}
		return true
	})
	if caption || headerish {
		return true
	}
	if nested {
		return false
	}
	if rows == 1 || columns == 1 {
		return false
	}
	if rows >= 10 || columns > 4 {
		return true
	}
	return float64(rows)*columns > 10
}

func isDataTableCached(table *Node) bool {
	if table.tableState < 0 {
		if isDataTable(table) {
			table.tableState = 1
		} else {
			table.tableState = 0
		}
	}
	return table.tableState == 1
}

// isAuthorBlock: names, affiliations and emails above the article's text
// (LaTeXML's ltx_authors, author lists too long for a byline): no headings or
// prose inside, under 200 characters of text before it.
func isAuthorBlock(el, root *Node) bool {
	if el.textLen == 0 || el.textLen >= 2000 || proseLength(el) >= 200 || hasHeading(el) {
		return false
	}
	before := 0
	for e := el; e != root && e.Parent != nil; e = e.Parent {
		for _, sibling := range e.Parent.Children {
			if sibling == e {
				break
			}
			if sibling.Kind == TextNode {
				before += sibling.length()
			} else if !sibling.skip {
				before += sibling.textLen
			}
		}
		if before >= 200 {
			return false
		}
	}
	return true
}

func hasHeading(el *Node) bool {
	found := false
	walk(el, func(e *Node) bool {
		if found || e.skip {
			return false
		}
		if isHeadingTag(e.Tag) {
			found = true
		}
		return !found
	})
	return found
}

// prepare cleans a root; statistics from the attempt's measure(body) are still valid here.
func prepare(root *Node, f flags) {
	rootLen := float64(max(1, root.textLen))

	walk(root, func(el *Node) bool {
		if el == root {
			return true
		}
		if el.skip {
			return false
		}
		tag := el.Tag
		if tag == "pre" || tag == "code" || tag == "math" || tag == "math-tex" || tag == "table" && isDataTableCached(el) {
			return false
		}
		if tag == "footer" && !hasAncestorTag(el, func(t string) bool { return t == "blockquote" || t == "figure" }) || tag == "aside" && !isCallout(el) && !isNoteMarkup(el) || tag == "nav" || tag == "d-appendix" || tag == "d-title" || tag == "d-byline" || tag == "form" && el.textLen < 200 {
			el.skip = true
			return false
		}
		if tag == "iframe" && !isContentFrame(el) {
			el.skip = true
			return false
		}
		// A heading's id is a slug of its own words ("nav_relaxing-in-...") and says nothing about it.
		match := el.matchString
		heading := isHeadingTag(tag)
		if heading {
			match = el.lowerClassName()
		}
		test := func(p *classPattern) bool {
			if heading {
				return p.match(match)
			}
			return p.matchEl(el)
		}
		if u16len(match) > 1 && float64(el.textLen) < math.Max(500, rootLen*0.3) {
			if test(share) && el.textLen < 500 || test(boilerplate) && !test(maybeContent) {
				el.skip = true
				return false
			}
		}
		if strings.Contains(match, "author") && isAuthorBlock(el, root) {
			el.skip = true
			return false
		}
		if tag == "article" && float64(el.textLen) < rootLen*0.4 && el.textLen < 1500 && hasLinkedHeading(el) {
			el.skip = true
			return false
		}
		if (tag == "ul" || tag == "ol") && isTableOfContents(el) {
			el.skip = true
			if heading := previousElement(el); heading != nil && isHeadingTag(heading.Tag) && heading.textLen < 40 {
				heading.skip = true
			}
			return false
		}
		// Negative words in a heading's class drop it, unless it anchors a section (an id that is not negative itself).
		if (tag == "h1" || tag == "h2") && classWeight(el, f) < 0 && (el.idAttr() == "" || negative.match(el.lowerIDString())) {
			el.skip = true
			return false
		}
		// A heading stays or goes whole: its links ("toc-backref", permalinks) are its words.
		if isHeadingTag(tag) {
			return false
		}
		if el.textLen < 40 && el.textLen > 0 && (tag == "p" || tag == "div" || tag == "span" || tag == "a" || tag == "li") && isUIText(textOf(el)) {
			el.skip = true
			return false
		}
		return true
	})

	if f.cleanConditionally {
		cleanConditionally(root, f)
	}
}

// isTableOfContents: a list of three or more items that is almost all links to sections of this page.
func isTableOfContents(list *Node) bool {
	if list.textLen == 0 || list.linkLen < float64(list.textLen)*0.2 {
		return false
	}
	items := 0
	inPage := 0
	walk(list, func(e *Node) bool {
		if e.skip {
			return false
		}
		if e.Tag == "li" {
			items++
		}
		if e.Tag == "a" && isInPageLink(e) {
			inPage += e.textLen
			return false
		}
		return true
	})
	return items >= 3 && float64(inPage) >= float64(list.textLen)*0.8
}

func previousElement(el *Node) *Node {
	parent := el.Parent
	if parent == nil {
		return nil
	}
	for i := indexOf(parent.Children, el) - 1; i >= 0; i-- {
		prev := parent.Children[i]
		if prev.Kind == ElementNode {
			if prev.skip {
				return nil
			}
			return prev
		}
		if !isBlank(prev.text) {
			return nil
		}
	}
	return nil
}

// hasLinkedHeading: teaser cards: a nested article whose heading links elsewhere.
func hasLinkedHeading(el *Node) bool {
	found := false
	walk(el, func(e *Node) bool {
		if found {
			return false
		}
		if e.Tag == "h1" || e.Tag == "h2" || e.Tag == "h3" || e.Tag == "h4" {
			walk(e, func(x *Node) bool {
				if x.Tag == "a" {
					if href, ok := x.attr("href"); ok && (href == "" || href[0] != '#') {
						found = true
					}
				}
				return !found
			})
			return false
		}
		return true
	})
	return found
}

func isConditionalTag(tag string) bool {
	switch tag {
	case "form", "fieldset", "table", "ul", "ol", "div", "section", "aside", "header", "dl":
		return true
	}
	return false
}

func isTextishTag(tag string) bool {
	switch tag {
	case "span", "li", "td", "blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul":
		return true
	}
	return false
}

// counts are subtree counts for conditional cleaning, excluding removed descendants.
type counts struct {
	text   int
	link   float64
	commas int
	p      int
	img    int
	li     int
	input  int
	// pre, math, a data table or a player: content that is never cleaned away.
	protected   int
	embeds      int
	headingText int
	listText    int
	textishText int
	// Figures holding an image, and the text and link text inside them (captions, credits).
	figures    int
	figureText int
	figureLink float64
}

func cleanConditionally(root *Node, f flags) {
	var visit func(el *Node, inProtected bool) counts
	visit = func(el *Node, inProtected bool) counts {
		var c counts
		tag := el.Tag
		dataTable := tag == "table" && isDataTableCached(el)
		// Footnote lists are link-heavy by nature; they are never clutter.
		notes := isFootnotes(el)
		protectedHere := inProtected || tag == "pre" || tag == "code" || dataTable || notes
		for _, child := range el.Children {
			if child.Kind == TextNode {
				c.text += child.length()
				c.commas += child.commaCount()
				continue
			}
			if child.skip {
				continue
			}
			k := visit(child, protectedHere)
			if child.skip {
				continue
			}
			ct := child.Tag
			c.text += k.text
			if ct == "a" {
				if isInPageLink(child) {
					c.link += float64(k.text) * 0.3
				} else {
					c.link += float64(k.text)
				}
			} else {
				c.link += k.link
			}
			c.commas += k.commas
			c.p += k.p
			if ct == "p" {
				c.p++
			}
			c.img += k.img
			if ct == "img" {
				c.img++
			}
			c.li += k.li
			if ct == "li" {
				c.li++
			}
			c.input += k.input
			if ct == "input" && jsLower(child.av("type")) != "checkbox" {
				c.input++
			}
			c.protected += k.protected
			if ct == "pre" || ct == "math" || ct == "math-tex" || ct == "table" && isDataTableCached(child) || ct == "video" || ct == "audio" || ct == "iframe" && isContentFrame(child) {
				c.protected++
			}
			c.embeds += k.embeds
			if (ct == "object" || ct == "embed" || ct == "iframe") && !(ct == "iframe" && isContentFrame(child)) {
				c.embeds++
			}
			if isHeadingTag(ct) {
				c.headingText += k.text
			} else {
				c.headingText += k.headingText
			}
			if ct == "ul" || ct == "ol" {
				c.listText += k.text
			} else {
				c.listText += k.listText
			}
			if isTextishTag(ct) {
				c.textishText += k.text
			} else {
				c.textishText += k.textishText
			}
			if ct == "figure" && k.img > 0 {
				c.figures++
				c.figureText += k.text
				c.figureLink += k.link
			} else {
				c.figures += k.figures
				c.figureText += k.figureText
				c.figureLink += k.figureLink
			}
		}
		el.textLen = c.text
		el.linkLen = c.link
		el.commas = c.commas
		if el != root && isConditionalTag(tag) && !inProtected && !notes && shouldRemove(el, &c, f) {
			el.skip = true
		}
		return c
	}
	visit(root, false)
}

func shouldRemove(el *Node, c *counts, f flags) bool {
	tag := el.Tag
	if tag == "table" && isDataTableCached(el) {
		return false
	}
	if c.protected > 0 {
		return false
	}
	// A wrapper around captioned figures (credit links and all) is media, not clutter.
	if c.figures > 0 && c.text-c.figureText < 25 && c.figureLink <= float64(c.figureText)*0.5 && c.input == 0 {
		return false
	}

	isList := tag == "ul" || tag == "ol"
	if !isList && c.text > 0 {
		isList = float64(c.listText)/float64(c.text) > 0.9
	}

	weight := classWeight(el, f)
	if weight < 0 {
		return true
	}
	text := float64(c.text)
	// An author's note box (admonition, callout) with prose in it stays, however many links it cites.
	if c.p > 0 && u16len(el.matchString) > 1 && c.link <= text*0.6 && c.input == 0 && isCallout(el) {
		return false
	}
	// A boxed "Recommended stories" / "Read more": a heading over a list of links elsewhere, and nothing else.
	if tag != "ul" && tag != "ol" && c.headingText > 0 && c.li >= 2 && c.text-c.listText <= c.headingText+30 && c.link >= float64(c.text-c.headingText)*0.7 {
		return true
	}
	if c.commas >= 10 {
		return false
	}
	// Heading wrappers (div.mw-heading with an edit link) are structure, not clutter.
	if c.headingText > 0 && text-c.link <= float64(c.headingText)*1.2 {
		return false
	}

	if c.text < 40 {
		t := textOf(el)
		if adWords.MatchString(t) || loadingWords.MatchString(t) {
			return true
		}
	}

	p := c.p
	img := c.img
	li := c.li - 100
	headingDensity := 0.0
	density := 0.0
	textDensity := 0.0
	if c.text != 0 {
		headingDensity = float64(c.headingText) / text
		density = math.Min(1, c.link/text)
		textDensity = float64(c.textishText) / text
	}
	contentLength := c.text
	inFigure := hasAncestorTag(el, func(t string) bool { return t == "figure" })

	remove := false
	if !inFigure && img > 1 && float64(p)/float64(img) < 0.5 {
		remove = true
	}
	if !isList && li > p {
		remove = true
	}
	if c.input > p/3 {
		remove = true
	}
	if !isList && !inFigure && headingDensity < 0.9 && contentLength < 25 && (img == 0 || img > 2) && density > 0 {
		remove = true
	}
	// Link-rich sections (encyclopedias, docs): a heading over whole sentences tolerates more links.
	if !isList && weight < 25 && density > 0.2 && !(density <= 0.3 && c.p > 0 && c.headingText > 0 && c.text-c.headingText >= 150 && sentences(textOf(el)) >= 2) {
		remove = true
	}
	if weight >= 25 && density > 0.5 {
		remove = true
	}
	// A list of short link-only items outside the prose ("Recent posts", archives, tag clouds) is navigation.
	if isList && tag != "ul" && tag != "ol" && c.li >= 3 && density > 0.6 && float64(contentLength)/float64(c.li) < 120 && headingDensity < 0.5 {
		remove = true
	}
	if (c.embeds == 1 && contentLength < 75) || c.embeds > 1 {
		remove = true
	}
	if img == 0 && textDensity == 0 && contentLength == 0 {
		remove = true
	}

	// Lists of images (galleries) stay.
	if isList && remove {
		for _, child := range el.Children {
			if child.Kind == ElementNode && !child.skip {
				elements := 0
				for _, k := range child.Children {
					if k.Kind == ElementNode {
						elements++
					}
				}
				if elements > 1 {
					return remove
				}
			}
		}
		if c.li == img {
			return false
		}
	}
	return remove
}

var uiTextGate = newPrefixGate("text size", "caption", "image ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "photo", "gallery", "enlarge", "view ", "ad", "sponsored", "share", "tweet", "email", "print", "cop", "loading", "read more", "continue reading", "subscribe", "sign up", "follow", "listen", "save", "bookmark", "comment", "reply", "related", "you may also like", "recommended", "more from ", "skip ", "back to top", "top", "close", "menu", "toggle navigation", "show more", "load more", "see more", "×")

// isUIText: short stand-alone text that is UI, not prose.
func isUIText(text string) bool {
	return uiTextGate.open(text) && uiText.MatchString(text)
}

// sentences counts sentence ends (any script) in text.
func sentences(text string) int {
	return len(sentenceEnd.FindAllStringIndex(text, -1))
}

// findContent runs the attempts and returns the article's root elements in
// document order. Mirrors Readability's retry: when the result is short, retry
// with fewer heuristics and keep the longest result.
func findContent(body *Node, articleBody *string) []*Node {
	const charThreshold = 500
	normalize(body)
	flagSets := [...]flags{
		{stripUnlikely: true, weightClasses: true, cleanConditionally: true},
		{stripUnlikely: false, weightClasses: true, cleanConditionally: true},
		{stripUnlikely: false, weightClasses: false, cleanConditionally: true},
		{stripUnlikely: false, weightClasses: false, cleanConditionally: false},
	}
	var attempts []attempt
	for _, f := range flagSets {
		a := grab(body, f, articleBody)
		if a.textLength >= charThreshold {
			return a.roots
		}
		attempts = append(attempts, a)
	}
	best := 0
	for i, a := range attempts {
		if a.textLength > attempts[best].textLength {
			best = i
		}
	}
	// Re-run the winning attempt so the marks on the tree match it.
	return grab(body, flagSets[best], articleBody).roots
}
