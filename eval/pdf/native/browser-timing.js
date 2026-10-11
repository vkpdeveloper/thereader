// Invoke with an engine name in the evaluation page after worker builds.
window.benchmark = async (engine) => {
  const rows = [];
  for (const name of [
    "harness",
    "axler",
    "hefferon",
    "thinkpython",
    "calculus",
  ]) {
    const input = new Uint8Array(
        await (await fetch("/pdf/" + name + ".pdf")).arrayBuffer(),
      ),
      worker = new Worker("/" + engine + "-worker.js"),
      samples = [];
    for (let i = 0; i < 4; i++) {
      const bytes = input.slice(),
        start = performance.now();
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("timeout")), 65000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(Error(e.message));
        };
        worker.postMessage(
          { id: i + 1, bytes: bytes.buffer, format: "markdown" },
          [bytes.buffer],
        );
      });
      if (data.error) throw Error(JSON.stringify(data.error));
      samples.push({
        extractionMs: data.stats.durationMs,
        wallMs: performance.now() - start,
        pages: data.stats.pages,
      });
    }
    worker.terminate();
    rows.push({ name, samples });
    document.querySelector("#result").textContent = JSON.stringify(
      { engine, rows },
      null,
      2,
    );
  }
  return {
    engine,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    warmups: 1,
    repeats: 3,
    scope:
      "Input bytes in memory. Dedicated worker, first extraction recorded separately; measured samples 1–3 include structured content, images and Markdown. Wall time additionally includes messaging.",
    rows,
  };
};
