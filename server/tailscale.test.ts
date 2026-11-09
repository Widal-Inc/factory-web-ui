import { describe, expect, it, spyOn } from "bun:test";
import { HTTPS_PORTS, httpsPorts, parseTailscale, parseTailscaleIp, TailnetAddressSource } from "./tailscale.ts";

const status = (state = "Running", dns = "pc.example.ts.net.") => JSON.stringify({ BackendState: state, Self: { DNSName: dns } });
/** a `tailscale serve status --json` document: listeners by port, and one "/" proxy per host:port */
const serve = (tcp: Record<string, { HTTPS?: boolean; HTTP?: boolean }>, web: Record<string, string>) =>
  JSON.stringify({ TCP: tcp, Web: Object.fromEntries(Object.entries(web).map(([key, proxy]) => [key, { Handlers: { "/": { Proxy: proxy } } }])) });

describe("TailnetAddressSource", () => {
  const self = (ip: string) => JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: [ip] } });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("answers null until a read lands, then this PC's tailnet address", async () => {
    const source = new TailnetAddressSource(async () => self("100.64.0.7"));
    expect(source.ip()).toBeNull();
    await settle();
    expect(source.ip()).toBe("100.64.0.7");
  });

  it("keeps the last address through a failed read, and reads again only after five minutes", async () => {
    let reads = 0;
    let answer: string | null = self("100.64.0.7");
    const source = new TailnetAddressSource(async () => { reads += 1; return answer; });
    source.ip();
    await settle();
    expect(reads).toBe(1);
    source.ip();
    expect(reads).toBe(1);
    answer = null;
    const start = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => start + 6 * 60_000);
    try {
      source.ip();
      await settle();
      expect(reads).toBe(2);
      expect(source.ip()).toBe("100.64.0.7");
    } finally { clock.mockRestore(); }
  });
});

describe("parseTailscaleIp", () => {
  it("picks this PC's IPv4 tailnet address, and nothing when there is none", () => {
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.7"] } }))).toBe("100.64.0.7");
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] } }))).toBeNull();
    expect(parseTailscaleIp(JSON.stringify({ Self: {} }))).toBeNull();
    expect(parseTailscaleIp("not json")).toBeNull();
    expect(parseTailscaleIp(null)).toBeNull();
  });
});

describe("parseTailscale", () => {
  it("reports a PC without the CLI", () => {
    expect(parseTailscale(null, 7317)).toEqual({ state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null });
  });

  it("reports a daemon that did not answer, or is not connected", () => {
    for (const output of [{ status: null, serve: null }, { status: "not json", serve: null }, { status: status("NeedsLogin"), serve: null }, { status: status("Stopped"), serve: serve({}, {}) }]) {
      expect(parseTailscale(output, 7317).state).toBe("stopped");
      expect(parseTailscale(output, 7317).serve_command).toBeNull();
    }
  });

  it("finds the HTTPS listener that already proxies this server, and strips the DNS dot", () => {
    const output = { status: status(), serve: serve(
      { "443": { HTTPS: true }, "17317": { HTTPS: true } },
      { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:17317": "http://127.0.0.1:7317" },
    ) };
    expect(parseTailscale(output, 7317)).toEqual({ state: "running", dns_name: "pc.example.ts.net", serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null });
  });

  it("names no port for 443, and accepts localhost as this machine", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://localhost:7317/" }) };
    expect(parseTailscale(output, 7317).serving_url).toBe("https://pc.example.ts.net");
  });

  it("suggests 443 when nothing is served, even when serve status failed", () => {
    for (const serveOutput of [null, serve({}, {})]) {
      expect(parseTailscale({ status: status(), serve: serveOutput }, 7317)).toEqual({
        state: "running", dns_name: "pc.example.ts.net", serving_url: null,
        serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net",
      });
    }
  });

  it("skips the ports other services already use", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true }, "8443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:8443": "http://127.0.0.1:3019/status" }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=7317 http://127.0.0.1:7317");
    expect(access.serve_url).toBe("https://pc.example.ts.net:7317");
  });

  it("does not count an HTTP listener, another path or another port as serving this server", () => {
    const output = { status: status(), serve: JSON.stringify({
      TCP: { "80": { HTTP: true }, "8443": { HTTPS: true }, "9000": { HTTPS: true } },
      Web: {
        "pc.example.ts.net:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:8443": { Handlers: { "/ui": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:9000": { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } },
      },
    }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
  });

  it("gives a command but no address when MagicDNS reports no name", () => {
    const access = parseTailscale({ status: status("Running", ""), serve: null }, 7317);
    expect(access.dns_name).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
    expect(access.serve_url).toBeNull();
  });

  it("publishes only on the port the user chose, while it is free", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://127.0.0.1:8787" }) };
    expect(parseTailscale(output, 7317, [9443])).toEqual({
      state: "running", dns_name: "pc.example.ts.net", serving_url: null,
      serve_command: "tailscale serve --bg --https=9443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net:9443",
    });
  });

  it("never trades a chosen port another service holds for a free one, nor offers any port for a value that names none", () => {
    const taken = { status: status(), serve: serve({ "9443": { HTTPS: true } }, { "pc.example.ts.net:9443": "http://127.0.0.1:8787" }) };
    expect(parseTailscale(taken, 7317, [9443])).toMatchObject({ serving_url: null, serve_command: null, serve_url: null });
    expect(parseTailscale({ status: status(), serve: serve({}, {}) }, 7317, [])).toMatchObject({ serving_url: null, serve_command: null, serve_url: null });
  });

  it("keeps the address that already serves the app when the user chose another port", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://127.0.0.1:7317" }) };
    expect(parseTailscale(output, 7317, [9443])).toMatchObject({ serving_url: "https://pc.example.ts.net", serve_command: null });
  });
});

describe("httpsPorts", () => {
  it("offers the usual ports while OVIS_TAILSCALE_HTTPS_PORT is unset or blank", () => {
    for (const value of [undefined, "", "  "]) expect(httpsPorts(value)).toEqual(HTTPS_PORTS);
  });

  it("offers only the port a value names, and none for a value that names no port", () => {
    expect(httpsPorts("9443")).toEqual([9443]);
    expect(httpsPorts(" 9443 ")).toEqual([9443]);
    expect(httpsPorts("65535")).toEqual([65535]);
    for (const value of ["0", "65536", "abc", "94.43", "-443", "443x"]) expect(httpsPorts(value)).toEqual([]);
  });
});
