/**
 * Who a request is and whether it gets in. There is no user database: a request is trusted for
 * where it comes from (this PC, with no proxy in front) or for what it holds (the shared token).
 * A token, when one is configured, is required of everything, this PC included: a plain local
 * connection, since the remote-PC bridge runs on a loopback port of a PC other people may use.
 * Without a token, a direct loopback connection is let in. Everything else is refused: a request
 * that came through a proxy or Funnel (a forwarding header, or Funnel's own) says nothing about who
 * is behind it, and a connection from another address holds no token.
 *
 * A proxy on this PC connects from loopback like a local client does, so it is known only by
 * what it sends: a forwarding header, or a Host that is not a name for this machine. A proxy
 * that sends neither (nginx's bare `proxy_pass` rewrites Host to the upstream address and adds
 * nothing) cannot be told from a local client: only a token closes that setup.
 */
import { BlockList, isIP } from "node:net";
import type { AccessRefusal, AccessVia, BindScope, ObservedIngress } from "../shared/protocol.ts";

export interface AccessInput {
  /** the connection came from this machine: 127/8, ::1 or their IPv4-mapped forms */
  loopback: boolean;
  /** a proxy in front shows in the request (`cameThroughProxy`): a forwarding header, or a Host that does not name this machine */
  forwarded: boolean;
  /** a forwarding header (`forwardingHeaders`) came with the request, whoever sent it */
  forwardingHeaders: boolean;
  /** Tailscale-Funnel-Request: the request came from the public internet through Funnel */
  funnel: boolean;
  /** the shared token matched (cookie or bearer) */
  tokenMatched: boolean;
  tokenConfigured: boolean;
}

export type Access =
  | { level: "full"; via: AccessVia }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * Is this bind address one only this machine can reach, so an unset token is nobody else's
 * business? Any spelling of loopback counts: `127.0.0.2`, `[::1]`, `LOCALHOST`, `::ffff:127.0.0.1`.
 * A name that merely resolves to loopback is not recognised; the bind address is what Bun was
 * given, not what DNS says of it.
 */
export function isLoopbackBind(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  // the address tests apply to an address: a DNS name such as 127.devbox.example may point anywhere
  const literal = /^[\d.]+$/.test(name) || name.includes(":");
  return name === "localhost" || name.endsWith(".localhost") || (literal && isLoopbackAddress(name));
}

/**
 * Where the configured bind address answers, read from the address literal alone: any spelling of
 * loopback (`isLoopbackBind`), a Tailscale address, or anything else (a LAN address, a wildcard, a
 * DNS name). A name is never resolved, and nothing here says what a proxy in front forwards.
 */
export function bindScope(hostname: string): BindScope {
  if (isLoopbackBind(hostname)) return "loopback";
  const address = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const family = isIP(address);
  return (family === 4 ? tailnetIpv4.check(address, "ipv4") : family === 6 && tailnetIpv6.check(address, "ipv6")) ? "tailnet" : "other";
}

/** Is this one address (never a list) in Tailscale's assigned ranges? */
export const inTailnet = (address: string | null | undefined): boolean => {
  const family = isIP(address ?? "");
  return family === 4 ? tailnetIpv4.check(address!, "ipv4") : family === 6 && tailnetIpv6.check(address!, "ipv6");
};

/**
 * How this one request reached the server, as far as the request proves it; never how every
 * device reaches it. A Funnel header is labelled only from loopback, where Tailscale's proxy
 * connects from: anywhere else it is `unknown`. Other forwarding is `proxy`, and an unforwarded
 * request is `direct` (a proxy that adds nothing, nginx's bare `proxy_pass`, looks the same: see
 * `cameThroughProxy`).
 */
export function observedIngress(input: Pick<AccessInput, "loopback" | "forwarded" | "funnel"> & {
  /** the connection's source address is known at all */
  peerKnown: boolean;
  /** a forwarding header (`forwardingHeaders`) came with the request */
  forwardingHeaders: boolean;
}): ObservedIngress {
  if (!input.peerKnown) return "unknown";
  if (input.funnel) return input.loopback ? "funnel" : "unknown";
  if (input.forwardingHeaders) return "proxy";
  // from this PC, a Host that does not name it is a proxy rewriting nothing but the address
  return input.loopback && input.forwarded ? "proxy" : "direct";
}

/** Is there a forwarding header on the request, whoever sent it? Unlike `cameThroughProxy`, a Host header alone does not count. */
export function forwardingHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => headers.has(name)) || headers.has("tailscale-funnel-request");
}

/** Headers a proxy adds and a browser or CLI on this PC has no reason to send. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via"];

/**
 * The name a Host header addresses, lower-cased, without its port or its DNS root dot. It is read
 * as a bare authority, a name or a bracketed address with an optional port, and nothing else:
 * handed to a URL parser, `public.example@localhost` and `localhost/x@public.example` both came
 * out as localhost.
 */
export function hostName(host: string): string | null {
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  // one trailing dot is the DNS root, the same name
  return authority ? authority[1]!.toLowerCase().replace(/\.$/, "") : null;
}

/** Is this Host header a name for this machine itself? */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name !== null && (name === "localhost" || name.endsWith(".localhost") || name === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(name) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/.test(name));
}

/**
 * Evidence that a request reached this server through a proxy. Claiming it only ever costs the
 * sender the trust a local connection has, so a forged header gains nothing.
 */
export function cameThroughProxy(headers: Headers): boolean {
  if (PROXY_HEADERS.some((name) => headers.has(name))) return true;
  // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
  const host = headers.get("host");
  return host === null || !isLoopbackHost(host);
}

// Tailscale's assigned address ranges (net/tsaddr/tsaddr.go).
const tailnetIpv4 = new BlockList();
tailnetIpv4.addSubnet("100.64.0.0", 10, "ipv4");
const tailnetIpv6 = new BlockList();
tailnetIpv6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * The owner, for actions that change what runs on this PC's PCs (updates, installs, approving a
 * setup, server/machine-api.ts): whoever got in. There is one owner and no other role.
 */
export function ownerAccess(access: Access): boolean {
  return access.level === "full";
}

export function decideAccess(input: AccessInput): Access {
  if (input.tokenMatched) return { level: "full", via: "token" };
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  // a proxy or Funnel in front, and nothing held: what it forwards says nothing about who is behind it
  if (input.funnel || input.forwardingHeaders) return { level: "none", reason: "token_required" };
  if (input.loopback && !input.forwarded) return { level: "full", via: "local" };
  return { level: "none", reason: "token_required" };
}
