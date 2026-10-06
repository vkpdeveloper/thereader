# Article extraction eval results

Generated 2026-10-05T23:59:31.678Z by `bun run eval` (see [eval/README.md](README.md)). Scores are re-derived from the stored outputs on every run.

## Engines

| engine | version | runtime | settings | ran at |
| --- | ---: | ---: | ---: | ---: |
| ours | 252910b | Chromium DOMParser | extract(doc, { url }); text = articleText(article) | 2026-10-05 23:59 |
| readability | 0.6.0 | Chromium DOMParser | new Readability(doc).parse() defaults; text from content HTML | 2026-10-05 23:51 |
| defuddle | 0.19.4 | Chromium DOMParser | new Defuddle(doc, { url }).parse(), core bundle defaults; text from content HTML | 2026-10-05 23:51 |
| trafilatura | 2.3.0 | CPython 3.12 + lxml | extract(tree, url, include_comments=False), txt output; stats from xml output | 2026-10-05 23:51 |
| postlight | 2.2.3 | Node v22.22.2 | Parser.parse(url, { html, fetchAllPages: false }); text from content HTML | 2026-10-05 23:51 |

Machine: os darwin 27.0.0, cpu Apple M5 x10, chromium 153.0.8010.12, bun 1.4.0, load avg at start 19.3 22.0 15.2, load avg at end 14.9 19.3 16.7.

## Zyte article-extraction-benchmark (181 pages, scrapinghub/article-extraction-benchmark@4a3bc97)

Official metric: 4-token shingle precision/recall per page, averaged; F1 from the averages; accuracy = exact token match. ± is the bootstrap std (1000 resamples), CI the 95% percentile interval of F1.

| engine | F1 | F1 95% CI | precision | recall | accuracy | failed | empty | median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | **0.972** ± 0.003 | 0.965–0.978 | 0.958 ± 0.006 | 0.987 ± 0.003 | 0.315 ± 0.034 | 0 | 0 | 3.67 |
| readability | **0.952** ± 0.005 | 0.943–0.961 | 0.918 ± 0.008 | 0.988 ± 0.003 | 0.177 ± 0.028 | 0 | 0 | 4.56 |
| defuddle | **0.932** ± 0.010 | 0.911–0.951 | 0.899 ± 0.012 | 0.968 ± 0.010 | 0.171 ± 0.028 | 0 | 0 | 18.1 |
| trafilatura | **0.955** ± 0.007 | 0.940–0.968 | 0.938 ± 0.009 | 0.974 ± 0.008 | 0.293 ± 0.033 | 0 | 0 | 22.9 |
| postlight | **0.920** ± 0.014 | 0.892–0.945 | 0.901 ± 0.014 | 0.940 ± 0.014 | 0.265 ± 0.032 | 0 | 0 | 41.5 |

### Metric sanity check

Our TypeScript port of `evaluate.py` re-scoring the benchmark's own committed outputs, against its README table:

| output file | version | published F1 / P / R / acc | ours F1 / P / R / acc | max abs diff |
| --- | ---: | ---: | ---: | ---: |
| output/readability_js.json | 0.6.0 | 0.947 / 0.914 / 0.982 / 0.166 | 0.947 / 0.914 / 0.982 / 0.166 | 0.000 |
| output/trafilatura.json | 2.0.0 | 0.958 / 0.938 / 0.978 / 0.293 | 0.958 / 0.938 / 0.978 / 0.293 | 0.000 |
| output/html-text.json | 0.7.0 | 0.665 / 0.500 / 0.994 / 0.000 | 0.665 / 0.500 / 0.994 / 0.000 | 0.000 |

## Curated live corpus (83 annotated pages with snapshots, of 145 entries; 0 jsOnly scored separately; 16 URLs blocked at fetch time, see corpus/blocked.json)

Combined score per page = weighted mean of mustInclude recall (0.5), 1 − mustExclude leak rate (0.2; 0 for empty output; dropped for the few pages with no boilerplate text), fuzzy title match (0.1) and structure checks passed (0.2; dropped when a page has no structure expectations).

| engine | pages | include recall | leak rate | pages leaking | title exact | title fuzzy | structure | code langs | combined | empty | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 83 | 78.5% | 3.0% | 6.2% | 66.3% | 74.7% | 62.6% | 56.9% | **0.759** | 1 | 18 |
| readability | 83 | 95.6% | 5.3% | 12.3% | 67.5% | 86.8% | 71.4% | 13.9% | **0.894** | 0 | 0 |
| defuddle | 83 | 98.3% | 8.5% | 21.0% | 75.9% | 87.9% | 83.7% | 46.3% | **0.930** | 0 | 0 |
| trafilatura | 83 | 95.4% | 8.5% | 21.0% | 0.0% | 0.0% | 39.6% | 0.0% | **0.736** | 0 | 0 |
| postlight | 83 | 88.8% | 5.0% | 12.3% | 68.7% | 89.2% | 59.0% | 33.3% | **0.838** | 1 | 0 |

### Structure checks (pages passing / pages with the expectation)

| engine | code | languages | images | headings | tables | math | footnotes | embeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 23/42 | 20/36 | 36/44 | 40/63 | 10/14 | 4/7 | 7/19 | 2/2 |
| readability | 39/42 | 5/36 | 39/44 | 55/63 | 12/14 | 4/7 | 7/19 | 1/2 |
| defuddle | 40/42 | 15/36 | 41/44 | 61/63 | 14/14 | 7/7 | 10/19 | 2/2 |
| trafilatura | 27/42 | 0/36 | 0/44 | 51/63 | 12/14 | 0/7 | 0/19 | 0/2 |
| postlight | 37/42 | 12/36 | 40/44 | 23/63 | 10/14 | 4/7 | 7/19 | 1/2 |

### Combined score by tier

| engine | tier 1 (9) | tier 2 (19) | tier 3 (35) | tier 4 (14) | tier 5 (6) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 0.881 | 0.539 | 0.791 | 0.834 | 0.918 |
| readability | 0.881 | 0.903 | 0.897 | 0.879 | 0.903 |
| defuddle | 0.895 | 0.907 | 0.948 | 0.941 | 0.918 |
| trafilatura | 0.727 | 0.733 | 0.743 | 0.725 | 0.747 |
| postlight | 0.859 | 0.842 | 0.841 | 0.834 | 0.778 |

### Combined score by category

| engine | academic (7) | boilerplate (1) | docs (20) | interactive (2) | news (7) | reference (3) | simple-blog (13) | tech-blog (30) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 0.915 | 0.400 | 0.509 | 0.938 | 0.931 | 0.978 | 0.849 | 0.789 |
| readability | 0.929 | 0.300 | 0.847 | 0.938 | 0.846 | 0.964 | 0.921 | 0.926 |
| defuddle | 0.942 | 0.700 | 0.915 | 0.938 | 0.963 | 1.000 | 0.922 | 0.932 |
| trafilatura | 0.724 | 0.300 | 0.733 | 0.875 | 0.709 | 0.809 | 0.726 | 0.750 |
| postlight | 0.797 | 0.100 | 0.793 | 0.938 | 0.800 | 0.909 | 0.874 | 0.880 |

## Performance (all scored pages, per-page median of the timed runs)

JS engines run in headless Chromium on a fresh `DOMParser` document per run; Trafilatura in CPython (lxml parse timed separately); Postlight in Node (cheerio parse is internal, so only the total is timed). Cross-runtime numbers are indicative; the three Chromium engines are directly comparable.

| engine | pages | parse median | extract median | extract p95 | extract mean | total median | total p95 | total mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ours | 308 | 1.92 | 2.42 | 23.3 | 8.19 | 4.72 | 30.9 | 11.9 |
| readability | 326 | 1.99 | 4.05 | 33.9 | 11.0 | 6.30 | 41.0 | 14.9 |
| defuddle | 326 | 2.10 | 20.0 | 122.3 | 44.0 | 22.6 | 127.3 | 48.1 |
| trafilatura | 326 | 3.38 | 25.6 | 270.4 | 98.1 | 30.9 | 277.3 | 107.3 |
| postlight | 326 | – | 51.8 | 473.4 | 142.3 | 51.8 | 473.4 | 142.3 |

### Total ms by HTML size (median / p95)

| engine | <50KB (30) | 50-200KB (168) | 200-500KB (73) | 0.5-1MB (20) | >1MB (17) |
| --- | ---: | ---: | ---: | ---: | ---: |
| ours | 2.38 / 11.7 | 3.74 / 11.3 | 6.71 / 20.7 | 13.5 / 31.8 | 68.6 / 183.7 |
| readability | 3.05 / 7.91 | 4.64 / 16.4 | 10.4 / 32.2 | 18.1 / 48.7 | 112.9 / 382.8 |
| defuddle | 12.2 / 33.4 | 18.8 / 59.8 | 29.0 / 99.3 | 53.6 / 167.4 | 326.7 / 968.7 |
| trafilatura | 16.7 / 65.6 | 26.2 / 101.1 | 42.5 / 179.7 | 83.4 / 622.6 | 1116.7 / 3561.9 |
| postlight | 23.3 / 109.6 | 42.6 / 179.3 | 72.9 / 378.2 | 135.2 / 524.5 | 1030.1 / 2835.7 |
