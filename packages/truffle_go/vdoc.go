package truffle

// The JSON form of a Document that `packages/truffle/scripts/vdoc-json.ts`
// writes from jsdom: a text node is a string, an element `{ t, a?, c? }` with
// attributes in iteration order; `head` and `body` are child-index paths from
// the root. Reading it runs the Go engine on the very tree the TypeScript
// engine saw, so parser differences drop out of a comparison.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// ReadDocumentJSON reads a Document from the JSON form vdoc-json.ts writes.
func ReadDocumentJSON(data []byte) (*Document, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := expectDelim(dec, '{'); err != nil {
		return nil, err
	}
	doc := &Document{}
	var headPath, bodyPath []int
	hasHead := false
	for dec.More() {
		key, err := stringToken(dec)
		if err != nil {
			return nil, err
		}
		switch key {
		case "root":
			node, err := readVNode(dec, nil)
			if err != nil {
				return nil, err
			}
			if node.Kind != ElementNode {
				return nil, errors.New("truffle: root is not an element")
			}
			doc.Root = node
		case "head":
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return nil, err
			}
			if string(raw) != "null" {
				hasHead = true
				if err := json.Unmarshal(raw, &headPath); err != nil {
					return nil, err
				}
			}
		case "body":
			if err := dec.Decode(&bodyPath); err != nil {
				return nil, err
			}
		case "jsonLd":
			if err := dec.Decode(&doc.JSONLD); err != nil {
				return nil, err
			}
		case "nextData":
			if err := dec.Decode(&doc.NextData); err != nil {
				return nil, err
			}
		case "baseHref":
			if err := dec.Decode(&doc.BaseHref); err != nil {
				return nil, err
			}
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return nil, err
			}
		}
	}
	if doc.Root == nil {
		return nil, errors.New("truffle: document without root")
	}
	at := func(path []int) (*Node, error) {
		el := doc.Root
		for _, i := range path {
			if i < 0 || i >= len(el.Children) {
				return nil, fmt.Errorf("truffle: bad node path %v", path)
			}
			el = el.Children[i]
		}
		return el, nil
	}
	var err error
	if hasHead {
		if doc.Head, err = at(headPath); err != nil {
			return nil, err
		}
	}
	if doc.Body, err = at(bodyPath); err != nil {
		return nil, err
	}
	return doc, nil
}

func expectDelim(dec *json.Decoder, want json.Delim) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != want {
		return fmt.Errorf("truffle: expected %q, got %v", want, tok)
	}
	return nil
}

func stringToken(dec *json.Decoder) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	s, ok := tok.(string)
	if !ok {
		return "", fmt.Errorf("truffle: expected a string, got %v", tok)
	}
	return s, nil
}

func readVNode(dec *json.Decoder, parent *Node) (*Node, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if s, ok := tok.(string); ok {
		n := NewText(s)
		n.Parent = parent
		return n, nil
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("truffle: expected a node, got %v", tok)
	}
	var tag string
	var attrs []Attr
	var children []*Node
	el := &Node{}
	for dec.More() {
		key, err := stringToken(dec)
		if err != nil {
			return nil, err
		}
		switch key {
		case "t":
			if tag, err = stringToken(dec); err != nil {
				return nil, err
			}
		case "a":
			if err := expectDelim(dec, '{'); err != nil {
				return nil, err
			}
			for dec.More() {
				name, err := stringToken(dec)
				if err != nil {
					return nil, err
				}
				value, err := stringToken(dec)
				if err != nil {
					return nil, err
				}
				attrs = append(attrs, Attr{name, value})
			}
			if err := expectDelim(dec, '}'); err != nil {
				return nil, err
			}
		case "c":
			if err := expectDelim(dec, '['); err != nil {
				return nil, err
			}
			for dec.More() {
				child, err := readVNode(dec, el)
				if err != nil {
					return nil, err
				}
				children = append(children, child)
			}
			if err := expectDelim(dec, ']'); err != nil {
				return nil, err
			}
		}
	}
	if err := expectDelim(dec, '}'); err != nil {
		return nil, err
	}
	*el = *NewElement(tag, attrs)
	el.Children = children
	el.Parent = parent
	return el, nil
}
