/**
 * One build of the engine timed under Bun on jsdom documents, in a worker (its
 * own JavaScriptCore VM) so that the two builds `bench.ts` compares never share
 * a runtime. Messages: `{ engine }` (the build's `index.ts`) once, then
 * `{ html, url, runs }` per page, answered with the page's `Timing`.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHarness, type Engine, type Harness } from './compare-harness';

declare const self: Worker;

let harness: Harness | null = null;
let doc: Document | null = null;

self.onmessage = async (event: MessageEvent) => {
  const data = event.data as { engine: string } | { html: string; url: string; runs: number };
  if ('engine' in data) {
    const engine = (await import(data.engine)) as Engine;
    harness = createHarness({ base: engine, next: engine, parse: () => doc!, gc: () => Bun.gc(true) });
    self.postMessage('ready');
    return;
  }
  doc = new JSDOM(data.html, { virtualConsole: new VirtualConsole() }).window.document;
  harness!.load(data.html, data.url);
  const timing = harness!.time('next', data.runs);
  doc.defaultView?.close();
  doc = null;
  self.postMessage(timing);
};
