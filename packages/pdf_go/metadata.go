package pdfextractor

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"strings"
)

// XMP is a fallback when Info fields are absent. encoding/xml never fetches a
// DTD, expands external entities, or executes PDF actions.
func (p *pdf) xmp(v any) {
	s, ok := p.resolve(v).(*stream)
	if !ok {
		return
	}
	data, e := p.decode(s)
	if e != nil {
		if errors.Is(e, ErrLimit) {
			p.err = e
		}
		p.warn("metadata", 0, "XMP metadata could not be decoded.")
		return
	}
	if len(data) > 4<<20 {
		p.warn("metadata", 0, "XMP metadata exceeds the metadata limit.")
		return
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	stack := []string{}
	values := map[string][]string{}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			p.warn("metadata", 0, "XMP metadata is malformed.")
			return
		}
		switch t := token.(type) {
		case xml.StartElement:
			if len(stack) > 64 {
				p.warn("metadata", 0, "XMP metadata nesting exceeds the limit.")
				return
			}
			stack = append(stack, t.Name.Local)
		case xml.EndElement:
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			text := strings.TrimSpace(string(t))
			if text == "" {
				continue
			}
			for _, field := range stack {
				switch field {
				case "title", "creator", "description", "language", "subject", "Keywords", "CreatorTool", "CreateDate":
					values[field] = append(values[field], text)
				}
			}
		}
	}
	first := func(k string) string {
		if len(values[k]) > 0 {
			return values[k][0]
		}
		return ""
	}
	if p.out.Title == "" {
		p.out.Title = first("title")
	}
	if p.out.Author == "" {
		p.out.Author = strings.Join(values["creator"], "; ")
	}
	if p.out.Subject == "" {
		p.out.Subject = first("description")
	}
	if p.out.Keywords == "" {
		p.out.Keywords = first("Keywords")
		if p.out.Keywords == "" {
			p.out.Keywords = strings.Join(values["subject"], ", ")
		}
	}
	if p.out.Creator == "" {
		p.out.Creator = first("CreatorTool")
	}
	if p.out.Created == "" {
		p.out.Created = first("CreateDate")
	}
	if p.out.Language == "" {
		p.out.Language = first("language")
	}
}

func markSectionRoles(pages []Page) {
	role := ""
	for pi := range pages {
		for bi := range pages[pi].Blocks {
			b := &pages[pi].Blocks[bi]
			if b.Kind == "heading" {
				title := strings.ToLower(strings.Trim(strings.TrimSpace(b.Text), "0123456789. "))
				switch title {
				case "references", "bibliography", "works cited", "further reading":
					role = "reference"
				case "index", "subject index", "name index":
					role = "index"
				default:
					if b.Level <= 2 {
						role = ""
					}
				}
			} else if b.Role == "" && (b.Kind == "paragraph" || b.Kind == "list") {
				b.Role = role
			}
		}
	}
}
