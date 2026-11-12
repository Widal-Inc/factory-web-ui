import { afterEach, expect, it } from "bun:test";
import { apiFetch } from "./api-request-id.ts";
import { fetchHealth } from "./api.ts";
import { abandonNativeReads, getTransport, nativeTransport, serverResourceUrl, setTransport, type Transport } from "./transport.ts";

function testTransport(fetch: Transport["fetch"]): Transport {
  return {
    kind: "custom",
    fetch,
    openSocket: () => { throw new Error("no socket in this test"); },
    openEventSource: () => { throw new Error("no event stream in this test"); },
    resourceUrl: (path) => `custom:${path}`,
  };
}

afterEach(() => setTransport(nativeTransport));

it("the native transport loads a server path from the path itself", () => {
  expect(getTransport()).toBe(nativeTransport);
  expect(nativeTransport.resourceUrl("/api/fs/file?path=a")).toBe("/api/fs/file?path=a");
  expect(serverResourceUrl("/api/fs/file?path=a")).toBe("/api/fs/file?path=a");
});

it("only server paths go to the transport for an address", () => {
  const transport = testTransport(() => Promise.reject(new Error("unused")));
  expect(serverResourceUrl("/api/fs/file?path=a", transport)).toBe("custom:/api/fs/file?path=a");
  for (const url of ["data:image/png;base64,AAAA", "blob:http://localhost/1", "https://other.example/api/x.png", "/?read=a.md"]) {
    expect(serverResourceUrl(url, transport)).toBe(url);
  }
});

it("setTransport swaps what apiFetch sends through", async () => {
  // Given
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  setTransport(testTransport(async (input, init) => { calls.push({ input, init }); return Response.json({ ok: true }); }));
  // When
  const response = await apiFetch("/api/session", { cache: "no-store" });
  // Then
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(String(calls[0]?.input)).toBe("/api/session");
  expect(calls[0]?.init?.cache).toBe("no-store");
  expect(new Headers(calls[0]?.init?.headers).get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

it("a transport that refuses makes the API call reject with its error", async () => {
  // Given
  const refused = new Error("transport unreachable");
  setTransport(testTransport(() => Promise.reject(refused)));
  // When / Then
  await expect(fetchHealth()).rejects.toBe(refused);
});

it("gives up the reads in flight on the browser's own connections, not a write nor a read sent after", async () => {
  // Given: requests sent on connections the network lost, which never answer by themselves
  const original = globalThis.fetch;
  const signals = new Map<string, AbortSignal>();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    signals.set(String(input), init!.signal!);
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  })) as typeof fetch;
  try {
    const read = nativeTransport.fetch("/api/a");
    const write = nativeTransport.fetch("/api/b", { method: "POST" });
    void write.catch(() => undefined);
    // When
    abandonNativeReads();
    const later = nativeTransport.fetch("/api/c");
    void later.catch(() => undefined);
    // Then
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(signals.get("/api/b")?.aborted ?? false).toBe(false);
    expect(signals.get("/api/c")!.aborted).toBe(false);
    // the caller's own abort still reaches the request
    const own = new AbortController();
    const mine = nativeTransport.fetch("/api/d", { signal: own.signal });
    own.abort();
    await expect(mine).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = original;
  }
});

it("gives up only another PC's reads when that PC's connection was lost, and every read when this server's was", async () => {
  // Given
  const original = globalThis.fetch;
  const signals = new Map<string, AbortSignal>();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    signals.set(String(input), init!.signal!);
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  try {
    for (const path of ["/api/pane/conversation?pane_id=p", "/api/machines/pc%202/pane/conversation?pane_id=p", "/api/machines/pc3/files"]) void nativeTransport.fetch(path);
    // When: the server's way to "pc 2" may be what was lost
    abandonNativeReads("pc 2");
    // Then
    expect([...signals.values()].map((signal) => signal.aborted)).toEqual([false, true, false]);
    // When: this server's own connection was lost, so was every read on the browser's way to it
    abandonNativeReads();
    expect([...signals.values()].map((signal) => signal.aborted)).toEqual([true, true, true]);
  } finally {
    globalThis.fetch = original;
  }
});
