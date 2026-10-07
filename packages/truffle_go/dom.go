package truffle

// fromDocument: the parser's tree becomes the engine's Document (tree.ts
// `fromDom`). The tree is filtered in place: dropped elements leave their
// parent's children, kept nodes are reused, so no second tree is allocated.

import (
	"strings"
)

// ParseDocument parses HTML the way a browser does with scripting disabled
// and returns the compact tree extraction runs on.
func ParseDocument(html string) *Document {
	return fromDocument(parseHTML(html))
}

// ParseHTML is the first half of ParseDocument: the HTML Standard's tree
// construction (scripting disabled), returning the Document node of the DOM.
func ParseHTML(html string) *Node {
	return parseHTML(html)
}

// FromTree is the second half of ParseDocument (the TypeScript engine's
// `fromDom`): it filters a ParseHTML tree in place into the Document
// extraction runs on. The tree is consumed.
func FromTree(tree *Node) *Document {
	return fromDocument(tree)
}

// ExtractHTML parses HTML and extracts its article; nil when there is none.
func ExtractHTML(html string, opts Options) *Article {
	// The tree is dropped after extraction (the article holds no node), so its
	// slabs go to the next page.
	s := slabPool.Get().(*slabs)
	article := ExtractTree(fromDocument(parseHTMLSlabs(html, s)), opts)
	s.release()
	return article
}

// Parser parses pages one after another into the same memory, which stays
// in the processor's cache: each parse reuses the nodes of the tree before,
// so a tree or Document must not be used after the next parse. The zero
// value is ready to use; a Parser is not safe for concurrent use.
type Parser struct {
	slabs *slabs
}

// ParseHTML is ParseHTML into the parser's memory.
func (p *Parser) ParseHTML(html string) *Node {
	if p.slabs == nil {
		p.slabs = new(slabs)
	} else {
		p.slabs.reset()
	}
	return parseHTMLSlabs(html, p.slabs)
}

// ParseDocument is ParseDocument into the parser's memory.
func (p *Parser) ParseDocument(html string) *Document {
	return fromDocument(p.ParseHTML(html))
}

// isDroppedTag: elements dropped with their content while copying the DOM.
func isDroppedTag(tag string) bool {
	switch tag {
	case "script", "style", "template", "canvas", "object", "embed", "applet", "param",
		"select", "option", "optgroup", "textarea", "button", "datalist", "dialog", "map", "area",
		"frame", "frameset", "noembed", "portal", "slot", "meter", "progress", "output":
		return true
	}
	return false
}

var (
	srOnly        = newClassPattern(`(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|screenreader-only|a11y-hidden|hide-for-sr|u-hidden-visually|vh|offscreen|is-hidden|hidden-text)(?:\s|$)`)
	decorativeAri = jsRegexp(`fallback-image|lazy|image|img|photo|figure|media`, "i")
)

// isSuspenseID is `/^S:\d+$/`: React streaming SSR parks finished Suspense
// boundaries in <div hidden id="S:n"> until JavaScript swaps them in.
func isSuspenseID(id string) bool {
	if len(id) < 3 || id[0] != 'S' || id[1] != ':' {
		return false
	}
	for i := 2; i < len(id); i++ {
		if id[i] < '0' || id[i] > '9' {
			return false
		}
	}
	return true
}

func isHidden(el *Node, tag string) bool {
	cls, hasCls := el.attr("class")
	if hasCls && strings.Contains(cls, "mwe-math-mathml") {
		return false
	}
	if el.has("hidden") && tag != "input" && !isSuspenseID(el.av("id")) {
		return true
	}
	if style, ok := el.attr("style"); ok && isHiddenStyle(style) {
		return true
	}
	if hasCls && srOnly.match(cls) {
		return true
	}
	if el.attrIs("aria-hidden", "true") {
		// KaTeX and MathJax hide their visual copy; the MathML copy is read instead.
		// Decorative wrappers that still hold real images or long text stay.
		return !(hasCls && decorativeAri.MatchString(cls))
	}
	return false
}

// isHiddenStyle is `/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i`.
func isHiddenStyle(style string) bool {
	for i := 0; ; {
		j := skipJSSpace(style, i)
		rest := style[j:]
		switch {
		case hasPrefixFold(rest, "display"):
			if k := skipJSSpace(style, j+7); k < len(style) && style[k] == ':' && hasPrefixFold(style[skipJSSpace(style, k+1):], "none") {
				return true
			}
		case hasPrefixFold(rest, "visibility"):
			if k := skipJSSpace(style, j+10); k < len(style) && style[k] == ':' && hasPrefixFold(style[skipJSSpace(style, k+1):], "hidden") {
				return true
			}
		}
		next := strings.IndexByte(style[i:], ';')
		if next < 0 {
			return false
		}
		i += next + 1
	}
}

// textContent is the DOM's textContent: all descendant text.
func textContent(el *Node) string {
	if len(el.Children) == 1 && el.Children[0].Kind == TextNode {
		return el.Children[0].text
	}
	var b strings.Builder
	var visit func(n *Node)
	visit = func(n *Node) {
		for _, c := range n.Children {
			switch c.Kind {
			case TextNode:
				b.WriteString(c.text)
			case ElementNode:
				visit(c)
			}
		}
	}
	visit(el)
	return b.String()
}

var imageObjectExt = jsRegexp(`\.(?:svg|png|jpe?g|gif|webp|avif)(?:$|[?#])`, "i")

func isImageObject(el *Node) bool {
	data, ok := el.attr("data")
	if !ok || data == "" {
		return false
	}
	typ := jsLower(el.av("type"))
	return strings.HasPrefix(typ, "image/") || typ == "" && imageObjectExt.MatchString(data)
}

type domBuilder struct {
	// <meta>, <link> and <title> outside <head>, for readMetadata.
	bodyMeta []*Node
	jsonLd   []string
	nextData *string
	baseHref *string
	head     *Node
	body     *Node
	// strings holds the elements' match strings.
	strings strArena
}

func fromDocument(doc *Node) *Document {
	b := &domBuilder{}
	var root *Node
	for _, c := range doc.Children {
		if c.Kind == ElementNode {
			root = b.copy(c, nil, false)
			break
		}
	}
	if root == nil {
		root = NewElement("html", nil)
	}
	root.Parent = nil
	if b.body == nil {
		b.body = NewElement("body", nil)
		root.appendChild(b.body)
	}
	out := &Document{Root: root, Head: b.head, Body: b.body, JSONLD: b.jsonLd, NextData: b.nextData, BaseHref: b.baseHref}
	// Only the ones inside the body element count (a <title> in a body-less page's root does not).
	for _, el := range b.bodyMeta {
		if isAncestor(b.body, el) {
			out.bodyMeta = append(out.bodyMeta, el)
		}
	}
	out.hasBodyMeta = true
	return out
}

// copy keeps el (filtered) or returns nil when it is dropped; parent is nil for the root.
func (b *domBuilder) copy(el *Node, parent *Node, inHead bool) *Node {
	tag := el.Tag
	switch tag {
	case "script":
		typ := jsLower(el.av("type"))
		if typ == "application/ld+json" {
			if text := textContent(el); text != "" {
				b.jsonLd = append(b.jsonLd, text)
			}
		} else if el.av("id") == "__NEXT_DATA__" {
			text := textContent(el)
			b.nextData = &text
		} else if strings.HasPrefix(typ, "math/tex") && parent != nil {
			display := "inline"
			if strings.Contains(typ, "mode=display") {
				display = "block"
			}
			math := NewElement("math-tex", []Attr{{"display", display}})
			math.appendChild(NewText(textContent(el)))
			return math
		}
		return nil
	case "base":
		if b.baseHref == nil {
			b.baseHref = el.attrPtr("href")
		}
		return nil
	case "object":
		// <object type="image/svg+xml" data="chart.svg"> is an image (LaTeXML figures, old sites).
		if !inHead && isImageObject(el) {
			attrs := []Attr{{"src", el.av("data")}, {"alt", el.av("title")}}
			if w, ok := el.attr("width"); ok {
				attrs = append(attrs, Attr{"width", w})
			}
			if h, ok := el.attr("height"); ok {
				attrs = append(attrs, Attr{"height", h})
			}
			return NewElement("img", attrs)
		}
	}
	if isDroppedTag(tag) {
		return nil
	}
	if inHead && tag != "title" && tag != "meta" && tag != "link" && tag != "noscript" {
		return nil
	}
	// Streaming renderers (React 19, Next.js) emit <title>, <meta> and <link> inside <body>; keep them for metadata.
	if tag == "meta" || tag == "link" || tag == "title" {
		if !inHead && tag == "meta" && !el.has("itemprop") && !el.has("property") && !el.has("name") {
			return nil
		}
		if !inHead {
			b.bodyMeta = append(b.bodyMeta, el)
		}
	} else if !inHead && isHidden(el, tag) {
		return nil
	}
	el.initMatchIn(&b.strings)

	if tag == "math" || tag == "svg" {
		// Kept as a leaf: math is serialized later; svg is dropped by the converter.
		text := NewText(textContent(el))
		if tag == "math" {
			var out strings.Builder
			serializeXML(el, &out)
			tex := annotationTex(el)
			el.Children = nil
			el.setAttr("data-xml", out.String())
			if tex != "" {
				el.setAttr("data-tex", jsTrim(tex))
			}
		} else {
			el.Children = nil
		}
		el.appendChild(text)
		return el
	}

	childInHead := inHead || tag == "head"
	kids := el.Children
	kept := kids[:0]
	for _, child := range kids {
		switch child.Kind {
		case TextNode:
			if child.text != "" {
				child.Parent = el
				kept = append(kept, child)
			}
		case ElementNode:
			if c := b.copy(child, el, childInHead); c != nil {
				c.Parent = el
				kept = append(kept, c)
			}
		}
	}
	// Clear the tail so dropped subtrees can be collected.
	for i := len(kept); i < len(kids); i++ {
		kids[i] = nil
	}
	el.Children = kept
	if tag == "head" {
		b.head = el
	} else if tag == "body" {
		b.body = el
	}
	return el
}

// annotationTex is the text of `annotation[encoding="application/x-tex"]`, the first in document order.
func annotationTex(el *Node) string {
	found := firstElement(el, func(e *Node) bool { return e.Tag == "annotation" && e.attrIs("encoding", "application/x-tex") })
	if found == nil {
		return ""
	}
	return textContent(found)
}

func isMathMLElement(tag string) bool {
	switch tag {
	case "math", "semantics", "mi", "mn", "mo", "ms", "mtext", "mspace", "mrow", "mfrac", "msqrt", "mroot", "mstyle", "merror",
		"mpadded", "mphantom", "mfenced", "menclose", "msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts",
		"mprescripts", "none", "mtable", "mtr", "mtd", "mlabeledtr", "maligngroup", "malignmark", "maction":
		return true
	}
	return false
}

func isMathMLAttribute(name string) bool {
	switch name {
	case "accent", "accentunder", "actiontype", "align", "alttext", "arg", "bevelled", "close", "columnalign", "columnlines",
		"columnspacing", "columnspan", "denomalign", "depth", "dir", "display", "displaystyle", "encoding", "equalcolumns",
		"equalrows", "fence", "form", "frame", "height", "intent", "largeop", "linethickness", "lspace", "mathbackground",
		"mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "movablelimits", "notation", "numalign", "open", "rowalign",
		"rowlines", "rowspacing", "rowspan", "rspace", "scriptlevel", "scriptminsize", "scriptsizemultiplier", "selection",
		"separator", "separators", "stretchy", "subscriptshift", "superscriptshift", "symmetric", "voffset", "width":
		return true
	}
	// /^data-[a-z0-9-]+$/
	if len(name) > 5 && strings.HasPrefix(name, "data-") {
		for i := 5; i < len(name); i++ {
			c := name[i]
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
				return false
			}
		}
		return true
	}
	return false
}

// serializeXML is a deterministic serialization of a MathML subtree
// (attributes in source order, no namespaces). Only MathML elements and
// attributes are written; anything else keeps only its text, so the output is inert markup.
func serializeXML(el *Node, out *strings.Builder) {
	tag := el.Tag
	switch tag {
	case "annotation", "annotation-xml", "script", "style", "template":
		return
	}
	kept := isMathMLElement(tag)
	if kept {
		out.WriteByte('<')
		out.WriteString(tag)
		for _, a := range el.Attrs {
			if !isMathMLAttribute(a.Name) {
				continue
			}
			out.WriteByte(' ')
			out.WriteString(a.Name)
			out.WriteString(`="`)
			writeEscaped(out, a.Value, true)
			out.WriteByte('"')
		}
		out.WriteByte('>')
	}
	for _, child := range el.Children {
		switch child.Kind {
		case TextNode:
			writeEscaped(out, child.text, false)
		case ElementNode:
			serializeXML(child, out)
		}
	}
	if kept {
		out.WriteString("</")
		out.WriteString(tag)
		out.WriteByte('>')
	}
}

func writeEscaped(out *strings.Builder, s string, quote bool) {
	start := 0
	for i := 0; i < len(s); i++ {
		var rep string
		switch s[i] {
		case '&':
			rep = "&amp;"
		case '<':
			rep = "&lt;"
		case '>':
			rep = "&gt;"
		case '"':
			if !quote {
				continue
			}
			rep = "&quot;"
		default:
			continue
		}
		out.WriteString(s[start:i])
		out.WriteString(rep)
		start = i + 1
	}
	out.WriteString(s[start:])
}
