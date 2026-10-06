# Article extraction eval results

Generated 2026-10-06T02:23:06.050Z by `bun run eval` (see [eval/README.md](README.md)). Scores are re-derived from the stored outputs on every run.

## Engines

| engine | version | runtime | settings | ran at |
| --- | ---: | ---: | ---: | ---: |
| ours | ca3b2d1 | Chromium DOMParser | extract(doc, { url }); text = articleText(article) | 2026-10-06 02:23 |
| readability | 0.6.0 | Chromium DOMParser | new Readability(doc).parse() defaults; text from content HTML | 2026-10-06 00:14 |
| defuddle | 0.19.4 | Chromium DOMParser | new Defuddle(doc, { url }).parse(), core bundle defaults; text from content HTML | 2026-10-06 00:14 |
| trafilatura | 2.3.0 | CPython 3.12 + lxml | extract(tree, url, include_comments=False), txt output; stats from xml output | 2026-10-06 00:14 |
| postlight | 2.2.3 | Node v22.22.2 | Parser.parse(url, { html, fetchAllPages: false }); text from content HTML | 2026-10-06 00:14 |

Machine: os darwin 27.0.0, cpu Apple M5 x10, chromium 153.0.8010.12, bun 1.4.0, load avg at start 5.8 5.5 7.5, load avg at end 5.8 5.5 7.5.

## Zyte article-extraction-benchmark (181 pages, scrapinghub/article-extraction-benchmark@4a3bc97)

Official metric: 4-token shingle precision/recall per page, averaged; F1 from the averages; accuracy = exact token match. ± is the bootstrap std (1000 resamples), CI the 95% percentile interval of F1.

| engine | F1 | F1 95% CI | precision | recall | accuracy | failed | empty | median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | **0.977** ± 0.002 | 0.972–0.982 | 0.967 ± 0.004 | 0.987 ± 0.003 | 0.343 ± 0.035 | 0 | 0 | 2.15 |
| readability | **0.952** ± 0.005 | 0.943–0.961 | 0.918 ± 0.008 | 0.988 ± 0.003 | 0.177 ± 0.028 | 0 | 0 | 3.58 |
| defuddle | **0.932** ± 0.010 | 0.911–0.951 | 0.899 ± 0.012 | 0.968 ± 0.010 | 0.171 ± 0.028 | 0 | 0 | 15.0 |
| trafilatura | **0.955** ± 0.007 | 0.940–0.968 | 0.938 ± 0.009 | 0.974 ± 0.008 | 0.293 ± 0.033 | 0 | 0 | 14.6 |
| postlight | **0.920** ± 0.014 | 0.892–0.945 | 0.901 ± 0.014 | 0.940 ± 0.014 | 0.265 ± 0.032 | 0 | 0 | 24.2 |

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
| readability | 145 | 96.8% | 7.4% | 16.1% | 69.0% | 89.7% | 73.2% | 10.9% | **0.908** | 0 | 0 |
| defuddle | 145 | 98.5% | 8.3% | 21.7% | 74.5% | 86.9% | 87.2% | 47.1% | **0.940** | 0 | 0 |
| trafilatura | 145 | 95.8% | 7.0% | 18.2% | 55.2% | 83.5% | 42.6% | 0.0% | **0.837** | 0 | 0 |
| postlight | 145 | 92.6% | 5.9% | 14.7% | 64.8% | 85.5% | 62.6% | 34.8% | **0.866** | 1 | 0 |

### Structure checks (pages passing / pages with the expectation)

| engine | code | languages | images | headings | tables | math | footnotes | embeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 55/60 | 44/46 | 82/85 | 103/107 | 31/31 | 8/8 | 18/20 | 8/9 |
| readability | 57/60 | 5/46 | 75/85 | 88/107 | 28/31 | 4/8 | 7/20 | 4/9 |
| defuddle | 57/60 | 20/46 | 82/85 | 103/107 | 30/31 | 8/8 | 11/20 | 8/9 |
| trafilatura | 38/60 | 0/46 | 0/85 | 91/107 | 27/31 | 0/8 | 0/20 | 0/9 |
| postlight | 53/60 | 16/46 | 77/85 | 41/107 | 25/31 | 5/8 | 8/20 | 4/9 |

### Combined score by tier

| engine | tier 1 (9) | tier 2 (20) | tier 3 (70) | tier 4 (35) | tier 5 (11) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 0.986 | 0.992 | 0.986 | 0.994 | 0.959 |
| readability | 0.881 | 0.908 | 0.917 | 0.899 | 0.904 |
| defuddle | 0.895 | 0.912 | 0.955 | 0.943 | 0.922 |
| trafilatura | 0.835 | 0.826 | 0.853 | 0.816 | 0.813 |
| postlight | 0.859 | 0.850 | 0.888 | 0.864 | 0.764 |

### Combined score by category

| engine | academic (7) | boilerplate (7) | docs (28) | interactive (2) | news (19) | non-english (29) | reference (5) | simple-blog (14) | tech-blog (34) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 0.962 | 0.988 | 0.993 | 1.000 | 0.995 | 0.982 | 0.980 | 0.986 | 0.986 |
| readability | 0.929 | 0.871 | 0.874 | 0.938 | 0.911 | 0.932 | 0.899 | 0.917 | 0.913 |
| defuddle | 0.942 | 0.909 | 0.915 | 0.938 | 0.969 | 0.955 | 0.960 | 0.923 | 0.940 |
| trafilatura | 0.824 | 0.800 | 0.849 | 0.938 | 0.840 | 0.852 | 0.835 | 0.829 | 0.818 |
| postlight | 0.797 | 0.762 | 0.832 | 0.938 | 0.899 | 0.886 | 0.865 | 0.878 | 0.883 |

## Performance (all scored pages, per-page median of the timed runs)

JS engines run in headless Chromium on a fresh `DOMParser` document per run; Trafilatura in CPython (lxml parse timed separately); Postlight in Node (cheerio parse is internal, so only the total is timed). Cross-runtime numbers are indicative; the three Chromium engines are directly comparable.

| engine | pages | parse median | extract median | extract p95 | extract mean | total median | total p95 | total mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 326 | 1.18 | 1.73 | 15.2 | 4.57 | 3.04 | 22.1 | 7.22 |
| readability | 326 | 1.64 | 3.34 | 29.1 | 9.56 | 5.27 | 36.0 | 12.9 |
| defuddle | 326 | 1.79 | 17.0 | 117.4 | 39.6 | 19.1 | 121.8 | 43.1 |
| trafilatura | 326 | 2.26 | 15.3 | 151.4 | 52.8 | 17.7 | 156.0 | 57.4 |
| postlight | 326 | – | 33.8 | 403.9 | 99.7 | 33.8 | 403.9 | 99.7 |

### Total ms by HTML size (median / p95)

| engine | <50KB (35) | 50-200KB (176) | 200-500KB (76) | 0.5-1MB (21) | >1MB (18) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 1.54 / 5.33 | 2.46 / 8.44 | 4.59 / 14.0 | 8.95 / 30.9 | 55.2 / 155.7 |
| readability | 2.50 / 5.97 | 4.05 / 13.8 | 8.30 / 29.5 | 17.5 / 37.1 | 102.4 / 350.2 |
| defuddle | 10.2 / 20.9 | 15.8 / 48.0 | 27.1 / 80.5 | 48.2 / 136.2 | 303.2 / 874.6 |
| trafilatura | 9.69 / 24.7 | 15.0 / 55.4 | 24.6 / 108.8 | 44.0 / 236.9 | 577.4 / 2057.6 |
| postlight | 17.9 / 63.0 | 29.5 / 130.4 | 55.9 / 322.4 | 50.0 / 477.4 | 735.2 / 2244.4 |
