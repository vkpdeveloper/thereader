// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// HTML tree construction (HTML Standard 13.2.6) with the scripting flag
// disabled, forked from golang.org/x/net/html (parse.go) to build Nodes
// directly: no per-token allocation, nodes, child lists and attribute lists
// carved from parser-owned slabs, tag checks on interned atoms. It keeps
// x/net's algorithm and its documented divergences (template contents are
// the template's children, the legacy <select> insertion modes, as in parse5
// 7 and jsdom), and departs from it where x/net departs from the standard and
// browsers: no 512-deep nesting limit, "</p>" and "</br>" break out of
// foreign content, and an uppercase "<!DOCTYPE HTML>" is not quirks mode.

package truffle

import (
	"strings"
	"sync"
)

// parseHTML parses an HTML document the way a browser's DOMParser does with
// scripting disabled. The result is a DocumentNode whose children are the
// doctype, comments and the <html> element; a DoctypeNode carries the name in
// text and its public and system identifiers, when present, as the attributes
// "public" and "system". Texts and attribute values are substrings of src
// when nothing in them needed decoding.
func parseHTML(src string) *Node {
	return parseHTMLSlabs(src, nil)
}

// parseHTMLSlabs parses into recycled slabs (nil: new ones); the caller
// releases them once nothing uses the tree.
func parseHTMLSlabs(src string, s *slabs) *Node {
	p := &parser{
		framesetOK: true,
		im:         initialIM,
		slabs:      s,
	}
	p.oe = p.oeBuf[:0]
	p.afe = p.afeBuf[:0]
	p.tok.attrs = p.attrScratch[:0]
	// Input stream preprocessing (13.2.3.5): CRLF and CR become LF, once, so
	// no later step has to look for CR.
	if strings.IndexByte(src, '\r') >= 0 {
		src = preprocessNewlines(src)
	}
	p.src = src
	p.hasNUL = strings.IndexByte(src, 0) >= 0
	p.ampAt, p.ampFrom = -1, 0
	p.doc = p.newNode()
	p.doc.Kind = DocumentNode
	p.parse()
	return p.doc
}

func preprocessNewlines(s string) string {
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\r' {
			c = '\n'
			if i+1 < len(s) && s[i+1] == '\n' {
				i++
			}
		}
		b = append(b, c)
	}
	return string(b)
}

// A parser implements the HTML5 parsing algorithm.
type parser struct {
	// Tokenizer state (html_token.go).
	src     string
	pos     int
	tok     token
	raw     rawKind
	rawName string
	hasNUL  bool
	// ampAt is the first '&' at or after ampFrom (len(src) if none).
	ampAt, ampFrom int
	doctype        doctypeData
	pending        []byte

	// Self-closing tags like <hr/> are treated as start tags, except that
	// hasSelfClosingToken is set while they are being processed.
	hasSelfClosingToken bool
	// doc is the document root element.
	doc *Node
	// The stack of open elements (13.2.4.3) and active formatting elements
	// (13.2.4.4), backed by arrays deep enough for real pages.
	oe, afe nodeStack
	// Element pointers (13.2.4.4).
	head, form *Node
	// Other parsing state flags (13.2.4.5).
	framesetOK bool
	// The stack of template insertion modes.
	templateStack insertionModeStack
	// im is the current insertion mode.
	im insertionMode
	// originalIM is the insertion mode to go back to after completing a text
	// or inTableText insertion mode.
	originalIM insertionMode
	// fosterParenting is whether new elements should be inserted according to
	// the foster parenting rules (13.2.6.1).
	fosterParenting bool
	// quirks is whether the parser is operating in "quirks mode."
	quirks bool

	// Allocation slabs: nodes, child pointers, attributes, decoded text.
	nodes     []Node
	nodeCount int // nodes in earlier slabs
	kids      []*Node
	attrs     []Attr
	tbuf      []byte
	// slabs, when set, hands out the node, child and attribute slabs.
	slabs *slabs

	oeBuf       [64]*Node
	afeBuf      [32]*Node
	attrScratch [16]Attr
}

// scopeMarker separates the active formatting elements of nested scopes.
var scopeMarker = &Node{Kind: ElementNode}

// ------------------------------------------------------------------ allocation

// newNode hands out a zeroed node from the slab.
func (p *parser) newNode() *Node {
	if len(p.nodes) == cap(p.nodes) {
		p.growNodes()
	}
	p.nodes = p.nodes[:len(p.nodes)+1]
	return &p.nodes[len(p.nodes)-1]
}

// growNodes starts a new node slab, sized by the node density of the source
// read so far: slab memory is zeroed when allocated, so unused slots cost.
func (p *parser) growNodes() {
	p.nodeCount += len(p.nodes)
	var n int
	if p.pos == 0 {
		n = len(p.src) / 128
	} else {
		n = int(float64(p.nodeCount)*float64(len(p.src)-p.pos)/float64(p.pos)) + 16
	}
	n = min(max(n, 64), 512)
	p.nodes = p.slabs.nodeSlab(n)
}

// slabs keeps a parse's node, child and attribute slabs for the next parse:
// ExtractHTML drops the tree it extracts from, and reused memory is still in
// the cache. Decoded text is never recycled (the article keeps it).
type slabs struct {
	nodes   [][]Node
	kids    [][]*Node
	attrs   [][]Attr
	n, k, a int // slabs handed out
}

var slabPool = sync.Pool{New: func() any { return new(slabs) }}

func (s *slabs) nodeSlab(n int) []Node {
	if s == nil {
		return make([]Node, 0, n)
	}
	return takeSlab(&s.nodes, &s.n, n)
}

func (s *slabs) kidSlab(n int) []*Node {
	if s == nil {
		return make([]*Node, 0, n)
	}
	return takeSlab(&s.kids, &s.k, n)
}

func (s *slabs) attrSlab(n int) []Attr {
	if s == nil {
		return make([]Attr, 0, n)
	}
	return takeSlab(&s.attrs, &s.a, n)
}

// takeSlab hands out the next kept slab of at least n (zeroed), or a new one it keeps.
func takeSlab[T any](kept *[][]T, next *int, n int) []T {
	i := *next
	*next++
	if i < len(*kept) && cap((*kept)[i]) >= n {
		return (*kept)[i][:0]
	}
	b := make([]T, 0, n)
	if i < len(*kept) {
		(*kept)[i] = b
	} else {
		*kept = append(*kept, b)
	}
	return b
}

// release resets the slabs and pools them.
func (s *slabs) release() {
	s.reset()
	slabPool.Put(s)
}

// reset zeroes the slabs handed out (dropping what they point to) for the next parse.
func (s *slabs) reset() {
	for _, b := range s.nodes[:s.n] {
		clear(b[:cap(b)])
	}
	for _, b := range s.kids[:s.k] {
		clear(b[:cap(b)])
	}
	for _, b := range s.attrs[:s.a] {
		clear(b[:cap(b)])
	}
	s.n, s.k, s.a = 0, 0, 0
}

func (p *parser) newElement(a atom, tag string, ns uint8, attrs []Attr) *Node {
	n := p.newNode()
	n.Kind = ElementNode
	n.atom = a
	n.Tag = tag
	n.ns = ns
	n.Attrs = p.copyAttrs(attrs)
	n.blockState, n.tableState, n.notesState = -1, -1, -1
	return n
}

func (p *parser) newText(s string) *Node {
	n := p.newNode()
	n.Kind = TextNode
	n.text = s
	n.visLen = -1
	return n
}

func (p *parser) newComment(s string) *Node {
	n := p.newNode()
	n.Kind = CommentNode
	n.text = s
	n.visLen = -1
	return n
}

// copyAttrs copies attrs into the attribute slab. The copy's capacity is its
// length, so a later append (setAttr) reallocates instead of overwriting the
// next element's attributes.
func (p *parser) copyAttrs(attrs []Attr) []Attr {
	n := len(attrs)
	if n == 0 {
		return nil
	}
	if cap(p.attrs)-len(p.attrs) < n {
		size := 256
		if n > size/4 {
			size = n
		}
		p.attrs = p.slabs.attrSlab(size)
	}
	at := len(p.attrs)
	p.attrs = append(p.attrs, attrs...)
	return p.attrs[at : at+n : at+n]
}

// appendKid appends n to a child list kept in the child slab. A list that
// ends at the top of the slab grows in place; otherwise it moves to the top
// with twice the room. Each list owns its capacity, so appends never touch
// another list.
func (p *parser) appendKid(s []*Node, n *Node) []*Node {
	if len(s) < cap(s) {
		return append(s, n)
	}
	c := cap(s)
	grow := c
	if grow < 2 {
		grow = 2
	}
	if c > 0 && len(p.kids) > 0 && cap(p.kids)-len(p.kids) >= grow && &s[c-1] == &p.kids[len(p.kids)-1] {
		at := len(p.kids) - c
		p.kids = p.kids[:len(p.kids)+grow]
		s = p.kids[at : at+c+1 : at+c+grow]
		s[c] = n
		return s
	}
	size := c + grow
	if cap(p.kids)-len(p.kids) < size {
		if size > 256 {
			t := make([]*Node, c, 2*size)
			copy(t, s)
			return append(t, n)
		}
		p.kids = p.slabs.kidSlab(2048)
	}
	at := len(p.kids)
	p.kids = p.kids[:at+size]
	t := p.kids[at : at+c : at+size]
	copy(t, s)
	return append(t, n)
}

// ------------------------------------------------------------------ tree operations

func (p *parser) appendChild(parent, n *Node) {
	n.Parent = parent
	parent.Children = p.appendKid(parent.Children, n)
}

// insertBefore inserts n into parent before ref (appends when ref is nil).
func (p *parser) insertBefore(parent, n, ref *Node) {
	if ref == nil {
		p.appendChild(parent, n)
		return
	}
	i := indexOf(parent.Children, ref)
	n.Parent = parent
	parent.Children = p.appendKid(parent.Children, nil)
	copy(parent.Children[i+1:], parent.Children[i:])
	parent.Children[i] = n
}

func removeChild(parent, n *Node) {
	kids := parent.Children
	i := indexOf(kids, n)
	copy(kids[i:], kids[i+1:])
	kids[len(kids)-1] = nil
	parent.Children = kids[:len(kids)-1]
	n.Parent = nil
}

func lastChild(n *Node) *Node {
	if len(n.Children) == 0 {
		return nil
	}
	return n.Children[len(n.Children)-1]
}

// prevSibling is n's previous sibling, or nil.
func prevSibling(n *Node) *Node {
	if n.Parent == nil {
		return nil
	}
	i := indexOf(n.Parent.Children, n)
	if i <= 0 {
		return nil
	}
	return n.Parent.Children[i-1]
}

// reparentChildren reparents all of src's child nodes to dst.
func (p *parser) reparentChildren(dst, src *Node) {
	for _, c := range src.Children {
		p.appendChild(dst, c)
	}
	clear(src.Children)
	src.Children = src.Children[:0]
}

// clone returns a new element with the same tag, namespace and attributes.
func (p *parser) clone(n *Node) *Node {
	return p.newElement(n.atom, n.Tag, n.ns, n.Attrs)
}

// ------------------------------------------------------------------ stacks

// nodeStack is a stack of nodes.
type nodeStack []*Node

// pop pops the stack. It will panic if s is empty.
func (s *nodeStack) pop() *Node {
	i := len(*s)
	n := (*s)[i-1]
	*s = (*s)[:i-1]
	return n
}

// top returns the most recently pushed node, or nil if s is empty.
func (s *nodeStack) top() *Node {
	if i := len(*s); i > 0 {
		return (*s)[i-1]
	}
	return nil
}

// index returns the index of the top-most occurrence of n in the stack, or -1
// if n is not present.
func (s *nodeStack) index(n *Node) int {
	for i := len(*s) - 1; i >= 0; i-- {
		if (*s)[i] == n {
			return i
		}
	}
	return -1
}

// contains returns whether an HTML element a is within s.
func (s *nodeStack) contains(a atom) bool {
	for _, n := range *s {
		if n.atom == a && n.ns == nsHTML {
			return true
		}
	}
	return false
}

// insert inserts a node at the given index.
func (s *nodeStack) insert(i int, n *Node) {
	(*s) = append(*s, nil)
	copy((*s)[i+1:], (*s)[i:])
	(*s)[i] = n
}

// remove removes a node from the stack. It is a no-op if n is not present.
func (s *nodeStack) remove(n *Node) {
	i := s.index(n)
	if i == -1 {
		return
	}
	copy((*s)[i:], (*s)[i+1:])
	j := len(*s) - 1
	(*s)[j] = nil
	*s = (*s)[:j]
}

type insertionModeStack []insertionMode

func (s *insertionModeStack) pop() (im insertionMode) {
	i := len(*s)
	im = (*s)[i-1]
	*s = (*s)[:i-1]
	return im
}

func (s *insertionModeStack) top() insertionMode {
	if i := len(*s); i > 0 {
		return (*s)[i-1]
	}
	return nil
}

func (p *parser) top() *Node {
	if n := p.oe.top(); n != nil {
		return n
	}
	return p.doc
}

// ------------------------------------------------------------------ scopes

type scope int

const (
	defaultScope scope = iota
	listItemScope
	buttonScope
	tableScope
	tableRowScope
	tableBodyScope
	selectScope
)

// defaultScopeStop reports whether n bounds the default scope (13.2.4.2).
func defaultScopeStop(n *Node) bool {
	switch n.ns {
	case nsHTML:
		switch n.atom {
		case aApplet, aCaption, aHtml, aTable, aTd, aTh, aMarquee, aObject, aTemplate:
			return true
		}
	case nsMathML:
		switch n.atom {
		case aAnnotationXml, aMi, aMn, aMo, aMs, aMtext:
			return true
		}
	case nsSVG:
		switch n.atom {
		case aDesc, aForeignObject, aTitle:
			return true
		}
	}
	return false
}

// popUntil pops the stack of open elements at the highest element whose tag
// is in matchTags, provided there is no higher element in the scope's stop
// tags (13.2.4.2). It returns whether or not there was such an element. If
// there was not, popUntil leaves the stack unchanged.
func (p *parser) popUntil(s scope, matchTags ...atom) bool {
	if i := p.indexOfElementInScope(s, matchTags...); i != -1 {
		p.oe = p.oe[:i]
		return true
	}
	return false
}

// indexOfElementInScope returns the index in p.oe of the highest element whose
// tag is in matchTags that is in scope. If no matching element is in scope, it
// returns -1.
func (p *parser) indexOfElementInScope(s scope, matchTags ...atom) int {
	bound := &scopeBound[s]
	for i := len(p.oe) - 1; i >= 0; i-- {
		n := p.oe[i]
		if n.ns == nsHTML {
			a := n.atom
			for _, t := range matchTags {
				if t == a {
					return i
				}
			}
			if bound[a] {
				return -1
			}
		} else if s <= buttonScope && defaultScopeStop(n) {
			return -1
		}
	}
	return -1
}

// elementInScope is like popUntil, except that it doesn't modify the stack of
// open elements.
func (p *parser) elementInScope(s scope, matchTags ...atom) bool {
	return p.indexOfElementInScope(s, matchTags...) != -1
}

// clearStackToContext pops elements off the stack of open elements until a
// scope-defined element is found.
func (p *parser) clearStackToContext(s scope) {
	for i := len(p.oe) - 1; i >= 0; i-- {
		tagAtom := p.oe[i].atom
		switch s {
		case tableScope:
			if tagAtom == aHtml || tagAtom == aTable || tagAtom == aTemplate {
				p.oe = p.oe[:i+1]
				return
			}
		case tableRowScope:
			if tagAtom == aHtml || tagAtom == aTr || tagAtom == aTemplate {
				p.oe = p.oe[:i+1]
				return
			}
		case tableBodyScope:
			if tagAtom == aHtml || tagAtom == aTbody || tagAtom == aTfoot || tagAtom == aThead || tagAtom == aTemplate {
				p.oe = p.oe[:i+1]
				return
			}
		}
	}
}

// ------------------------------------------------------------------ insertion

// parseGenericRawTextElement implements the generic raw text element parsing
// algorithm (13.2.6.2) for RAWTEXT elements.
func (p *parser) parseGenericRawTextElement() {
	p.addElement()
	p.setRaw(rawRAWTEXT)
	p.originalIM = p.im
	p.im = textIM
}

// setRaw switches the tokenizer to a raw text state for the element just
// inserted from the current token.
func (p *parser) setRaw(kind rawKind) {
	p.raw = kind
	p.rawName = p.tok.data
}

// generateImpliedEndTags pops nodes off the stack of open elements as long as
// the top node has a tag name of dd, dt, li, optgroup, option, p, rb, rp, rt or
// rtc, except for the tag except (0 for none).
func (p *parser) generateImpliedEndTags(except atom) {
	var i int
loop:
	for i = len(p.oe) - 1; i >= 0; i-- {
		switch a := p.oe[i].atom; a {
		case aDd, aDt, aLi, aOptgroup, aOption, aP, aRb, aRp, aRt, aRtc:
			if a == except {
				break loop
			}
			continue
		}
		break
	}
	p.oe = p.oe[:i+1]
}

// addChild adds a child node n to the top element, and pushes n onto the stack
// of open elements if it is an element node.
func (p *parser) addChild(n *Node) {
	if p.shouldFosterParent() {
		p.fosterParent(n)
	} else {
		p.appendChild(p.top(), n)
	}
	if n.Kind == ElementNode {
		p.oe = append(p.oe, n)
	}
}

// shouldFosterParent returns whether the next node to be added should be
// foster parented.
func (p *parser) shouldFosterParent() bool {
	if p.fosterParenting {
		switch p.top().atom {
		case aTable, aTbody, aTfoot, aThead, aTr:
			return true
		}
	}
	return false
}

// fosterParent adds a child node according to the foster parenting rules
// (13.2.6.1).
func (p *parser) fosterParent(n *Node) {
	var table, parent, prev, template *Node
	var i int
	for i = len(p.oe) - 1; i >= 0; i-- {
		if p.oe[i].atom == aTable {
			table = p.oe[i]
			break
		}
	}

	var j int
	for j = len(p.oe) - 1; j >= 0; j-- {
		if p.oe[j].atom == aTemplate {
			template = p.oe[j]
			break
		}
	}

	if template != nil && (table == nil || j > i) {
		p.appendChild(template, n)
		return
	}

	if table == nil {
		// The foster parent is the html element.
		parent = p.oe[0]
	} else {
		parent = table.Parent
	}
	if parent == nil {
		parent = p.oe[i-1]
	}

	if table != nil {
		prev = prevSibling(table)
	} else {
		prev = lastChild(parent)
	}
	if prev != nil && prev.Kind == TextNode && n.Kind == TextNode {
		prev.text = p.concat(prev.text, n.text)
		return
	}

	p.insertBefore(parent, n, table)
}

// addText adds text to the preceding node if it is a text node, or else it
// calls addChild with a new text node.
func (p *parser) addText(text string) {
	if text == "" {
		return
	}
	if p.shouldFosterParent() {
		p.fosterParent(p.newText(text))
		return
	}
	t := p.top()
	if n := lastChild(t); n != nil && n.Kind == TextNode {
		n.text = p.concat(n.text, text)
		return
	}
	p.addChild(p.newText(text))
}

func (p *parser) addComment() {
	p.addChild(p.newComment(p.tok.data))
}

// addElement adds a child element based on the current token.
func (p *parser) addElement() {
	p.addChild(p.newElement(p.tok.atom, p.tok.data, nsHTML, p.tok.attrs))
}

// addFormattingElement adds a formatting element (13.2.4.3).
func (p *parser) addFormattingElement() {
	tagAtom, attr := p.tok.atom, p.tok.attrs
	p.addElement()

	// Implement the Noah's Ark clause, but with three per family instead of two.
	identicalElements := 0
findIdenticalElements:
	for i := len(p.afe) - 1; i >= 0; i-- {
		n := p.afe[i]
		if n == scopeMarker {
			break
		}
		if n.ns != nsHTML {
			continue
		}
		if n.atom != tagAtom {
			continue
		}
		if len(n.Attrs) != len(attr) {
			continue
		}
	compareAttributes:
		for _, t0 := range n.Attrs {
			for _, t1 := range attr {
				if t0.Name == t1.Name && t0.Value == t1.Value {
					// Found a match for this attribute, continue with the next attribute.
					continue compareAttributes
				}
			}
			// If we get here, there is no attribute that matches a.
			// Therefore the element is not identical to the new one.
			continue findIdenticalElements
		}

		identicalElements++
		if identicalElements >= 3 {
			p.afe.remove(n)
		}
	}

	p.afe = append(p.afe, p.top())
}

// clearActiveFormattingElements clears the list up to the last marker
// (13.2.4.3).
func (p *parser) clearActiveFormattingElements() {
	for {
		if n := p.afe.pop(); len(p.afe) == 0 || n == scopeMarker {
			return
		}
	}
}

// reconstructActiveFormattingElements (13.2.4.3).
func (p *parser) reconstructActiveFormattingElements() {
	n := p.afe.top()
	if n == nil {
		return
	}
	if n == scopeMarker || p.oe.index(n) != -1 {
		return
	}
	i := len(p.afe) - 1
	for n != scopeMarker && p.oe.index(n) == -1 {
		if i == 0 {
			i = -1
			break
		}
		i--
		n = p.afe[i]
	}
	for {
		i++
		clone := p.clone(p.afe[i])
		p.addChild(clone)
		p.afe[i] = clone
		if i == len(p.afe)-1 {
			break
		}
	}
}

// acknowledgeSelfClosingTag (13.2.5).
func (p *parser) acknowledgeSelfClosingTag() {
	p.hasSelfClosingToken = false
}

// An insertion mode (13.2.4.1) is the state transition function from a
// particular state in the HTML5 parser's state machine. It updates the
// parser's fields depending on parser.tok (where eofToken means EOF).
// It returns whether the token was consumed.
type insertionMode func(*parser) bool

// setOriginalIM sets the insertion mode to return to after completing a text or
// inTableText insertion mode.
func (p *parser) setOriginalIM() {
	if p.originalIM != nil {
		panic("html: bad parser state: originalIM was set twice")
	}
	p.originalIM = p.im
}

// resetInsertionMode (13.2.4.1, "reset the insertion mode appropriately").
func (p *parser) resetInsertionMode() {
	for i := len(p.oe) - 1; i >= 0; i-- {
		n := p.oe[i]
		last := i == 0

		switch n.atom {
		case aSelect:
			if !last {
				for ancestor, first := n, p.oe[0]; ancestor != first; {
					ancestor = p.oe[p.oe.index(ancestor)-1]
					switch ancestor.atom {
					case aTemplate:
						p.im = inSelectIM
						return
					case aTable:
						p.im = inSelectInTableIM
						return
					}
				}
			}
			p.im = inSelectIM
		case aTd, aTh:
			// x/net divergence (only visible to fragment parsing).
			p.im = inCellIM
		case aTr:
			p.im = inRowIM
		case aTbody, aThead, aTfoot:
			p.im = inTableBodyIM
		case aCaption:
			p.im = inCaptionIM
		case aColgroup:
			p.im = inColumnGroupIM
		case aTable:
			p.im = inTableIM
		case aTemplate:
			if n.ns != nsHTML {
				continue
			}
			p.im = p.templateStack.top()
		case aHead:
			// x/net divergence (only visible to fragment parsing).
			p.im = inHeadIM
		case aBody:
			p.im = inBodyIM
		case aFrameset:
			p.im = inFramesetIM
		case aHtml:
			if p.head == nil {
				p.im = beforeHeadIM
			} else {
				p.im = afterHeadIM
			}
		default:
			if last {
				p.im = inBodyIM
				return
			}
			continue
		}
		return
	}
}

const whitespace = " \t\r\n\f"

// trimLeftSpace is strings.TrimLeft(s, whitespace) without the cutset setup.
func trimLeftSpace(s string) string {
	i := 0
	for i < len(s) && isSpace(s[i]) {
		i++
	}
	return s[i:]
}

func isAllSpace(s string) bool {
	return len(trimLeftSpace(s)) == 0
}

// stripNUL drops NUL characters (ignored in most insertion modes).
func (p *parser) stripNUL(s string) string {
	if !p.hasNUL || strings.IndexByte(s, 0) < 0 {
		return s
	}
	return strings.ReplaceAll(s, "\x00", "")
}

// ------------------------------------------------------------------ insertion modes

// Section 13.2.6.4.1.
func initialIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		p.tok.data = trimLeftSpace(p.tok.data)
		if len(p.tok.data) == 0 {
			// It was all whitespace, so ignore it.
			return true
		}
	case commentToken:
		p.appendChild(p.doc, p.newComment(p.tok.data))
		return true
	case doctypeToken:
		p.appendChild(p.doc, p.newDoctype())
		p.quirks = doctypeQuirks(&p.doctype)
		p.im = beforeHTMLIM
		return true
	}
	p.quirks = true
	p.im = beforeHTMLIM
	return false
}

// Section 13.2.6.4.2.
func beforeHTMLIM(p *parser) bool {
	switch p.tok.typ {
	case doctypeToken:
		// Ignore the token.
		return true
	case textToken:
		p.tok.data = trimLeftSpace(p.tok.data)
		if len(p.tok.data) == 0 {
			// It was all whitespace, so ignore it.
			return true
		}
	case startTagToken:
		if p.tok.atom == aHtml {
			p.addElement()
			p.im = beforeHeadIM
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aHead, aBody, aHtml, aBr:
			p.parseImpliedToken(startTagToken, aHtml)
			return false
		default:
			// Ignore the token.
			return true
		}
	case commentToken:
		p.appendChild(p.doc, p.newComment(p.tok.data))
		return true
	}
	p.parseImpliedToken(startTagToken, aHtml)
	return false
}

// Section 13.2.6.4.3.
func beforeHeadIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		p.tok.data = trimLeftSpace(p.tok.data)
		if len(p.tok.data) == 0 {
			// It was all whitespace, so ignore it.
			return true
		}
	case startTagToken:
		switch p.tok.atom {
		case aHead:
			p.addElement()
			p.head = p.top()
			p.im = inHeadIM
			return true
		case aHtml:
			return inBodyIM(p)
		}
	case endTagToken:
		switch p.tok.atom {
		case aHead, aBody, aHtml, aBr:
			p.parseImpliedToken(startTagToken, aHead)
			return false
		default:
			// Ignore the token.
			return true
		}
	case commentToken:
		p.addComment()
		return true
	case doctypeToken:
		// Ignore the token.
		return true
	}

	p.parseImpliedToken(startTagToken, aHead)
	return false
}

// Section 13.2.6.4.4.
func inHeadIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) < len(p.tok.data) {
			// Add the initial whitespace to the current node.
			p.addText(p.tok.data[:len(p.tok.data)-len(s)])
			if s == "" {
				return true
			}
			p.tok.data = s
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aBase, aBasefont, aBgsound, aLink, aMeta:
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
			return true
		case aNoscript:
			// Scripting is disabled: the content is markup.
			p.addElement()
			p.im = inHeadNoscriptIM
			return true
		case aScript:
			p.addElement()
			p.setRaw(rawScriptData)
			p.setOriginalIM()
			p.im = textIM
			return true
		case aTitle:
			p.addElement()
			p.setRaw(rawRCDATA)
			p.setOriginalIM()
			p.im = textIM
			return true
		case aNoframes, aStyle:
			p.parseGenericRawTextElement()
			return true
		case aHead:
			// Ignore the token.
			return true
		case aTemplate:
			// x/net divergence: it does not handle all of the corner cases
			// when mixing foreign content (i.e. <math> or <svg>) with
			// <template>, so it ignores the rest of the HTML then. Their
			// combination is very rare.
			for _, e := range p.oe {
				if e.ns != nsHTML {
					p.im = ignoreTheRemainingTokens
					return true
				}
			}

			p.addElement()
			p.afe = append(p.afe, scopeMarker)
			p.framesetOK = false
			p.im = inTemplateIM
			p.templateStack = append(p.templateStack, inTemplateIM)
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aHead:
			p.oe.pop()
			p.im = afterHeadIM
			return true
		case aBody, aHtml, aBr:
			p.parseImpliedToken(endTagToken, aHead)
			return false
		case aTemplate:
			if !p.oe.contains(aTemplate) {
				return true
			}
			// x/net divergence, see https://bugs.chromium.org/p/chromium/issues/detail?id=829668
			p.generateImpliedEndTags(0)
			for i := len(p.oe) - 1; i >= 0; i-- {
				if n := p.oe[i]; n.ns == nsHTML && n.atom == aTemplate {
					p.oe = p.oe[:i]
					break
				}
			}
			p.clearActiveFormattingElements()
			p.templateStack.pop()
			p.resetInsertionMode()
			return true
		default:
			// Ignore the token.
			return true
		}
	case commentToken:
		p.addComment()
		return true
	case doctypeToken:
		// Ignore the token.
		return true
	}

	p.parseImpliedToken(endTagToken, aHead)
	return false
}

// Section 13.2.6.4.5.
func inHeadNoscriptIM(p *parser) bool {
	switch p.tok.typ {
	case doctypeToken:
		// Ignore the token.
		return true
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aBasefont, aBgsound, aLink, aMeta, aNoframes, aStyle:
			return inHeadIM(p)
		case aHead, aNoscript:
			// Ignore the token.
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aNoscript, aBr:
		default:
			// Ignore the token.
			return true
		}
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) == 0 {
			// It was all whitespace.
			return inHeadIM(p)
		}
		// Leading whitespace stays in the <noscript>, as the standard
		// processes characters one by one (x/net moves it to <head>).
		if len(s) < len(p.tok.data) {
			p.addText(p.tok.data[:len(p.tok.data)-len(s)])
			p.tok.data = s
		}
	case commentToken:
		return inHeadIM(p)
	}
	p.oe.pop()
	if p.top().atom != aHead {
		panic("html: the new current node will be a head element.")
	}
	p.im = inHeadIM
	if p.tok.atom == aNoscript {
		return true
	}
	return false
}

// Section 13.2.6.4.6.
func afterHeadIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) < len(p.tok.data) {
			// Add the initial whitespace to the current node.
			p.addText(p.tok.data[:len(p.tok.data)-len(s)])
			if s == "" {
				return true
			}
			p.tok.data = s
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aBody:
			p.addElement()
			p.framesetOK = false
			p.im = inBodyIM
			return true
		case aFrameset:
			p.addElement()
			p.im = inFramesetIM
			return true
		case aBase, aBasefont, aBgsound, aLink, aMeta, aNoframes, aScript, aStyle, aTemplate, aTitle:
			p.oe = append(p.oe, p.head)
			defer p.oe.remove(p.head)
			return inHeadIM(p)
		case aHead:
			// Ignore the token.
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aBody, aHtml, aBr:
			// Drop down to creating an implied <body> tag.
		case aTemplate:
			return inHeadIM(p)
		default:
			// Ignore the token.
			return true
		}
	case commentToken:
		p.addComment()
		return true
	case doctypeToken:
		// Ignore the token.
		return true
	}

	p.parseImpliedToken(startTagToken, aBody)
	p.framesetOK = true
	if p.tok.typ == eofToken {
		// Stop parsing.
		return true
	}
	return false
}

// copyAttributes copies attributes of the current token not found on dst to dst.
func (p *parser) copyAttributes(dst *Node) {
	for _, t := range p.tok.attrs {
		if !dst.has(t.Name) {
			dst.Attrs = append(dst.Attrs, t)
		}
	}
}

// Section 13.2.6.4.7.
func inBodyIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		d := p.tok.data
		switch n := p.oe.top(); n.atom {
		case aPre, aListing:
			if len(n.Children) == 0 {
				// Ignore a newline at the start of a <pre> block.
				if d != "" && d[0] == '\n' {
					d = d[1:]
				}
			}
		}
		d = p.stripNUL(d)
		if d == "" {
			return true
		}
		p.reconstructActiveFormattingElements()
		p.addText(d)
		if p.framesetOK && !isAllSpace(d) {
			// There were non-whitespace characters inserted.
			p.framesetOK = false
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			if p.oe.contains(aTemplate) {
				return true
			}
			p.copyAttributes(p.oe[0])
		case aBase, aBasefont, aBgsound, aLink, aMeta, aNoframes, aScript, aStyle, aTemplate, aTitle:
			return inHeadIM(p)
		case aBody:
			if p.oe.contains(aTemplate) {
				return true
			}
			if len(p.oe) >= 2 {
				body := p.oe[1]
				if body.Kind == ElementNode && body.atom == aBody {
					p.framesetOK = false
					p.copyAttributes(body)
				}
			}
		case aFrameset:
			if !p.framesetOK || len(p.oe) < 2 || p.oe[1].atom != aBody {
				// Ignore the token.
				return true
			}
			body := p.oe[1]
			if body.Parent != nil {
				removeChild(body.Parent, body)
			}
			p.oe = p.oe[:1]
			p.addElement()
			p.im = inFramesetIM
			return true
		case aAddress, aArticle, aAside, aBlockquote, aCenter, aDetails, aDialog, aDir, aDiv, aDl, aFieldset, aFigcaption, aFigure, aFooter, aHeader, aHgroup, aMain, aMenu, aNav, aOl, aP, aSearch, aSection, aSummary, aUl:
			p.popUntil(buttonScope, aP)
			p.addElement()
		case aH1, aH2, aH3, aH4, aH5, aH6:
			p.popUntil(buttonScope, aP)
			switch n := p.top(); n.atom {
			case aH1, aH2, aH3, aH4, aH5, aH6:
				p.oe.pop()
			}
			p.addElement()
		case aPre, aListing:
			p.popUntil(buttonScope, aP)
			p.addElement()
			// The newline, if any, will be dealt with by the textToken case.
			p.framesetOK = false
		case aForm:
			if p.form != nil && !p.oe.contains(aTemplate) {
				// Ignore the token
				return true
			}
			p.popUntil(buttonScope, aP)
			p.addElement()
			if !p.oe.contains(aTemplate) {
				p.form = p.top()
			}
		case aLi:
			p.framesetOK = false
			for i := len(p.oe) - 1; i >= 0; i-- {
				node := p.oe[i]
				switch node.atom {
				case aLi:
					p.oe = p.oe[:i]
				case aAddress, aDiv, aP:
					continue
				default:
					if !isSpecialElement(node) {
						continue
					}
				}
				break
			}
			p.popUntil(buttonScope, aP)
			p.addElement()
		case aDd, aDt:
			p.framesetOK = false
			for i := len(p.oe) - 1; i >= 0; i-- {
				node := p.oe[i]
				switch node.atom {
				case aDd, aDt:
					p.oe = p.oe[:i]
				case aAddress, aDiv, aP:
					continue
				default:
					if !isSpecialElement(node) {
						continue
					}
				}
				break
			}
			p.popUntil(buttonScope, aP)
			p.addElement()
		case aPlaintext:
			p.popUntil(buttonScope, aP)
			p.addElement()
			p.setRaw(rawPlaintext)
		case aButton:
			p.popUntil(defaultScope, aButton)
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.framesetOK = false
		case aA:
			for i := len(p.afe) - 1; i >= 0 && p.afe[i] != scopeMarker; i-- {
				if n := p.afe[i]; n.atom == aA {
					p.inBodyEndTagFormatting(aA, "a")
					p.oe.remove(n)
					p.afe.remove(n)
					break
				}
			}
			p.reconstructActiveFormattingElements()
			p.addFormattingElement()
		case aB, aBig, aCode, aEm, aFont, aI, aS, aSmall, aStrike, aStrong, aTt, aU:
			p.reconstructActiveFormattingElements()
			p.addFormattingElement()
		case aNobr:
			p.reconstructActiveFormattingElements()
			if p.elementInScope(defaultScope, aNobr) {
				p.inBodyEndTagFormatting(aNobr, "nobr")
				p.reconstructActiveFormattingElements()
			}
			p.addFormattingElement()
		case aApplet, aMarquee, aObject:
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.afe = append(p.afe, scopeMarker)
			p.framesetOK = false
		case aTable:
			if !p.quirks {
				p.popUntil(buttonScope, aP)
			}
			p.addElement()
			p.framesetOK = false
			p.im = inTableIM
			return true
		case aArea, aBr, aEmbed, aImg, aInput, aKeygen, aWbr:
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
			if p.tok.atom == aInput {
				for _, t := range p.tok.attrs {
					if t.Name == "type" {
						if strings.EqualFold(t.Value, "hidden") {
							// Skip setting framesetOK = false
							return true
						}
					}
				}
			}
			p.framesetOK = false
		case aParam, aSource, aTrack:
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
		case aHr:
			p.popUntil(buttonScope, aP)
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
			p.framesetOK = false
		case aImage:
			p.tok.atom = aImg
			p.tok.data = atomNames[aImg]
			return false
		case aTextarea:
			p.addElement()
			p.setRaw(rawRCDATA)
			p.setOriginalIM()
			p.framesetOK = false
			p.im = textIM
		case aXmp:
			p.popUntil(buttonScope, aP)
			p.reconstructActiveFormattingElements()
			p.framesetOK = false
			p.parseGenericRawTextElement()
		case aIframe:
			p.framesetOK = false
			p.parseGenericRawTextElement()
		case aNoembed:
			p.parseGenericRawTextElement()
		case aNoscript:
			// Scripting is disabled: the content is markup.
			p.reconstructActiveFormattingElements()
			p.addElement()
		case aSelect:
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.framesetOK = false
			p.im = inSelectIM
			return true
		case aOptgroup, aOption:
			if p.top().atom == aOption {
				p.oe.pop()
			}
			p.reconstructActiveFormattingElements()
			p.addElement()
		case aRb, aRtc:
			if p.elementInScope(defaultScope, aRuby) {
				p.generateImpliedEndTags(0)
			}
			p.addElement()
		case aRp, aRt:
			if p.elementInScope(defaultScope, aRuby) {
				p.generateImpliedEndTags(aRtc)
			}
			p.addElement()
		case aMath, aSvg:
			p.reconstructActiveFormattingElements()
			ns := nsSVG
			if p.tok.atom == aMath {
				ns = nsMathML
			}
			adjustAttributeNames(p.tok.attrs, ns)
			p.addChild(p.newElement(p.tok.atom, p.tok.data, ns, p.tok.attrs))
			if p.hasSelfClosingToken {
				p.oe.pop()
				p.acknowledgeSelfClosingTag()
			}
			return true
		case aCaption, aCol, aColgroup, aFrame, aHead, aTbody, aTd, aTfoot, aTh, aThead, aTr:
			// Ignore the token.
		default:
			p.reconstructActiveFormattingElements()
			p.addElement()
		}
	case endTagToken:
		switch p.tok.atom {
		case aBody:
			if p.elementInScope(defaultScope, aBody) {
				p.im = afterBodyIM
			}
		case aHtml:
			if p.elementInScope(defaultScope, aBody) {
				p.parseImpliedToken(endTagToken, aBody)
				return false
			}
			return true
		case aAddress, aArticle, aAside, aBlockquote, aButton, aCenter, aDetails, aDialog, aDir, aDiv, aDl, aFieldset, aFigcaption, aFigure, aFooter, aHeader, aHgroup, aListing, aMain, aMenu, aNav, aOl, aPre, aSearch, aSection, aSummary, aUl:
			p.popUntil(defaultScope, p.tok.atom)
		case aForm:
			if p.oe.contains(aTemplate) {
				i := p.indexOfElementInScope(defaultScope, aForm)
				if i == -1 {
					// Ignore the token.
					return true
				}
				p.generateImpliedEndTags(0)
				if p.oe[i].atom != aForm {
					// Ignore the token.
					return true
				}
				p.popUntil(defaultScope, aForm)
			} else {
				node := p.form
				p.form = nil
				i := p.indexOfElementInScope(defaultScope, aForm)
				if node == nil || i == -1 || p.oe[i] != node {
					// Ignore the token.
					return true
				}
				p.generateImpliedEndTags(0)
				p.oe.remove(node)
			}
		case aP:
			if !p.elementInScope(buttonScope, aP) {
				p.parseImpliedToken(startTagToken, aP)
			}
			p.popUntil(buttonScope, aP)
		case aLi:
			p.popUntil(listItemScope, aLi)
		case aDd, aDt:
			p.popUntil(defaultScope, p.tok.atom)
		case aH1, aH2, aH3, aH4, aH5, aH6:
			p.popUntil(defaultScope, aH1, aH2, aH3, aH4, aH5, aH6)
		case aA, aB, aBig, aCode, aEm, aFont, aI, aNobr, aS, aSmall, aStrike, aStrong, aTt, aU:
			p.inBodyEndTagFormatting(p.tok.atom, p.tok.data)
		case aApplet, aMarquee, aObject:
			if p.popUntil(defaultScope, p.tok.atom) {
				p.clearActiveFormattingElements()
			}
		case aBr:
			p.tok.typ = startTagToken
			return false
		case aTemplate:
			return inHeadIM(p)
		default:
			p.inBodyEndTagOther(p.tok.atom, p.tok.data)
		}
	case commentToken:
		p.addComment()
	case eofToken:
		// x/net divergence.
		if len(p.templateStack) > 0 {
			p.im = inTemplateIM
			return false
		}
		for _, e := range p.oe {
			switch e.atom {
			case aDd, aDt, aLi, aOptgroup, aOption, aP, aRb, aRp, aRt, aRtc, aTbody, aTd, aTfoot, aTh,
				aThead, aTr, aBody, aHtml:
			default:
				return true
			}
		}
	}

	return true
}

// inBodyEndTagFormatting is the adoption agency algorithm (13.2.6.4.7).
func (p *parser) inBodyEndTagFormatting(tagAtom atom, tagName string) {
	// Steps 1-2
	if current := p.oe.top(); current.Tag == tagName && p.afe.index(current) == -1 {
		p.oe.pop()
		return
	}

	// Steps 3-5. The outer loop.
	for i := 0; i < 8; i++ {
		// Step 6. Find the formatting element.
		var formattingElement *Node
		for j := len(p.afe) - 1; j >= 0; j-- {
			if p.afe[j] == scopeMarker {
				break
			}
			if p.afe[j].atom == tagAtom {
				formattingElement = p.afe[j]
				break
			}
		}
		if formattingElement == nil {
			p.inBodyEndTagOther(tagAtom, tagName)
			return
		}

		// Step 7. Ignore the tag if formatting element is not in the stack of open elements.
		feIndex := p.oe.index(formattingElement)
		if feIndex == -1 {
			p.afe.remove(formattingElement)
			return
		}
		// Step 8. Ignore the tag if formatting element is not in the scope.
		if !p.elementInScope(defaultScope, tagAtom) {
			// Ignore the tag.
			return
		}

		// Step 9. This step is omitted because it's just a parse error but no need to return.

		// Steps 10-11. Find the furthest block.
		var furthestBlock *Node
		for _, e := range p.oe[feIndex:] {
			if isSpecialElement(e) {
				furthestBlock = e
				break
			}
		}
		if furthestBlock == nil {
			e := p.oe.pop()
			for e != formattingElement {
				e = p.oe.pop()
			}
			p.afe.remove(e)
			return
		}

		// Steps 12-13. Find the common ancestor and bookmark node.
		commonAncestor := p.oe[feIndex-1]
		bookmark := p.afe.index(formattingElement)

		// Step 14. The inner loop. Find the lastNode to reparent.
		lastNode := furthestBlock
		node := furthestBlock
		x := p.oe.index(node)
		// Step 14.1.
		j := 0
		for {
			// Step 14.2.
			j++
			// Step. 14.3.
			x--
			node = p.oe[x]
			// Step 14.4. Go to the next step if node is formatting element.
			if node == formattingElement {
				break
			}
			// Step 14.5. Remove node from the list of active formatting elements if
			// inner loop counter is greater than three and node is in the list of
			// active formatting elements.
			if ni := p.afe.index(node); j > 3 && ni > -1 {
				p.afe.remove(node)
				// If any element of the list of active formatting elements is removed,
				// we need to take care whether bookmark should be decremented or not.
				// This is because the value of bookmark may exceed the size of the
				// list by removing elements from the list.
				if ni <= bookmark {
					bookmark--
				}
				continue
			}
			// Step 14.6. Continue the next inner loop if node is not in the list of
			// active formatting elements.
			if p.afe.index(node) == -1 {
				p.oe.remove(node)
				continue
			}
			// Step 14.7.
			clone := p.clone(node)
			p.afe[p.afe.index(node)] = clone
			p.oe[p.oe.index(node)] = clone
			node = clone
			// Step 14.8.
			if lastNode == furthestBlock {
				bookmark = p.afe.index(node) + 1
			}
			// Step 14.9.
			if lastNode.Parent != nil {
				removeChild(lastNode.Parent, lastNode)
			}
			p.appendChild(node, lastNode)
			// Step 14.10.
			lastNode = node
		}

		// Step 15. Reparent lastNode to the common ancestor,
		// or for misnested table nodes, to the foster parent.
		if lastNode.Parent != nil {
			removeChild(lastNode.Parent, lastNode)
		}
		switch commonAncestor.atom {
		case aTable, aTbody, aTfoot, aThead, aTr:
			p.fosterParent(lastNode)
		default:
			p.appendChild(commonAncestor, lastNode)
		}

		// Steps 16-18. Reparent nodes from the furthest block's children
		// to a clone of the formatting element.
		clone := p.clone(formattingElement)
		p.reparentChildren(clone, furthestBlock)
		p.appendChild(furthestBlock, clone)

		// Step 19. Fix up the list of active formatting elements.
		if oldLoc := p.afe.index(formattingElement); oldLoc != -1 && oldLoc < bookmark {
			// Move the bookmark with the rest of the list.
			bookmark--
		}
		p.afe.remove(formattingElement)
		p.afe.insert(bookmark, clone)

		// Step 20. Fix up the stack of open elements.
		p.oe.remove(formattingElement)
		p.oe.insert(p.oe.index(furthestBlock)+1, clone)
	}
}

// inBodyEndTagOther performs the "any other end tag" algorithm for inBodyIM.
func (p *parser) inBodyEndTagOther(tagAtom atom, tagName string) {
	for i := len(p.oe) - 1; i >= 0; i-- {
		// Uncommon (custom) tags have no atom: compare names.
		if p.oe[i].atom == tagAtom && (tagAtom != 0 || p.oe[i].Tag == tagName) {
			p.oe = p.oe[:i]
			break
		}
		if isSpecialElement(p.oe[i]) {
			break
		}
	}
}

// Section 13.2.6.4.8.
func textIM(p *parser) bool {
	switch p.tok.typ {
	case eofToken:
		p.oe.pop()
	case textToken:
		d := p.tok.data
		if n := p.oe.top(); n.atom == aTextarea && len(n.Children) == 0 {
			// Ignore a newline at the start of a <textarea> block.
			if d != "" && d[0] == '\n' {
				d = d[1:]
			}
		}
		if d == "" {
			return true
		}
		p.addText(d)
		return true
	case endTagToken:
		p.oe.pop()
	}
	p.im = p.originalIM
	p.originalIM = nil
	return p.tok.typ == endTagToken
}

// Section 13.2.6.4.9.
func inTableIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		p.tok.data = p.stripNUL(p.tok.data)
		switch p.oe.top().atom {
		case aTable, aTbody, aTfoot, aThead, aTr:
			if isAllSpace(p.tok.data) {
				p.addText(p.tok.data)
				return true
			}
		}
	case startTagToken:
		switch p.tok.atom {
		case aCaption:
			p.clearStackToContext(tableScope)
			p.afe = append(p.afe, scopeMarker)
			p.addElement()
			p.im = inCaptionIM
			return true
		case aColgroup:
			p.clearStackToContext(tableScope)
			p.addElement()
			p.im = inColumnGroupIM
			return true
		case aCol:
			p.parseImpliedToken(startTagToken, aColgroup)
			return false
		case aTbody, aTfoot, aThead:
			p.clearStackToContext(tableScope)
			p.addElement()
			p.im = inTableBodyIM
			return true
		case aTd, aTh, aTr:
			p.parseImpliedToken(startTagToken, aTbody)
			return false
		case aTable:
			if p.popUntil(tableScope, aTable) {
				p.resetInsertionMode()
				return false
			}
			// Ignore the token.
			return true
		case aStyle, aScript, aTemplate:
			return inHeadIM(p)
		case aInput:
			for _, t := range p.tok.attrs {
				if t.Name == "type" && strings.EqualFold(t.Value, "hidden") {
					p.addElement()
					p.oe.pop()
					return true
				}
			}
			// Otherwise drop down to the default action.
		case aForm:
			if p.oe.contains(aTemplate) || p.form != nil {
				// Ignore the token.
				return true
			}
			p.addElement()
			p.form = p.oe.pop()
		case aSelect:
			p.reconstructActiveFormattingElements()
			switch p.top().atom {
			case aTable, aTbody, aTfoot, aThead, aTr:
				p.fosterParenting = true
			}
			p.addElement()
			p.fosterParenting = false
			p.framesetOK = false
			p.im = inSelectInTableIM
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aTable:
			if p.popUntil(tableScope, aTable) {
				p.resetInsertionMode()
				return true
			}
			// Ignore the token.
			return true
		case aBody, aCaption, aCol, aColgroup, aHtml, aTbody, aTd, aTfoot, aTh, aThead, aTr:
			// Ignore the token.
			return true
		case aTemplate:
			return inHeadIM(p)
		}
	case commentToken:
		p.addComment()
		return true
	case doctypeToken:
		// Ignore the token.
		return true
	case eofToken:
		return inBodyIM(p)
	}

	p.fosterParenting = true
	consumed := inBodyIM(p)
	p.fosterParenting = false
	return consumed
}

// Section 13.2.6.4.11.
func inCaptionIM(p *parser) bool {
	switch p.tok.typ {
	case startTagToken:
		switch p.tok.atom {
		case aCaption, aCol, aColgroup, aTbody, aTd, aTfoot, aThead, aTr:
			if !p.popUntil(tableScope, aCaption) {
				// Ignore the token.
				return true
			}
			p.clearActiveFormattingElements()
			p.im = inTableIM
			return false
		case aSelect:
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.framesetOK = false
			p.im = inSelectInTableIM
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aCaption:
			if p.popUntil(tableScope, aCaption) {
				p.clearActiveFormattingElements()
				p.im = inTableIM
			}
			return true
		case aTable:
			if !p.popUntil(tableScope, aCaption) {
				// Ignore the token.
				return true
			}
			p.clearActiveFormattingElements()
			p.im = inTableIM
			return false
		case aBody, aCol, aColgroup, aHtml, aTbody, aTd, aTfoot, aTh, aThead, aTr:
			// Ignore the token.
			return true
		}
	}
	return inBodyIM(p)
}

// Section 13.2.6.4.12.
func inColumnGroupIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) < len(p.tok.data) {
			// Add the initial whitespace to the current node.
			p.addText(p.tok.data[:len(p.tok.data)-len(s)])
			if s == "" {
				return true
			}
			p.tok.data = s
		}
	case commentToken:
		p.addComment()
		return true
	case doctypeToken:
		// Ignore the token.
		return true
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aCol:
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
			return true
		case aTemplate:
			return inHeadIM(p)
		}
	case endTagToken:
		switch p.tok.atom {
		case aColgroup:
			if p.oe.top().atom == aColgroup {
				p.oe.pop()
				p.im = inTableIM
			}
			return true
		case aCol:
			// Ignore the token.
			return true
		case aTemplate:
			return inHeadIM(p)
		}
	case eofToken:
		return inBodyIM(p)
	}
	if p.oe.top().atom != aColgroup {
		return true
	}
	p.oe.pop()
	p.im = inTableIM
	return false
}

// Section 13.2.6.4.13.
func inTableBodyIM(p *parser) bool {
	switch p.tok.typ {
	case startTagToken:
		switch p.tok.atom {
		case aTr:
			p.clearStackToContext(tableBodyScope)
			p.addElement()
			p.im = inRowIM
			return true
		case aTd, aTh:
			p.parseImpliedToken(startTagToken, aTr)
			return false
		case aCaption, aCol, aColgroup, aTbody, aTfoot, aThead:
			if p.popUntil(tableScope, aTbody, aThead, aTfoot) {
				p.im = inTableIM
				return false
			}
			// Ignore the token.
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aTbody, aTfoot, aThead:
			if p.elementInScope(tableScope, p.tok.atom) {
				p.clearStackToContext(tableBodyScope)
				p.oe.pop()
				p.im = inTableIM
			}
			return true
		case aTable:
			if p.popUntil(tableScope, aTbody, aThead, aTfoot) {
				p.im = inTableIM
				return false
			}
			// Ignore the token.
			return true
		case aBody, aCaption, aCol, aColgroup, aHtml, aTd, aTh, aTr:
			// Ignore the token.
			return true
		}
	case commentToken:
		p.addComment()
		return true
	}

	return inTableIM(p)
}

// Section 13.2.6.4.14.
func inRowIM(p *parser) bool {
	switch p.tok.typ {
	case startTagToken:
		switch p.tok.atom {
		case aTd, aTh:
			p.clearStackToContext(tableRowScope)
			p.addElement()
			p.afe = append(p.afe, scopeMarker)
			p.im = inCellIM
			return true
		case aCaption, aCol, aColgroup, aTbody, aTfoot, aThead, aTr:
			if p.elementInScope(tableScope, aTr) {
				p.clearStackToContext(tableRowScope)
				p.oe.pop()
				p.im = inTableBodyIM
				return false
			}
			// Ignore the token.
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aTr:
			if p.elementInScope(tableScope, aTr) {
				p.clearStackToContext(tableRowScope)
				p.oe.pop()
				p.im = inTableBodyIM
				return true
			}
			// Ignore the token.
			return true
		case aTable:
			if p.elementInScope(tableScope, aTr) {
				p.clearStackToContext(tableRowScope)
				p.oe.pop()
				p.im = inTableBodyIM
				return false
			}
			// Ignore the token.
			return true
		case aTbody, aTfoot, aThead:
			if p.elementInScope(tableScope, p.tok.atom) && p.elementInScope(tableScope, aTr) {
				p.clearStackToContext(tableRowScope)
				p.oe.pop()
				p.im = inTableBodyIM
				return false
			}
			// Ignore the token.
			return true
		case aBody, aCaption, aCol, aColgroup, aHtml, aTd, aTh:
			// Ignore the token.
			return true
		}
	}

	return inTableIM(p)
}

// Section 13.2.6.4.15.
func inCellIM(p *parser) bool {
	switch p.tok.typ {
	case startTagToken:
		switch p.tok.atom {
		case aCaption, aCol, aColgroup, aTbody, aTd, aTfoot, aTh, aThead, aTr:
			if p.popUntil(tableScope, aTd, aTh) {
				// Close the cell and reprocess.
				p.clearActiveFormattingElements()
				p.im = inRowIM
				return false
			}
			// Ignore the token.
			return true
		case aSelect:
			p.reconstructActiveFormattingElements()
			p.addElement()
			p.framesetOK = false
			p.im = inSelectInTableIM
			return true
		}
	case endTagToken:
		switch p.tok.atom {
		case aTd, aTh:
			if !p.popUntil(tableScope, p.tok.atom) {
				// Ignore the token.
				return true
			}
			p.clearActiveFormattingElements()
			p.im = inRowIM
			return true
		case aBody, aCaption, aCol, aColgroup, aHtml:
			// Ignore the token.
			return true
		case aTable, aTbody, aTfoot, aThead, aTr:
			if !p.elementInScope(tableScope, p.tok.atom) {
				// Ignore the token.
				return true
			}
			// Close the cell and reprocess.
			if p.popUntil(tableScope, aTd, aTh) {
				p.clearActiveFormattingElements()
			}
			p.im = inRowIM
			return false
		}
	}
	return inBodyIM(p)
}

// Section 13.2.6.4.16 (the <select> parser of parse5 7 and x/net up to
// v0.50, before the 2025 customizable-select changes).
func inSelectIM(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		p.addText(p.stripNUL(p.tok.data))
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aOption:
			if p.top().atom == aOption {
				p.oe.pop()
			}
			p.addElement()
		case aOptgroup:
			if p.top().atom == aOption {
				p.oe.pop()
			}
			if p.top().atom == aOptgroup {
				p.oe.pop()
			}
			p.addElement()
		case aSelect:
			if !p.popUntil(selectScope, aSelect) {
				// Ignore the token.
				return true
			}
			p.resetInsertionMode()
		case aInput, aKeygen, aTextarea:
			if p.elementInScope(selectScope, aSelect) {
				p.parseImpliedToken(endTagToken, aSelect)
				return false
			}
			// Ignore the token.
			return true
		case aScript, aTemplate:
			return inHeadIM(p)
		}
	case endTagToken:
		switch p.tok.atom {
		case aOption:
			if p.top().atom == aOption {
				p.oe.pop()
			}
		case aOptgroup:
			i := len(p.oe) - 1
			if p.oe[i].atom == aOption {
				i--
			}
			if p.oe[i].atom == aOptgroup {
				p.oe = p.oe[:i]
			}
		case aSelect:
			if !p.popUntil(selectScope, aSelect) {
				// Ignore the token.
				return true
			}
			p.resetInsertionMode()
		case aTemplate:
			return inHeadIM(p)
		}
	case commentToken:
		p.addComment()
	case doctypeToken:
		// Ignore the token.
		return true
	case eofToken:
		return inBodyIM(p)
	}

	return true
}

// Section 13.2.6.4.17.
func inSelectInTableIM(p *parser) bool {
	switch p.tok.typ {
	case startTagToken, endTagToken:
		switch p.tok.atom {
		case aCaption, aTable, aTbody, aTfoot, aThead, aTr, aTd, aTh:
			if p.tok.typ == endTagToken && !p.elementInScope(tableScope, p.tok.atom) {
				// Ignore the token.
				return true
			}
			// This is like p.popUntil(selectScope, aSelect), but it also
			// matches <math select>, not just <select>. Matching the MathML
			// tag is arguably incorrect (conceptually), but it mimics what
			// Chromium does.
			for i := len(p.oe) - 1; i >= 0; i-- {
				if n := p.oe[i]; n.atom == aSelect {
					p.oe = p.oe[:i]
					break
				}
			}
			p.resetInsertionMode()
			return false
		}
	}
	return inSelectIM(p)
}

// Section 13.2.6.4.18.
func inTemplateIM(p *parser) bool {
	switch p.tok.typ {
	case textToken, commentToken, doctypeToken:
		return inBodyIM(p)
	case startTagToken:
		switch p.tok.atom {
		case aBase, aBasefont, aBgsound, aLink, aMeta, aNoframes, aScript, aStyle, aTemplate, aTitle:
			return inHeadIM(p)
		case aCaption, aColgroup, aTbody, aTfoot, aThead:
			p.templateStack.pop()
			p.templateStack = append(p.templateStack, inTableIM)
			p.im = inTableIM
			return false
		case aCol:
			p.templateStack.pop()
			p.templateStack = append(p.templateStack, inColumnGroupIM)
			p.im = inColumnGroupIM
			return false
		case aTr:
			p.templateStack.pop()
			p.templateStack = append(p.templateStack, inTableBodyIM)
			p.im = inTableBodyIM
			return false
		case aTd, aTh:
			p.templateStack.pop()
			p.templateStack = append(p.templateStack, inRowIM)
			p.im = inRowIM
			return false
		default:
			p.templateStack.pop()
			p.templateStack = append(p.templateStack, inBodyIM)
			p.im = inBodyIM
			return false
		}
	case endTagToken:
		switch p.tok.atom {
		case aTemplate:
			return inHeadIM(p)
		default:
			// Ignore the token.
			return true
		}
	case eofToken:
		if !p.oe.contains(aTemplate) {
			// Ignore the token.
			return true
		}
		// x/net divergence, see https://bugs.chromium.org/p/chromium/issues/detail?id=829668
		p.generateImpliedEndTags(0)
		for i := len(p.oe) - 1; i >= 0; i-- {
			if n := p.oe[i]; n.ns == nsHTML && n.atom == aTemplate {
				p.oe = p.oe[:i]
				break
			}
		}
		p.clearActiveFormattingElements()
		p.templateStack.pop()
		p.resetInsertionMode()
		return false
	}
	return false
}

// Section 13.2.6.4.19.
func afterBodyIM(p *parser) bool {
	switch p.tok.typ {
	case eofToken:
		// Stop parsing.
		return true
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) == 0 {
			// It was all whitespace.
			return inBodyIM(p)
		}
	case startTagToken:
		if p.tok.atom == aHtml {
			return inBodyIM(p)
		}
	case endTagToken:
		if p.tok.atom == aHtml {
			p.im = afterAfterBodyIM
			return true
		}
	case commentToken:
		// The comment is attached to the <html> element.
		if len(p.oe) < 1 || p.oe[0].atom != aHtml {
			panic("html: bad parser state: <html> element not found, in the after-body insertion mode")
		}
		p.appendChild(p.oe[0], p.newComment(p.tok.data))
		return true
	}
	p.im = inBodyIM
	return false
}

// keepSpace keeps only the whitespace of s (framesets ignore other text).
func keepSpace(s string) string {
	for i := 0; i < len(s); i++ {
		if !isSpace(s[i]) {
			b := make([]byte, 0, len(s))
			for j := 0; j < len(s); j++ {
				if isSpace(s[j]) {
					b = append(b, s[j])
				}
			}
			return string(b)
		}
	}
	return s
}

// Section 13.2.6.4.20.
func inFramesetIM(p *parser) bool {
	switch p.tok.typ {
	case commentToken:
		p.addComment()
	case textToken:
		// Ignore all text but whitespace.
		if s := keepSpace(p.tok.data); s != "" {
			p.addText(s)
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aFrameset:
			p.addElement()
		case aFrame:
			p.addElement()
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
		case aNoframes:
			return inHeadIM(p)
		}
	case endTagToken:
		switch p.tok.atom {
		case aFrameset:
			if p.oe.top().atom != aHtml {
				p.oe.pop()
				if p.oe.top().atom != aFrameset {
					p.im = afterFramesetIM
					return true
				}
			}
		}
	default:
		// Ignore the token.
	}
	return true
}

// Section 13.2.6.4.21.
func afterFramesetIM(p *parser) bool {
	switch p.tok.typ {
	case commentToken:
		p.addComment()
	case textToken:
		// Ignore all text but whitespace.
		if s := keepSpace(p.tok.data); s != "" {
			p.addText(s)
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aNoframes:
			return inHeadIM(p)
		}
	case endTagToken:
		switch p.tok.atom {
		case aHtml:
			p.im = afterAfterFramesetIM
			return true
		}
	default:
		// Ignore the token.
	}
	return true
}

// Section 13.2.6.4.22.
func afterAfterBodyIM(p *parser) bool {
	switch p.tok.typ {
	case eofToken:
		// Stop parsing.
		return true
	case textToken:
		s := trimLeftSpace(p.tok.data)
		if len(s) == 0 {
			// It was all whitespace.
			return inBodyIM(p)
		}
	case startTagToken:
		if p.tok.atom == aHtml {
			return inBodyIM(p)
		}
	case commentToken:
		p.appendChild(p.doc, p.newComment(p.tok.data))
		return true
	case doctypeToken:
		return inBodyIM(p)
	}
	p.im = inBodyIM
	return false
}

// Section 13.2.6.4.23.
func afterAfterFramesetIM(p *parser) bool {
	switch p.tok.typ {
	case commentToken:
		p.appendChild(p.doc, p.newComment(p.tok.data))
	case textToken:
		// Ignore all text but whitespace.
		if s := keepSpace(p.tok.data); s != "" {
			p.tok.data = s
			return inBodyIM(p)
		}
	case startTagToken:
		switch p.tok.atom {
		case aHtml:
			return inBodyIM(p)
		case aNoframes:
			return inHeadIM(p)
		}
	case doctypeToken:
		return inBodyIM(p)
	default:
		// Ignore the token.
	}
	return true
}

func ignoreTheRemainingTokens(p *parser) bool {
	return true
}

// Section 13.2.6.5.
func parseForeignContent(p *parser) bool {
	switch p.tok.typ {
	case textToken:
		if p.framesetOK {
			p.framesetOK = isAllSpace(p.stripNUL(p.tok.data))
		}
		if p.hasNUL {
			p.tok.data = p.replaceNUL(p.tok.data)
		}
		p.addText(p.tok.data)
	case commentToken:
		p.addComment()
	case startTagToken:
		b := breakout(p.tok.atom)
		if p.tok.atom == aFont {
		loop:
			for _, attr := range p.tok.attrs {
				switch attr.Name {
				case "color", "face", "size":
					b = true
					break loop
				}
			}
		}
		if b {
			p.popToHTMLOrIntegrationPoint()
			return p.im(p)
		}
		current := p.oe.top()
		switch current.ns {
		case nsMathML:
			adjustAttributeNames(p.tok.attrs, nsMathML)
		case nsSVG:
			// Adjust SVG tag names. The tokenizer lower-cases tag names, but
			// SVG wants e.g. "foreignObject" with a capital second "O".
			if x := svgTagFix[p.tok.atom]; x != 0 {
				p.tok.atom = x
				p.tok.data = atomNames[x]
			}
			adjustAttributeNames(p.tok.attrs, nsSVG)
		default:
			panic("html: bad parser state: unexpected namespace")
		}
		p.addChild(p.newElement(p.tok.atom, p.tok.data, current.ns, p.tok.attrs))
		if p.hasSelfClosingToken {
			p.oe.pop()
			p.acknowledgeSelfClosingTag()
		}
	case endTagToken:
		if p.tok.atom == aP || p.tok.atom == aBr {
			// x/net misses this rule; parse5 and browsers have it.
			p.popToHTMLOrIntegrationPoint()
			return p.im(p)
		}
		if eqFoldASCII(p.oe[len(p.oe)-1].Tag, p.tok.data) {
			p.oe = p.oe[:len(p.oe)-1]
			return true
		}
		for i := len(p.oe) - 1; i >= 0; i-- {
			if eqFoldASCII(p.oe[i].Tag, p.tok.data) {
				p.oe = p.oe[:i]
				return true
			}
			if i > 0 && p.oe[i-1].ns == nsHTML {
				break
			}
		}
		return p.im(p)
	default:
		// Ignore the token.
	}
	return true
}

// popToHTMLOrIntegrationPoint pops foreign elements off the stack until the
// current node is an HTML element or an integration point; the token is then
// reprocessed as HTML.
func (p *parser) popToHTMLOrIntegrationPoint() {
	for i := len(p.oe) - 1; i >= 0; i-- {
		n := p.oe[i]
		if n.ns == nsHTML || htmlIntegrationPoint(n) || mathMLTextIntegrationPoint(n) {
			p.oe = p.oe[:i+1]
			break
		}
	}
}

// eqFoldASCII reports whether a and b are equal ignoring ASCII case.
func eqFoldASCII(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if lowerASCII(a[i]) != lowerASCII(b[i]) {
			return false
		}
	}
	return true
}

// inForeignContent (13.2.6, the tree construction dispatcher).
func (p *parser) inForeignContent() bool {
	if len(p.oe) == 0 {
		return false
	}
	n := p.oe[len(p.oe)-1]
	if n.ns == nsHTML {
		return false
	}
	if mathMLTextIntegrationPoint(n) {
		if p.tok.typ == startTagToken && p.tok.atom != aMglyph && p.tok.atom != aMalignmark {
			return false
		}
		if p.tok.typ == textToken {
			return false
		}
	}
	if n.ns == nsMathML && n.atom == aAnnotationXml && p.tok.typ == startTagToken && p.tok.atom == aSvg {
		return false
	}
	if htmlIntegrationPoint(n) && (p.tok.typ == startTagToken || p.tok.typ == textToken) {
		return false
	}
	if p.tok.typ == eofToken {
		return false
	}
	return true
}

// parseImpliedToken parses a token as though it had appeared in the parser's
// input.
func (p *parser) parseImpliedToken(t tokenType, a atom) {
	realToken, selfClosing := p.tok, p.hasSelfClosingToken
	p.tok = token{typ: t, atom: a, data: atomNames[a]}
	p.hasSelfClosingToken = false
	p.parseCurrentToken()
	p.tok, p.hasSelfClosingToken = realToken, selfClosing
}

// parseCurrentToken runs the current token through the parsing routines
// until it is consumed.
func (p *parser) parseCurrentToken() {
	if p.tok.typ == startTagToken && p.tok.selfClosing {
		p.hasSelfClosingToken = true
	}

	for {
		var consumed bool
		if len(p.oe) == 0 || p.oe[len(p.oe)-1].ns == nsHTML || !p.inForeignContent() {
			consumed = p.im(p)
		} else {
			consumed = parseForeignContent(p)
		}
		if consumed {
			break
		}
	}

	if p.hasSelfClosingToken {
		// This is a parse error, but ignore it.
		p.hasSelfClosingToken = false
	}
}

func (p *parser) parse() {
	for {
		p.nextToken()
		p.parseCurrentToken()
		if p.tok.typ == eofToken {
			return
		}
	}
}
