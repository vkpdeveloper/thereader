# Article extraction eval results

Generated 2026-10-06T04:00:58.487Z by `bun run eval` (see [eval/README.md](README.md)). Scores are re-derived from the stored outputs on every run.

## Engines

| engine | version | runtime | settings | ran at |
| --- | ---: | ---: | ---: | ---: |
| ours | 0009aa3 | Chromium DOMParser | extract(doc, { url }); text = articleText(article) | 2026-10-06 04:00 |
| ours-dart | 0009aa3 | Dart 3.13.4 AOT, package:html 0.15.7, one process | package:html parse, then extractTree(fromDocument(doc), url) (base href added as for Chromium); text = articleText(article) | 2026-10-06 04:00 |
| readability | 0.6.0 | Chromium DOMParser | new Readability(doc).parse() defaults; text from content HTML | 2026-10-06 04:00 |
| defuddle | 0.19.4 | Chromium DOMParser | new Defuddle(doc, { url }).parse(), core bundle defaults; text from content HTML | 2026-10-06 04:00 |
| trafilatura | 2.3.0 | CPython 3.12 + lxml | extract(tree, url, include_comments=False), txt output; stats from xml output | 2026-10-06 04:00 |
| postlight | 2.2.3 | Node v22.22.2 | Parser.parse(url, { html, fetchAllPages: false }); text from content HTML | 2026-10-06 04:00 |

Machine: os darwin 27.0.0, cpu Apple M5 x10, chromium 153.0.8010.12, bun 1.4.0, load avg at start 3.9 4.2 5.9, load avg at end 5.2 4.6 5.9.

## Zyte article-extraction-benchmark (181 pages, scrapinghub/article-extraction-benchmark@4a3bc97)

Official metric: 4-token shingle precision/recall per page, averaged; F1 from the averages; accuracy = exact token match. ± is the bootstrap std (1000 resamples), CI the 95% percentile interval of F1.

| engine | F1 | F1 95% CI | precision | recall | accuracy | failed | empty | median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 1.64 |
| ours-dart | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 3.17 |
| readability | **0.952** ± 0.005 | 0.943–0.961 | 0.918 ± 0.008 | 0.988 ± 0.003 | 0.177 ± 0.028 | 0 | 0 | 1.84 |
| defuddle | **0.932** ± 0.010 | 0.911–0.951 | 0.899 ± 0.012 | 0.968 ± 0.010 | 0.171 ± 0.028 | 0 | 0 | 7.95 |
| trafilatura | **0.955** ± 0.007 | 0.940–0.968 | 0.938 ± 0.009 | 0.974 ± 0.008 | 0.293 ± 0.033 | 0 | 0 | 7.09 |
| postlight | **0.920** ± 0.014 | 0.892–0.945 | 0.901 ± 0.014 | 0.940 ± 0.014 | 0.265 ± 0.032 | 0 | 0 | 10.8 |

### Metric sanity check

Our TypeScript port of `evaluate.py` re-scoring the benchmark's own committed outputs, against its README table:

| output file | version | published F1 / P / R / acc | ours F1 / P / R / acc | max abs diff |
| --- | ---: | ---: | ---: | ---: |
| output/readability_js.json | 0.6.0 | 0.947 / 0.914 / 0.982 / 0.166 | 0.947 / 0.914 / 0.982 / 0.166 | 0.000 |
| output/trafilatura.json | 2.0.0 | 0.958 / 0.938 / 0.978 / 0.293 | 0.958 / 0.938 / 0.978 / 0.293 | 0.000 |
| output/html-text.json | 0.7.0 | 0.665 / 0.500 / 0.994 / 0.000 | 0.665 / 0.500 / 0.994 / 0.000 | 0.000 |

## Curated live corpus (145 annotated pages with snapshots, of 145 entries; 0 jsOnly scored separately; 16 URLs blocked at fetch time, see corpus/blocked.json)

Combined score per page = weighted mean of mustInclude recall (0.5), 1 − mustExclude leak rate (0.2; 0 for empty output; dropped for the few pages with no boilerplate text), fuzzy title match (0.1) and structure checks passed (0.2; dropped when a page has no structure expectations).

| engine | pages | include recall | leak rate | pages leaking | title exact | title fuzzy | structure | code langs | combined | empty | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 145 | 99.8% | 2.1% | 4.9% | 95.9% | 98.6% | 95.4% | 96.7% | **0.987** | 0 | 0 |
| ours-dart | 145 | 99.8% | 2.1% | 4.9% | 95.9% | 98.6% | 95.4% | 96.7% | **0.987** | 0 | 0 |
| readability | 145 | 96.8% | 7.4% | 16.1% | 69.0% | 89.7% | 73.2% | 10.9% | **0.908** | 0 | 0 |
| defuddle | 145 | 98.5% | 8.3% | 21.7% | 74.5% | 86.9% | 87.2% | 47.1% | **0.940** | 0 | 0 |
| trafilatura | 145 | 95.8% | 7.0% | 18.2% | 55.2% | 83.5% | 42.6% | 0.0% | **0.837** | 0 | 0 |
| postlight | 145 | 92.6% | 5.9% | 14.7% | 64.8% | 85.5% | 62.6% | 34.8% | **0.866** | 1 | 0 |

### Structure checks (pages passing / pages with the expectation)

| engine | code | languages | images | headings | tables | math | footnotes | embeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| ours-dart | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| readability | 57/60 | 5/46 | 75/85 | 88/107 | 28/31 | 4/8 | 7/20 | 4/9 |
| defuddle | 57/60 | 20/46 | 82/85 | 103/107 | 30/31 | 8/8 | 11/20 | 8/9 |
| trafilatura | 38/60 | 0/46 | 0/85 | 91/107 | 27/31 | 0/8 | 0/20 | 0/9 |
| postlight | 53/60 | 16/46 | 77/85 | 41/107 | 25/31 | 5/8 | 8/20 | 4/9 |

### Combined score by tier

| engine | tier 1 (9) | tier 2 (20) | tier 3 (70) | tier 4 (35) | tier 5 (11) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 0.986 | 0.992 | 0.986 | 0.994 | 0.959 |
| ours-dart | 0.986 | 0.992 | 0.986 | 0.994 | 0.959 |
| readability | 0.881 | 0.908 | 0.917 | 0.899 | 0.904 |
| defuddle | 0.895 | 0.912 | 0.955 | 0.943 | 0.922 |
| trafilatura | 0.835 | 0.826 | 0.853 | 0.816 | 0.813 |
| postlight | 0.859 | 0.850 | 0.888 | 0.864 | 0.764 |

### Combined score by category

| engine | academic (7) | boilerplate (7) | docs (28) | interactive (2) | news (19) | non-english (29) | reference (5) | simple-blog (14) | tech-blog (34) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 0.962 | 0.988 | 0.993 | 1.000 | 0.995 | 0.982 | 0.980 | 0.986 | 0.986 |
| ours-dart | 0.962 | 0.988 | 0.993 | 1.000 | 0.995 | 0.982 | 0.980 | 0.986 | 0.986 |
| readability | 0.929 | 0.871 | 0.874 | 0.938 | 0.911 | 0.932 | 0.899 | 0.917 | 0.913 |
| defuddle | 0.942 | 0.909 | 0.915 | 0.938 | 0.969 | 0.955 | 0.960 | 0.923 | 0.940 |
| trafilatura | 0.824 | 0.800 | 0.849 | 0.938 | 0.840 | 0.852 | 0.835 | 0.829 | 0.818 |
| postlight | 0.797 | 0.762 | 0.832 | 0.938 | 0.899 | 0.886 | 0.865 | 0.878 | 0.883 |

## Performance (all scored pages, per-page median of the timed runs)

JS engines run in headless Chromium on a fresh `DOMParser` document per run; ours-dart (the Dart port, AOT-compiled, one process) parses with package:html, timed separately from extraction; Trafilatura in CPython (lxml parse timed separately); Postlight in Node (cheerio parse is internal, so only the total is timed). Cross-runtime numbers are indicative; the three Chromium engines are directly comparable.

| engine | pages | parse median | extract median | extract p95 | extract mean | total median | total p95 | total mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 326 | 0.88 | 1.23 | 10.2 | 3.00 | 2.25 | 15.0 | 4.76 |
| ours-dart | 326 | 2.74 | 1.05 | 15.5 | 3.60 | 4.15 | 30.3 | 9.69 |
| readability | 326 | 0.84 | 1.77 | 16.6 | 5.02 | 2.78 | 19.2 | 6.78 |
| defuddle | 326 | 0.96 | 9.19 | 59.6 | 20.8 | 10.4 | 61.6 | 22.6 |
| trafilatura | 326 | 1.21 | 7.36 | 80.9 | 25.0 | 8.98 | 83.4 | 27.6 |
| postlight | 326 | – | 15.1 | 163.1 | 40.6 | 15.1 | 163.1 | 40.6 |

### Total ms by HTML size (median / p95)

| engine | <50KB (35) | 50-200KB (176) | 200-500KB (76) | 0.5-1MB (21) | >1MB (18) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 1.11 / 3.75 | 1.78 / 5.68 | 3.24 / 9.61 | 6.08 / 18.8 | 30.5 / 93.3 |
| ours-dart | 1.58 / 10.2 | 3.21 / 9.67 | 6.36 / 17.8 | 10.9 / 34.7 | 71.7 / 297.2 |
| readability | 1.32 / 3.35 | 2.02 / 7.07 | 4.68 / 15.2 | 8.38 / 22.6 | 52.6 / 181.6 |
| defuddle | 5.45 / 16.3 | 8.40 / 27.1 | 12.7 / 47.1 | 24.9 / 76.5 | 145.7 / 567.2 |
| trafilatura | 4.85 / 13.4 | 7.63 / 29.6 | 12.1 / 66.5 | 23.2 / 189.6 | 258.9 / 770.3 |
| postlight | 7.35 / 28.8 | 12.3 / 45.1 | 23.0 / 112.3 | 33.1 / 163.4 | 306.1 / 834.3 |
