/**
 * What Tailscale on this PC can already do for a phone, read-only: `tailscale status --json` and
 * `tailscale serve status --json`, never `serve`, `up` or anything else that changes the tailnet.
 * The Settings → Phone panel turns the answer into the address that already works, or the one
 * command the user still has to run on this PC.
 */
import { existsSync } from "node:fs";
import type { RemoteAccess, TailscaleAccess } from "../shared/protocol.ts";

const TIMEOUT_MS = 2500;
/** the macOS App Store build puts no `tailscale` on the PATH; its CLI lives in the app bundle */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** HTTPS ports to suggest, the conventional one first; a port another service already uses is skipped */
export const HTTPS_PORTS: readonly number[] = [443, 8443, 7317, 17317];
/** names the one HTTPS port to publish the app on, for a user who keeps 443 for something else */
export const HTTPS_PORT_VARIABLE = "OVIS_TAILSCALE_HTTPS_PORT";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** stdout of the two commands; null where the command failed, timed out or is not installed */
export interface TailscaleOutput {
  status: string | null;
  serve: string | null;
}

interface NodeJson { DNSName?: string; TailscaleIPs?: string[] }
interface StatusJson { BackendState?: string; Self?: NodeJson }
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  /** "host:port" -> handlers by path */
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

const NONE: TailscaleAccess = { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null };

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** Does this `serve` proxy target point at the web ui on this machine, at its root? */
function proxiesTo(target: string | undefined, port: number): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
  } catch { return false; }
}

function httpsUrl(host: string, port: number): string {
  return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

/**
 * The HTTPS ports a new `tailscale serve` may take, in order: the usual ones while the variable is
 * unset, only the port it names when it is set, and none when it names no port. A port the user
 * chose is never traded for another, since a phone's installed app stays on the address it was
 * installed from.
 */
export function httpsPorts(value: string | undefined): readonly number[] {
  const text = value?.trim() ?? "";
  if (text === "") return HTTPS_PORTS;
  const port = /^\d+$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65535 ? [port] : [];
}

/** Pure: the two commands' output (or their absence) to what the phone panel needs. */
export function parseTailscale(output: TailscaleOutput | null, port: number, candidates: readonly number[] = HTTPS_PORTS): TailscaleAccess {
  if (output === null) return NONE;
  const status = parseJson<StatusJson>(output.status);
  if (status === null || status.BackendState !== "Running") return { ...NONE, state: "stopped" };
  const dns = parseNodeName(output.status);
  const serve = parseJson<ServeJson>(output.serve);
  const taken = new Set(Object.keys(serve?.TCP ?? {}).map(Number).filter(Number.isFinite));
  let servingUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, separator);
    const webPort = Number(hostPort.slice(separator + 1));
    // an HTTP listener is no use to a phone: it can neither install the app nor receive alerts
    if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
    if (proxiesTo(site.Handlers?.["/"]?.Proxy, port)) { servingUrl = httpsUrl(host, webPort); break; }
  }
  const free = servingUrl === null ? candidates.find((candidate) => !taken.has(candidate)) ?? null : null;
  return {
    state: "running",
    dns_name: dns,
    serving_url: servingUrl,
    serve_command: free === null ? null : `tailscale serve --bg --https=${free} http://127.0.0.1:${port}`,
    serve_url: free === null || dns === null ? null : httpsUrl(dns, free),
  };
}

export function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

async function run(binary: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn([binary, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readTailscale(binary: string | null = tailscaleBinary()): Promise<TailscaleOutput | null> {
  if (binary === null) return null;
  const [status, serve] = await Promise.all([run(binary, ["status", "--json"]), run(binary, ["serve", "status", "--json"])]);
  return { status, serve };
}

export async function remoteAccess(port: number, candidates: readonly number[] = httpsPorts(process.env[HTTPS_PORT_VARIABLE])): Promise<RemoteAccess> {
  return { port, tailscale: parseTailscale(await readTailscale(), port, candidates) };
}

/** This PC's IPv4 address on the tailnet (100.x.y.z), from `tailscale status --json`; null when it has none. */
export function parseTailscaleIp(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

/** This PC's MagicDNS name from `tailscale status --json`, without its trailing dot; null when it has none. */
export function parseNodeName(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.DNSName?.replace(/\.$/, "") || null;
}

const ADDRESS_TTL_MS = 5 * 60_000;

/** `tailscale status --json` from this PC's own CLI, or null when Tailscale is not here or does not answer in time */
export const readTailscaleStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  return binary === null ? null : run(binary, ["status", "--json"]);
};

/** peers listed at most, so a large tailnet costs a bounded number of rows */
const MAX_PEERS = 32;
/** systems that never run a PC worth connecting to */
const PHONE_OS = new Set(["ios", "android"]);

interface PeerJson { DNSName?: string; UserID?: string; Online?: boolean; OS?: string; Tags?: string[]; TailscaleIPs?: string[] }

/** Online, untagged peers of this PC's own login, phones aside, from `tailscale status --json`: names to offer for SSH, nothing more. */
export function tailnetPeers(status: string | null): { name: string; dnsName: string; ips: string[] }[] {
  if (status === null) return [];
  let parsed: { BackendState?: string; Self?: PeerJson; Peer?: Record<string, PeerJson> };
  // user ids pass 2^53: kept as the digits written, or two ids can become one
  try { parsed = JSON.parse(status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"')); } catch { return []; }
  const own = parsed.Self?.UserID;
  if (parsed.BackendState !== "Running" || own === undefined || (parsed.Self?.Tags?.length ?? 0) > 0) return [];
  return Object.values(parsed.Peer ?? {})
    .filter((peer) => peer.Online === true && (peer.Tags?.length ?? 0) === 0 && String(peer.UserID) === String(own)
      && typeof peer.DNSName === "string" && peer.DNSName !== "" && !PHONE_OS.has((peer.OS ?? "").toLowerCase()))
    .slice(0, MAX_PEERS)
    .map((peer) => {
      const dnsName = peer.DNSName!.replace(/\.$/, "");
      // the machine name Tailscale's admin console shows and lets the person rename, not the OS hostname
      return { name: dnsName.split(".")[0]!.slice(0, 100), dnsName, ips: (peer.TailscaleIPs ?? []).filter((ip) => typeof ip === "string") };
    });
}

/**
 * This PC's IPv4 address on the tailnet, read through `readStatus` (`tailscale status --json`) and
 * kept five minutes. A stale value is answered at once and refreshed in the background, so no
 * caller waits on the tailscale CLI; the first answer is null until a read lands. A read that
 * fails keeps the last address.
 */
export class TailnetAddressSource {
  private cache: { ip: string | null; at: number } | null = null;
  private reading: Promise<void> | null = null;

  constructor(private readonly readStatus: () => Promise<string | null> = readTailscaleStatus) {}

  private refresh(): void {
    this.reading ??= this.readStatus()
      .then((status) => { this.cache = { ip: status === null ? this.cache?.ip ?? null : parseTailscaleIp(status), at: Date.now() }; })
      .catch(() => { this.cache = { ip: this.cache?.ip ?? null, at: Date.now() }; })
      .finally(() => { this.reading = null; });
  }

  ip(): string | null {
    if (this.cache === null || Date.now() - this.cache.at >= ADDRESS_TTL_MS) this.refresh();
    return this.cache?.ip ?? null;
  }
}
