// Normal installed app, no Flutter integration-test frame scheduling.
// Prepare the three corpus downloads and leave Library visible before running.
// IDB=/path/to/idb bun scripts/measure-cached-ios.ts <simulator-udid> [ignored-output-dir]
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const udid = process.argv[2];
if (!udid) throw new Error('Pass an iOS simulator UDID');
const output = resolve(process.argv[3] ?? 'artifacts/private/readable-poll');
await mkdir(output, { recursive: true });
const events: object[] = [];
const idb = process.env.IDB ?? 'idb';

async function ui(...args: string[]) {
  const child = Bun.spawn([idb, 'ui', ...args, '--udid', udid], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(child.stdout).text();
  if (await child.exited) throw new Error(await new Response(child.stderr).text());
  return text;
}

async function tap(x: number, y: number, label: string) {
  events.push({ event: 'tap', label, at: new Date().toISOString(), x, y });
  await ui('tap', String(Math.round(x)), String(Math.round(y)));
  await Bun.sleep(700);
}

async function tapLabel(label: string) {
  const elements = JSON.parse(await ui('describe-all', '--json'));
  const element = elements.find((e: any) => e.AXLabel?.includes(label) && e.frame.height > 0);
  if (!element) throw new Error(`No visible element: ${label}. Prepare the corpus Library first.`);
  const { x, y, width, height } = element.frame;
  await tap(x + width / 2, y + height / 2, label);
}

try {
  for (let cycle = 0; cycle < 2; cycle++) {
    for (const role of ['large', 'long-chapter', 'typical']) {
      // Clock deliberately starts before AX lookup/tap. Screenshot completion
      // is a conservative upper bound, not an exact first-paint timestamp.
      const start = Bun.nanoseconds();
      await tapLabel(`Corpus · ${role} by`);
      for (let frame = 0; frame < 6; frame++) {
        const beforeMs = (Bun.nanoseconds() - start) / 1e6;
        const path = resolve(output, `${role}-${cycle}-${frame}.png`);
        const capture = Bun.spawn(['xcrun', 'simctl', 'io', udid, 'screenshot', path],
          { stdout: 'ignore', stderr: 'pipe' });
        if (await capture.exited) throw new Error(await new Response(capture.stderr).text());
        events.push({ role, cycle, frame, path, beforeMs, afterMs: (Bun.nanoseconds() - start) / 1e6 });
        await Bun.sleep(200);
      }
      await tap(200, 437, 'show controls'); // iPhone 17 logical coordinates
      await tapLabel('Close book');
    }
  }
} finally {
  await Bun.write(resolve(output, 'events.json'), JSON.stringify(events, null, 2));
}
console.log(`Inspect screenshots for the first actual body text; use its afterMs as an upper bound. ${output}`);
