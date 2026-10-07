import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/** The page script's API as seen from Node (it lives on `globalThis.evalPage` in the renderer). */
export type PageApi = Pick<typeof import('./page'), 'load' | 'runEngine' | 'timeMarkdown' | 'benchPipeline' | 'benchKeep' | 'summarizeHtml' | 'summarizeArticle' | 'pageText' | 'pageBlocks' | 'meta'>;

/** Bundles `src/page.ts` (and the engine sources it imports, live) into one browser script. */
export async function bundlePage(): Promise<string> {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, 'page.ts')], target: 'browser', format: 'iife' });
  if (!build.success) throw new AggregateError(build.logs, 'page bundle failed');
  return build.outputs[0].text();
}

export class TimeoutError extends Error {}

interface Worker {
  index: number;
  context: BrowserContext;
  page: Page;
}

/**
 * Headless Chromium with one isolated context (own origin, own renderer
 * process) per worker. Pages are cross-origin isolated so `performance.now()`
 * has 5µs resolution instead of 100µs.
 */
export class BrowserPool {
  private constructor(
    private browser: Browser,
    private script: string,
    private workers: Worker[],
  ) {}

  /** `args`: extra Chromium flags. */
  static async open(size: number, script?: string, args: string[] = []): Promise<BrowserPool> {
    const browser = await chromium.launch({ args });
    const pool = new BrowserPool(browser, script ?? (await bundlePage()), []);
    pool.workers = await Promise.all(Array.from({ length: size }, (_, index) => pool.openWorker(index)));
    return pool;
  }

  private async openWorker(index: number): Promise<Worker> {
    const context = await this.browser.newContext();
    const origin = `http://w${index}.localhost`;
    const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
    await context.route(`${origin}/**`, (route) =>
      route.request().url().endsWith('/page.js')
        ? route.fulfill({ contentType: 'text/javascript', headers, body: this.script })
        : route.fulfill({ contentType: 'text/html', headers, body: '<!doctype html><meta charset="utf-8"><title>eval</title><script src="/page.js"></script>' }),
    );
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`[w${index}] ${error.message}`));
    await page.goto(`${origin}/`);
    return { index, context, page };
  }

  /** Calls a page API function in a worker's renderer, failing with `TimeoutError` after `timeoutMs`. */
  async call<K extends keyof PageApi>(worker: Worker, name: K, args: Parameters<PageApi[K]>, timeoutMs = 120_000): Promise<ReturnType<PageApi[K]>> {
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return (await Promise.race([
        worker.page.evaluate(([fn, list]) => (globalThis as any).evalPage[fn](...list), [name, args] as const),
        timeout,
      ])) as ReturnType<PageApi[K]>;
    } catch (error) {
      if (error instanceof TimeoutError) await this.replace(worker);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async replace(worker: Worker): Promise<void> {
    await worker.context.close().catch(() => {});
    const fresh = await this.openWorker(worker.index);
    worker.context = fresh.context;
    worker.page = fresh.page;
  }

  /** Runs `task` over `items` with every worker pulling from one queue; results keep input order. */
  async map<T, R>(items: T[], task: (worker: Worker, item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    await Promise.all(
      this.workers.map(async (worker) => {
        for (let index = next++; index < items.length; index = next++) results[index] = await task(worker, items[index], index);
      }),
    );
    return results;
  }

  version(): string {
    return this.browser.version();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
