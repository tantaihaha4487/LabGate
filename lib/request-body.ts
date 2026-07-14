export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 413,
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export class RequestBodyTooLargeError extends RequestBodyError {
  constructor(readonly maximumBytes: number) {
    super(`Request body exceeds the ${maximumBytes}-byte limit.`, 413);
    this.name = "RequestBodyTooLargeError";
  }
}

export class RequestBodyTimeoutError extends RequestBodyError {
  constructor(readonly timeoutMilliseconds: number) {
    super(`Request body was not received within ${timeoutMilliseconds} ms.`, 408);
    this.name = "RequestBodyTimeoutError";
  }
}

export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 5_000;

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort cleanup. It must never replace the bounded
    // parser's original size, timeout, or stream-read decision.
  }
}

export async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  timeoutMilliseconds = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("A positive request-body byte limit is required.");
  }
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError("A positive request-body timeout is required.");
  }

  const contentLength = request.headers.get("content-length");

  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);

    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      try {
        void request.body?.cancel().catch(() => undefined);
      } catch {
        // Preserve the deterministic 413 even if transport cleanup fails.
      }
      throw new RequestBodyTooLargeError(maximumBytes);
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const readOperation = (async () => {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        throw new RequestBodyTooLargeError(maximumBytes);
      }
      chunks.push(value);
    }
  })();

  try {
    await Promise.race([
      readOperation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new RequestBodyTimeoutError(timeoutMilliseconds)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } catch (error: unknown) {
    cancelReader(reader);
    if (error instanceof RequestBodyError) {
      throw error;
    }
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after best-effort cancel.
    }
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export async function readBoundedJsonObject(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown> | null> {
  const body = await readBoundedRequestBody(request, maximumBytes);

  if (body === null) {
    return null;
  }

  let text: string;

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }

  if (!text.trim()) {
    return null;
  }

  let value: unknown;

  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
