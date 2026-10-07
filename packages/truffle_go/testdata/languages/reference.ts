/**
 * TypeScript reference for the Go port's language tests (`languages_test.go`):
 * runs `packages/truffle/src/languages.ts` over test inputs and prints, as JSON,
 * what the Go functions must return. Detection cases also carry `rules`, a hex
 * mask of which RULES patterns match the prepared code (RULES order, bit i of
 * the mask is rule i), so every pattern is checked on its own, and `from`:
 * `corpus`, `fixture`, `edge`, `synthetic` or `long` (corpus blocks of one
 * language joined past the 5000 units the detector reads).
 *
 *   bun testdata/languages/reference.ts corpus <test-corpus>   # every case in the corpus (the Go test runs this)
 *   bun testdata/languages/reference.ts subset <test-corpus> | gzip -9 > testdata/languages/cases.json.gz
 *
 * `corpus` takes every code block of `parity/ts/*.json` and of the fixtures, every
 * distinct `class` and language attribute of `parity/vdoc/*.json`; `subset` takes
 * a deterministic sample of those plus synthetic edge cases.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RULES is module-private: import a copy that exports it.
const source = readFileSync(new URL('../../../truffle/src/languages.ts', import.meta.url), 'utf8');
const copy = join(mkdtempSync(join(tmpdir(), 'truffle-languages-')), 'languages.ts');
writeFileSync(copy, source.replace(/^const RULES\b/m, 'export const RULES'));
const L = (await import(copy)) as {
  detectLanguage(source: string): string | null;
  languageFromClass(className: string): string | null;
  normalizeLanguage(name: string | null): string | null;
  RULES: [string, [RegExp, number][]][];
};
const patterns = L.RULES.flatMap(([, rules]) => rules.map(([pattern]) => pattern));

const FIXTURES = new URL('../../../truffle/fixtures/expected/', import.meta.url).pathname;
const LANG_ATTRS = ['data-lang', 'data-language', 'data-code-language', 'data-snippet-lang', 'data-syntax', 'lang'];

type Detect = { code: string; want: string | null; rules: string; from: string };

function ruleMask(input: string): string {
  const code = (input.length > 5000 ? input.slice(0, 5000) : input).trim();
  let hex = '';
  for (let i = 0; i < patterns.length; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4 && i + b < patterns.length; b++) if (patterns[i + b].test(code)) nibble |= 1 << b;
    hex += nibble.toString(16);
  }
  return hex;
}

const detect = (code: string, from: string): Detect => ({ code, want: L.detectLanguage(code), rules: ruleMask(code), from });

function codeBlocks(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) codeBlocks(v, out);
  } else if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.type === 'code' && typeof o.code === 'string') out.push(o.code);
    for (const k in o) codeBlocks(o[k], out);
  }
}

function attributes(node: unknown, classes: Set<string>, names: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  const el = node as { a?: Record<string, string>; c?: unknown[] };
  if (el.a !== undefined) {
    if (typeof el.a.class === 'string') classes.add(el.a.class);
    for (const k of LANG_ATTRS) if (typeof el.a[k] === 'string') names.add(el.a[k]);
  }
  if (el.c !== undefined) for (const c of el.c) attributes(c, classes, names);
}

function corpusInputs(corpus: string): { corpusCode: string[]; fixtureCode: string[]; classes: string[]; names: string[] } {
  const parity = join(corpus, 'parity');
  const corpusCode: string[] = [];
  for (const f of readdirSync(join(parity, 'ts')).sort()) if (f.endsWith('.json')) codeBlocks(JSON.parse(readFileSync(join(parity, 'ts', f), 'utf8')), corpusCode);
  const fixtureCode: string[] = [];
  for (const f of readdirSync(FIXTURES).sort()) if (f.endsWith('.json')) codeBlocks(JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')), fixtureCode);
  const classes = new Set<string>();
  const names = new Set<string>();
  for (const f of readdirSync(join(parity, 'vdoc')).sort()) {
    if (f.endsWith('.json')) attributes(JSON.parse(readFileSync(join(parity, 'vdoc', f), 'utf8')).root, classes, names);
  }
  return { corpusCode: [...new Set(corpusCode)], fixtureCode: [...new Set(fixtureCode)], classes: [...classes], names: [...names] };
}

// Deterministic PRNG (mulberry32) for the sample and the synthetic cases.
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Up to `perGroup` of each group, chosen by hash so the sample is stable. */
function sample<T>(items: T[], key: (t: T) => string, group: (t: T) => string, perGroup: number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of [...items].sort((a, b) => hash(key(a)) - hash(key(b)))) {
    const g = group(item);
    const list = groups.get(g) ?? [];
    if (list.length < perGroup) list.push(item);
    groups.set(g, list);
  }
  return [...groups.values()].flat();
}

const SPACES = ['\u00a0', '\u3000', '\ufeff', '\u2003', '\u202f', '\u1680', '\v', '\f', '\t'];
const BREAKS = ['\r\n', '\r', '\u2028', '\u2029'];

/** Hand-written edge cases: line breaks, Unicode spaces, prompts, diffs, JSON-ish text, tiny and long strings. */
function edgeCases(): string[] {
  const long = 'def handle(self, request):\n    return self.render(request)\n';
  return [
    '', ' ', 'x', '1234567', '12345678', '       abc       ', '\u00a0\u00a0abcdefgh\u3000', 'a\ud83d\ude00b\ud83d\ude00c\ud83d\ude00',
    'def f(x):\n    return x', 'def f(x):\r    return x', 'def f(x):\u2028    return x', 'def f(x):\u2029    return x', 'def f(x):\r\n    return x',
    'class Foo:\r  pass\rprint(None)', 'import os\rimport sys\rfrom a import b', 'x = 1\r\ny = 2\r\nz = None',
    '$ ls -la\ntotal 0\n$ cd /tmp', '% brew install go', '❯ npm run build', '> node index.js\nhello', 'PS C:\\Users\\me> Get-ChildItem', 'user@host:~$ sudo apt-get install git',
    'root@box:/var/log# tail -f syslog', '$ echo hi\nhi\n$ echo there\nthere', '>>> print(1)\n1\n>>> x = 2', '  >>> import os', '$ python\n>>> 1 + 1\n2',
    '$\u00a0ls\n$\u00a0pwd', '$ ls\r$ pwd\r$ cd', 'C:\\> dir\nPS C:\\> ls ', 'me@host:~$\nls',
    '+added line\n-removed line\n context', '+a\n-b\n+c\n-d', '--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old\n+new', 'diff --git a/x b/x\nindex 1..2\n',
    '++not\n--not\n++diff', '+\n-\n+\n-', '-\n+', '+a\r-b\r+c', '+one\u2028-two\u2028+three',
    '{"a": 1, "b": [1, 2, 3]}', '[1, 2, 3, 4, 5]', '[1e400, -1e400]', '{"a": 1e999}', '{"a": 1,}', '{"key": "value"', '{"key": value}', "{'a': 1}", '[01, 2]', '[.5, 1]', '[1., 2]',
    '{"a":"\u0001"}', '{"a":"\\u0001"}', '{"a":"\\ud800"}', '{"a":"\\x41"}', '[true, false, null]', '[True, False, None]', '{"a": NaN}', '[Infinity]', '{"__proto__": 1}',
    '{ "$schema": "x", "@id": 1 } }', '{"a-b": {', '[ "x" , ]', '[' + '['.repeat(600) + ']'.repeat(600) + ']', '{"a":1}\u00a0', '\ufeff{"a": 1}', '{"a":\u00a01}', '{"a":\u20281}',
    '{\n  "name": "x",\n  "version": "1.0.0"\n}', '[\n  {"id": 1},\n  {"id": 2}\n]', '{}{}{}{}', '[][][][]', '{"a": [1, 2}', '["\u2028"]',
    'SELECT * FROM users WHERE id = 1', 'select a from b', 'ſelect a from b', 'SELECT a ſrom b', 'CREATE TABLE t (id INT PRIMARY KEY)', 'create table t (id int primary \u212aey)',
    '<!DOCTYPE html>\n<html><body><div class="a">x</div></body></html>', '<!doctype HTML>\n<div>', '<?xml version="1.0"?>\n<root/>', '  \n<?xml version="1.0"?><a:b x="1">',
    'FROM node:18 AS build\nRUN npm ci\nCOPY . .', 'from python:3.12\nrun pip install x', 'ſROM node\nRUN x',
    'fn main() {\n    let mut x = vec![1, 2];\n    println!("{}", x.len());\n}', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}',
    'package main\r\rimport "fmt"\r\rfunc main() {\r\tfmt.Println("hi")\r}', '#include <stdio.h>\nint main(void) { printf("hi"); }', 'std::cout << "hi";',
    'const x = 1;\nlet y = () => x;\nconsole.log(y());', 'interface A { b: string; }\nconst c: number = 1;', 'body {\n  color: red;\n  margin: 0;\n}',
    '$x: 1px;\n.a { &:hover { color: $x; } }', 'name: x\nversion: 1\ndependencies:\n  - a\n  - b', '[package]\nname = "x"\nversion = "0.1.0"', '[section]\nkey=value\n; comment',
    'all: build\n\tgo build ./...\n.PHONY: all', '# Title\n\n- item\n- [link](http://x)\n**bold**', 'query { user(id: 1) { name } }', 'local x = 1\nif x ~= 2 then\n  print(x)\nend',
    'x <- c(1, 2)\nlibrary(dplyr)', 'main :: IO ()\nmain = putStrLn "hi"', 'f :: Int\n  -> Int', 'f\n  :: Int', 'defmodule A do\n  def b, do: 1\nend', 'import \'package:flutter/material.dart\';',
    'object Main extends App {\n  val x: Int = 1\n}', '(defn f [x] (+ x 1))', '\\begin{equation}\n\\frac{a}{b}\n\\end{equation}', 'server {\n  listen 80;\n  location / {\n  }\n}',
    'syntax = "proto3";\nmessage A {\n  repeated int32 x = 1;\n}', 'pragma solidity ^0.8.0;\ncontract A {}', '@interface Foo : NSObject\n@end', 'use strict;\nmy $x = 1;', 'function y = f(x)\n  y = x .* 2;\nend',
    'Get-ChildItem | Where-Object { $_.Length -gt 1 }', '#!/bin/bash\nset -e\necho "hi" && ls', '#!/usr/bin/env zsh\nfor f in *; do echo $f; done', 'apt-get install -y curl\ncd /tmp\nls -la',
    'K\u212aelvin ſ \u017f', 'if\u00a0x:\n\u00a0\u00a0\u00a0\u00a0pass', '\u3000def\u3000f():\u3000\n\u3000\u3000return', 'def f():\u000b\n\treturn 1', 'x\u2028y\u2029z\u0085w = None',
    long.repeat(120), (long + '\ud83d\ude00').repeat(200), 'x'.repeat(4999) + '\ud83d\ude00' + 'def f(self):\n', ' '.repeat(4995) + 'abc\ud83d\ude00def', ' '.repeat(4993) + 'abcdef\ud83d\ude00xyz',
    '[' + '1,'.repeat(2600) + '1]', '{"a": "' + 'x'.repeat(5100) + '"}', 'def f(self):\n' + ' '.repeat(6000) + 'return', '\n'.repeat(3000) + 'def f(self):\n    pass', 'a = 1\n'.repeat(1000),
  ];
}

/** Long blocks: corpus blocks detected as one language, joined until past 5000 units, `perGroup` per language. */
function longBlocks(blocks: string[], perGroup: number): string[] {
  const groups = new Map<string, string[]>();
  for (const code of [...blocks].sort((a, b) => hash(a) - hash(b))) {
    const g = String(L.detectLanguage(code));
    groups.set(g, [...(groups.get(g) ?? []), code]);
  }
  const out: string[] = [];
  for (const [, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let i = 0;
    for (let n = 0; n < perGroup && i < list.length; n++) {
      let code = '';
      while (code.length < 5200 && i < list.length) code += (code === '' ? '' : '\n\n') + list[i++];
      if (code.length >= 5000) out.push(code);
    }
  }
  return out;
}

/** Synthetic blocks: corpus lines mixed across blocks, with other line breaks, Unicode spaces and prompts. */
function synthetic(blocks: string[], count: number): string[] {
  const random = prng(20261007);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const lines = blocks.flatMap((b) => b.split('\n')).filter((l) => l.trim().length > 0);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let code: string;
    const shape = random();
    if (shape < 0.4) {
      // A corpus block with another line break and some indentation spaces.
      code = pick(blocks);
      if (random() < 0.7) code = code.split('\n').join(pick(BREAKS));
      if (random() < 0.5) code = code.replace(/^( +)/gm, (s) => (random() < 0.3 ? pick(SPACES) : s));
    } else if (shape < 0.8) {
      // Lines from several blocks.
      const n = 1 + Math.floor(random() * 12);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) parts.push(pick(lines));
      code = parts.join(random() < 0.8 ? '\n' : pick(BREAKS));
    } else {
      // A terminal session or a diff over corpus lines.
      const n = 2 + Math.floor(random() * 8);
      const parts: string[] = [];
      for (let k = 0; k < n; k++) {
        const line = pick(lines).trim();
        const r = random();
        parts.push(r < 0.3 ? pick(['$ ', '% ', '❯ ', '> ', 'PS C:\\> ', 'me@box:~/src$ ']) + line : r < 0.6 ? pick(['+', '-', ' ', '+', '-']) + line : line);
      }
      code = parts.join('\n');
    }
    out.push(code);
  }
  return out;
}

const [mode, corpus] = process.argv.slice(2);
if ((mode !== 'corpus' && mode !== 'subset') || corpus === undefined) {
  console.error('usage: bun reference.ts corpus|subset <test-corpus dir>');
  process.exit(2);
}
const { corpusCode, fixtureCode, classes, names } = corpusInputs(corpus);

let detectInputs: [string, string][];
let classInputs: string[];
let nameInputs: string[];
const nameEdges = ['', ' ', 'JS', ' Python ', '.py', '..py', '.', 'C++', 'c#', 'F#', 'Objective-C', 'shell-session', 'no-highlight', '\u212at', '\u212aotlin', 'ſh', 'İ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '\u00a0rust\u3000', '\ufeffgo', 'GoLang', 'text', 'none', 'TSX', 'vb.net'];
if (mode === 'corpus') {
  detectInputs = [...corpusCode.map((c) => [c, 'corpus']), ...fixtureCode.filter((c) => !corpusCode.includes(c)).map((c) => [c, 'fixture'])] as [string, string][];
  classInputs = classes;
  nameInputs = [...new Set([...names, ...nameEdges])];
} else {
  const groups = (code: string) => String(L.detectLanguage(code));
  const sampled = sample(corpusCode, (c) => c, groups, 30);
  const seen = new Set<string>();
  detectInputs = [];
  const add = (codes: string[], from: string) => {
    for (const c of codes) if (!seen.has(c)) seen.add(c), detectInputs.push([c, from]);
  };
  add(sampled, 'corpus');
  add(fixtureCode, 'fixture');
  add(edgeCases(), 'edge');
  add(longBlocks(corpusCode, 3), 'long');
  add(synthetic(corpusCode, 700), 'synthetic');
  // Every class that names a language or looks like it might, and a sample of the rest.
  const hint = /lang|code|highlight|brush|source|hljs|pretty|syntax|^\S{2,12}$/i;
  const named = classes.filter((c) => L.languageFromClass(c) !== null || hint.test(c));
  const rest = sample(classes.filter((c) => !named.includes(c)), (c) => c, () => '', 300);
  const classEdges = ['language-js', 'LANGUAGE-PY', 'lang-ſh', 'lang-cſ lang-js', 'language-\u212atlin', 'highlight-source-', 'highlight-source- x', 'highlight-source-rust', 'brush: py', 'brush:\u00a0ruby', 'sourceCode python', 'hljs\tgo', 'prettyprint lang-rb', 'code-python x', 'code-python.x', 'x syntax-rust', 'foo-bar-code', 'go-code', 'python-codex', '\u00a0python', 'py', 'text', 'output', 'plaintext', 'abcdefghijklmnopython', 'x\u3000js', 'mw-highlight-lang-c'];
  classInputs = [...new Set([...named.slice(0, 3000), ...rest, ...classEdges])];
  nameInputs = [...new Set([...names, ...nameEdges])];
}

const result = {
  rules: patterns.length,
  detect: detectInputs.map(([code, from]) => detect(code, from)),
  class: classInputs.map((c) => [c, L.languageFromClass(c)]),
  normalize: nameInputs.map((n) => [n, L.normalizeLanguage(n)]),
};
process.stdout.write(JSON.stringify(result));
