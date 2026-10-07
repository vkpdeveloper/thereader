package truffle

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The i flag without u, against V8: a character matches those with the same
// uppercase form, never an ASCII letter a non-ASCII one (RE2's (?i) folds k
// with the Kelvin sign and s with long s). Expected values from
// new RegExp(source, flags).test(subject) under bun.
func TestJSRegexpCaseFolding(t *testing.T) {
	type fold struct {
		subject string
		want    bool
	}
	for _, c := range []struct {
		source, flags string
		subjects      []fold
	}{
		{"k", "i", []fold{{"k", true}, {"K", true}, {"\u212a", false}}},
		{"s", "i", []fold{{"\u017f", false}, {"S", true}, {"s", true}}},
		{"\\w", "i", []fold{{"\u017f", false}, {"\u212a", false}, {"x", true}}},
		{"^\\w+$", "i", []fold{{"Ks", true}, {"K\u017f", false}}},
		{"[a-z]", "i", []fold{{"\u017f", false}, {"\u212a", false}, {"Q", true}}},
		{"[^a-z]", "i", []fold{{"\u017f", true}, {"Q", false}, {"1", true}}},
		{"\\W", "i", []fold{{"\u017f", true}, {"a", false}}},
		{"\u00e5", "i", []fold{{"\u212b", false}, {"\u00c5", true}}},
		{"\u00df", "i", []fold{{"\u1e9e", false}, {"\u00df", true}, {"SS", false}}},
		{"suscr[i\u00ed]b", "i", []fold{{"SUSCR\u00cdBETE", true}, {"Suscribe", true}, {"suscr\u0131be", false}}},
		{"(?<word>abc)", "i", []fold{{"xABCx", true}, {"ab", false}}},
		{"\\x41", "i", []fold{{"a", true}, {"b", false}}},
		{"\\u00e9", "i", []fold{{"\u00c9", true}, {"e", false}}},
		{"^[\\w-]+$", "i", []fold{{"\u017f-", false}, {"ab-c", true}}},
		{"\u00b5", "i", []fold{{"\u03bc", true}, {"\u039c", true}}},
		{"\u01c5", "i", []fold{{"\u01c4", true}, {"\u01c6", true}}},
		{"\u0131", "i", []fold{{"I", false}, {"i", false}}},
		{"i", "i", []fold{{"\u0130", false}, {"\u0131", false}, {"I", true}}},
		{"\\bhost\\b", "i", []fold{{"HOST", true}, {"ho\u017ft", false}}},
		{"[\u03ac-\u03ce]", "i", []fold{{"\u0386", true}, {"\u038f", true}, {"\u03a3", true}}},
		{"\u1f80", "i", []fold{{"\u1f88", false}, {"\u1f80", true}}},
		{"\u03c3", "i", []fold{{"\u03c2", true}, {"\u03a3", true}}},
		{"[^\\s]", "i", []fold{{" ", false}, {"\u212a", true}}},
		{"\\S", "i", []fold{{"\u212a", true}}},
		{"caf\u00e9", "i", []fold{{"CAF\u00c9", true}}},
		{"\u00ff", "i", []fold{{"\u0178", true}}},
		{"\u0390", "i", []fold{{"\u1fd3", false}}},
	} {
		re := jsRegexp(c.source, c.flags)
		for _, s := range c.subjects {
			if got := re.MatchString(s.subject); got != s.want {
				t.Errorf("/%s/%s on %q: %v, JavaScript %v (as %s)", c.source, c.flags, s.subject, got, s.want, re)
			}
		}
	}
}

// The matchers that stand in for regexps agree with them (the gates are
// necessary conditions) on every text of the fixture pages (and of the eval
// corpus when test-corpus/ is present), and on edge cases.
func TestFastMatchersAgreeWithRegexps(t *testing.T) {
	texts := []string{"", "Author", "co-author", "AUTHORS", "an author.", "authorship", "host_x", "Keynote host", "hoſt", "Freelancer", "freelance", "freelancers", "_writer", "writer_", "9writer", "écrivain writer", "Sign up for our newsletter", "BOLETÍN", "Téléchargez", "follow us", "×", "Ad", "  ad"}
	pages, _ := filepath.Glob(fixtures + "pages/*.html")
	corpus, _ := filepath.Glob(filepath.Join(parityDir(), "html", "*.html")) // when test-corpus/ is present
	seen := map[string]bool{}
	seenStyle := map[string]bool{}
	srcs := []string{"https://secure.GRAVATAR.com/avatar/x", "/u/avatars/1.png", "/avatar", "/avatarsx/"}
	styles := []string{"display:none", " DISPLAY : NONE", "color:red;display:\u00a0none", "a;visibility:hidden", "xdisplay:none", "display:nonesuch", "display: block; visibility :hidden", "display", "display:", "visibility:hidde"}
	for _, f := range append(pages, corpus...) {
		raw, _ := os.ReadFile(f)
		var visit func(n *Node)
		visit = func(n *Node) {
			if style, ok := n.attr("style"); ok && !seenStyle[style] {
				seenStyle[style] = true
				styles = append(styles, style)
			}
			if src, ok := n.attr("src"); ok && !seenStyle[src] {
				seenStyle[src] = true
				srcs = append(srcs, src)
			}
			// The engine tests short texts (paragraph heads, lines, sources).
			if n.Kind == TextNode && len(n.text) < 600 && !seen[n.text] {
				seen[n.text] = true
				texts = append(texts, n.text, collapse(n.text))
			}
			for _, c := range n.Children {
				visit(c)
			}
		}
		visit(ParseHTML(string(raw)))
	}
	if len(texts) < 1000 {
		t.Fatalf("only %d texts", len(texts))
	}
	hidden := jsRegexp(`(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)`, "i")
	for _, s := range styles {
		if got, want := isHiddenStyle(s), hidden.MatchString(s); got != want {
			t.Errorf("isHiddenStyle(%q): %v, regexp %v", s, got, want)
		}
	}
	avatar := jsRegexp(`gravatar\.com\/avatar|\/avatars?\/`, "i")
	for _, s := range srcs {
		if got, want := avatarSrc.open(s), avatar.MatchString(s); got != want {
			t.Errorf("avatarSrc on %q: %v, regexp %v", s, got, want)
		}
	}
	role := jsRegexp(bioRoleSource, "i")
	for _, s := range texts {
		if got, want := bioRole.match(s), role.MatchString(s); got != want {
			t.Errorf("bioRole on %q: %v, regexp %v", s, got, want)
		}
		for _, g := range []struct {
			name string
			open bool
			re   *regexp.Regexp
		}{
			{"callToAction", callToActionGate.open(s), callToAction},
			{"promo", promoGate.open(s), promo},
			{"promoLine", promoGate.open(s), promoLine},
			{"uiText", uiTextGate.open(s), uiText},
			{"trackingPixel", trackingPixelGate.open(s), trackingPixel},
		} {
			if !g.open && g.re.MatchString(s) {
				t.Errorf("%s gate closed on %q, which the pattern matches", g.name, s)
			}
		}
	}
}

// u16len against the rune count it shortcuts, on valid and invalid UTF-8.
func TestU16Len(t *testing.T) {
	ref := func(s string) int {
		n := len(s)
		for i := 0; i < len(s); i++ {
			switch c := s[i]; {
			case c >= 0xe0:
				n -= 2
			case c >= 0xc0:
				n--
			}
		}
		return n
	}
	pieces := []string{"a", "é", "€", "😀", "\xff", "\x80", "\xc3", " ", "abcdefgh", "ñandú", "\U0010ffff"}
	seed := uint32(1)
	for k := 0; k < 20000; k++ {
		var b []byte
		for j := 0; j < int(seed%40); j++ {
			seed = seed*1664525 + 1013904223
			b = append(b, pieces[seed>>16%uint32(len(pieces))]...)
		}
		seed = seed*1664525 + 1013904223
		if s := string(b); u16len(s) != ref(s) {
			t.Fatalf("u16len(%q) = %d, want %d", s, u16len(s), ref(s))
		}
	}
}

// collapseHTMLSpace against the plain byte loop.
func TestCollapseHTMLSpace(t *testing.T) {
	ref := func(s string) string {
		var b []byte
		for i := 0; i < len(s); i++ {
			if isHTMLSpace(s[i]) {
				b = append(b, ' ')
				for i+1 < len(s) && isHTMLSpace(s[i+1]) {
					i++
				}
				continue
			}
			b = append(b, s[i])
		}
		return string(b)
	}
	pieces := []string{"a", " ", "  ", "\n", "\t", "\r", "\f", "\v", "\x00", "\x1f", "é", "abcdefg", "!", "\x7f", "\xa0"}
	seed := uint32(7)
	for k := 0; k < 50000; k++ {
		var b []byte
		for j := 0; j < int(seed%30); j++ {
			seed = seed*1664525 + 1013904223
			b = append(b, pieces[seed>>16%uint32(len(pieces))]...)
		}
		seed = seed*1664525 + 1013904223
		if s := string(b); collapseHTMLSpace(s) != ref(s) {
			t.Fatalf("collapseHTMLSpace(%q) = %q, want %q", s, collapseHTMLSpace(s), ref(s))
		}
	}
}
