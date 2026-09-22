export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

export function errorResponse(error: ApiError, head = false): Response {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(
    head
      ? null
      : JSON.stringify({
          error: { code: error.code, message: error.message },
        }),
    { status: error.status, headers },
  );
}
