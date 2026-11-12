import { describe, expect, it } from "bun:test";
import { FactoryAuth, factoryAuthFromEnv, factoryAuthResponse } from "./factory-auth.ts";
import { factoryFixture } from "./factory-auth.fake.ts";
import { protectFactoryResponse } from "./factory-http.ts";
import { withFactoryAuthority } from "./factory-context.ts";
import { sameOrigin } from "./machine-security.ts";
import { updateRequestAllowed } from "./update-api.ts";

describe("factory signed identity", () => {
  it("checks signature, signer, issuer, client, expiry and verified identity", async () => {
    const f = factoryFixture();
    expect((await f.auth.identity(f.token())).person).toBe("ada@example.test");
    expect((await f.auth.identity(f.token({}, {}, true))).person).toBe("ada@example.test");
    const forged = factoryFixture().token();
    for (const token of [null, "", "a.b.c", forged, f.token({ alg: "none" }), f.token({ signer: "other" }), f.token({ iss: "https://other.example.test" }), f.token({ client: "other" }), f.token({ exp: 0 }), f.token({}, { email_verified: false }), f.token({}, { email: null })]) {
      await expect(f.auth.identity(token)).rejects.toMatchObject({ status: 401 });
    }
    expect(f.calls.filter((call) => call.url.includes("public-keys")).length).toBe(1);
  });

  it("fails closed on missing key and bounds key fetch failures", async () => {
    const f = factoryFixture();
    let fetched = 0;
    const auth = new FactoryAuth({ ...f.options, fetch: (async () => { fetched++; throw new Error("private upstream detail"); }) as unknown as typeof fetch });
    for (let i = 0; i < 2; i++) await expect(auth.identity(f.token())).rejects.toMatchObject({ status: 503 });
    expect(fetched).toBe(1);
    expect(await factoryAuthResponse(new Error("private upstream detail")).text()).not.toContain("private upstream detail");
  });

  it("requires the configured peer, host and browser origin, never loopback or forwarding claims", async () => {
    const f = factoryFixture();
    expect(await f.auth.admit(f.request(), "10.1.2.4")).toMatchObject({ person: "ada@example.test" });
    for (const peer of [null, "127.0.0.1", "::1", "10.1.3.4"]) await expect(f.auth.admit(f.request(), peer)).rejects.toMatchObject({ status: 403 });
    await expect(f.auth.admit(f.request("/ws", { headers: { origin: "https://evil.example.test" } }), "10.1.2.4")).rejects.toMatchObject({ status: 403 });
    await expect(f.auth.admit(new Request("http://127.0.0.1/api/preferences", { headers: f.request().headers }), "10.1.2.4")).rejects.toMatchObject({ status: 403 });
    await expect(f.auth.admit(f.request("/api/preferences", { method: "POST", headers: { origin: "null" } }), "10.1.2.4")).rejects.toMatchObject({ status: 403 });
    expect(f.auth.trustedPeer("::ffff:10.1.2.4")).toBe(true);
  });

  it("uses current ownership for each call and denies another engineer or admin", async () => {
    const f = factoryFixture();
    const identity = await f.auth.identity(f.token());
    await f.auth.checkOwner(identity);
    const good = { factory: f.options.factory, owner: f.options.owner, address: f.options.origin, state: "ready" };
    for (const me of [
      { person: "other@example.test", role: "admin", factories: [good] },
      { person: f.options.owner, role: "admin", factories: [{ ...good, owner: "other@example.test" }] },
      { person: f.options.owner, role: "engineer", factories: [{ ...good, factory: "other-factory" }] },
      { person: f.options.owner, role: "admin", factories: [{ ...good, state: "removed" }] },
      { person: f.options.owner, role: "engineer", factories: [{ ...good, address: "https://other.example.test" }] },
      { person: f.options.owner, role: "admin", factories: [] }, null,
    ]) {
      f.setMe(me);
      await expect(f.auth.checkOwner(identity)).rejects.toMatchObject({ status: 403 });
    }
    f.setMe({}, 503);
    await expect(f.auth.checkOwner(identity)).rejects.toMatchObject({ status: 503 });
    f.setMe({}, 403);
    await expect(f.auth.checkOwner(identity)).rejects.toMatchObject({ status: 403 });
    await expect(f.auth.checkOwner(await f.auth.identity(f.token({}, { email: "other@example.test" })))).rejects.toMatchObject({ status: 403 });
    const lookup = f.calls.find((call) => call.url.endsWith("/api/app/me"))!;
    expect(lookup.init).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(new Headers(lookup.init?.headers).get("x-amzn-oidc-data")).toBe(identity.token);
    f.advance(3600_001);
    await expect(f.auth.checkOwner(identity)).rejects.toMatchObject({ status: 401 });
  });

  it("keeps the unsigned health exception narrow", async () => {
    const f = factoryFixture();
    const unsigned = (path: string, method = "GET") => new Request(`${f.options.origin}${path}`, { method });
    expect(await f.auth.health(unsigned("/api/health"), "10.1.2.4")?.json()).toEqual({ ok: true });
    for (const request of [unsigned("/api/health?scope=full"), unsigned("/api/health/"), unsigned("/api/health", "HEAD"), unsigned("/api/preferences"), f.request("/api/health")]) expect(f.auth.health(request, "10.1.2.4")).toBeUndefined();
    expect(f.auth.health(unsigned("/api/health"), "127.0.0.1")).toBeUndefined();
  });

  it("answers only trusted browser preflight metadata without granting data or control", async () => {
    const f = factoryFixture();
    const preflight = f.request("/api/preferences", { method: "OPTIONS", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-request-id" } });
    preflight.headers.delete("x-amzn-oidc-data");
    const response = f.auth.preflight(preflight, "10.1.2.4");
    expect(response?.status).toBe(204);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("access-control-allow-origin")).toBe(f.options.hubOrigin);
    expect(f.calls).toEqual([]);
    const filePreflight = new Request(`${f.options.origin}/api/fs/stat?path=%2Ffixture`, preflight);
    expect(f.auth.preflight(filePreflight, "10.1.2.4")?.status).toBe(204);
    // A preflight grants no file access, even when its metadata response succeeds.
    const unsignedFile = new Request(filePreflight, { method: "GET" });
    await expect(f.auth.admit(unsignedFile, "10.1.2.4")).rejects.toMatchObject({ status: 401 });
    expect(f.auth.preflight(preflight, "127.0.0.1")).toBeUndefined();
    for (const [name, value] of [["origin", "https://evil.example.test"], ["access-control-request-method", "CONNECT"], ["access-control-request-headers", "authorization"], ["x-forwarded-proto", "http"]]) {
      const request = new Request(preflight);
      request.headers.set(name!, value!);
      expect(f.auth.preflight(request, "10.1.2.4")).toBeUndefined();
    }
    const actual = f.request("/api/preferences", { method: "POST" });
    actual.headers.delete("x-amzn-oidc-data");
    await expect(f.auth.admit(actual, "10.1.2.4")).rejects.toMatchObject({ status: 401 });
  });

  it("refuses partial deployment configuration before server startup", () => {
    expect(factoryAuthFromEnv({})).toBeUndefined();
    for (const env of [{ WIDAL_AUTH_MODE: "alb" }, { WIDAL_FACTORY_ID: "ada" }, { WIDAL_AUTH_MODE: "local" }]) expect(() => factoryAuthFromEnv(env)).toThrow();
    expect(() => new FactoryAuth({ ...factoryFixture().options, trustedProxyCidrs: ["0.0.0.0/0"] })).toThrow();
  });

  it("keeps route origin guards consistent with the authenticated hub origin", () => {
    const f = factoryFixture();
    const request = f.request("/api/updates/check", { method: "POST", headers: { "x-herdr-update": "1", "sec-fetch-site": "same-site" } });
    expect(sameOrigin(request)).toBe(false);
    expect(updateRequestAllowed(request)).toBe(false);
    withFactoryAuthority(async () => {}, () => {
      expect(sameOrigin(request)).toBe(true);
      expect(updateRequestAllowed(request)).toBe(true);
      expect(updateRequestAllowed(f.request("/api/updates/check", { method: "POST" }))).toBe(false);
      expect(sameOrigin(f.request("/api/preferences", { method: "POST", headers: { origin: "https://evil.example.test" } }))).toBe(false);
    }, { factory: f.options.origin, hub: f.options.hubOrigin });
  });

  it("stops streaming output after removal and limits CORS to the configured hub", async () => {
    const f = factoryFixture();
    const identity = await f.auth.identity(f.token());
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const response = protectFactoryResponse(f.request(), new Response(stream), f.auth, () => f.auth.checkOwner(identity));
    expect(response.headers.get("access-control-allow-origin")).toBe(f.options.hubOrigin);
    expect(response.headers.get("access-control-expose-headers")).toContain("content-range");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body!.getReader();
    const first = reader.read();
    source.enqueue(new TextEncoder().encode("first"));
    expect(new TextDecoder().decode((await first).value)).toBe("first");
    const second = reader.read();
    f.setMe({}, 403);
    source.enqueue(new TextEncoder().encode("private after removal"));
    await expect(second).rejects.toThrow("Factory access refused");
    f.auth.audit(identity, "http.POST");
    expect(Object.keys(f.audits[0]!).sort()).toEqual(["action", "actor", "at", "factory", "outcome"]);
    expect(JSON.stringify(f.audits)).not.toContain(identity.token);
  });
});
