// Diagnostic host RSS/CPU for one iOS simulator runtime. Includes WebContent
// helpers, unlike Runner-only readings. Close other apps on this runtime first.
// bun scripts/observe-simulator.ts artifacts/private/memory.jsonl iOS_23F77
const output = process.argv[2];
const runtime = process.argv[3];
if (!output || !runtime) throw new Error('Pass output JSONL and simulator runtime tag');
const writer = Bun.file(output).writer();
let running = true;
process.on('SIGINT', () => { running = false; });
while (running) {
  const child = Bun.spawn(['ps', '-axo', 'pid=,rss=,%cpu=,comm='], { stdout: 'pipe' });
  const rows = (await new Response(child.stdout).text()).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), rssKiB: Number(match[2]), cpu: Number(match[3]), path: match[4]! } : null;
  }).filter(row => row && (row.path.includes('Runner.app/Runner') ||
    (row.path.includes(runtime) && row.path.endsWith('com.apple.WebKit.WebContent'))));
  writer.write(JSON.stringify({ at: new Date().toISOString(),
    runner: rows.filter(row => row!.path.includes('Runner.app/Runner')).map(({pid, rssKiB, cpu}: any) => ({pid,rssKiB,cpu})),
    web: rows.filter(row => row!.path.endsWith('WebContent')).map(({pid, rssKiB, cpu}: any) => ({pid,rssKiB,cpu})),
  }) + '\n');
  await writer.flush();
  await Bun.sleep(500);
}
await writer.end();
