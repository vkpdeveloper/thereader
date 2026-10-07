# TypeScript, Dart and Go: the whole pipeline

Generated 2026-10-07T03:55:29.493Z by `bun run bench` (see [eval/README.md](../README.md)): every page of the parity dump (325 pages, Zyte + curated), HTML to article and Markdown, 11 timed runs per page after one warm-up, medians per page; summaries are over pages. Milliseconds unless noted.

Machine: linux 6.18.44-fc-v77, Intel(R) Xeon(R) Processor @ 2.30GHz x4, load avg at start 0.7 0.7 0.3, at end 1.4 1.1 0.6. Engines run one after another, single-threaded.

| engine | runtime |
| --- | --- |
| TypeScript | Chromium 153.0.8010.12 (V8), native DOMParser |
| Dart | Dart 3.13.5 AOT, package:html |
| Go | Go 1.24.7, native binary (PGO), own HTML5 parser |

## Whole pipeline (parse + tree + extract + Markdown)

| engine | median | p90 | p95 | mean | max | pages under 1 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 4.76 | 18.0 | 31.4 | 11.1 | 271 | 0/325 |
| Dart | 7.88 | 30.1 | 46.2 | 17.0 | 335 | 0/325 |
| Go | 0.887 | 3.34 | 6.42 | 2.13 | 45.9 | 181/325 |

## Phases (median / p95)

| engine | parse | tree | extract | Markdown |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 2.30 / 19.7 | 0.940 / 5.01 | 1.07 / 10.7 | 0.050 / 0.600 |
| Dart | 5.64 / 41.3 | 0.645 / 3.90 | 1.20 / 14.0 | 0.060 / 0.707 |
| Go | 0.212 / 1.06 | 0.070 / 0.591 | 0.571 / 4.30 | 0.019 / 0.239 |

Parse: TypeScript uses Chromium's native parser, Dart package:html, Go its own HTML5 parser. Tree: `fromDom` / `fromDocument` / `FromTree`, the compact copy the engine runs on.

## Memory per page

| engine | median MB | p90 | p95 | max | pages under 5 MB | process peak RSS | what is measured |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| TypeScript | 1.44 | 3.13 | 4.20 | 25.5 | 312/325 | – | growth of the V8 and DOM (Blink) heaps across one run whose results stay alive, after a full collection (DevTools Runtime.getHeapUsage); garbage collected during the run is not counted |
| Dart | – | – | – | – | – | 226.0 MB | not measured per page here (the Dart VM exposes no heap counter to programs; packages/truffle_dart/tool/bench_memory.dart samples it through the VM service); the process peak RSS is reported |
| Go | 0.63 | 2.07 | 3.61 | 21.8 | 312/325 | 95.6 MB | every byte the pipeline allocates for the page, garbage collector paused (Markdown included) |

## Whole pipeline by HTML size (median / p95)

| engine | <50KB (34) | 50-200KB (175) | 200-500KB (77) | 0.5-1MB (21) | >1MB (18) |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 2.25 / 5.52 | 3.99 / 11.9 | 7.70 / 18.0 | 18.0 / 40.7 | 64.8 / 271 |
| Dart | 2.83 / 6.84 | 6.16 / 14.3 | 14.0 / 31.1 | 25.5 / 63.9 | 106 / 335 |
| Go | 0.524 / 1.87 | 0.746 / 2.79 | 1.12 / 4.32 | 1.71 / 8.47 | 14.6 / 45.9 |

## Go speedup per page (other engine total / Go total)

| vs | median | p10 | p90 |
| --- | ---: | ---: | ---: |
| TypeScript | 5.1x | 3.3x | 10.7x |
| Dart | 8.2x | 4.7x | 15.4x |
