/**
 * Writes the cases url_test.go checks the Go port against, with the
 * TypeScript engine's answers (oracle.ts):
 *
 *   bun testdata/url/gen.ts <test-corpus/parity> [urltestdata.json IdnaTestV2.json]
 *
 * - cases.json.gz: a sample of the corpus's URL attribute values against
 *   their page URLs (every unusual one, the rest at random), the page URLs,
 *   the security test cases, hand-written WHATWG edge cases against a range
 *   of bases, the web-platform-tests URL inputs, and corpus values with
 *   random mutations (whitespace, controls, slashes, dots, ports, hosts);
 * - idna.json.gz: the web-platform-tests IDNA inputs as hosts, which the Go
 *   port's approximation of the UTS #46 tables does not all match (NFC and
 *   rarer compatibility mappings). Mutations therefore never insert `xn--`,
 *   whose Punycode would decode to arbitrary code points.
 *
 * The web-platform-tests files are url/resources/urltestdata.json and
 * url/resources/IdnaTestV2.json from https://github.com/web-platform-tests/wpt.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { answer, type Questions } from './oracle';
import { collect } from './corpus';

const [corpusDir, wptUrls, wptIdna] = process.argv.slice(2);
if (corpusDir === undefined) throw new Error('usage: bun gen.ts <test-corpus/parity> [urltestdata.json IdnaTestV2.json]');

// A seeded generator, so the cases only change with the corpus.
let seed = 0x2545f491;
function random(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
function sample<T>(xs: readonly T[], n: number): T[] {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

const questions: Questions = { resolve: [], urls: [] };
const seen = new Set<string>();
function ask(base: string, href: string) {
  const key = base + '\u0000' + href;
  if (seen.has(key)) return;
  seen.add(key);
  questions.resolve.push([base, href]);
}
const seenUrls = new Set<string>();
function askUrl(url: string) {
  if (seenUrls.has(url)) return;
  seenUrls.add(url);
  questions.urls.push(url);
}

// ------------------------------------------------------------------ corpus

const { pages, pairs } = collect(corpusDir);
const short = pairs.filter(([, v]) => v.length <= 1000);
const unusual = (v: string) => /[^A-Za-z0-9\-._~/?#&=:;,+!$*()]|%|\.\.|\.\/|^\/\/|:\d|^(?!https?:)[a-z][a-z0-9+.-]*:/i.test(v);
const odd = short.filter(([, v]) => unusual(v));
const plain = short.filter(([, v]) => !unusual(v));
const corpus = [...sample(odd, 1500), ...sample(plain, 600)];
for (const [base, value] of corpus) ask(base, value);
for (const page of pages) askUrl(page);

// ------------------------------------------------------------------ security-urls.test.ts

const example = 'https://example.com/a';
for (const href of [
  '\u0001javascript:alert(1)', ' \u0001\u001fJavaScript:alert(1)', 'java\tscript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end',
  'data:text/html,hi', '\u0001data:text/html,hi', 'web+evil:x', 'vbscript:x', 'blob:https://example.com/x', 'about:blank', 'mailto:a@b.c',
  '/next', 'mailto:a@b.png', '/full.png', '/big.jpg', 'file:///etc/', 'next', 'javascript:alert(document.domain)',
  'data:text/html,<script>alert(1)</script>//twitter.com/a/status/1', '/r/x/comments/1', 'https://twitter.com/jane/status/123456?ref_src=twsrc',
  'javascript://embed.ted.com/talks/x%0aalert(document.domain)', 'javascript://bandcamp.com/EmbeddedPlayer%0aalert(1)',
  'file:///etc/passwd#bandcamp.com/EmbeddedPlayer', '\u0001javascript://fast.wistia.net/embed/iframe/abc%0aalert(1)',
  '//player.twitch.tv/?channel=abc', 'https://cdn.example.com/clip.mp4', 'javascript:alert(1)', '/a.mp3', 'x', 'javascript:alert(3)',
  'https://w.soundcloud.com/player/?url=javascript%3Aalert(document.domain)',
  'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/123&color=ff5500',
  'https://evil.com:x@www.nytimes.com/story', 'https://www.nytimes.com@evil.com/story', 'https://evil.com/story',
  'https://datawrapper.de:x@evil.com/chart/', 'https://datawrapper.dwcdn.net/abc/1/', '1/../../../@evil?"><x',
]) {
  ask(example, href);
  ask('https://evil.com/a', href);
}
ask('https://w.soundcloud.com/player/?url=javascript%3Aalert(document.domain)', 'javascript:alert(document.domain)');
ask('https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/123&color=ff5500', 'https://api.soundcloud.com/tracks/123');
for (const url of ['https://example.com/a', 'https://evil.com/a', 'https://evil.com/a?utm_source=x', 'https://evil.com:x@www.nytimes.com/story', 'https://www.nytimes.com@evil.com/story', 'https://datawrapper.de:x@evil.com/chart/']) askUrl(url);

// ------------------------------------------------------------------ WHATWG edge cases

// Every edge case against the core bases; relative references against the rest too.
const coreBases = [
  'https://example.com/a/b/c.html?q=1#f', 'http://example.com', 'https://user:pass@example.com/p', 'http://[::1]:8080/a', 'file:///C:/dir/file',
  'foo://host/a/b', 'data:text/plain,x', '',
];
const moreBases = [
  'https://example.com:8443/dir/', 'http://192.168.0.1/x/y', 'https://xn--fa-hia.de/a', 'https://example.com/a?b', 'https://example.com/%7Euser/',
  'https://EXAMPLE.com/A/./b/../C', 'file:///etc/x', 'foo:/a/b', 'foo://u@h', 'foo://u@h?q', 'mailto:a@b.c', 'about:blank', 'javascript:void(0)',
  'sc://h', 'not a url', '//example.com/x', 'http:', 'https://', 'http://a b/',
];
const relative = [
  '', ' ', '.', '..', './', '../', '../..', '../../../../x', './x', 'a/./b', 'a/../b', 'a/%2e/b', 'a/%2E%2e/b', 'a/.%2e/b', 'a/%2e./b', '/./', '/../',
  '/a/b/..', '/a/b/.', '/a/b/%2e', '/a//b', '//', '///', '////x', '/\\x', '\\x', '\\\\x', '\\\\x\\y', 'a\\b', '/..//x', '.../x', '..x', 'x..',
  '?', '?q', '??', '?#', '#', '#f', '##', '#f#g', '?q#f', 'x?y#z', '/?', '/#', ';x', ';', 'x;y', '%', '%zz', '%2', '%2F', '%2f/x', 'x%00y', 'a b',
  '//u@h?x', '//@h#x', 'c:/x', 'C|/x', '/c:/x',
];
const edges = [
  ...relative,
  // Schemes.
  'http:', 'http:x', 'http:/x', 'http://x', 'http:\\\\x', 'http:/\\x', 'HTTP://X.COM', 'HtTpS://x.com/A', 'https:x', 'https:/x', 'ftp://x/y',
  'ws://x', 'wss://x:443/', 'ws://x:80', 'ftp://x:21/', 'file:', 'file:x', 'file:/x', 'file://x/y', 'file:///x', 'file:////x', 'file://localhost/x',
  'file://LOCALHOST/x', 'file:c:/x', 'file:c|/x', 'file:///c|/x', 'file://c:/x', 'file:/c:/../..', 'file:..', 'file:?q', 'file:#f', 'c:/x',
  'C|/x', '/c:/x', 'foo:', 'foo:x', 'foo:/x', 'foo://x', 'foo://x:80/', 'foo://', 'foo:///x', 'foo://@x', 'foo://x/./y/../z', 'foo:/.//x',
  'foo:/..//x', 'foo:x y', 'foo:x ?y', 'foo:x  #y', 'foo:x\u0000', 'foo:\u00e9', 'foo://\u00e9/', 'foo://[::1]/', 'foo://[x]/', 'foo://a b/',
  'foo://a%20b/', 'foo://a<b/', 'foo://a^b/', 'mailto:a@b.c', 'MAILTO:A@B.C', 'mailto:', 'tel:+1 555', 'tel:+1%20555', 'TEL:123',
  'javascript:alert(1)', 'JaVaScRiPt:x', 'java\nscript:x', 'java\u0000script:x', '\u0000javascript:x', ' javascript:x', 'jav&#x09;ascript:x',
  'data:,x', 'DATA:image/png;base64,AAAA', ' data:x', '\u00a0data:x', 'data :x', 'vbscript:x', 'blob:https://a/b', 'about:blank', 'a:', 'a1+.-:x',
  '1a:x', '+a:x', 'a_b:x', 'a b:x', 'é:x', 'web+x:y', 'sc:\\../', 'sc::a@example.net', 'sc:/.//p', 'non-spec:/..//p',
  // Authority, userinfo and ports.
  '//x', '//x/y', '//x:1/', '//X.COM', '\\\\x\\y', '//@x', '//u@x', '//u:p@x', '//u:@x', '//:p@x', '//:@x', '//u@', '//@', '//a@b@c',
  '//a:b:c@d', 'foo://u@h?x', 'foo://@h#x', 'foo://u@h:1?x', 'foo://u@h', 'sc://u:p@h?x#y', '//a%40b@c', '//u\u00e9:p\u00e9@x', '//u p@x', '//u"<>@x', '//x:', '//x:80', '//x:080', '//x:0', '//x:65535', '//x:65536',
  '//x:99999999999999999999', '//x:-1', '//x:1a', '//x: 1', '//x:1:2', 'http://x:443/', 'https://x:443/', 'https://x:80/', 'http://x:80/',
  'https://x:0443/', 'http://x.com:8080', 'http://x.com:8080?q', 'http://x.com#f', 'http://x.com?q', 'http://x.com/?q#f',
  // Hosts.
  'http://', 'http:///', 'http://x/', 'http://X.Com/', 'http://x./', 'http://x../', 'http://.x/', 'http://../', 'http://./', 'http://x..y/',
  'http://-x-/', 'http://x_y/', 'http://x*y/', 'http://x$y/', 'http://x!y/', 'http://x y/', 'http://x%20y/', 'http://x%2fy/', 'http://x%2Ey/',
  'http://x%41/', 'http://%41.com/', 'http://x%/', 'http://x%zz/', 'http://x%00/', 'http://x\u0000y/', 'http://x\u001fy/', 'http://x\u007fy/',
  'http://x<y/', 'http://x>y/', 'http://x^y/', 'http://x|y/', 'http://x[y/', 'http://x]y/', 'http://x\\y/', 'http://x{y/', 'http://x"y/',
  "http://x'y/", 'http://x`y/', 'http://x~y/', 'http://x=y/', 'http://x;y/', 'http://x,y/', 'http://x&y/', 'http://x+y/', 'http://x(y)/',
  // IPv4.
  'http://1.2.3.4/', 'http://1.2.3.4./', 'http://1.2.3.4../', 'http://1.2.3/', 'http://1.2/', 'http://1/', 'http://0/', 'http://4294967295/',
  'http://4294967296/', 'http://0xffffffff/', 'http://0x100000000/', 'http://0xFF.0x0.0X0.0x1/', 'http://0x/', 'http://0x./', 'http://0X.0x/',
  'http://00/', 'http://010/', 'http://08/', 'http://0377.0377.0377.0377/', 'http://0400.0.0.0/', 'http://256.0.0.1/', 'http://1.256.0.1/',
  'http://1.2.3.256/', 'http://1.2.65536/', 'http://1.2.65535/', 'http://1.16777215/', 'http://1.16777216/', 'http://1.2.3.4.5/',
  'http://1.2.3.4.5./', 'http://1..2/', 'http://.1.2/', 'http://1.2.3.09/', 'http://a.1/', 'http://1.a/', 'http://a.0x1/', 'http://a.0x/',
  'http://a.09/', 'http://a.1e/', 'http://1e/', 'http://0x1g/', 'http://%30/', 'http://%31.%32/', 'http://0x7f.1/', 'http://127.1/',
  'http://999999999999999999999/', 'http://0x999999999999999999/', 'http://00000000000000000000001/', 'http://１２７.０.０.１/',
  // IPv6.
  'http://[::]/', 'http://[::1]/', 'http://[::1]:80/', 'http://[::1]:81/', 'http://[1::]/', 'http://[1:2:3:4:5:6:7:8]/', 'http://[1:2:3:4:5:6:7:8:9]/',
  'http://[1:2:3:4:5:6:7]/', 'http://[1:2:3:4:5:6::7]/', 'http://[1::2::3]/', 'http://[:1]/', 'http://[1:]/', 'http://[::ffff:1.2.3.4]/',
  'http://[::1.2.3.4]/', 'http://[::1.2.3]/', 'http://[::1.2.3.4.5]/', 'http://[::1.2.3.256]/', 'http://[::01.2.3.4]/', 'http://[1:2:3:4:5:6:1.2.3.4]/',
  'http://[1:2:3:4:5:6:7:1.2.3.4]/', 'http://[0:0:0:0:0:0:0:0]/', 'http://[0:1:0:0:1:0:0:0]/', 'http://[1:0:0:2:0:0:0:3]/', 'http://[1:0:2:0:3:0:4:0]/',
  'http://[ABCD:EF01::]/', 'http://[00001::]/', 'http://[0001::]/', 'http://[::%31]/', 'http://[::1%25eth0]/', 'http://[::1]x/', 'http://[::1/',
  'http://::1]/', 'http://[]/', 'http://[/', 'http://]/', 'http://[::1]:/', 'http://[::1]:99999/', 'http://u@[::1]/', 'http://[g::]/', 'http://[::.1]/',
  // IDNA.
  'http://ÉXAMPLE.com/', 'http://faß.de/', 'http://FASS.de/', 'http://xn--fa-hia.de/', 'http://XN--FA-HIA.DE/', 'http://xn--/', 'http://xn--a/',
  'http://xn--zca/', 'http://xn---zca/', 'http://xn--zca-/', 'http://xn--abc-/', 'http://a.xn--/', 'http://xn--n3h.net/', 'http://☃.net/',
  'http://%e2%98%83.net/', 'http://%E2%98%83.NET/', 'http://%ff/', 'http://%c3/', 'http://%c3%a9/', 'http://例え.テスト/', 'http://中国.cn/',
  'http://日本語。ｊｐ/', 'http://ＡＢＣ．ｃｏｍ/', 'http://a\u3002b/', 'http://a\uff0eb/', 'http://a\uff61b/', 'http://a\u200bb/', 'http://a\u00adb/',
  'http://\u00ad/', 'http://a\u200cb/', 'http://a\u200db/', 'http://a\u2060b/', 'http://a\ufeffb/', 'http://a\u00a0b/', 'http://a\u3000b/',
  'http://a\u2028b/', 'http://a\u200eb/', 'http://a\ufffdb/', 'http://a\ue000b/', 'http://ıstanbul.tr/', 'http://İstanbul.tr/', 'http://ſ.de/',
  'http://Σ.gr/', 'http://σ.gr/', 'http://ς.gr/', 'http://µ.de/', 'http://ẞ.de/', 'http://Ꭰ.us/', 'http://ꭰ.us/', 'http://Ⅸ.com/', 'http://ǅ.com/',
  'http://рф.рф/', 'http://ПРИМЕР.РФ/', 'http://xn--80aaaa1bhnclcci1cl5c4ep.xn--p1ai/', 'http://xn--e1afmkfd.xn--p1ai/', 'http://münchen.de/',
  'http://MÜNCHEN.de/', 'http://xn--mnchen-3ya.de/', 'http://xn--mnchen-3ya.de./', 'http://müller.example.com:8080/a?b#c', 'http://u:p@müller.de/',
  'http://مثال.إختبار/', 'http://مثال.com/', 'http://مثال.1com/', 'http://a.مثال/', 'http://aمثال.com/', 'http://مثال1.com/', 'http://مثال١.com/',
  'http://١.com/', 'http://א.com/', 'http://אב/', 'http://א1/', 'http://1א/', 'http://אa/', 'http://א\u05b0/', 'http://\u05b0א/', 'http://\u0301a/',
  'http://क्\u200d/', 'http://क्\u200c/', 'http://م\u200cل/', 'http://ا\u200cل/', 'http://\u200cx/', 'http://xn--1ug/',
  'http://💩.la/', 'http://xn--ls8h.la/', 'http://ü.xn--zca.de/', 'http://-ü-.de/', 'http://ü--x.de/', 'http://x.ü/', 'http://ü./', 'http://.ü/',
  'http://ü..x/', 'http://ü:80/', 'http://ü%2e.x/', 'http://ü%2fx/', 'http://ü x/', 'http://' + 'ü'.repeat(70) + '.de/', 'http://' + 'a'.repeat(300) + '/',
  'http://é.1/', 'http://é.0x1/', 'http://1.é/', 'http://é1.2/',
  // Percent-encoding sets.
  '/ !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~', '?q !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~', '# !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~',
  'foo:/ !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~', 'foo:x?q !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~', 'foo:x# !"#$%&\'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~',
  'http://u !"$&\'()*+,-.;<=>AZ[]^_`az{|}~:p !"$&\'()*+,-.;<=>AZ[]^_`az{|}~@h/', '/\u0000\u0001\u001f\u007f\u0080\u00ff', '?\u0000\u0001\u001f\u007f\u0080',
  '#\u0000\u0001\u001f\u007f\u0080', '/é?é#é', '/中文?中文#中文', '/💩?💩#💩', '/\ud800', '?\udc00', '#\ud83d', '/\ufffd', '/%e9', '/%C3%A9', "/?'", "?'", "#'",
  'foo:/?\'', 'foo:x?\'', '/^', '/|', '/{}', '/`', '?`', '#`', '?^', '#^', '/a b', '/a\tb', '/a\nb', '/a\rb', '/a\fb', '/a\u000bb', ' /a ', '\t/a\n',
  '\u0000/a\u0000', '\u001f/a\u0020', '\u00a0/a', '/a\u00a0', '\ufeff/a', '/a\ufeff', '\u3000/a', '/a\u2028', '\u2029/a',
];
for (const base of coreBases) for (const input of edges) ask(base, input);
for (const base of moreBases) for (const input of relative) ask(base, input);

if (wptUrls !== undefined) {
  for (const t of JSON.parse(readFileSync(wptUrls, 'utf8')) as unknown[]) {
    if (typeof t !== 'object' || t === null || !('input' in t)) continue;
    const { input, base } = t as { input: string; base: string | null };
    ask(base ?? 'https://example.com/a', input);
    ask(example, input);
  }
}

// ------------------------------------------------------------------ mutations

const palette = [
  '\t', '\n', '\r', ' ', '  ', '\\', '/', '//', '%', '%2e', '%2E', '.', '..', '/..', '/.', '#', '?', '@', ':', '[', ']', '^', '|', '`', '{', '}', '"', "'",
  '<', '>', '\u0000', '\u0001', '\u001f', '\u007f', '\u0080', '\u00a0', '\u3000', '\ufeff', '\u2028', 'é', 'É', 'ß', '中', '💩', '\u200b', '\u00ad',
  '0x', '0', '1', '9', 'A', 'Z', '~', '&', '=', ';', '+', ',', '%20', '%41', '%c3%a9', '%zz', ':80', ':443', ':8080', ':', ':0', ':99999', 'u:p@',
  '@', '127.0.0.1', '0x7f.1', '[::1]', 'utm_source=x&', '&ref=1', '#!',
];
const schemes = ['https:', 'http:', 'HTTP:', 'Https:', 'foo:', 'file:', 'javascript:', 'data:', 'mailto:', 'tel:', '', ' ', 'ht tp:', 'ws:'];
function mutate(value: string): string {
  let v = value;
  const edits = 1 + Math.floor(random() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(random() * (v.length + 1));
    switch (Math.floor(random() * 5)) {
      case 0:
        v = v.slice(0, at) + pick(palette) + v.slice(at);
        break;
      case 1:
        v = v.slice(0, at) + pick(palette) + v.slice(at + 1);
        break;
      case 2:
        v = v.slice(0, at) + v.slice(at + 1 + Math.floor(random() * 4));
        break;
      case 3:
        v = v.replace(/^[a-z][a-z0-9+.-]*:/i, pick(schemes));
        break;
      default: {
        // Change the host.
        const m = /^([a-z]+:\/\/)([^/?#]*)(.*)$/is.exec(v);
        if (m !== null) v = m[1] + pick(['', 'u:p@', '@', 'WWW.']) + (random() < 0.5 ? m[2]!.toUpperCase() : pick(['127.1', '[::1]', '0x7f.0.0.1', 'xn--fa-hia.de', 'faß.de', 'a..b', 'a.', '%41.com', ''])) + pick(['', ':80', ':443', ':', ':x']) + m[3];
      }
    }
  }
  return v;
}
for (const [base, value] of sample(corpus.filter(([, v]) => v.length <= 300), 1500)) ask(base, mutate(value));

// ------------------------------------------------------------------ hostOf and canonicalUrl

for (const url of [
  'https://user:pass@www.Example.com:80/x', 'HTTP://WWW.A.COM', 'https://a@b@c/', 'https://a@:80/', 'https://a@b@:80/', 'https://:x@h/', 'https://@h',
  'https://h@', 'https://:80', 'https://@:80', 'mailto:a@b.c', 'https://x.com/?utm_source=a&b=1&UTM_MEDIUM=2&ref=x&&c#frag', 'https://x.com/?',
  'https://x.com/?&', 'https://x.com/?=', 'https://x.com/?utm_=1', 'https://x.com/?utm_Ab_c=1', 'https://x.com/?utm_a1=1', 'https://x.com/?utm_ſ=1',
  'https://x.com/?ſhare=1', 'https://x.com/?SHARE', 'https://x.com/?shares=1', 'https://x.com/?Guce_Referrer_Sig=1&a', 'https://x.com/#?utm_source=1',
  'https://x.com/a?b#c?d', 'https://ⓌⓌⓌ.x/', 'https://WWW.İ.com/', 'https://www./', 'https://www.', 'https://wwww.x/', 'https://www.www.x/',
  '1http://x', 'ht~tp://x', 'h+.-://x', 'http:/x', 'http://', 'http:///x', 'h://@', 'h://@/', 'h://x?y', 'h://x#y', 'h://ÀÉ.com', 'h://Σ.gr',
  'https://x.com/?a=1&utm_source=2', 'https://x.com/?utm_source=2&a=1', 'https://x.com/?fbclid', 'https://x.com/?fbclid=1=2', 'https://x.com/?=fbclid',
  'https://x.com/?a&&&b', 'https://x.com/?&a', 'https://x.com?ref_src=twsrc%5Etfw', 'https://x.com/p?via=y#z', '', '?', '#', '?utm_source=x', 'a?b&c',
]) askUrl(url);
const resolved = answer({ resolve: questions.resolve, urls: [] }).resolve.flatMap(([, , url]) => (url !== null && url.length <= 1000 ? [url] : []));
for (const url of sample([...new Set(resolved)], 2000)) askUrl(url);

const out = answer(questions);
const here = import.meta.dir;
await Bun.write(resolve(here, 'cases.json.gz'), Bun.gzipSync(JSON.stringify(out) + '\n', { level: 9 }));
console.log(`cases.json.gz: ${out.resolve.length} resolutions, ${out.urls.length} URLs`);

if (wptIdna !== undefined) {
  const idna: Questions = { resolve: [], urls: [] };
  for (const t of JSON.parse(readFileSync(wptIdna, 'utf8')) as unknown[]) {
    if (typeof t !== 'object' || t === null || !('input' in t)) continue;
    idna.resolve.push([example, 'https://' + (t as { input: string }).input + '/x']);
  }
  const answers = answer(idna);
  await Bun.write(resolve(here, 'idna.json.gz'), Bun.gzipSync(JSON.stringify(answers) + '\n', { level: 9 }));
  console.log(`idna.json.gz: ${answers.resolve.length} hosts`);
}
