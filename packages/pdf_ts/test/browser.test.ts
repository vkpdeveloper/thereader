import { expect, test } from "bun:test";
import { extractInWorker } from "../src/browser";

class FakeWorker {
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminated = false;
  posted?: any;
  postMessage(data: unknown) {
    this.posted = data;
  }
  terminate() {
    this.terminated = true;
  }
}
test("worker deadline terminates a stuck extraction", async () => {
  const worker = new FakeWorker();
  await expect(
    extractInWorker(new Uint8Array([1]), "markdown", {
      workerFactory: () => worker as unknown as Worker,
      timeoutMs: 5,
    }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(worker.terminated).toBe(true);
});
test("cancellation terminates the worker and preserves input ownership", async () => {
  const worker = new FakeWorker(),
    controller = new AbortController(),
    input = new Uint8Array([1, 2, 3]);
  const result = extractInWorker(input, "document", {
    workerFactory: () => worker as unknown as Worker,
    signal: controller.signal,
  });
  expect(worker.posted.bytes).not.toBe(input.buffer);
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: "ABORTED" });
  expect(worker.terminated).toBe(true);
  expect([...input]).toEqual([1, 2, 3]);
});
test("success and malformed worker messages are isolated by job ID", async () => {
  const worker = new FakeWorker();
  const result = extractInWorker(new Uint8Array([1]), "markdown", {
    workerFactory: () => worker as unknown as Worker,
  });
  worker.onmessage!({ data: { id: 9, result: "wrong" } });
  expect(worker.terminated).toBe(false);
  worker.onmessage!({ data: { id: 1, result: "right" } });
  expect((await result).result).toBe("right");
  expect(worker.terminated).toBe(true);
});
