import type { Article } from '@thereader/extract';

const img = (id: number, w: number, h: number) => ({
  src: `https://picsum.photos/id/${id}/${w}/${h}`,
  srcset: `https://picsum.photos/id/${id}/${w / 2}/${h / 2} ${w / 2}w, https://picsum.photos/id/${id}/${w}/${h} ${w}w`,
  width: w,
  height: h,
});

const favicon =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#52a8ff"/><path d="M4 4h8v2H9v6H7V6H4z" fill="#000"/></svg>');

/** One of every block and inline type in the article model, for renderer tests and visual checks. */
export const everyBlock: Article = {
  schema: 1,
  url: 'https://example.org/notes/every-block',
  title: 'A field guide to every block the reader draws',
  subtitle: 'Headings, code, figures, tables, quotes, math and footnotes, rendered from the structured article model.',
  byline: 'Ada Writer and Grace Editor',
  authors: ['Ada Writer', 'Grace Editor'],
  siteName: 'Example Notes',
  publishedAt: '2026-09-30T08:00:00.000Z',
  modifiedAt: null,
  language: 'en',
  dir: 'ltr',
  excerpt: 'A test article that exercises every block type.',
  leadImage: { ...img(1015, 1200, 800), alt: 'A river valley' },
  favicon,
  wordCount: 1100,
  readingMinutes: 5,
  blocks: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'This paragraph mixes ' },
        { type: 'text', text: 'bold', marks: ['bold'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'italic', marks: ['italic'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'underline', marks: ['underline'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'strike', marks: ['strike'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'inline code', marks: ['code'] },
        { type: 'text', text: ', H' },
        { type: 'text', text: '2', marks: ['sub'] },
        { type: 'text', text: 'O, E = mc' },
        { type: 'text', text: '2', marks: ['sup'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'a highlight', marks: ['highlight'] },
        { type: 'text', text: ', ' },
        { type: 'text', text: 'small print', marks: ['small'] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: '⌘K', marks: ['kbd'] },
        { type: 'text', text: '. Links open in a new tab: ' },
        { type: 'text', text: 'a ', href: 'https://developer.mozilla.org/' },
        { type: 'text', text: 'bold link', marks: ['bold'], href: 'https://developer.mozilla.org/' },
        { type: 'text', text: ', and an unsafe ' },
        { type: 'text', text: 'script link', href: 'javascript:alert(1)' },
        { type: 'text', text: ' renders as text. A footnote follows' },
        { type: 'ref', id: 'n1', label: '1' },
        { type: 'text', text: ' and an emoji image ' },
        { type: 'image', src: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Smiley.svg/32px-Smiley.svg.png', alt: 'smiley', width: 18, height: 18 },
        { type: 'text', text: ' sits in the line.' },
        { type: 'break' },
        { type: 'text', text: 'After a line break, inline math: ' },
        {
          type: 'math',
          tex: 'a^2 + b^2 = c^2',
          mathml: '<math><msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></math>',
          text: 'a² + b² = c²',
        },
        { type: 'text', text: ' and TeX only: ' },
        { type: 'math', tex: '\\sum_{i=1}^{n} i', text: 'sum of i' },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Code' }], anchor: 'code' },
    {
      type: 'code',
      language: 'typescript',
      languageSource: 'markup',
      title: 'store.ts',
      code: [
        'export async function save(url: string): Promise<Summary> {',
        '  const page = await fetch(`/v1/article-source?url=${encodeURIComponent(url)}`);',
        "  if (!page.ok) throw new Error('Could not fetch the page.');",
        '  const html = new TextDecoder(charsetOf(page)).decode(await page.arrayBuffer());',
        '  return store(extract(new DOMParser().parseFromString(html, "text/html"), { url }));',
        '}',
      ].join('\n'),
    },
    {
      type: 'code',
      language: 'python',
      code: 'def fib(n: int) -> int:\n    """The nth Fibonacci number."""\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint([fib(i) for i in range(10)])  # a very long comment line that keeps going so the block has to scroll sideways instead of wrapping',
    },
    {
      type: 'code',
      language: null,
      code: 'use std::collections::HashMap;\n\nfn main() {\n    let mut counts: HashMap<&str, usize> = HashMap::new();\n    for word in "the quick brown fox jumps over the lazy dog the end".split_whitespace() {\n        *counts.entry(word).or_insert(0) += 1;\n    }\n    println!("{:?}", counts.get("the"));\n}',
    },
    { type: 'code', language: 'bash', code: '$ curl -s "http://127.0.0.1:8787/v1/article-source?url=https%3A%2F%2Fexample.org" | head -c 200' },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Figures' }], anchor: 'figures' },
    {
      type: 'figure',
      images: [{ ...img(1043, 1200, 800), alt: 'A misty forest' }],
      caption: [{ type: 'text', text: 'A single image with a caption, ' }, { type: 'text', text: 'linked text', href: 'https://picsum.photos/' }, { type: 'text', text: ' and a credit.' }],
      credit: [{ type: 'text', text: 'Photo: Picsum' }],
    },
    {
      type: 'figure',
      images: [
        { ...img(1018, 800, 600), alt: 'Mountains' },
        { ...img(1025, 800, 600), alt: 'A dog' },
        { ...img(1039, 800, 600), alt: 'A waterfall' },
      ],
      caption: [{ type: 'text', text: 'A gallery of three.' }],
    },
    { type: 'heading', level: 3, content: [{ type: 'text', text: 'Video and audio' }], anchor: 'media' },
    {
      type: 'video',
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      embedUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ',
      title: 'Big Buck Bunny',
      caption: [{ type: 'text', text: 'Click to load the player; nothing is fetched from YouTube before that.' }],
    },
    { type: 'audio', provider: 'file', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', title: 'SoundHelix Song 1' },
    { type: 'audio', provider: 'spotify', url: 'https://open.spotify.com/episode/x', embedUrl: 'https://open.spotify.com/embed/episode/x', title: 'An episode' },
    {
      type: 'embed',
      provider: 'twitter',
      url: 'https://twitter.com/example/status/1',
      author: '@example',
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Embeds keep their text as a quiet card, with a link back to the post.' }] }],
    },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Lists and quotes' }], anchor: 'lists' },
    {
      type: 'list',
      ordered: true,
      start: 3,
      items: [
        { blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ordered lists keep their start number.' }] }] },
        {
          blocks: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Items nest:' }] },
            {
              type: 'list',
              ordered: false,
              items: [
                { blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'a nested bullet' }] }] },
                { blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'another one' }] }] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'list',
      ordered: false,
      items: [
        { checked: true, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'A finished task' }] }] },
        { checked: false, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'An open task' }] }] },
      ],
    },
    {
      type: 'quote',
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Typography exists to honor content.' }] }],
      cite: [{ type: 'text', text: 'Robert Bringhurst' }],
    },
    {
      type: 'quote',
      pull: true,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'A pull quote repeats a line from the article for emphasis.' }] }],
    },
    { type: 'rule' },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Tables' }], anchor: 'tables' },
    {
      type: 'table',
      caption: [{ type: 'text', text: 'Header rows, spans and alignment.' }],
      headerRows: 1,
      rows: [
        {
          cells: [
            { content: [{ type: 'text', text: 'Format' }], header: true },
            { content: [{ type: 'text', text: 'Size' }], header: true, align: 'right' },
            { content: [{ type: 'text', text: 'Notes' }], header: true, colspan: 2 },
          ],
        },
        {
          cells: [
            { content: [{ type: 'text', text: 'EPUB' }], header: true, rowspan: 2 },
            { content: [{ type: 'text', text: '1.2 MB' }], align: 'right' },
            { content: [{ type: 'text', text: 'Reflowable' }] },
            { content: [{ type: 'text', text: 'Zip of XHTML' }] },
          ],
        },
        {
          cells: [
            { content: [{ type: 'text', text: '640 KB' }], align: 'right' },
            { content: [{ type: 'text', text: 'Fixed layout' }], colspan: 2, align: 'center' },
          ],
        },
        {
          cells: [
            { content: [{ type: 'text', text: 'Article' }], header: true },
            { content: [{ type: 'text', text: '48 KB' }], align: 'right' },
            { content: [{ type: 'text', text: 'Structured JSON, stored once' }] },
            { content: [{ type: 'text', text: 'Rendered by the reader' }] },
          ],
        },
      ],
    },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Math' }], anchor: 'math' },
    {
      type: 'math',
      tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
      mathml:
        '<math display="block"><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac><mtext onclick="alert(1)">.</mtext><mi href="javascript:alert(1)" style="color:red">⁣</mi><annotation-xml encoding="text/html"><img src="x" onerror="alert(1)"></annotation-xml></math>',
      text: 'x = (−b ± √(b² − 4ac)) / 2a',
    },
    { type: 'math', tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', text: 'integral of e^(-x^2) = sqrt(pi)/2' },
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'Definitions, details and callouts' }], anchor: 'more' },
    {
      type: 'definitions',
      items: [
        { term: [{ type: 'text', text: 'Measure' }], details: [{ type: 'paragraph', content: [{ type: 'text', text: 'The length of a line of text, ideally 60–75 characters.' }] }] },
        { term: [{ type: 'text', text: 'Leading' }], details: [{ type: 'paragraph', content: [{ type: 'text', text: 'The space between lines.' }] }] },
      ],
    },
    {
      type: 'details',
      summary: [{ type: 'text', text: 'Show the details' }],
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden until opened, like the page had it.' }] }],
    },
    { type: 'callout', variant: 'note', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note callout uses the theme blue.' }] }] },
    { type: 'callout', variant: 'tip', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'A tip is green.' }] }] },
    { type: 'callout', variant: 'info', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Info is cyan.' }] }] },
    { type: 'callout', variant: 'warning', title: [{ type: 'text', text: 'Careful' }], blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'A warning with its own title is orange.' }] }] },
    { type: 'callout', variant: 'danger', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Danger is pink.' }] }] },
    { type: 'callout', variant: null, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'An unstyled callout stays quiet.' }] }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'A second reference to the first note' }, { type: 'ref', id: 'n1', label: '1' }, { type: 'text', text: ' and one to another' }, { type: 'ref', id: 'n2', label: '2' }, { type: 'text', text: '.' }],
    },
    {
      type: 'footnotes',
      items: [
        { id: 'n1', label: '1', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'The first footnote. Its arrow returns to the reference you came from.' }] }] },
        { id: 'n2', label: '2', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'The second footnote, with a ' }, { type: 'text', text: 'link', href: 'https://example.org/' }, { type: 'text', text: '.' }] }] },
      ],
    },
  ],
};

/** A short right-to-left article. */
export const rtlArticle: Article = {
  ...everyBlock,
  url: 'https://example.org/ar/note',
  title: 'مقالة قصيرة من اليمين إلى اليسار',
  subtitle: null,
  byline: 'كاتب',
  siteName: 'مثال',
  language: 'ar',
  dir: 'rtl',
  leadImage: null,
  readingMinutes: 1,
  blocks: [
    { type: 'heading', level: 2, content: [{ type: 'text', text: 'عنوان' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'هذه فقرة باللغة العربية تُعرض من اليمين إلى اليسار، مع ' }, { type: 'text', text: 'رابط', href: 'https://example.org/' }, { type: 'text', text: ' في وسطها.' }] },
    { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'عنصر أول' }] }] }, { blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'عنصر ثان' }] }] }] },
    { type: 'quote', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'اقتباس قصير.' }] }] },
    { type: 'code', language: 'javascript', code: 'const dir = "rtl"; // code stays left to right' },
  ],
};
