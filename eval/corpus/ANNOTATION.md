# Curated corpus annotation guide

You are producing GROUND TRUTH for an article-extraction benchmark. An extractor
(Readability-like "reader view") receives the raw HTML of each page and must output
the article body. Your annotations decide what counts as a hit or a leak, so be
careful, conservative and honest. Never guess: everything must come from the snapshot.

Repo:
  the repository root (`<repo>`)
Snapshots (raw HTML as fetched): `<repo>/test-corpus/live/<id>.html` (+ `<id>.json` meta with finalUrl)

## Tools (run from `<repo>/eval`)

- `bun run dump <id> [<id> ...] > /tmp/<id>.txt`
  Prints the page `<title>`, og:title, h1s, then every text block of the page in
  document order as `[n] <dom path> text`. Long blocks are truncated at 400 chars;
  add `--full` for full text, or `--grep "some words"` to see only matching blocks.
  The DOM path (ids/classes such as `article.post-content`, `footer`, `nav`,
  `aside.related`, `div.comments`) is how you tell article from boilerplate.
- `bun run validate --file annotations.json` (or `--ids id,id` after editing curated.json)
  Checks every snippet occurs in the page text (normalized: case, whitespace,
  curly quotes/dashes are ignored). Must end with `0 errors`. Fix warnings when reasonable.
- You may also look at the raw HTML with grep/sed (e.g. count `<pre`, `<figure`,
  `<table`, `<math`, `class="footnote`, `<iframe` inside the article container).
- You may use web_fetch / browser to look at the live page, but annotations must
  match the SNAPSHOT (the validator only knows the snapshot).

## Output

Each entry in `eval/corpus/curated.json` is one object, keeping the existing `id`, `url`, `tier`,
`category`, `language`, `notes` fields and adding:

```jsonc
{
  "id": "...", "url": "...", "tier": 3, "category": "tech-blog", "language": "en",
  "notes": "<original notes>; <your short observations>",
  "title": "Expected article title exactly as the headline shows it (no ' | Site' suffix)",
  "mustInclude": ["4-6 verbatim snippets"],
  "mustExclude": ["3-5 verbatim boilerplate snippets"],
  "minCodeBlocks": 3,            // only when the article has code blocks
  "codeLanguages": ["python"],    // only when languages are clear
  "minImages": 2,                 // only content images
  "minHeadings": 4,               // only when the article has section headings
  "minTables": 1,                 // only data tables
  "hasMath": true,                // only when true
  "hasFootnotes": true,           // only when true
  "hasEmbeds": true,              // only when true
  "jsOnly": true,                 // only when the article body is NOT in the raw HTML
  "annotationConfidence": "high"  // high | medium | low
}
```
Omit structure fields that do not apply (do not write `false` or `0`).
You may correct `tier` (1 trivial clean page .. 5 brutal) or `category` if clearly wrong; say so in notes.

## What is the article body?

IN: the body text after the headline: standfirst/dek if it is part of the article,
paragraphs, section headings, lists, blockquotes, code blocks, tables, figure
captions, footnotes/endnotes/sidenotes, a recipe's ingredients and steps, a gallery's captions,
a docs page's main content (its admonitions/notes/tabs content).

OUT (boilerplate): site header and nav menus, breadcrumbs, sidebars, table-of-contents
widgets, "related"/"more stories"/"recommended", newsletter/subscribe boxes,
donation appeals, share buttons, tag lists, comments and comment forms, author bio
boxes, cookie/consent banners, ads, "edit this page", previous/next page links,
footer (copyright, legal, links), search boxes, login prompts.

NEUTRAL (never use in either list): byline, dates, reading time, the title itself,
image credits outside captions, Wikipedia reference lists, a recipe's nutrition box.

## mustInclude rules (4-6 snippets)

- Verbatim text copied from the dump, 8-20 words (CJK: 15-60 characters), each
  entirely inside ONE block (one paragraph / list item). Prefer prose paragraphs.
- Spread across the article: 1 from the first body paragraph, 1-3 from the middle,
  and 1 from the VERY LAST paragraph of the main text (before footnotes, bios,
  comments). Find the end of the article carefully: it is the last block before the
  boilerplate starts. If the article has footnotes you may add one footnote snippet.
- Avoid code text, footnote markers like `[1]`, text that also appears in a
  "related"/teaser box or meta description only, and text with odd inline spacing.

## mustExclude rules (3-5 snippets)

- Verbatim boilerplate text that IS in the page text but is NOT the article,
  each at least 3-4 words / 15+ characters and specific to boilerplate (it must not
  occur anywhere in the article body). Good picks: footer copyright line, newsletter
  pitch sentence, a related-article headline, a comment's text, cookie banner sentence,
  "Edit this page on GitHub", nav menu label sequence that sits in one block.
- Mix kinds (nav, footer, related, comments...) when the page has them.

## Structure fields

Count inside the article only and be conservative (a perfect extractor must reach
the minimum): code blocks = `<pre>` blocks; images = real content images (figures,
photos, diagrams), not logos/avatars/ads/icons; headings = h2-h6 section headings in
the article; tables = data tables (not layout tables like Paul Graham's).
`codeLanguages`: canonical lowercase ids (javascript, typescript, python, bash, rust,
go, c, cpp, csharp, java, ruby, css, html, json, yaml, toml, sql, ...) only for
languages you are sure about from markup classes (`language-xxx`) or obvious content;
list the main ones (not every one-off).

## Special cases

- If the article text is not in the raw HTML (JS-rendered shell): set `jsOnly: true`,
  take title/mustExclude from the snapshot when possible and mustInclude from the live
  page (web_fetch), confidence medium/low, and explain in notes.
- If the snapshot is not an article at all (error page, captcha, consent wall,
  paywall stub with only a teaser): still write the entry with what you can and put
  `"NOT-ARTICLE: <reason>"` at the start of notes; the lead will decide.
- Paywalled/teaser pages where only part of the article is in the HTML: annotate only
  what is in the HTML and say so in notes.
- Use `annotationConfidence` honestly: `medium`/`low` when the article boundary is
  ambiguous (hubs, docs with tabs, galleries, Wikipedia infobox, etc.).
