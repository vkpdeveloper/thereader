import {
  PdfError,
  type Document,
  type Options,
  type Stats,
  type Warning,
} from "./model";

export interface BrowserOptions extends Options {
  /** Supply a bundled worker URL from your application, e.g. Vite's ?worker. */
  workerFactory: () => Worker;
}
export interface WorkerResult<T> {
  result: T;
  stats: Stats;
  warnings: Warning[];
  complete: boolean;
}
export type ResultFormat = "document" | "markdown" | "epub";
export type FormatResult<F extends ResultFormat> = F extends "epub"
  ? Uint8Array
  : F extends "markdown"
    ? string
    : Document;

/** One isolated worker per job. Aborting or reaching the deadline terminates it. */
export async function extractInWorker<F extends ResultFormat>(
  bytes: Uint8Array,
  format: F,
  options: BrowserOptions,
): Promise<WorkerResult<FormatResult<F>>> {
  const {
    workerFactory,
    signal,
    timeoutMs = 65_000,
    limits,
    keepArtifacts,
  } = options;
  if (signal?.aborted)
    throw new PdfError("ABORTED", "PDF extraction cancelled");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new PdfError(
      "INVALID_REQUEST",
      "A positive worker deadline is required.",
    );
  if (bytes.byteLength > (limits?.inputBytes || 64 * 1024 * 1024))
    throw new PdfError("RESOURCE_LIMIT", "PDF input exceeds the byte limit.");
  return new Promise((resolve, reject) => {
    const worker = workerFactory();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, value?: WorkerResult<FormatResult<F>>) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () =>
      finish(new PdfError("ABORTED", "PDF extraction cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () =>
        finish(
          new PdfError(
            "TIMEOUT",
            "PDF extraction exceeded the worker deadline",
          ),
        ),
      timeoutMs,
    );
    worker.onmessage = ({ data }) => {
      if (data?.id !== 1) return;
      if (data.error) finish(new PdfError(data.error.code, data.error.message));
      else finish(undefined, data);
    };
    worker.onerror = () =>
      finish(
        new PdfError(
          "WORKER_FAILED",
          "The PDF extraction worker could not run.",
        ),
      );
    worker.onmessageerror = () =>
      finish(
        new PdfError(
          "WORKER_FAILED",
          "The PDF extraction result could not be read.",
        ),
      );
    try {
      // Preserve the caller's input and transfer only this job's owned buffer.
      const owned = bytes.slice();
      worker.postMessage(
        {
          id: 1,
          bytes: owned.buffer,
          format,
          options: { limits, keepArtifacts, timeoutMs },
        },
        [owned.buffer],
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
