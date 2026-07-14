import assert from "node:assert/strict";
import test from "node:test";
import {
  readBoundedJsonObject,
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "../lib/request-body";

test("bounded JSON parsing accepts a small object", async () => {
  const value = await readBoundedJsonObject(
    new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    }),
    128,
  );

  assert.deepEqual(value, { ok: true });
});

test("an oversized stream remains a 413 decision when cancellation rejects", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(101));
    },
    cancel() {
      return Promise.reject(new Error("transport cancel failed"));
    },
  });
  const request = new Request("http://localhost/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedRequestBody(request, 100),
    RequestBodyTooLargeError,
  );
});

test("a slow request body has a hard read deadline", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedRequestBody(request, 100, 20),
    RequestBodyTimeoutError,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test("bounded JSON parsing stops an oversized chunked stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(48));
      controller.enqueue(new Uint8Array(48));
      controller.enqueue(new Uint8Array(48));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/test", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    readBoundedJsonObject(request, 100),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelled, true);
});

test("bounded JSON parsing rejects an excessive declared length immediately", async () => {
  const request = new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Length": "4097" },
    body: "{}",
  });

  await assert.rejects(
    readBoundedJsonObject(request, 4_096),
    RequestBodyTooLargeError,
  );
  assert.equal(request.bodyUsed, true);
});
