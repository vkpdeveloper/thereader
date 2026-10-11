package pdfextractor

import (
	"strings"
	"testing"
)

func TestDehyphenationRequiresWitnessAndPreservesCompounds(t *testing.T) {
	p := &pdf{opts: (Options{}).normalized(), out: &Document{}, warned: map[string]bool{}}
	for _, tc := range []struct{ reference, want string }{{"Coordination matters.", "coordination"}, {"A different spelling.", "coordi-nation"}, {"Coordination and coordi-nation.", "coordi-nation"}} {
		spans := []span{tableSpan(tc.reference, 20, 30, 190), tableSpan("There is coordi-", 20, 60, 150), tableSpan("nation within this system.", 20, 72, 180)}
		blocks := p.layout(&pageContent{page: Page{Width: 400, Height: 400}, spans: spans}, 10)
		d := &Document{Pages: []Page{{Blocks: blocks}}}
		md := Markdown(d)
		if !strings.Contains(md, "There is "+tc.want+" within") {
			t.Fatal(md)
		}
	}
	if witnessedHyphen("well-", "known", map[string]bool{"well-known": true, "wellknown": true}) {
		t.Fatal("removed explicit compound")
	}
}
