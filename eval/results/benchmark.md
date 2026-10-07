# TypeScript, Dart and Go: the whole pipeline

Generated 2026-10-07T03:11:28.252Z by `bun run bench` (see [eval/README.md](../README.md)): every page of the parity dump (325 pages, Zyte + curated), HTML to article and Markdown, 11 timed runs per page after one warm-up, medians per page; summaries are over pages. Milliseconds unless noted.

Machine: linux 6.18.44-fc-v77, Intel(R) Xeon(R) Processor @ 2.80GHz x4, load avg at start 0.6 1.0 1.0, at end 1.1 1.1 1.0. Engines run one after another, single-threaded.

| engine | runtime |
| --- | --- |
| TypeScript | Chromium 153.0.8010.12 (V8), native DOMParser |
| Dart | Dart 3.13.5 AOT, package:html |
| Go | Go 1.24.7, native binary (PGO), own HTML5 parser |

## Whole pipeline (parse + tree + extract + Markdown)

| engine | median | p90 | p95 | mean | max | pages under 1 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 9.05 | 28.8 | 49.3 | 17.0 | 323 | 0/325 |
| Dart | 11.7 | 42.4 | 90.1 | 26.3 | 527 | 0/325 |
| Go | 1.16 | 4.33 | 8.97 | 2.84 | 64.7 | 124/325 |

## Phases (median / p95)

| engine | parse | tree | extract | Markdown |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 3.71 / 28.6 | 2.01 / 12.6 | 1.98 / 19.6 | 0.080 / 0.920 |
| Dart | 7.74 / 56.2 | 1.15 / 7.51 | 1.70 / 30.4 | 0.081 / 0.994 |
| Go | 0.311 / 1.45 | 0.089 / 0.731 | 0.723 / 5.64 | 0.024 / 0.319 |

Parse: TypeScript uses Chromium's native parser, Dart package:html, Go its own HTML5 parser. Tree: `fromDom` / `fromDocument` / `FromTree`, the compact copy the engine runs on.

## Memory per page

| engine | median MB | p90 | p95 | max | pages under 5 MB | process peak RSS | what is measured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| TypeScript | 1.69 | 3.92 | 5.93 | 33.0 | 308/325 | – | growth of the V8 and DOM (Blink) heaps across one run whose results stay alive, after a full collection (DevTools Runtime.getHeapUsage); garbage collected during the run is not counted |
| Dart | – | – | – | – | – | 227.3 MB | not measured per page (the Dart VM exposes no heap counter to programs); the process peak RSS is reported |
| Go | 0.62 | 2.06 | 3.65 | 21.9 | 312/325 | 95.4 MB | every byte the pipeline allocates for the page, garbage collector paused (Markdown included) |

## Whole pipeline by HTML size (median / p95)

| engine | <50KB (34) | 50-200KB (175) | 200-500KB (77) | 0.5-1MB (21) | >1MB (18) |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 3.87 / 9.05 | 7.14 / 16.5 | 14.0 / 30.4 | 23.7 / 76.5 | 97.7 / 323 |
| Dart | 3.97 / 26.8 | 8.64 / 24.0 | 20.0 / 47.3 | 33.5 / 95.4 | 181 / 527 |
| Go | 0.723 / 2.32 | 1.01 / 3.67 | 1.44 / 5.49 | 2.28 / 11.2 | 17.6 / 64.7 |

## Go speedup per page (other engine total / Go total)

| vs | median | p10 | p90 |
| --- | ---: | ---: | ---: |
| TypeScript | 6.3x | 4.4x | 12.3x |
| Dart | 8.9x | 5.2x | 16.3x |
