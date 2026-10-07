package truffle

// The article document model (model.ts): what the extractor produces and both
// renderers draw. JSON output follows model.ts field order and omits absent
// optionals, so it is byte-identical to the TypeScript engine's
// `JSON.stringify(article, null, 2)`.
//
// Optional fields: an empty string or zero number is absent (the engine never
// sets an empty one), a nil slice is absent. Nullable article fields are
// pointers.

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// ArticleSchema is the version of the model.
const ArticleSchema = 1

// Mark is inline formatting. Runs list their marks in MarkOrder.
type Mark string

const (
	MarkBold      Mark = "bold"
	MarkItalic    Mark = "italic"
	MarkUnderline Mark = "underline"
	MarkStrike    Mark = "strike"
	MarkCode      Mark = "code"
	MarkSub       Mark = "sub"
	MarkSup       Mark = "sup"
	MarkHighlight Mark = "highlight"
	MarkSmall     Mark = "small"
	MarkKbd       Mark = "kbd"
)

// MarkOrder is the order marks are listed in.
var MarkOrder = []Mark{MarkBold, MarkItalic, MarkUnderline, MarkStrike, MarkCode, MarkSub, MarkSup, MarkHighlight, MarkSmall, MarkKbd}

// Inline is one of *TextRun, *LineBreak, *InlineImage, *InlineMath, *FootnoteRef.
type Inline interface {
	InlineType() string
}

// TextRun is a run of text with formatting.
type TextRun struct {
	Text  string
	Marks []Mark // nil when none
	Href  string // absolute link target; "" when none
}

// LineBreak is a hard line break.
type LineBreak struct{}

// InlineImage is a small image inside a line (emoji, icons, inline formulas as images).
type InlineImage struct {
	Src    string
	Alt    string
	Width  int // 0 when unknown
	Height int // 0 when unknown
}

// InlineMath is a formula inside a line.
type InlineMath struct {
	Tex    string // LaTeX source when the page provided it
	MathML string // serialized <math> when the page provided MathML
	Text   string // text fallback
}

// FootnoteRef is a footnote reference; ID matches a Footnote.
type FootnoteRef struct {
	ID    string
	Label string
}

func (*TextRun) InlineType() string     { return "text" }
func (*LineBreak) InlineType() string   { return "break" }
func (*InlineImage) InlineType() string { return "image" }
func (*InlineMath) InlineType() string  { return "math" }
func (*FootnoteRef) InlineType() string { return "ref" }

// Image is a figure image or the lead image.
type Image struct {
	Src    string // best available source
	Alt    string
	Width  int
	Height int
	Srcset string // normalized absolute srcset, when the page offered several sizes
	Href   string // link target when the image itself is a link
}

// Block is one of the block types below.
type Block interface {
	BlockType() string
}

// Heading levels are 2..6; the title is the only level-1 heading and is not a block.
type Heading struct {
	Level   int
	Content []Inline
	Anchor  string
}

type Paragraph struct {
	Content []Inline
}

type ListItem struct {
	Blocks  []Block
	Checked *bool // task-list state
}

type List struct {
	Ordered bool
	Start   *int // first number of an ordered list when not 1
	Items   []*ListItem
}

type Quote struct {
	Blocks []Block
	Cite   []Inline
	Pull   bool // pull quote: a decorative repeat of article text
}

type Code struct {
	Code           string
	Language       string  // canonical id; "" is null (unknown)
	LanguageSource string  // "markup" or "detected"; "" when absent
	Title          *string // file name or title shown above the block
}

// Figure is one image, or a gallery when Images has several.
type Figure struct {
	Images  []*Image
	Caption []Inline
	Credit  []Inline
}

type Video struct {
	Provider string
	URL      string
	EmbedURL string
	Poster   string
	Title    string
	Caption  []Inline
}

type Audio struct {
	Provider string
	URL      string
	EmbedURL string
	Title    string
	Caption  []Inline
}

// Embed is a social post or other third-party embed kept as readable content.
type Embed struct {
	Provider string
	URL      string
	Author   string
	Blocks   []Block
}

type TableCell struct {
	Content []Inline
	Header  bool
	Colspan int
	Rowspan int
	Align   string
}

type TableRow struct {
	Cells []*TableCell
}

type Table struct {
	Caption    []Inline
	Rows       []*TableRow
	HeaderRows int
}

type Rule struct{}

type MathBlock struct {
	Tex    string
	MathML string
	Text   string
}

type Definition struct {
	Term    []Inline
	Details []Block
}

type DefinitionList struct {
	Items []*Definition
}

type Details struct {
	Summary []Inline
	Blocks  []Block
}

// Callout is an admonition: Variant is note, tip, info, warning, danger, or "" (null) when unstyled.
type Callout struct {
	Variant string
	Title   []Inline
	Blocks  []Block
}

type Footnote struct {
	ID     string
	Label  string
	Blocks []Block
}

type Footnotes struct {
	Items []*Footnote
}

func (*Heading) BlockType() string        { return "heading" }
func (*Paragraph) BlockType() string      { return "paragraph" }
func (*List) BlockType() string           { return "list" }
func (*Quote) BlockType() string          { return "quote" }
func (*Code) BlockType() string           { return "code" }
func (*Figure) BlockType() string         { return "figure" }
func (*Video) BlockType() string          { return "video" }
func (*Audio) BlockType() string          { return "audio" }
func (*Embed) BlockType() string          { return "embed" }
func (*Table) BlockType() string          { return "table" }
func (*Rule) BlockType() string           { return "rule" }
func (*MathBlock) BlockType() string      { return "math" }
func (*DefinitionList) BlockType() string { return "definitions" }
func (*Details) BlockType() string        { return "details" }
func (*Callout) BlockType() string        { return "callout" }
func (*Footnotes) BlockType() string      { return "footnotes" }

// Article is what extraction returns.
type Article struct {
	Schema         int
	URL            string // canonical URL on the same site, else the fetched URL
	Title          string
	Subtitle       *string
	Byline         *string
	Authors        []string
	SiteName       *string
	PublishedAt    *string // ISO 8601
	ModifiedAt     *string
	Language       *string // BCP 47
	Dir            string  // "ltr" or "rtl"
	Excerpt        *string
	LeadImage      *Image
	Favicon        *string
	WordCount      int
	ReadingMinutes int
	Blocks         []Block
	Markdown       *string // present only when extraction was asked for it
}

// ------------------------------------------------------------------ JSON output

// jsonWriter writes JSON as `JSON.stringify(value, null, indent)` does.
type jsonWriter struct {
	b      []byte
	indent string
	counts []int // elements written in each open object/array
}

func (w *jsonWriter) newline() {
	w.b = append(w.b, '\n')
	for range w.counts {
		w.b = append(w.b, w.indent...)
	}
}

// element starts the next member of the innermost object or array.
func (w *jsonWriter) element() {
	n := len(w.counts)
	if n == 0 {
		return
	}
	if w.counts[n-1] > 0 {
		w.b = append(w.b, ',')
	}
	w.counts[n-1]++
	if w.indent != "" {
		w.newline()
	}
}

func (w *jsonWriter) open(c byte) {
	w.b = append(w.b, c)
	w.counts = append(w.counts, 0)
}

func (w *jsonWriter) close(c byte) {
	n := len(w.counts)
	had := w.counts[n-1] > 0
	w.counts = w.counts[:n-1]
	if had && w.indent != "" {
		w.newline()
	}
	w.b = append(w.b, c)
}

func (w *jsonWriter) key(k string) {
	w.element()
	w.b = jsonQuote(w.b, k)
	w.b = append(w.b, ':')
	if w.indent != "" {
		w.b = append(w.b, ' ')
	}
}

func (w *jsonWriter) str(s string)         { w.b = jsonQuote(w.b, s) }
func (w *jsonWriter) num(n int)            { w.b = strconv.AppendInt(w.b, int64(n), 10) }
func (w *jsonWriter) null()                { w.b = append(w.b, "null"...) }
func (w *jsonWriter) boolean(v bool)       { w.b = strconv.AppendBool(w.b, v) }
func (w *jsonWriter) kstr(k, v string)     { w.key(k); w.str(v) }
func (w *jsonWriter) knum(k string, v int) { w.key(k); w.num(v) }

func (w *jsonWriter) knullable(k string, v *string) {
	w.key(k)
	if v == nil {
		w.null()
	} else {
		w.str(*v)
	}
}

func (w *jsonWriter) inlines(content []Inline) {
	w.open('[')
	for _, n := range content {
		w.element()
		w.inline(n)
	}
	w.close(']')
}

func (w *jsonWriter) inline(n Inline) {
	w.open('{')
	switch n := n.(type) {
	case *TextRun:
		w.kstr("type", "text")
		w.kstr("text", n.Text)
		if n.Marks != nil {
			w.key("marks")
			w.open('[')
			for _, m := range n.Marks {
				w.element()
				w.str(string(m))
			}
			w.close(']')
		}
		if n.Href != "" {
			w.kstr("href", n.Href)
		}
	case *LineBreak:
		w.kstr("type", "break")
	case *InlineImage:
		w.kstr("type", "image")
		w.kstr("src", n.Src)
		w.kstr("alt", n.Alt)
		if n.Width != 0 {
			w.knum("width", n.Width)
		}
		if n.Height != 0 {
			w.knum("height", n.Height)
		}
	case *InlineMath:
		w.kstr("type", "math")
		if n.Tex != "" {
			w.kstr("tex", n.Tex)
		}
		if n.MathML != "" {
			w.kstr("mathml", n.MathML)
		}
		w.kstr("text", n.Text)
	case *FootnoteRef:
		w.kstr("type", "ref")
		w.kstr("id", n.ID)
		w.kstr("label", n.Label)
	}
	w.close('}')
}

func (w *jsonWriter) image(img *Image) {
	w.open('{')
	w.kstr("src", img.Src)
	w.kstr("alt", img.Alt)
	if img.Width != 0 {
		w.knum("width", img.Width)
	}
	if img.Height != 0 {
		w.knum("height", img.Height)
	}
	if img.Srcset != "" {
		w.kstr("srcset", img.Srcset)
	}
	if img.Href != "" {
		w.kstr("href", img.Href)
	}
	w.close('}')
}

func (w *jsonWriter) blocks(blocks []Block) {
	w.open('[')
	for _, b := range blocks {
		w.element()
		w.block(b)
	}
	w.close(']')
}

func (w *jsonWriter) optInlines(k string, content []Inline) {
	if content != nil {
		w.key(k)
		w.inlines(content)
	}
}

func (w *jsonWriter) block(b Block) {
	w.open('{')
	w.kstr("type", b.BlockType())
	switch b := b.(type) {
	case *Heading:
		w.knum("level", b.Level)
		w.key("content")
		w.inlines(b.Content)
		if b.Anchor != "" {
			w.kstr("anchor", b.Anchor)
		}
	case *Paragraph:
		w.key("content")
		w.inlines(b.Content)
	case *List:
		w.key("ordered")
		w.boolean(b.Ordered)
		if b.Start != nil {
			w.knum("start", *b.Start)
		}
		w.key("items")
		w.open('[')
		for _, item := range b.Items {
			w.element()
			w.open('{')
			w.key("blocks")
			w.blocks(item.Blocks)
			if item.Checked != nil {
				w.key("checked")
				w.boolean(*item.Checked)
			}
			w.close('}')
		}
		w.close(']')
	case *Quote:
		w.key("blocks")
		w.blocks(b.Blocks)
		w.optInlines("cite", b.Cite)
		if b.Pull {
			w.key("pull")
			w.boolean(true)
		}
	case *Code:
		w.kstr("code", b.Code)
		w.key("language")
		if b.Language == "" {
			w.null()
		} else {
			w.str(b.Language)
		}
		if b.LanguageSource != "" {
			w.kstr("languageSource", b.LanguageSource)
		}
		if b.Title != nil {
			w.kstr("title", *b.Title)
		}
	case *Figure:
		w.key("images")
		w.open('[')
		for _, img := range b.Images {
			w.element()
			w.image(img)
		}
		w.close(']')
		w.optInlines("caption", b.Caption)
		w.optInlines("credit", b.Credit)
	case *Video:
		w.kstr("provider", b.Provider)
		w.kstr("url", b.URL)
		if b.EmbedURL != "" {
			w.kstr("embedUrl", b.EmbedURL)
		}
		if b.Poster != "" {
			w.kstr("poster", b.Poster)
		}
		if b.Title != "" {
			w.kstr("title", b.Title)
		}
		w.optInlines("caption", b.Caption)
	case *Audio:
		w.kstr("provider", b.Provider)
		w.kstr("url", b.URL)
		if b.EmbedURL != "" {
			w.kstr("embedUrl", b.EmbedURL)
		}
		if b.Title != "" {
			w.kstr("title", b.Title)
		}
		w.optInlines("caption", b.Caption)
	case *Embed:
		w.kstr("provider", b.Provider)
		w.kstr("url", b.URL)
		if b.Author != "" {
			w.kstr("author", b.Author)
		}
		if b.Blocks != nil {
			w.key("blocks")
			w.blocks(b.Blocks)
		}
	case *Table:
		w.optInlines("caption", b.Caption)
		w.key("rows")
		w.open('[')
		for _, row := range b.Rows {
			w.element()
			w.open('{')
			w.key("cells")
			w.open('[')
			for _, cell := range row.Cells {
				w.element()
				w.open('{')
				w.key("content")
				w.inlines(cell.Content)
				if cell.Header {
					w.key("header")
					w.boolean(true)
				}
				if cell.Colspan != 0 {
					w.knum("colspan", cell.Colspan)
				}
				if cell.Rowspan != 0 {
					w.knum("rowspan", cell.Rowspan)
				}
				if cell.Align != "" {
					w.kstr("align", cell.Align)
				}
				w.close('}')
			}
			w.close(']')
			w.close('}')
		}
		w.close(']')
		if b.HeaderRows != 0 {
			w.knum("headerRows", b.HeaderRows)
		}
	case *Rule:
	case *MathBlock:
		if b.Tex != "" {
			w.kstr("tex", b.Tex)
		}
		if b.MathML != "" {
			w.kstr("mathml", b.MathML)
		}
		w.kstr("text", b.Text)
	case *DefinitionList:
		w.key("items")
		w.open('[')
		for _, item := range b.Items {
			w.element()
			w.open('{')
			w.key("term")
			w.inlines(item.Term)
			w.key("details")
			w.blocks(item.Details)
			w.close('}')
		}
		w.close(']')
	case *Details:
		w.key("summary")
		w.inlines(b.Summary)
		w.key("blocks")
		w.blocks(b.Blocks)
	case *Callout:
		w.key("variant")
		if b.Variant == "" {
			w.null()
		} else {
			w.str(b.Variant)
		}
		w.optInlines("title", b.Title)
		w.key("blocks")
		w.blocks(b.Blocks)
	case *Footnotes:
		w.key("items")
		w.open('[')
		for _, item := range b.Items {
			w.element()
			w.open('{')
			w.kstr("id", item.ID)
			w.kstr("label", item.Label)
			w.key("blocks")
			w.blocks(item.Blocks)
			w.close('}')
		}
		w.close(']')
	}
	w.close('}')
}

func (w *jsonWriter) article(a *Article) {
	w.open('{')
	w.knum("schema", a.Schema)
	w.kstr("url", a.URL)
	w.kstr("title", a.Title)
	w.knullable("subtitle", a.Subtitle)
	w.knullable("byline", a.Byline)
	w.key("authors")
	w.open('[')
	for _, s := range a.Authors {
		w.element()
		w.str(s)
	}
	w.close(']')
	w.knullable("siteName", a.SiteName)
	w.knullable("publishedAt", a.PublishedAt)
	w.knullable("modifiedAt", a.ModifiedAt)
	w.knullable("language", a.Language)
	w.kstr("dir", a.Dir)
	w.knullable("excerpt", a.Excerpt)
	w.key("leadImage")
	if a.LeadImage == nil {
		w.null()
	} else {
		w.image(a.LeadImage)
	}
	w.knullable("favicon", a.Favicon)
	w.knum("wordCount", a.WordCount)
	w.knum("readingMinutes", a.ReadingMinutes)
	w.key("blocks")
	w.blocks(a.Blocks)
	if a.Markdown != nil {
		w.kstr("markdown", *a.Markdown)
	}
	w.close('}')
}

// JSON writes the article as `JSON.stringify(article, null, indent)` does
// ("" for compact output).
func (a *Article) JSON(indent string) []byte {
	w := jsonWriter{indent: indent, b: make([]byte, 0, 4096)}
	w.article(a)
	return w.b
}

// MarshalJSON implements json.Marshaler (compact, model key order).
func (a *Article) MarshalJSON() ([]byte, error) {
	return a.JSON(""), nil
}

// BlocksJSON writes blocks as `JSON.stringify(blocks, null, indent)` does.
func BlocksJSON(blocks []Block, indent string) []byte {
	w := jsonWriter{indent: indent}
	w.blocks(blocks)
	return w.b
}

// ------------------------------------------------------------------ JSON input

// ParseArticleJSON reads an article written by any Truffle engine.
func ParseArticleJSON(data []byte) (*Article, error) {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	return articleFromJSON(raw)
}

// ParseBlocksJSON reads a JSON array of blocks.
func ParseBlocksJSON(data []byte) (blocks []Block, err error) {
	var raw []any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("truffle: bad block JSON: %v", r)
		}
	}()
	return blocksFromJSON(raw), nil
}

func articleFromJSON(raw map[string]any) (a *Article, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("truffle: bad article JSON: %v", r)
		}
	}()
	a = &Article{
		Schema:         jInt(raw["schema"]),
		URL:            jStr(raw["url"]),
		Title:          jStr(raw["title"]),
		Subtitle:       jNullable(raw["subtitle"]),
		Byline:         jNullable(raw["byline"]),
		SiteName:       jNullable(raw["siteName"]),
		PublishedAt:    jNullable(raw["publishedAt"]),
		ModifiedAt:     jNullable(raw["modifiedAt"]),
		Language:       jNullable(raw["language"]),
		Dir:            jStr(raw["dir"]),
		Excerpt:        jNullable(raw["excerpt"]),
		Favicon:        jNullable(raw["favicon"]),
		WordCount:      jInt(raw["wordCount"]),
		ReadingMinutes: jInt(raw["readingMinutes"]),
		Markdown:       jNullable(raw["markdown"]),
	}
	a.Authors = []string{}
	for _, s := range jArr(raw["authors"]) {
		a.Authors = append(a.Authors, s.(string))
	}
	if img, ok := raw["leadImage"].(map[string]any); ok {
		a.LeadImage = imageFromJSON(img)
	}
	a.Blocks = blocksFromJSON(jArr(raw["blocks"]))
	return a, nil
}

func jStr(v any) string {
	s, _ := v.(string)
	return s
}

func jNullable(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func jInt(v any) int {
	f, _ := v.(float64)
	return int(f)
}

func jArr(v any) []any {
	a, _ := v.([]any)
	return a
}

func jBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func imageFromJSON(m map[string]any) *Image {
	return &Image{Src: jStr(m["src"]), Alt: jStr(m["alt"]), Width: jInt(m["width"]), Height: jInt(m["height"]), Srcset: jStr(m["srcset"]), Href: jStr(m["href"])}
}

// optInlinesFromJSON keeps absent (nil) apart from empty.
func optInlinesFromJSON(v any) []Inline {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	return inlinesFromJSON(arr)
}

func inlinesFromJSON(arr []any) []Inline {
	out := make([]Inline, 0, len(arr))
	for _, v := range arr {
		m := v.(map[string]any)
		switch jStr(m["type"]) {
		case "text":
			run := &TextRun{Text: jStr(m["text"]), Href: jStr(m["href"])}
			if marks, ok := m["marks"].([]any); ok {
				run.Marks = make([]Mark, 0, len(marks))
				for _, mk := range marks {
					run.Marks = append(run.Marks, Mark(mk.(string)))
				}
			}
			out = append(out, run)
		case "break":
			out = append(out, &LineBreak{})
		case "image":
			out = append(out, &InlineImage{Src: jStr(m["src"]), Alt: jStr(m["alt"]), Width: jInt(m["width"]), Height: jInt(m["height"])})
		case "math":
			out = append(out, &InlineMath{Tex: jStr(m["tex"]), MathML: jStr(m["mathml"]), Text: jStr(m["text"])})
		case "ref":
			out = append(out, &FootnoteRef{ID: jStr(m["id"]), Label: jStr(m["label"])})
		default:
			panic("unknown inline type " + jStr(m["type"]))
		}
	}
	return out
}

func optBlocksFromJSON(v any) []Block {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	return blocksFromJSON(arr)
}

func blocksFromJSON(arr []any) []Block {
	out := make([]Block, 0, len(arr))
	for _, v := range arr {
		out = append(out, blockFromJSON(v.(map[string]any)))
	}
	return out
}

func blockFromJSON(m map[string]any) Block {
	switch jStr(m["type"]) {
	case "heading":
		return &Heading{Level: jInt(m["level"]), Content: inlinesFromJSON(jArr(m["content"])), Anchor: jStr(m["anchor"])}
	case "paragraph":
		return &Paragraph{Content: inlinesFromJSON(jArr(m["content"]))}
	case "list":
		l := &List{Ordered: jBool(m["ordered"])}
		if s, ok := m["start"].(float64); ok {
			n := int(s)
			l.Start = &n
		}
		l.Items = []*ListItem{}
		for _, it := range jArr(m["items"]) {
			im := it.(map[string]any)
			item := &ListItem{Blocks: blocksFromJSON(jArr(im["blocks"]))}
			if c, ok := im["checked"].(bool); ok {
				item.Checked = &c
			}
			l.Items = append(l.Items, item)
		}
		return l
	case "quote":
		return &Quote{Blocks: blocksFromJSON(jArr(m["blocks"])), Cite: optInlinesFromJSON(m["cite"]), Pull: jBool(m["pull"])}
	case "code":
		c := &Code{Code: jStr(m["code"]), Language: jStr(m["language"]), LanguageSource: jStr(m["languageSource"])}
		if t, ok := m["title"].(string); ok {
			c.Title = &t
		}
		return c
	case "figure":
		f := &Figure{Caption: optInlinesFromJSON(m["caption"]), Credit: optInlinesFromJSON(m["credit"])}
		f.Images = []*Image{}
		for _, img := range jArr(m["images"]) {
			f.Images = append(f.Images, imageFromJSON(img.(map[string]any)))
		}
		return f
	case "video":
		return &Video{Provider: jStr(m["provider"]), URL: jStr(m["url"]), EmbedURL: jStr(m["embedUrl"]), Poster: jStr(m["poster"]), Title: jStr(m["title"]), Caption: optInlinesFromJSON(m["caption"])}
	case "audio":
		return &Audio{Provider: jStr(m["provider"]), URL: jStr(m["url"]), EmbedURL: jStr(m["embedUrl"]), Title: jStr(m["title"]), Caption: optInlinesFromJSON(m["caption"])}
	case "embed":
		return &Embed{Provider: jStr(m["provider"]), URL: jStr(m["url"]), Author: jStr(m["author"]), Blocks: optBlocksFromJSON(m["blocks"])}
	case "table":
		t := &Table{Caption: optInlinesFromJSON(m["caption"]), HeaderRows: jInt(m["headerRows"])}
		t.Rows = []*TableRow{}
		for _, r := range jArr(m["rows"]) {
			row := &TableRow{Cells: []*TableCell{}}
			for _, c := range jArr(r.(map[string]any)["cells"]) {
				cm := c.(map[string]any)
				row.Cells = append(row.Cells, &TableCell{Content: inlinesFromJSON(jArr(cm["content"])), Header: jBool(cm["header"]), Colspan: jInt(cm["colspan"]), Rowspan: jInt(cm["rowspan"]), Align: jStr(cm["align"])})
			}
			t.Rows = append(t.Rows, row)
		}
		return t
	case "rule":
		return &Rule{}
	case "math":
		return &MathBlock{Tex: jStr(m["tex"]), MathML: jStr(m["mathml"]), Text: jStr(m["text"])}
	case "definitions":
		d := &DefinitionList{Items: []*Definition{}}
		for _, it := range jArr(m["items"]) {
			im := it.(map[string]any)
			d.Items = append(d.Items, &Definition{Term: inlinesFromJSON(jArr(im["term"])), Details: blocksFromJSON(jArr(im["details"]))})
		}
		return d
	case "details":
		return &Details{Summary: inlinesFromJSON(jArr(m["summary"])), Blocks: blocksFromJSON(jArr(m["blocks"]))}
	case "callout":
		return &Callout{Variant: jStr(m["variant"]), Title: optInlinesFromJSON(m["title"]), Blocks: blocksFromJSON(jArr(m["blocks"]))}
	case "footnotes":
		f := &Footnotes{Items: []*Footnote{}}
		for _, it := range jArr(m["items"]) {
			im := it.(map[string]any)
			f.Items = append(f.Items, &Footnote{ID: jStr(im["id"]), Label: jStr(im["label"]), Blocks: blocksFromJSON(jArr(im["blocks"]))})
		}
		return f
	}
	panic("unknown block type " + jStr(m["type"]))
}
