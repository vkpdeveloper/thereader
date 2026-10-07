# Article extraction eval results

Generated 2026-10-07T04:07:43.091Z by `bun run eval` (see [eval/README.md](README.md)). Scores are re-derived from the stored outputs on every run.

## Engines

| engine | version | runtime | settings | ran at |
| --- | ---: | ---: | ---: | ---: |
| ours | bc0dae3 | Chromium DOMParser | extract(doc, { url }); text = articleText(article) | 2026-10-07 04:07 |
| ours-md | bc0dae3 | Chromium DOMParser | extract(doc, { url, markdown: true }) (timed); text and stats from article.markdown rendered by remark (GFM + math) and mdast-util-to-hast | 2026-10-07 04:07 |
| ours-dart | bc0dae3 | Dart 3.13.5 AOT, package:html 0.15.7, one process | package:html parse, then extractTree(fromDocument(doc), url) (base href added as for Chromium); text = articleText(article) | 2026-10-07 04:07 |
| ours-go | bc0dae3 | Go 1.24.7 native (PGO), own HTML5 parser, one process | ParseDocument(html), then ExtractTree(doc, { URL }) (base href added as for Chromium); text = articleText(article) | 2026-10-07 04:07 |
| readability | 0.6.0 | Chromium DOMParser | new Readability(doc).parse() defaults; text from content HTML | 2026-10-07 04:07 |
| defuddle | 0.19.4 | Chromium DOMParser | new Defuddle(doc, { url }).parse(), core bundle defaults; text from content HTML | 2026-10-07 04:07 |
| trafilatura | 2.3.0 | CPython 3.12 + lxml | extract(tree, url, include_comments=False), txt output; stats from xml output | 2026-10-07 04:07 |
| postlight | 2.2.3 | Node v22.22.0 | Parser.parse(url, { html, fetchAllPages: false }); text from content HTML | 2026-10-07 04:07 |

Machine: os linux 6.18.44-fc-v77, cpu Intel(R) Xeon(R) Processor @ 2.30GHz x4, chromium 153.0.8010.12, bun 1.4.2, load avg at start 0.1 1.0 0.9, load avg at end 3.5 2.2 1.4.

## Zyte article-extraction-benchmark (181 pages, scrapinghub/article-extraction-benchmark@4a3bc97)

Official metric: 4-token shingle precision/recall per page, averaged; F1 from the averages; accuracy = exact token match. ± is the bootstrap std (1000 resamples), CI the 95% percentile interval of F1.

| engine | F1 | F1 95% CI | precision | recall | accuracy | failed | empty | median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 4.37 |
| ours-md | **0.966** ± 0.003 | 0.960–0.972 | 0.948 ± 0.005 | 0.986 ± 0.003 | 0.265 ± 0.033 | 0 | 0 | 4.54 |
| ours-dart | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 6.71 |
| ours-go | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 0.71 |
| readability | **0.952** ± 0.005 | 0.943–0.961 | 0.918 ± 0.008 | 0.988 ± 0.003 | 0.177 ± 0.028 | 0 | 0 | 5.60 |
| defuddle | **0.932** ± 0.010 | 0.911–0.951 | 0.899 ± 0.012 | 0.968 ± 0.010 | 0.171 ± 0.028 | 0 | 0 | 17.1 |
| trafilatura | **0.955** ± 0.007 | 0.940–0.968 | 0.938 ± 0.009 | 0.974 ± 0.008 | 0.293 ± 0.033 | 0 | 0 | 12.0 |
| postlight | **0.920** ± 0.014 | 0.892–0.945 | 0.901 ± 0.014 | 0.940 ± 0.014 | 0.265 ± 0.032 | 0 | 0 | 21.2 |

### Metric sanity check

Our TypeScript port of `evaluate.py` re-scoring the benchmark's own committed outputs, against its README table:

| output file | version | published F1 / P / R / acc | ours F1 / P / R / acc | max abs diff |
| --- | ---: | ---: | ---: | ---: |
| output/readability_js.json | 0.6.0 | 0.947 / 0.914 / 0.982 / 0.166 | 0.947 / 0.914 / 0.982 / 0.166 | 0.000 |
| output/trafilatura.json | 2.0.0 | 0.958 / 0.938 / 0.978 / 0.293 | 0.958 / 0.938 / 0.978 / 0.293 | 0.000 |
| output/html-text.json | 0.7.0 | 0.665 / 0.500 / 0.994 / 0.000 | 0.665 / 0.500 / 0.994 / 0.000 | 0.000 |

## Curated live corpus (144 annotated pages with snapshots, of 145 entries; 0 jsOnly scored separately; 16 URLs blocked at fetch time, see corpus/blocked.json)

Combined score per page = weighted mean of mustInclude recall (0.5), 1 − mustExclude leak rate (0.2; 0 for empty output; dropped for the few pages with no boilerplate text), fuzzy title match (0.1) and structure checks passed (0.2; dropped when a page has no structure expectations).

| engine | pages | include recall | leak rate | pages leaking | title exact | title fuzzy | structure | code langs | combined | empty | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 144 | 99.2% | 2.1% | 4.9% | 95.1% | 97.9% | 95.4% | 96.7% | **0.983** | 0 | 0 |
| ours-md | 144 | 99.2% | 2.1% | 4.9% | 95.1% | 97.9% | 92.6% | 96.7% | **0.979** | 0 | 0 |
| ours-dart | 144 | 99.2% | 2.1% | 4.9% | 95.1% | 97.9% | 95.4% | 96.7% | **0.983** | 0 | 0 |
| ours-go | 144 | 99.2% | 2.1% | 4.9% | 95.1% | 97.9% | 95.4% | 96.7% | **0.983** | 0 | 0 |
| readability | 144 | 96.4% | 7.1% | 16.2% | 68.8% | 88.9% | 73.2% | 10.9% | **0.906** | 0 | 0 |
| defuddle | 144 | 97.9% | 7.5% | 20.4% | 73.6% | 86.1% | 87.2% | 47.1% | **0.938** | 0 | 0 |
| trafilatura | 144 | 95.2% | 6.7% | 17.6% | 54.9% | 82.6% | 42.6% | 0.0% | **0.833** | 0 | 0 |
| postlight | 144 | 92.2% | 5.7% | 14.8% | 63.9% | 84.7% | 62.6% | 34.8% | **0.863** | 1 | 0 |

### Structure checks (pages passing / pages with the expectation)

| engine | code | languages | images | headings | tables | math | footnotes | embeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| ours-md | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 7/8 | 17/20 | 0/9 |
| ours-dart | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| ours-go | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| readability | 57/60 | 5/46 | 75/85 | 88/107 | 28/31 | 4/8 | 7/20 | 4/9 |
| defuddle | 57/60 | 20/46 | 82/85 | 103/107 | 30/31 | 8/8 | 11/20 | 8/9 |
| trafilatura | 38/60 | 0/46 | 0/85 | 91/107 | 27/31 | 0/8 | 0/20 | 0/9 |
| postlight | 53/60 | 16/46 | 77/85 | 41/107 | 25/31 | 5/8 | 8/20 | 4/9 |

### Combined score by tier

| engine | tier 1 (9) | tier 2 (20) | tier 3 (70) | tier 4 (34) | tier 5 (11) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 0.986 | 0.992 | 0.979 | 0.994 | 0.959 |
| ours-md | 0.986 | 0.989 | 0.972 | 0.993 | 0.953 |
| ours-dart | 0.986 | 0.992 | 0.979 | 0.994 | 0.959 |
| ours-go | 0.986 | 0.992 | 0.979 | 0.994 | 0.959 |
| readability | 0.881 | 0.908 | 0.913 | 0.896 | 0.909 |
| defuddle | 0.895 | 0.912 | 0.951 | 0.942 | 0.922 |
| trafilatura | 0.835 | 0.828 | 0.847 | 0.811 | 0.817 |
| postlight | 0.859 | 0.850 | 0.883 | 0.860 | 0.768 |

### Combined score by category

| engine | academic (7) | boilerplate (6) | docs (28) | interactive (2) | news (19) | non-english (29) | reference (5) | simple-blog (14) | tech-blog (34) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 0.962 | 0.986 | 0.993 | 1.000 | 0.979 | 0.977 | 0.980 | 0.986 | 0.986 |
| ours-md | 0.962 | 0.975 | 0.991 | 1.000 | 0.968 | 0.974 | 0.980 | 0.982 | 0.980 |
| ours-dart | 0.962 | 0.986 | 0.993 | 1.000 | 0.979 | 0.977 | 0.980 | 0.986 | 0.986 |
| ours-go | 0.962 | 0.986 | 0.993 | 1.000 | 0.979 | 0.977 | 0.980 | 0.986 | 0.986 |
| readability | 0.929 | 0.850 | 0.874 | 0.938 | 0.901 | 0.930 | 0.909 | 0.917 | 0.912 |
| defuddle | 0.942 | 0.902 | 0.915 | 0.938 | 0.956 | 0.952 | 0.960 | 0.923 | 0.943 |
| trafilatura | 0.824 | 0.767 | 0.851 | 0.938 | 0.824 | 0.846 | 0.845 | 0.829 | 0.818 |
| postlight | 0.797 | 0.723 | 0.832 | 0.938 | 0.889 | 0.880 | 0.875 | 0.878 | 0.883 |

## Performance (all scored pages, per-page median of the timed runs)

JS engines run in headless Chromium on a fresh `DOMParser` document per run; ours-dart (the Dart port, AOT-compiled, one process) parses with package:html, timed separately from extraction; ours-go (the Go port, native binary, one process) parses with its own HTML5 parser, timed the same way; Trafilatura in CPython (lxml parse timed separately); Postlight in Node (cheerio parse is internal, so only the total is timed). Cross-runtime numbers are indicative; the Chromium engines are directly comparable. ours-md is ours with `markdown: true`; its cost measured alternately on each page is in [results/markdown-cost.md](results/markdown-cost.md) (`bun run markdown-cost`).

| engine | pages | parse median | extract median | extract p95 | extract mean | total median | total p95 | total mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 325 | 2.38 | 2.50 | 17.0 | 5.80 | 5.33 | 34.0 | 10.8 |
| ours-md | 325 | 2.42 | 2.58 | 17.8 | 5.76 | 5.28 | 30.7 | 10.7 |
| ours-dart | 325 | 6.26 | 1.93 | 18.0 | 5.34 | 8.69 | 47.3 | 19.0 |
| ours-go | 325 | 0.30 | 0.60 | 4.64 | 1.57 | 0.97 | 7.47 | 2.24 |
| readability | 325 | 2.21 | 4.22 | 35.8 | 12.8 | 7.07 | 48.8 | 17.6 |
| defuddle | 325 | 2.33 | 17.5 | 102.9 | 40.4 | 20.5 | 111.8 | 45.5 |
| trafilatura | 325 | 1.75 | 12.4 | 127.4 | 45.1 | 14.6 | 133.0 | 49.0 |
| postlight | 325 | – | 30.2 | 284.9 | 79.0 | 30.2 | 284.9 | 79.0 |

### Total ms by HTML size (median / p95)

| engine | <50KB (34) | 50-200KB (175) | 200-500KB (77) | 0.5-1MB (21) | >1MB (18) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 2.60 / 5.92 | 4.33 / 10.8 | 7.75 / 18.8 | 13.9 / 39.8 | 73.3 / 214.8 |
| ours-md | 2.52 / 7.30 | 4.53 / 13.5 | 7.88 / 20.1 | 15.4 / 41.4 | 69.0 / 212.3 |
| ours-dart | 2.87 / 8.02 | 6.63 / 17.6 | 15.8 / 37.0 | 25.9 / 84.0 | 124.7 / 374.6 |
| ours-go | 0.58 / 1.42 | 0.82 / 2.77 | 1.16 / 4.44 | 1.81 / 8.70 | 13.7 / 42.3 |
| readability | 3.48 / 6.33 | 5.46 / 16.8 | 10.3 / 39.0 | 21.5 / 51.9 | 123.4 / 477.2 |
| defuddle | 11.1 / 21.2 | 17.3 / 50.8 | 29.7 / 85.3 | 58.4 / 165.5 | 329.1 / 1114.4 |
| trafilatura | 8.26 / 20.3 | 12.6 / 50.5 | 18.9 / 86.8 | 41.2 / 242.6 | 476.8 / 1650.3 |
| postlight | 14.1 / 49.6 | 25.4 / 78.7 | 51.5 / 211.0 | 70.1 / 325.2 | 566.0 / 1474.5 |
