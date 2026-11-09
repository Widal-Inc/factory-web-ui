import { describe, expect, it } from "bun:test";
import { bindScope, cameThroughProxy, decideAccess, forwardingHeaders, isLoopbackAddress, isLoopbackBind, isLoopbackHost, observedIngress, ownerAccess, type AccessInput } from "./access.ts";

const base: AccessInput = { loopback: true, forwarded: false, forwardingHeaders: false, funnel: false, tokenMatched: false, tokenConfigured: false };
const via = (input: Partial<AccessInput>) => { const a = decideAccess({ ...base, ...input }); return a.level === "full" ? a.via : `refused:${a.reason}`; };

describe("decideAccess", () => {
  it("lets this PC in without a token, but not through a proxy", () => {
    expect(via({})).toBe("local");
    expect(via({ forwarded: true })).toBe("refused:token_required");
    // a forwarding header is a proxy in front, whether the connection is from this PC or from the network
    expect(via({ forwarded: true, forwardingHeaders: true })).toBe("refused:token_required");
    expect(via({ loopback: false, forwarded: true, forwardingHeaders: true })).toBe("refused:token_required");
  });

  it("refuses a connection from another address without a token", () => {
    expect(via({ loopback: false })).toBe("refused:token_required");
    expect(via({ loopback: true, forwarded: true })).toBe("refused:token_required");
  });

  it("never lets a Funnel request in without the token", () => {
    expect(via({ loopback: true, forwarded: true, funnel: true })).toBe("refused:token_required");
    expect(via({ loopback: true, forwarded: true, funnel: true, tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ loopback: true, forwarded: true, funnel: true, tokenConfigured: true, tokenMatched: true })).toBe("token");
  });

  it("lets a proxied request in only with the token", () => {
    const proxied = { forwarded: true, forwardingHeaders: true } as const;
    expect(via({ ...proxied })).toBe("refused:token_required");
    expect(via({ ...proxied, tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ ...proxied, tokenConfigured: true, tokenMatched: true })).toBe("token");
  });

  it("a configured token gates everything, this PC included", () => {
    expect(via({ tokenConfigured: true })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, tokenMatched: true })).toBe("token");
    expect(via({ tokenConfigured: true, loopback: false })).toBe("refused:token_required");
    expect(via({ tokenConfigured: true, loopback: false, tokenMatched: true })).toBe("token");
  });

  it("knows a name for this machine from a proxied Host", () => {
    for (const host of ["localhost", "localhost:7317", "LOCALHOST:5173", "herdr.localhost:7317", "127.0.0.1:7317", "127.9.9.9", "[::1]:7317", "localhost.:7317", "[::ffff:127.0.0.1]:7317"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["app.example.test", "app.example.test:8443", "192.168.0.10:7317", "localhost.example.test", "127.0.0.1.example.test", "[fd7a::1]:7317", "", "0.0.0.0:7317", "[::ffff:192.168.0.10]"]) expect(isLoopbackHost(host)).toBe(false);
    // not an authority: a URL parser would have read these as localhost
    for (const host of ["public.example@localhost:7317", "localhost/x@public.example", "localhost:7317/x", "localhost?x", "local host", "localhost:port", "localhost..", "127.0.0.1@public.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("sees a proxy in a forwarding header or in a Host that is not this machine", () => {
    const proxy = (headers: Record<string, string>) => cameThroughProxy(new Headers(headers));
    expect(proxy({ host: "localhost:7317" })).toBe(false);
    expect(proxy({ host: "127.0.0.1:7317", origin: "http://127.0.0.1:7317" })).toBe(false);
    // no Host at all: HTTP/1.0 through a proxy, never a local browser or CLI
    expect(proxy({})).toBe(true);
    expect(proxy({ host: "public.example@localhost:7317" })).toBe(true);
    expect(proxy({ host: "app.example.test" })).toBe(true);
    for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"]) expect(proxy({ host: "127.0.0.1:7317", [name]: "x" })).toBe(true);
  });

  it("knows loopback addresses in every spelling", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10", "fd7a::1"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("ownerAccess", () => {
  it("is whoever got in: a direct local connection or the token, never a refused request", () => {
    expect(ownerAccess(decideAccess({ ...base }))).toBe(true);
    expect(ownerAccess(decideAccess({ ...base, tokenConfigured: true, tokenMatched: true }))).toBe(true);
    expect(ownerAccess(decideAccess({ ...base, loopback: false }))).toBe(false);
    expect(ownerAccess({ level: "none", reason: "token_required" })).toBe(false);
  });
});

describe("bindScope", () => {
  it("reads every loopback spelling as loopback, never a name that merely resolves there", () => {
    for (const hostname of ["127.0.0.1", "localhost", "::1", "127.0.0.2", "[::1]", "LOCALHOST", "::ffff:127.0.0.1", "app.localhost", " localhost "]) expect(bindScope(hostname)).toBe("loopback");
    for (const hostname of ["127.devbox.example", "localhost.example"]) expect(bindScope(hostname)).toBe("other");
  });

  it("reads Tailscale address literals as tailnet", () => {
    for (const hostname of ["100.64.0.0", "100.127.255.255", "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0::1]", "FD7A:115C:A1E0:0:0:0:0:1", " 100.64.0.2 "]) expect(bindScope(hostname)).toBe("tailnet");
  });

  it("reads wildcards, LAN addresses and names as other", () => {
    for (const hostname of ["0.0.0.0", "::", "[::]", "192.168.0.10", "fd7a::1", "my-pc.local", "100.63.255.255", "100.128.0.0", "fd7a:115c:a1e1::", "100.64.0.2.example"]) {
      expect(isLoopbackBind(hostname)).toBe(false);
      expect(bindScope(hostname)).toBe("other");
    }
  });
});

describe("observedIngress", () => {
  // a request from this PC's own browser, with nothing forwarded
  type Request = Parameters<typeof observedIngress>[0];
  const local: Request = { peerKnown: true, loopback: true, forwarded: false, forwardingHeaders: false, funnel: false };
  const ingress = (over: Partial<Request>) => observedIngress({ ...local, ...over });

  it("calls an unforwarded request direct, from this PC or from the network", () => {
    expect(ingress({})).toBe("direct");
    // a LAN client addresses the server by its LAN name; that Host alone is no forwarding
    expect(ingress({ loopback: false, forwarded: true })).toBe("direct");
    expect(ingress({ peerKnown: false })).toBe("unknown");
  });

  it("labels Funnel only from loopback, where Tailscale's proxy connects from", () => {
    expect(ingress({ forwarded: true, forwardingHeaders: true, funnel: true })).toBe("funnel");
    expect(ingress({ forwarded: true, forwardingHeaders: true, funnel: true, loopback: false })).toBe("unknown");
  });

  it("calls any other forwarding a proxy, including a rewritten Host from this PC", () => {
    expect(ingress({ forwarded: true, forwardingHeaders: true })).toBe("proxy");
    expect(ingress({ loopback: false, forwarded: true, forwardingHeaders: true })).toBe("proxy");
    expect(ingress({ forwarded: true })).toBe("proxy");
  });

  it("finds forwarding headers, but not in a Host header alone", () => {
    expect(forwardingHeaders(new Headers({ host: "192.168.0.10:7317" }))).toBe(false);
    for (const name of ["x-forwarded-for", "forwarded", "via", "x-real-ip", "tailscale-funnel-request"]) expect(forwardingHeaders(new Headers({ [name]: "x" }))).toBe(true);
    // a Tailscale login header says nothing about a proxy: it is not read at all
    expect(forwardingHeaders(new Headers({ "tailscale-user-login": "me@example.com" }))).toBe(false);
  });
});
