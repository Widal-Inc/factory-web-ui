/** How a request got in, when it did. */
export type AccessVia = "local" | "token";
/** Why a request did not. */
export type AccessRefusal = "token_required";

/** GET /api/health `auth`: `authenticated` is whether this request got in; `required` is the opposite, kept for older clients. */
export interface HealthAuth {
  readonly required: boolean;
  readonly authenticated: boolean;
  readonly via?: AccessVia;
  /** with `via: "token"`: the token came in an `Authorization` header (a proxy sends it), so signing out of this browser would change nothing */
  readonly bearer?: true;
  readonly reason?: AccessRefusal;
}

/** The configured bind address, read from its literal (`bindScope` in server/access.ts): never a DNS lookup or the request's Host. */
export type BindScope = "loopback" | "tailnet" | "other";
/** How this one request arrived, as far as it proves (`observedIngress` in server/access.ts); not how every device reaches the server. `direct`: no proxy said it forwarded the request, which a proxy that adds nothing (an SSH tunnel, nginx's bare `proxy_pass`) also looks like. */
export type ObservedIngress = "direct" | "proxy" | "funnel" | "unknown";

/**
 * GET /api/health (both scopes), authenticated requests only:
 * what protects this server, each fact on its own and none of them a verdict. It carries no
 * token, hash, header, login or address, and is sent `no-store`. Anonymous answers omit it, and
 * an older server sends none: the client then says the facts are unavailable rather than
 * reading them from `auth`.
 */
export interface SecuritySummary {
  /** an access token is configured on the server, whether or not this request used it */
  readonly token_configured: boolean;
  readonly bind_scope: BindScope;
  readonly observed_ingress: ObservedIngress;
  /** `observed` only with trusted public-ingress evidence on this request (Funnel); otherwise unknown, never "none" */
  readonly public_exposure: "observed" | "unknown";
}

/** GET /api/access: how a phone can reach this server, as far as the server can tell (Settings → Phone). */
export interface RemoteAccess {
  /** the port this server listens on; the tailscale command names it */
  readonly port: number;
  readonly tailscale: TailscaleAccess;
}

/** Read from `tailscale status --json` and `tailscale serve status --json`, never by changing anything. */
export interface TailscaleAccess {
  /** missing: no tailscale CLI on this PC; stopped: the CLI is there but the daemon is not running or not logged in */
  readonly state: "missing" | "stopped" | "running";
  /** this PC's MagicDNS name, without the trailing dot */
  readonly dns_name: string | null;
  /** the HTTPS address Tailscale already proxies to this server, when there is one */
  readonly serving_url: string | null;
  /** otherwise, the command that publishes it on the first free of the usual HTTPS ports, or on the one OVIS_TAILSCALE_HTTPS_PORT names while it is free ... */
  readonly serve_command: string | null;
  /** ... and the address that command gives, when the DNS name is known */
  readonly serve_url: string | null;
}
