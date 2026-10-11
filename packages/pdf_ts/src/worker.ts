import { extract } from "./extract";
import { epub } from "./render";
import { PdfError, type Options } from "./model";

// No DOM, network, filesystem or Go runtime is used by the worker.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
scope.onmessage = ({ data }) => {
  const id = data?.id;
  try {
    if (
      !(data?.bytes instanceof ArrayBuffer) ||
      !["document", "markdown", "epub"].includes(data?.format)
    ) {
      throw new PdfError(
        "INVALID_REQUEST",
        "Expected PDF bytes and a result format.",
      );
    }
    const options: Options = {
      limits: data.options?.limits,
      keepArtifacts: data.options?.keepArtifacts,
      timeoutMs: data.options?.timeoutMs,
    };
    const doc = extract(new Uint8Array(data.bytes), options);
    if (data.format === "epub") {
      const bytes = epub(doc);
      scope.postMessage(
        {
          id,
          result: bytes,
          stats: doc.stats,
          warnings: doc.warnings,
          complete: doc.complete,
        },
        [bytes.buffer],
      );
    } else {
      const result = data.format === "markdown" ? doc.markdown : doc;
      scope.postMessage(
        {
          id,
          result,
          stats: doc.stats,
          warnings: doc.warnings,
          complete: doc.complete,
        },
        data.format === "document"
          ? [...new Set(doc.assets.map((a) => a.data.buffer as ArrayBuffer))]
          : [],
      );
    }
  } catch (error) {
    scope.postMessage({
      id,
      error: {
        code: error instanceof PdfError ? error.code : "EXTRACTION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
