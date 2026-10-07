package truffle

// A compact, mutable copy of the parsed page (tree.ts). The page is walked
// once; every later stage (metadata, scoring, cleaning, block conversion)
// works on these nodes. Only the stage that builds them from a parser's tree
// is platform-specific.

import (
	"strings"
	"unicode/utf8"
	"unsafe"
)

// NodeKind tells text nodes from elements.
type NodeKind uint8

const (
	TextNode    NodeKind = 0
	ElementNode NodeKind = 1
	// Only the HTML parser's tree has these; the Document built from it never does.
	CommentNode  NodeKind = 2
	DocumentNode NodeKind = 3
	DoctypeNode  NodeKind = 4
)

// Namespaces of parsed elements.
const (
	nsHTML   uint8 = 0
	nsSVG    uint8 = 1
	nsMathML uint8 = 2
)

// Attr is one attribute, in source order.
type Attr struct {
	Name  string
	Value string
}

// Node is a text node or an element of a Document.
type Node struct {
	Kind NodeKind
	ns   uint8 // nsHTML, nsSVG or nsMathML (parser trees)
	atom atom  // parser only: Tag interned (html_atom.go)
	// matchString[:classEnd] is the lowercase class, matchString[classEnd+1:] the lowercase id.
	classEnd int32

	// Readability-style score, valid while scored.
	scored bool
	// Excluded from scoring and output (boilerplate, hidden).
	skip bool
	// Set by content normalization: has a block-level descendant.
	containsBlock bool
	// Cached: isContentFrame, has a block-level descendant, data table,
	// footnote list (-1 unknown, 0 no, 1 yes).
	frameState, blockState, tableState, notesState int8

	// Text nodes: cached visibleLength(text) (-1 until first asked) and commas.
	visLen, commaCnt int32

	Parent *Node
	// Text nodes.
	text string

	// Elements.
	Tag      string
	Attrs    []Attr
	Children []*Node
	// matchString is the lowercase class + " " + id, for pattern matching.
	matchString string

	// Visible text length (whitespace runs count as one), excluding skipped descendants.
	textLen int
	// Commas (any script) in the text.
	commas int
	// Text length inside links.
	linkLen float64
	score   float64
	// Class pattern results on matchString (classPattern.matchEl).
	patKnown, patHit uint64
}

// Document is the compact tree extraction runs on.
type Document struct {
	Root *Node
	Head *Node // nil when the page has none
	Body *Node
	// Raw text of `<script type="application/ld+json">` blocks, in document order.
	JSONLD []string
	// Raw text of a Next.js `__NEXT_DATA__` script, if present.
	NextData *string
	// `<base href>`, when the page declares one.
	BaseHref *string
	// The <meta>, <link> and <title> elements in Body, in document order, when
	// the tree was built by FromTree (nil: metadata walks Body for them).
	bodyMeta    []*Node
	hasBodyMeta bool
}

// NewText returns a text node.
func NewText(text string) *Node {
	return &Node{Kind: TextNode, text: text, visLen: -1}
}

// NewElement returns an element with the given attributes (kept in order).
func NewElement(tag string, attrs []Attr) *Node {
	el := &Node{Kind: ElementNode, Tag: tag, Attrs: attrs, blockState: -1, tableState: -1, notesState: -1, frameState: -1}
	el.initMatch()
	return el
}

// lower returns the lowercase className and id.
// lower is the lowercase class and id (jsLower).
func (el *Node) lower() (string, string) {
	return el.matchString[:el.classEnd], el.matchString[el.classEnd+1:]
}

func (el *Node) lowerIDString() string {
	return el.matchString[el.classEnd+1:]
}

func (el *Node) lowerClassName() string {
	return el.matchString[:el.classEnd]
}

// classAttr is the class attribute ("" when absent).
func (el *Node) classAttr() string {
	v, _ := el.attr("class")
	return v
}

// idAttr is the id attribute ("" when absent).
func (el *Node) idAttr() string {
	v, _ := el.attr("id")
	return v
}

func (el *Node) initMatch() { el.initMatchIn(nil) }

// initMatchIn: initMatch, the match string allocated from a (nil: the heap).
func (el *Node) initMatchIn(a *strArena) {
	el.frameState = -1
	cls, _ := el.attr("class")
	id, _ := el.attr("id")
	if cls == "" && id == "" {
		el.matchString, el.classEnd = " ", 0
		return
	}
	// jsLower(cls + " " + id), which is jsLower(cls) + " " + jsLower(id) (a
	// space ends a word for final sigma): ASCII lowercased in place.
	n := len(cls) + 1 + len(id)
	buf := a.alloc(n)
	for i := 0; i < len(cls); i++ {
		if cls[i] >= 0x80 {
			el.lowerSlow(cls, id)
			return
		}
		buf[i] = lowerByte[cls[i]]
	}
	buf[len(cls)] = ' '
	for i := 0; i < len(id); i++ {
		if id[i] >= 0x80 {
			el.lowerSlow(cls, id)
			return
		}
		buf[len(cls)+1+i] = lowerByte[id[i]]
	}
	el.matchString, el.classEnd = unsafe.String(&buf[0], n), int32(len(cls))
}

func (el *Node) lowerSlow(cls, id string) {
	lc := jsLower(cls)
	el.matchString, el.classEnd = lc+" "+jsLower(id), int32(len(lc))
}

// strArena hands out byte slices from shared chunks, for strings built once
// and never changed (one allocation per chunk instead of one per string).
type strArena struct {
	chunk []byte
}

func (a *strArena) alloc(n int) []byte {
	if a == nil || n > 1024 {
		return make([]byte, n)
	}
	if len(a.chunk) < n {
		a.chunk = make([]byte, 16<<10)
	}
	b := a.chunk[:n:n]
	a.chunk = a.chunk[n:]
	return b
}

// Text is a text node's text.
func (n *Node) Text() string { return n.text }

// attr is `el.attrs[name]` (ok false when undefined).
func (el *Node) attr(name string) (string, bool) {
	for i := range el.Attrs {
		if el.Attrs[i].Name == name {
			return el.Attrs[i].Value, true
		}
	}
	return "", false
}

// Attr returns an attribute's value and whether it is present.
func (el *Node) Attr(name string) (string, bool) { return el.attr(name) }

// av is `el.attrs[name] ?? ”`.
func (el *Node) av(name string) string {
	v, _ := el.attr(name)
	return v
}

func (el *Node) has(name string) bool {
	_, ok := el.attr(name)
	return ok
}

// attrIs is `el.attrs[name] === value`.
func (el *Node) attrIs(name, value string) bool {
	v, ok := el.attr(name)
	return ok && v == value
}

// attrPtr is `el.attrs[name]` as a nullable string.
func (el *Node) attrPtr(name string) *string {
	for i := range el.Attrs {
		if el.Attrs[i].Name == name {
			return &el.Attrs[i].Value
		}
	}
	return nil
}

func (el *Node) setAttr(name, value string) {
	for i := range el.Attrs {
		if el.Attrs[i].Name == name {
			el.Attrs[i].Value = value
			return
		}
	}
	el.Attrs = append(el.Attrs, Attr{name, value})
}

// hasClass: the class attribute lists name as one of its whitespace-separated words.
func (el *Node) hasClass(name string) bool {
	if el.classAttr() == "" || !strings.Contains(el.classAttr(), name) {
		return false
	}
	return hasToken(el.classAttr(), name)
}

func (el *Node) appendChild(node *Node) {
	node.Parent = el
	el.Children = append(el.Children, node)
}

// length is a text node's `visibleLength`, cached.
func (n *Node) length() int {
	if n.visLen < 0 {
		l, c := measureText(n.text)
		n.visLen, n.commaCnt = int32(l), int32(c)
	}
	return int(n.visLen)
}

// measureText is visibleLength and countCommas in one pass.
func measureText(text string) (length, commas int) {
	n := 0
	space := true
	for i := 0; i < len(text); {
		c := text[i]
		switch textClass[c] {
		case textOther:
			n++
			space = false
			i++
		case textSpace:
			if !space {
				n++
				space = true
			}
			i++
		case textComma:
			n++
			commas++
			space = false
			i++
		default:
			r, size := utf8.DecodeRuneInString(text[i:])
			if r >= 0x10000 {
				n += 2
			} else {
				n++
			}
			if isNonASCIIComma(r) {
				commas++
			}
			space = false
			i += size
		}
	}
	if space && n > 0 {
		n--
	}
	return n, commas
}

const (
	textOther = iota
	textSpace
	textComma
	textNonASCII
)

var textClass = func() (t [256]uint8) {
	for c := 0x80; c < 0x100; c++ {
		t[c] = textNonASCII
	}
	for _, c := range []byte{' ', '\n', '\t', '\r', '\f'} {
		t[c] = textSpace
	}
	t[','] = textComma
	return t
}()

func (n *Node) commaCount() int {
	if n.visLen < 0 {
		n.length()
	}
	return int(n.commaCnt)
}

// ------------------------------------------------------------------ helpers

// rawText is the concatenated text of a subtree (skipped nodes excluded).
func rawText(node *Node) string {
	if node.Kind == TextNode {
		return node.text
	}
	if node.skip {
		return ""
	}
	// One child text: no copy.
	if len(node.Children) == 1 && node.Children[0].Kind == TextNode {
		return node.Children[0].text
	}
	var b strings.Builder
	appendRawText(&b, node)
	return b.String()
}

func appendRawText(b *strings.Builder, node *Node) {
	for _, child := range node.Children {
		if child.Kind == TextNode {
			b.WriteString(child.text)
		} else if !child.skip {
			appendRawText(b, child)
		}
	}
}

// textOf is the text of a subtree with whitespace collapsed and trimmed.
func textOf(node *Node) string {
	return collapse(rawText(node))
}

// visibleLength is the length of text as rendered: whitespace runs count as
// one character, edges trimmed. UTF-16 code units, as in JavaScript.
func visibleLength(text string) int {
	n := 0
	space := true
	for i := 0; i < len(text); {
		c := text[i]
		if c < 0x80 {
			if c == ' ' || c == '\n' || c == '\t' || c == '\r' || c == '\f' {
				if !space {
					n++
					space = true
				}
			} else {
				n++
				space = false
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		space = false
		i += size
	}
	if space && n > 0 {
		return n - 1
	}
	return n
}

// countCommas counts commas in any script: , ، 、 ， ﹐ ﹑ ､ ⸲ ⸴ ⹁ ⹌ ⹎ ߸ ᠂ ᠈ ꓾ ꘍ ꛵ ︑
func countCommas(text string) int {
	n := 0
	for i := 0; i < len(text); {
		c := text[i]
		if c < 0x80 {
			if c == ',' {
				n++
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		if isNonASCIIComma(r) {
			n++
		}
		i += size
	}
	return n
}

func isNonASCIIComma(r rune) bool {
	switch r {
	case 0x60c, 0x3001, 0xff0c, 0xfe50, 0xfe51, 0xff64, 0x2e32, 0x2e34, 0x2e41, 0x2e4c, 0x2e4e, 0x7f8, 0x1802, 0x1808, 0xa4fe, 0xa60d, 0xa6f5, 0xfe11:
		return true
	}
	return false
}

// walk is a depth-first pre-order walk over elements. Return false from visit
// to skip an element's children.
func walk(el *Node, visit func(el *Node) bool) {
	if !visit(el) {
		return
	}
	for _, child := range el.Children {
		if child.Kind == ElementNode {
			walk(child, visit)
		}
	}
}

// walkAll is walk without pruning.
func walkAll(el *Node, visit func(el *Node)) {
	visit(el)
	for _, child := range el.Children {
		if child.Kind == ElementNode {
			walkAll(child, visit)
		}
	}
}

// firstElement is the first descendant (pre-order, el excluded) passing test.
func firstElement(el *Node, test func(e *Node) bool) *Node {
	for _, child := range el.Children {
		if child.Kind != ElementNode {
			continue
		}
		if test(child) {
			return child
		}
		if found := firstElement(child, test); found != nil {
			return found
		}
	}
	return nil
}

// firstTag is firstElement(el, e => e.tag === tag).
func firstTag(el *Node, tag string) *Node {
	for _, child := range el.Children {
		if child.Kind != ElementNode {
			continue
		}
		if child.Tag == tag {
			return child
		}
		if found := firstTag(child, tag); found != nil {
			return found
		}
	}
	return nil
}

// indexOf is `parent.children.indexOf(node)`.
func indexOf(nodes []*Node, node *Node) int {
	for i, n := range nodes {
		if n == node {
			return i
		}
	}
	return -1
}

// isAncestor: ancestor is a proper ancestor of node.
func isAncestor(ancestor, node *Node) bool {
	for p := node.Parent; p != nil; p = p.Parent {
		if p == ancestor {
			return true
		}
	}
	return false
}
