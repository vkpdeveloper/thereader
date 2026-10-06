/**
 * Text normalization shared by every engine's output and by the scorers, so
 * that differences in whitespace never count as differences in content.
 */

/** Collapses horizontal whitespace, trims lines and drops empty ones; one block per line. */
export function normalizeText(text: string): string {
  return text
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Key for verbatim snippet matching: NFKC, lowercase, typographic quotes and
 * dashes folded, and all whitespace removed (so block boundaries, CJK line
 * breaks and inline-element spacing never break a match).
 */
export function matchKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\s\u00ad\u200b-\u200d\u2060\ufeff]+/g, '');
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', python3: 'python', py3: 'python', pycon: 'python', ipython: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', shellscript: 'bash', 'shell-session': 'bash', shellsession: 'bash', terminal: 'bash',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  rs: 'rust', golang: 'go', rb: 'ruby', kt: 'kotlin', kts: 'kotlin',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', 'c#': 'csharp', cs: 'csharp', 'f#': 'fsharp', fs: 'fsharp',
  yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'html', xhtml: 'html', svg: 'xml', markup: 'html', vue: 'html',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', plpgsql: 'sql', sqlite: 'sql', psql: 'sql',
  dockerfile: 'docker', objc: 'objectivec', 'objective-c': 'objectivec', hs: 'haskell', ex: 'elixir', exs: 'elixir',
  scss: 'css', sass: 'css', less: 'css', jsonc: 'json', json5: 'json', toml: 'toml', ini: 'ini', conf: 'ini',
};

const NOT_LANGUAGES = new Set(['text', 'plain', 'plaintext', 'txt', 'none', 'nohighlight', 'output', 'code', 'raw', 'default', 'auto']);

/** Canonical lowercase language id, or null for "no language" labels. */
export function canonicalLanguage(label: string | null | undefined): string | null {
  if (!label) return null;
  const id = label.trim().toLowerCase();
  if (!id || NOT_LANGUAGES.has(id)) return null;
  return LANGUAGE_ALIASES[id] ?? id;
}
