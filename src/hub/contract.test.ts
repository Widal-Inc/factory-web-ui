import { describe, expect, it } from "bun:test";
import { ownerOrigin, parseAdmin, parseBootstrap, parseOverview, parseToday, readHub, routeFor } from "./contract.ts";
import { fixtureAdmin, fixtureBootstrap, fixtureOverview, fixtureToday } from "./fixtures.ts";

describe("hub v1 boundary", () => {
  it("rejects missing, unsupported and malformed responses instead of inventing empty data", () => {
    for (const value of [null, {}, { ...fixtureBootstrap, version: 2 }, { ...fixtureBootstrap, me: { role: "admin" } }]) expect(() => parseBootstrap(value)).toThrow("unsupported response");
    expect(() => parseOverview({ ...fixtureOverview, work: { state: "ready" } })).toThrow();
    expect(() => parseToday({ ...fixtureToday, cost: { usd: 0 } })).toThrow();
    expect(() => parseToday({ ...fixtureToday, asOf: Infinity })).toThrow();
    expect(() => parseToday({ ...fixtureToday, asOf: 1e200 })).toThrow();
  });
  it("preserves unavailable and partial states and strips unknown personal-session fields", () => {
    const data = parseOverview({ ...fixtureOverview, work: { state: "unavailable", reason: "Dolt is not configured" }, transcript: "must not cross boundary" });
    expect(data.work).toEqual({ state: "unavailable", reason: "Dolt is not configured" });
    expect(data).not.toHaveProperty("transcript");
    expect(fixtureOverview.work.state).toBe("partial");
    expect(fixtureToday.cost.usd).toBeNull();
  });
  it("only offers a registered ready factory owned by the signed-in person", () => {
    expect(ownerOrigin(fixtureOverview, "ADA@example.com", "sample-factory")).toBe("https://ada.factory.example.com");
    expect(ownerOrigin(fixtureOverview, "admin@example.com", "sample-factory")).toBeNull();
    expect(ownerOrigin(fixtureOverview, "ada@example.com", "someone-else")).toBeNull();
    for (const origin of ["http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com#x", "javascript:alert(1)"]) {
      expect(ownerOrigin({ ...fixtureOverview, live: [{ factory: "sample-factory", connection: { state: "direct", origin } }] }, "ada@example.com", "sample-factory")).toBeNull();
    }
    expect(ownerOrigin({ ...fixtureOverview, factories: fixtureOverview.factories.map((f) => ({ ...f, state: "removed" })) }, "ada@example.com", "sample-factory")).toBeNull();
    expect(ownerOrigin({ ...fixtureOverview, live: [{ factory: "sample-factory", connection: { state: "direct", origin: "https://another.factory.example.com" } }] }, "ada@example.com", "sample-factory")).toBeNull();
  });
  it("reads the hub with cookies and no cache, never a bearer token or a selected factory transport", async () => {
    let call: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const request: typeof fetch = (async (path: RequestInfo | URL, init?: RequestInit) => { call = [path, init]; return Response.json(fixtureBootstrap); }) as typeof fetch;
    const controller = new AbortController();
    await readHub("/api/app/bootstrap", parseBootstrap, controller.signal, request);
    expect(call?.[0]).toBe("/api/app/bootstrap");
    expect(call?.[1]).toEqual({ credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json" }, signal: controller.signal });
    for (const path of ["https://example.com/api/app/bootstrap", "//example.com/api/app/bootstrap", "/api/app/bootstrap?token=secret"]) await expect(readHub(path, parseBootstrap, controller.signal, request)).rejects.toThrow("Unsupported hub request");
  });
  it("handles 401, 403 and infrastructure failure without displaying server details", async () => {
    for (const status of [401, 403, 404, 503]) {
      const request = (async () => Response.json({ error: "private infrastructure details" }, { status })) as unknown as typeof fetch;
      try { await readHub("/api/app/bootstrap", parseBootstrap, new AbortController().signal, request); throw new Error("expected refusal"); }
      catch (error) { expect(error).toHaveProperty("status", status); expect((error as Error).message).not.toContain("private infrastructure"); }
    }
  });
  it("does not expose malformed success bodies in parser error messages", async () => {
    const request = (async () => new Response("<html>private infrastructure text</html>")) as unknown as typeof fetch;
    await expect(readHub("/api/app/bootstrap", parseBootstrap, new AbortController().signal, request)).rejects.toThrow("unsupported response");
  });
  it("keeps only the hub's supported deep links", () => {
    expect(routeFor("/team/items/sample-factory/sample-1")).toEqual({ page: "item", factory: "sample-factory", id: "sample-1" });
    for (const path of ["/team/items/sample-factory/%2Fsecret", "/team/items/sample-factory/%zz", "/team/items/a/b/c", "/unknown", "/setup/a/b"]) expect(routeFor(path)).toEqual({ page: "missing" });
  });
  it("routes Linear's return page and parses a hub with onboarding ready or unavailable", () => {
    expect(routeFor("/linear/callback")).toEqual({ page: "linearCallback" });
    expect(routeFor("/linear/callback/extra")).toEqual({ page: "missing" });
    expect(parseAdmin({ ...fixtureAdmin, capabilities: { ...fixtureAdmin.capabilities, onboarding: { state: "ready", endpoint: "/api/app/admin/onboarding" } } }).capabilities.onboarding).toEqual({ state: "ready", endpoint: "/api/app/admin/onboarding" });
    expect(() => parseAdmin({ ...fixtureAdmin, capabilities: { ...fixtureAdmin.capabilities, onboarding: { state: "ready" } } })).toThrow();
  });
});
