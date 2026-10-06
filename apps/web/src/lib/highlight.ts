import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';
import { grammarFor, type Grammar } from './codeLanguages';

/**
 * Syntax highlighting for article code blocks, loaded as its own chunk only
 * when an article has code. Each grammar is a further chunk fetched on first
 * use; detection loads a small common set.
 */

const loaders: Record<Grammar, () => Promise<{ default: LanguageFn }>> = {
  ada: () => import('highlight.js/lib/languages/ada'),
  apache: () => import('highlight.js/lib/languages/apache'),
  armasm: () => import('highlight.js/lib/languages/armasm'),
  awk: () => import('highlight.js/lib/languages/awk'),
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  coq: () => import('highlight.js/lib/languages/coq'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  crystal: () => import('highlight.js/lib/languages/crystal'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  d: () => import('highlight.js/lib/languages/d'),
  dart: () => import('highlight.js/lib/languages/dart'),
  delphi: () => import('highlight.js/lib/languages/delphi'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  elm: () => import('highlight.js/lib/languages/elm'),
  erb: () => import('highlight.js/lib/languages/erb'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  fsharp: () => import('highlight.js/lib/languages/fsharp'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  haxe: () => import('highlight.js/lib/languages/haxe'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  less: () => import('highlight.js/lib/languages/less'),
  lisp: () => import('highlight.js/lib/languages/lisp'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  matlab: () => import('highlight.js/lib/languages/matlab'),
  mipsasm: () => import('highlight.js/lib/languages/mipsasm'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nim: () => import('highlight.js/lib/languages/nim'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  perl: () => import('highlight.js/lib/languages/perl'),
  pgsql: () => import('highlight.js/lib/languages/pgsql'),
  php: () => import('highlight.js/lib/languages/php'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  prolog: () => import('highlight.js/lib/languages/prolog'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  reasonml: () => import('highlight.js/lib/languages/reasonml'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scheme: () => import('highlight.js/lib/languages/scheme'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  sql: () => import('highlight.js/lib/languages/sql'),
  stylus: () => import('highlight.js/lib/languages/stylus'),
  swift: () => import('highlight.js/lib/languages/swift'),
  tcl: () => import('highlight.js/lib/languages/tcl'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vala: () => import('highlight.js/lib/languages/vala'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  vbscript: () => import('highlight.js/lib/languages/vbscript'),
  vim: () => import('highlight.js/lib/languages/vim'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
  x86asm: () => import('highlight.js/lib/languages/x86asm'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

/** Grammars `highlightAuto` chooses between when the page did not name a language. */
const detectable: Grammar[] = ['javascript', 'typescript', 'python', 'bash', 'json', 'xml', 'css', 'go', 'rust', 'java', 'cpp', 'csharp', 'sql', 'yaml', 'ruby', 'php'];

const registered = new Map<Grammar, Promise<boolean>>();

function ensure(name: Grammar): Promise<boolean> {
  let ready = registered.get(name);
  if (!ready) {
    ready = loaders[name]().then(
      (m) => {
        hljs.registerLanguage(name, m.default);
        return true;
      },
      () => {
        registered.delete(name);
        return false;
      },
    );
    registered.set(name, ready);
  }
  return ready;
}

export interface Highlighted {
  /** highlight.js markup: escaped source wrapped in `hljs-*` spans. */
  html: string;
  /** The grammar used; for detected code, the language that was found. */
  language: string;
}

/**
 * Highlights `code` in the named language, or detects one when `language`
 * is null and accepts it only when highlight.js is confident. Null leaves
 * the code plain.
 */
export async function highlightCode(code: string, language: string | null): Promise<Highlighted | null> {
  if (language) {
    const name = grammarFor(language);
    if (!name || name === 'plaintext' || !(await ensure(name))) return null;
    return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language };
  }
  if (code.trim().length < 12) return null;
  await Promise.all(detectable.map(ensure));
  const result = hljs.highlightAuto(code, detectable.filter((name) => hljs.getLanguage(name)));
  const runnerUp = result.secondBest?.relevance ?? 0;
  if (!result.language || result.relevance < 10 || result.relevance < runnerUp * 1.4) return null;
  return { html: result.value, language: result.language };
}
