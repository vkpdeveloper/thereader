# Cost of the Markdown export

Generated 2026-10-06T19:15:28.219Z by `bun run markdown-cost` (see [eval/README.md](../README.md)): `extract(doc, { url })` and `extract(doc, { url, markdown: true })` on each of 326 pages (zyte + curated) in headless Chromium, in the same renderer, alternating which runs first, 21 runs each after one warm-up; a fresh `DOMParser` document per run, parsing not timed. Milliseconds, over the per-page medians.

Machine: darwin 27.0.0, Apple M5 x10, load avg at start 1.9 1.9 1.9, at end 5.0 2.6 2.1, 4 workers.

| extract | median | p90 | p95 | mean |
| --- | ---: | ---: | ---: | ---: |
| without markdown | 1.020 | 4.845 | 10.105 | 2.787 |
| markdown: true | 1.048 | 4.965 | 10.555 | 2.921 |
| per-page difference | 0.030 | 0.165 | 0.395 | 0.134 |

Per-page difference as a share of extraction: median 2.9%, p90 6.7%.

Largest per-page differences:

| page | without | with |
| --- | ---: | ---: |
| curated/frwiki-paris | 69.405 | 74.305 |
| curated/ruwiki-moscow | 35.620 | 38.915 |
| curated/wiki-tokyo | 31.305 | 34.430 |
| curated/whatwg-parsing | 31.320 | 33.925 |
| curated/node-fs | 37.700 | 40.245 |
