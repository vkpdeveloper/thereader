package truffle

// Plain text of articles (text.ts).

import (
	"math"
	"strings"
	"unicode/utf8"
)

// InlineText is the plain text of inline content. Breaks become newlines.
func InlineText(content []Inline) string {
	if len(content) == 1 {
		if run, ok := content[0].(*TextRun); ok {
			return run.Text
		}
	}
	size := 0
	for _, node := range content {
		switch n := node.(type) {
		case *TextRun:
			size += len(n.Text)
		case *LineBreak:
			size++
		case *InlineMath:
			size += len(n.Text)
		case *FootnoteRef:
			size += len(n.Label)
		}
	}
	var b strings.Builder
	b.Grow(size)
	for _, node := range content {
		switch n := node.(type) {
		case *TextRun:
			b.WriteString(n.Text)
		case *LineBreak:
			b.WriteByte('\n')
		case *InlineMath:
			b.WriteString(n.Text)
		case *FootnoteRef:
			b.WriteString(n.Label)
		}
	}
	return b.String()
}

func blockText(block Block, out []string, captions bool) []string {
	switch b := block.(type) {
	case *Heading:
		out = append(out, InlineText(b.Content))
	case *Paragraph:
		out = append(out, InlineText(b.Content))
	case *List:
		for _, item := range b.Items {
			for _, child := range item.Blocks {
				out = blockText(child, out, false)
			}
		}
	case *Quote:
		for _, child := range b.Blocks {
			out = blockText(child, out, false)
		}
		if b.Cite != nil {
			out = append(out, InlineText(b.Cite))
		}
	case *Code:
		out = append(out, b.Code)
	case *Figure:
		// Captions belong to their media, not the running text (schema.org articleBody semantics),
		// except in photo galleries, where they are the text.
		if captions && b.Caption != nil {
			out = append(out, InlineText(b.Caption))
		}
	case *Embed:
		for _, child := range b.Blocks {
			out = blockText(child, out, false)
		}
	case *Table:
		if b.Caption != nil {
			out = append(out, InlineText(b.Caption))
		}
		for _, row := range b.Rows {
			cells := make([]string, len(row.Cells))
			for i, cell := range row.Cells {
				cells[i] = InlineText(cell.Content)
			}
			out = append(out, strings.Join(cells, "\t"))
		}
	case *MathBlock:
		out = append(out, b.Text)
	case *DefinitionList:
		for _, item := range b.Items {
			out = append(out, InlineText(item.Term))
			for _, child := range item.Details {
				out = blockText(child, out, false)
			}
		}
	case *Details:
		out = append(out, InlineText(b.Summary))
		for _, child := range b.Blocks {
			out = blockText(child, out, false)
		}
	case *Callout:
		if b.Title != nil {
			out = append(out, InlineText(b.Title))
		}
		for _, child := range b.Blocks {
			out = blockText(child, out, false)
		}
	case *Footnotes:
		for _, item := range b.Items {
			for _, child := range item.Blocks {
				out = blockText(child, out, false)
			}
		}
	}
	return out
}

// BlocksText is the body text of an article (title excluded), one block per paragraph.
func BlocksText(blocks []Block) string {
	captions := isGallery(blocks)
	var out []string
	for _, block := range blocks {
		out = blockText(block, out, captions)
	}
	n := 0
	size := 0
	for _, part := range out {
		if part != "" {
			n++
			size += len(part) + 2
		}
	}
	var b strings.Builder
	b.Grow(size)
	first := true
	for _, part := range out {
		if part == "" {
			continue
		}
		if !first {
			b.WriteString("\n\n")
		}
		first = false
		b.WriteString(part)
	}
	return b.String()
}

// blocksTextLen is u16len(BlocksText(blocks)) without building the text.
func blocksTextLen(blocks []Block) int {
	captions := isGallery(blocks)
	var out []string
	for _, block := range blocks {
		out = blockText(block, out, captions)
	}
	n := 0
	parts := 0
	for _, part := range out {
		if part != "" {
			if parts > 0 {
				n += 2
			}
			parts++
			n += u16len(part)
		}
	}
	return n
}

// isGallery: three or more captioned figures whose captions outweigh the rest of the text.
func isGallery(blocks []Block) bool {
	figures := 0
	captionLength := 0
	for _, block := range blocks {
		if f, ok := block.(*Figure); ok && f.Caption != nil {
			figures++
			captionLength += u16len(InlineText(f.Caption))
		}
	}
	if figures < 3 {
		return false
	}
	restLength := 0
	var rest []string
	for _, block := range blocks {
		rest = blockText(block, rest[:0], false)
		for _, part := range rest {
			restLength += u16len(part)
		}
		if restLength >= captionLength {
			return false
		}
	}
	return true
}

// ArticleText is the article's body text.
func ArticleText(a *Article) string {
	return BlocksText(a.Blocks)
}

func isCJK(r rune) bool {
	return (r >= 0x3040 && r <= 0x30ff) || (r >= 0x3400 && r <= 0x4dbf) || (r >= 0x4e00 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff) || (r >= 0xac00 && r <= 0xd7af)
}

// CountWords counts words for reading time: whitespace-separated tokens, CJK
// characters counted at two per word.
func CountWords(text string) int {
	cjk := 0
	words := 0
	inWord := false
	for i := 0; i < len(text); {
		if c := text[i]; c < 0x80 {
			i++
			if c == ' ' || c >= 0x09 && c <= 0x0d {
				inWord = false
			} else if !inWord {
				words++
				inWord = true
			}
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		i += size
		// CJK characters are replaced by spaces before splitting.
		if isCJK(r) {
			cjk++
			inWord = false
			continue
		}
		if isJSSpace(r) {
			inWord = false
			continue
		}
		if !inWord {
			words++
			inWord = true
		}
	}
	return words + int(math.Ceil(float64(cjk)/2))
}
