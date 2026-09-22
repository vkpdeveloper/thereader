import { ApiError } from "./errors";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readBoundedJson(request: Request, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    }
    if (length > maximumBytes) throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
  }
  if (request.body === null) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ApiError(413, "REQUEST_TOO_LARGE", "Request body is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }
}

export function canonicalIsoDate(value: unknown, futureLimitMs?: number): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (match === null) return null;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const millisecondIso = `${match[1]}.${fraction.slice(0, 3)}Z`;
  const milliseconds = Date.parse(millisecondIso);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== millisecondIso) return null;
  if (!Number.isSafeInteger(milliseconds * 1_000 + Number(fraction.slice(3, 6)))) return null;
  if (futureLimitMs !== undefined && milliseconds > futureLimitMs) return null;
  return value;
}

export function isoTimestampOrder(value: string): number {
  const fraction = /\.(\d{1,6})Z$/.exec(value)?.[1]?.padEnd(6, "0") ?? "000000";
  return Date.parse(value) * 1_000 + Number(fraction.slice(3, 6));
}
