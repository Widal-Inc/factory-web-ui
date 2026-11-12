import { describe, expect, it } from "bun:test";
import { directTransport } from "./directTransport.ts";
import type { EventSourceLike, WebSocketLike } from "../lib/transport.ts";
const owner = "https://ada.factory.example.com";
const hub = "https://factory.example.com";
function connections() {
  const calls: { kind: string; url: string; options?: RequestInit }[] = [];
  const requests: Request[] = [];
  return {
    calls, requests,
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => { if (input instanceof Request) requests.push(input); calls.push({ kind: "fetch", url: input instanceof Request ? input.url : String(input), options }); return Response.json({ ok: true }); }) as typeof fetch,
    socket: (url: string) => { calls.push({ kind: "socket", url }); return {} as WebSocketLike; },
    events: (url: string) => { calls.push({ kind: "events", url }); return {} as EventSourceLike; },
  };
}
describe("direct owner transport", () => {
  it("preserves existing App paths and uses credentialed direct connections without a hub relay", async () => {
    const browser = connections();
    const transport = directTransport(owner, hub, browser);
    const controller = new AbortController();
    await transport.fetch("/api/example?pane=test", { method: "POST", body: "example input", signal: controller.signal });
    transport.openSocket("wss://factory.example.com/example-socket?pane=test");
    transport.openEventSource("/api/example-events");
    expect(browser.calls[0]).toEqual({ kind: "fetch", url: `${owner}/api/example?pane=test`, options: { method: "POST", body: "example input", signal: controller.signal, credentials: "include", redirect: "error", cache: "no-store" } });
    expect(browser.calls[1]).toEqual({ kind: "socket", url: "wss://ada.factory.example.com/example-socket?pane=test" });
    expect(browser.calls[2]).toEqual({ kind: "events", url: `${owner}/api/example-events` });
    expect(transport.resourceUrl("/api/example-file?path=%2Ftmp%2Fdemo")).toBe(`${owner}/api/example-file?path=%2Ftmp%2Fdemo`);
  });
  it("preserves a Request body, method and headers while overriding unsafe credentials/redirect options", async () => {
    const browser = connections();
    const request = new Request(`${hub}/api/example`, { method: "POST", body: "draft", headers: { "content-type": "text/plain" } });
    await directTransport(owner, hub, browser).fetch(request, { credentials: "omit", redirect: "follow", cache: "force-cache" });
    expect(browser.calls[0]!.url).toBe(`${owner}/api/example`);
    expect(browser.calls[0]!.options).toEqual({ credentials: "include", redirect: "error", cache: "no-store" });
    expect(browser.requests[0]!.method).toBe("POST");
    expect(browser.requests[0]!.headers.get("content-type")).toBe("text/plain");
    expect(await browser.requests[0]!.text()).toBe("draft");
  });
  it("uses the owner port rather than retaining a different hub port", () => {
    const transport = directTransport(owner, "https://factory.example.com:8443", connections());
    expect(transport.resourceUrl("/api/example")).toBe(`${owner}/api/example`);
    expect(directTransport(`${owner}:9443`, hub, connections()).resourceUrl("/api/example")).toBe(`${owner}:9443/api/example`);
  });
  it("rejects other factories, unsafe schemes, URL credentials and hub data requests", () => {
    const browser = connections();
    const transport = directTransport(owner, hub, browser);
    for (const path of ["https://other.factory.example.com/api/example", "//other.factory.example.com/api/example", "https://u:p@ada.factory.example.com/api/example", "/api/app/team/today", "javascript:alert(1)", "data:text/plain,x"]) expect(() => transport.resourceUrl(path)).toThrow();
    expect(() => transport.openSocket("ws://factory.example.com/example")).toThrow();
    expect(() => transport.openSocket("wss://other.factory.example.com/example")).toThrow();
    expect(browser.calls).toHaveLength(0);
    for (const origin of ["http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com?x=1"]) expect(() => directTransport(origin, hub, browser)).toThrow();
  });
  it("never replays a failed write", async () => {
    let writes = 0;
    const browser = connections();
    browser.fetch = (async () => { writes++; throw new TypeError("Disconnected"); }) as unknown as typeof fetch;
    await expect(directTransport(owner, hub, browser).fetch("/api/example", { method: "POST", body: "draft" })).rejects.toThrow("Disconnected");
    expect(writes).toBe(1);
  });
});
