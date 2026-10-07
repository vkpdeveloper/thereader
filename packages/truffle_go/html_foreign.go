// Copyright 2011 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Element categories, foreign content adjustments and the doctype's quirks
// test for the HTML parser, forked from golang.org/x/net/html (foreign.go,
// const.go, doctype.go) onto atoms.

package truffle

import "strings"

// isSpecialElement: the "special" category of 13.2.4.3 (x/net's list: with
// keygen, without search).
func isSpecialElement(n *Node) bool {
	switch n.ns {
	case nsHTML:
		return specialHTML[n.atom]
	case nsMathML:
		switch n.atom {
		case aMi, aMo, aMn, aMs, aMtext, aAnnotationXml:
			return true
		}
	case nsSVG:
		switch n.atom {
		case aForeignObject, aDesc, aTitle:
			return true
		}
	}
	return false
}

func htmlIntegrationPoint(n *Node) bool {
	switch n.ns {
	case nsMathML:
		if n.atom == aAnnotationXml {
			for _, a := range n.Attrs {
				if a.Name == "encoding" {
					if strings.EqualFold(a.Value, "text/html") || strings.EqualFold(a.Value, "application/xhtml+xml") {
						return true
					}
				}
			}
		}
	case nsSVG:
		switch n.atom {
		case aDesc, aForeignObject, aTitle:
			return true
		}
	}
	return false
}

func mathMLTextIntegrationPoint(n *Node) bool {
	if n.ns != nsMathML {
		return false
	}
	switch n.atom {
	case aMi, aMo, aMn, aMs, aMtext:
		return true
	}
	return false
}

// breakout reports whether a start tag leaves foreign content (13.2.6.5).
func breakout(a atom) bool {
	switch a {
	case aB, aBig, aBlockquote, aBody, aBr, aCenter, aCode, aDd, aDiv, aDl, aDt, aEm, aEmbed,
		aH1, aH2, aH3, aH4, aH5, aH6, aHead, aHr, aI, aImg, aLi, aListing, aMenu, aMeta, aNobr,
		aOl, aP, aPre, aRuby, aS, aSmall, aSpan, aStrong, aStrike, aSub, aSup, aTable, aTt, aU,
		aUl, aVar:
		return true
	}
	return false
}

// adjustAttributeNames applies the SVG or MathML attribute name case fixes
// ("viewbox" becomes "viewBox"). Foreign attributes (xlink:href, xml:lang,
// xmlns:xlink) only change namespace, which the DOM's attr.name does not show.
func adjustAttributeNames(attrs []Attr, ns uint8) {
	table := &svgAttrFix
	if ns == nsMathML {
		table = &mathAttrFix
	}
	for i := range attrs {
		if a := lookupAtom(attrs[i].Name); a != 0 {
			if fixed := table[a]; fixed != 0 {
				attrs[i].Name = atomNames[fixed]
			}
		}
	}
}

// newDoctype returns the doctype node for the current doctype token.
func (p *parser) newDoctype() *Node {
	d := &p.doctype
	n := p.newNode()
	n.Kind = DoctypeNode
	n.text = d.name
	n.visLen = -1
	var attrs [2]Attr
	k := 0
	if d.hasPublic {
		attrs[k] = Attr{"public", d.publicID}
		k++
	}
	if d.hasSystem {
		attrs[k] = Attr{"system", d.systemID}
		k++
	}
	n.Attrs = p.copyAttrs(attrs[:k])
	return n
}

// doctypeQuirks reports whether a doctype puts the document in quirks mode
// (13.2.6.4.1). Limited-quirks mode changes no tree construction rule.
func doctypeQuirks(d *doctypeData) bool {
	if d.forceQuirks || d.name != "html" {
		return true
	}
	if d.hasSystem && strings.EqualFold(d.systemID, "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd") {
		return true
	}
	if !d.hasPublic {
		return false
	}
	public := strings.ToLower(d.publicID)
	switch public {
	case "-//w3o//dtd w3 html strict 3.0//en//", "-/w3c/dtd html 4.0 transitional/en", "html":
		return true
	}
	for _, q := range quirkyIDs {
		if strings.HasPrefix(public, q) {
			return true
		}
	}
	return !d.hasSystem && (strings.HasPrefix(public, "-//w3c//dtd html 4.01 frameset//") ||
		strings.HasPrefix(public, "-//w3c//dtd html 4.01 transitional//"))
}

var quirkyIDs = []string{
	"+//silmaril//dtd html pro v0r11 19970101//",
	"-//advasoft ltd//dtd html 3.0 aswedit + extensions//",
	"-//as//dtd html 3.0 aswedit + extensions//",
	"-//ietf//dtd html 2.0 level 1//",
	"-//ietf//dtd html 2.0 level 2//",
	"-//ietf//dtd html 2.0 strict level 1//",
	"-//ietf//dtd html 2.0 strict level 2//",
	"-//ietf//dtd html 2.0 strict//",
	"-//ietf//dtd html 2.0//",
	"-//ietf//dtd html 2.1e//",
	"-//ietf//dtd html 3.0//",
	"-//ietf//dtd html 3.2 final//",
	"-//ietf//dtd html 3.2//",
	"-//ietf//dtd html 3//",
	"-//ietf//dtd html level 0//",
	"-//ietf//dtd html level 1//",
	"-//ietf//dtd html level 2//",
	"-//ietf//dtd html level 3//",
	"-//ietf//dtd html strict level 0//",
	"-//ietf//dtd html strict level 1//",
	"-//ietf//dtd html strict level 2//",
	"-//ietf//dtd html strict level 3//",
	"-//ietf//dtd html strict//",
	"-//ietf//dtd html//",
	"-//metrius//dtd metrius presentational//",
	"-//microsoft//dtd internet explorer 2.0 html strict//",
	"-//microsoft//dtd internet explorer 2.0 html//",
	"-//microsoft//dtd internet explorer 2.0 tables//",
	"-//microsoft//dtd internet explorer 3.0 html strict//",
	"-//microsoft//dtd internet explorer 3.0 html//",
	"-//microsoft//dtd internet explorer 3.0 tables//",
	"-//netscape comm. corp.//dtd html//",
	"-//netscape comm. corp.//dtd strict html//",
	"-//o'reilly and associates//dtd html 2.0//",
	"-//o'reilly and associates//dtd html extended 1.0//",
	"-//o'reilly and associates//dtd html extended relaxed 1.0//",
	"-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
	"-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//",
	"-//spyglass//dtd html 2.0 extended//",
	"-//sq//dtd html 2.0 hotmetal + extensions//",
	"-//sun microsystems corp.//dtd hotjava html//",
	"-//sun microsystems corp.//dtd hotjava strict html//",
	"-//w3c//dtd html 3 1995-03-24//",
	"-//w3c//dtd html 3.2 draft//",
	"-//w3c//dtd html 3.2 final//",
	"-//w3c//dtd html 3.2//",
	"-//w3c//dtd html 3.2s draft//",
	"-//w3c//dtd html 4.0 frameset//",
	"-//w3c//dtd html 4.0 transitional//",
	"-//w3c//dtd html experimental 19960712//",
	"-//w3c//dtd html experimental 970421//",
	"-//w3c//dtd w3 html//",
	"-//w3o//dtd w3 html 3.0//",
	"-//webtechs//dtd mozilla html 2.0//",
	"-//webtechs//dtd mozilla html//",
}
