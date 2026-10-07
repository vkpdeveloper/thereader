/**
 * The TypeScript engine's answers (packages/truffle/src/url.ts) for url_test.go:
 *
 *   bun testdata/url/oracle.ts < questions.json > answers.json
 *   bun testdata/url/oracle.ts --corpus <test-corpus/parity> > answers.json
 *
 * Questions: `{ "resolve": [[base, href], ...], "urls": [url, ...] }`; with
 * `--corpus`, every URL attribute value of the corpus against its page URL
 * (corpus.ts), and the page URLs and every resolved URL as `urls`.
 * Answers: `{ "resolve": [[base, href, resolveUrl, resolveHttp, newURLHref], ...],
 * "urls": [[url, hostOf, canonicalUrl], ...] }`, null where a function returns
 * null or `new URL(href, base)` throws. gen.ts writes the committed cases with it.
 */
import { canonicalUrl, hostOf, resolveHttp, resolveUrl } from '../../../truffle/src/url';
import { collect } from './corpus';

export interface Questions {
  resolve: [string, string][];
  urls: string[];
}

export interface Answers {
  resolve: [string, string, string | null, string | null, string | null][];
  urls: [string, string, string][];
}

function href(input: string, base: string): string | null {
  try {
    return new URL(input, base).href;
  } catch {
    return null;
  }
}

export function answer(q: Questions): Answers {
  return {
    resolve: q.resolve.map(([base, input]) => [base, input, resolveUrl(input, base), resolveHttp(input, base), href(input, base)]),
    urls: q.urls.map((url) => [url, hostOf(url), canonicalUrl(url)]),
  };
}

if (import.meta.main) {
  const corpus = process.argv.indexOf('--corpus');
  let questions: Questions;
  if (corpus >= 0) {
    const { pages, pairs } = collect(process.argv[corpus + 1]!);
    const urls = new Set(pages);
    for (const [base, href] of pairs) {
      const url = resolveUrl(href, base);
      if (url !== null) urls.add(url);
    }
    questions = { resolve: pairs, urls: [...urls] };
  } else {
    questions = JSON.parse(await Bun.stdin.text()) as Questions;
  }
  await Bun.write(Bun.stdout, JSON.stringify(answer(questions)));
}
