/** Factory ingress follows the hub's hub/src/signin.ts ALB contract. Ownership is never cached. */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { jsonResponse } from "./http.ts";

export const ALB_IDENTITY_HEADER = "x-amzn-oidc-data";
const ARN = /^arn:(aws|aws-cn):elasticloadbalancing:([a-z0-9-]+):\d{12}:loadbalancer\/app\/[A-Za-z0-9-]+\/[a-f0-9]+$/;
const MAX_IDENTITY_BYTES = 32 * 1024;

export interface FactoryAuthOptions {
  factory: string;
  owner: string;
  origin: string;
  loadBalancer: string;
  issuer: string;
  clientId: string;
  hubOrigin: string;
  registryOrigin: string;
  trustedProxyCidrs: string[];
  /** Only tests substitute keys and the hub. Production fetches pinned AWS/hub origins. */
  fetch?: typeof fetch;
  now?: () => number;
  audit?: (event: FactoryAudit) => void;
}

export interface FactoryAudit {
  at: string;
  factory: string;
  actor: string;
  action: string;
  outcome: "allowed" | "denied";
}

export class FactoryAuthError extends Error {
  constructor(readonly status: 401 | 403 | 503) { super("Factory access refused"); }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decode(part: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(part)) return undefined;
  try { return object(JSON.parse(Buffer.from(part, "base64url").toString("utf8"))); } catch { return undefined; }
}

const samePerson = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function origin(value: string, name: string, https: boolean): string {
  const url = new URL(value);
  if ((https ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${name} must be an ${https ? "HTTPS " : "HTTP(S) "}origin`);
  }
  return url.origin;
}

export class FactoryAuth {
  readonly factory: string;
  readonly origin: string;
  readonly browserOrigin: string;
  private readonly hubMe: string;
  private readonly peers = new BlockList();
  private readonly keys = new Map<string, Promise<KeyObject>>();
  private readonly failedKeys = new Map<string, number>();
  private readonly keyHost: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: FactoryAuthOptions) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(options.factory)) throw new Error("Invalid factory ID");
    this.factory = options.factory;
    this.origin = origin(options.origin, "Factory origin", true);
    if (!/^[^\s\x00-\x1f\x7f/]{1,254}$/.test(options.owner)) throw new Error("Invalid factory owner");
    this.browserOrigin = origin(options.hubOrigin, "Hub browser origin", true);
    this.hubMe = `${origin(options.registryOrigin, "Registry origin", false)}/api/app/me`;
    const arn = ARN.exec(options.loadBalancer);
    if (!arn) throw new Error("Invalid ALB ARN");
    this.keyHost = `https://public-keys.auth.elb.${arn[2]}.amazonaws.com${arn[1] === "aws-cn" ? ".cn" : ""}`;
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("Identity issuer must be an HTTPS URL");
    if (!options.clientId || !/^[A-Za-z0-9_-]{1,256}$/.test(options.clientId)) throw new Error("Invalid identity client ID");
    if (!options.trustedProxyCidrs.length) throw new Error("Trusted ALB subnets are required");
    for (const cidr of options.trustedProxyCidrs) {
      const [address, prefix, extra] = cidr.split("/");
      const family = isIP(address ?? "");
      const bits = Number(prefix);
      if (!family || extra !== undefined || !prefix || !/^\d+$/.test(prefix) || !Number.isInteger(bits) || bits <= 0 || bits > (family === 4 ? 32 : 128)) throw new Error("Invalid trusted ALB subnet");
      this.peers.addSubnet(address!, bits, family === 4 ? "ipv4" : "ipv6");
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  trustedPeer(peer: string | null): boolean {
    if (!peer) return false;
    const address = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
    const family = isIP(address);
    return family === 4 ? this.peers.check(address, "ipv4") : family === 6 && this.peers.check(address, "ipv6");
  }

  /** GET only, no query, identity, runtime facts or dependency on herdr/registry. ALB health probes carry no sign-in. */
  health(request: Request, peer: string | null): Response | undefined {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/health" && url.search === "" && !request.headers.has(ALB_IDENTITY_HEADER) && this.trustedPeer(peer)) {
      return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
    }
    return undefined;
  }

  /** Browser preflights contain no sign-in cookie. This grants only CORS metadata, never route execution. */
  preflight(request: Request, peer: string | null): Response | undefined {
    const url = new URL(request.url);
    if (request.method !== "OPTIONS" || !url.pathname.startsWith("/api/") || url.search || request.headers.has(ALB_IDENTITY_HEADER)
      || !this.trustedPeer(peer) || url.host !== new URL(this.origin).host || request.headers.get("x-forwarded-proto") !== "https"
      || !this.allowsOrigin(request.headers.get("origin"))) return undefined;
    const method = request.headers.get("access-control-request-method");
    const requested = request.headers.get("access-control-request-headers") ?? "";
    const allowed = new Set(["content-type", "x-herdr-machine", "x-herdr-update", "x-request-id"]);
    if (!method || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) || requested.length > 512
      || requested.split(",").some((name) => name.trim() !== "" && !allowed.has(name.trim().toLowerCase()))) return undefined;
    return new Response(null, { status: 204, headers: {
      "cache-control": "no-store", "access-control-allow-origin": request.headers.get("origin")!,
      "access-control-allow-credentials": "true", "access-control-allow-methods": method,
      "access-control-allow-headers": [...allowed].join(", "), "vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    } });
  }

  async admit(request: Request, peer: string | null): Promise<FactoryIdentity> {
    if (!this.trustedPeer(peer)) throw new FactoryAuthError(403);
    const url = new URL(request.url);
    // Pin the browser origin to installation config, never to caller-controlled forwarding headers.
    if (url.host !== new URL(this.origin).host || request.headers.get("x-forwarded-proto") !== "https") throw new FactoryAuthError(403);
    const mutation = !["GET", "HEAD"].includes(request.method) || url.pathname === "/ws";
    const browserOrigin = request.headers.get("origin");
    if ((mutation || browserOrigin !== null) && !this.allowsOrigin(browserOrigin)) throw new FactoryAuthError(403);
    const identity = await this.identity(request.headers.get(ALB_IDENTITY_HEADER));
    await this.checkOwner(identity);
    return identity;
  }

  allowsOrigin(value: string | null): boolean { return value === this.origin || value === this.browserOrigin; }

  private async key(kid: string): Promise<KeyObject> {
    const known = this.keys.get(kid);
    if (known) return known;
    const recent = [...this.failedKeys.values()].filter((at) => this.now() - at < 60_000);
    if (this.now() - (this.failedKeys.get(kid) ?? -Infinity) < 60_000 || recent.length >= 10 || this.keys.size >= 16) throw new FactoryAuthError(503);
    const pending = (async () => {
      try {
        const response = await this.fetcher(`${this.keyHost}/${kid}`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
        if (!response.ok) throw new Error();
        const pem = await response.text();
        if (pem.length > 16_384) throw new Error();
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
        return key;
      } catch {
        this.keys.delete(kid);
        if (this.failedKeys.size >= 256) this.failedKeys.delete(this.failedKeys.keys().next().value!);
        this.failedKeys.set(kid, this.now());
        throw new FactoryAuthError(503);
      }
    })();
    this.keys.set(kid, pending);
    // Evict an old successful key to allow ALB rotation; no identity or ownership answer is kept.
    if (this.keys.size === 16) this.keys.delete(this.keys.keys().next().value!);
    return pending;
  }

  async identity(token: string | null): Promise<FactoryIdentity> {
    if (!token || token.length > MAX_IDENTITY_BYTES) throw new FactoryAuthError(401);
    const parts = token.split(".");
    if (parts.length !== 3) throw new FactoryAuthError(401);
    const [h, p, s] = parts as [string, string, string];
    const header = decode(h);
    const payload = decode(p);
    if (!header || !payload || header.alg !== "ES256" || header.signer !== this.options.loadBalancer || header.iss !== this.options.issuer || header.client !== this.options.clientId
      || typeof header.kid !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(header.kid) || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new FactoryAuthError(401);
    const expires = Number(header.exp);
    if ((typeof header.exp !== "number" && typeof header.exp !== "string") || !Number.isFinite(expires) || expires * 1000 <= this.now()) throw new FactoryAuthError(401);
    const publicKey = await this.key(header.kid);
    try {
      if (!verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))) throw new Error();
    } catch { throw new FactoryAuthError(401); }
    const person = payload.email;
    if (typeof person !== "string" || !/^[^\s\x00-\x1f\x7f/]{1,254}$/.test(person) || (payload.email_verified !== undefined && payload.email_verified !== true && payload.email_verified !== "true")) throw new FactoryAuthError(401);
    return { person, token, expires: expires * 1000 };
  }

  /** Each request, incoming frame and outgoing frame asks the hub again. A failure never falls back to a token/local role. */
  async checkOwner(identity: FactoryIdentity): Promise<void> {
    if (identity.expires <= this.now()) throw new FactoryAuthError(401);
    if (!samePerson(identity.person, this.options.owner)) throw new FactoryAuthError(403);
    let response: Response;
    let me: Record<string, unknown> | undefined;
    try {
      response = await this.fetcher(this.hubMe, {
        headers: { [ALB_IDENTITY_HEADER]: identity.token, "cache-control": "no-cache, no-store", accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) throw new FactoryAuthError(403);
      if (!response.ok) throw new Error();
      me = object(await response.json());
    } catch (error) {
      if (error instanceof FactoryAuthError) throw error;
      throw new FactoryAuthError(503);
    }
    if (!me || typeof me.person !== "string" || !samePerson(me.person, identity.person) || !["engineer", "admin", "viewer"].includes(String(me.role)) || !Array.isArray(me.factories)) throw new FactoryAuthError(403);
    const owns = me.factories.some((entry: unknown) => {
      const factory = object(entry);
      return factory?.factory === this.factory && typeof factory.owner === "string" && samePerson(factory.owner, identity.person)
        && factory.address === this.origin && factory.state === "ready";
    });
    if (!owns || identity.expires <= this.now()) throw new FactoryAuthError(403);
  }

  audit(identity: FactoryIdentity | undefined, action: string, outcome: "allowed" | "denied" = "allowed"): void {
    const event: FactoryAudit = { at: new Date(this.now()).toISOString(), factory: this.factory, actor: identity?.person ?? "unknown", action, outcome };
    try {
      if (this.options.audit) this.options.audit(event);
      else console.info(JSON.stringify(event));
    } catch { /* Audit transport must not expose a request or its contents. */ }
  }
}

export interface FactoryIdentity { person: string; token: string; expires: number }

export function factoryAuthResponse(error: unknown): Response {
  const status = error instanceof FactoryAuthError ? error.status : 503;
  return jsonResponse({ error: { code: status === 503 ? "identity_unavailable" : status === 401 ? "unauthorized" : "forbidden", message: "Factory access refused" } }, status, { "cache-control": "no-store" });
}

/** Any factory configuration opts into the complete gate. Partial/misspelled modes cannot silently start a local server. */
export function factoryAuthFromEnv(env: Record<string, string | undefined>): FactoryAuth | undefined {
  const names = ["WIDAL_AUTH_MODE", "WIDAL_FACTORY_OWNER", "WIDAL_REGISTRY_ORIGIN", "WIDAL_FACTORY_ID", "WIDAL_FACTORY_ORIGIN", "WIDAL_ALB_ARN", "WIDAL_OIDC_ISSUER", "WIDAL_OIDC_CLIENT_ID", "WIDAL_HUB_ORIGIN", "WIDAL_ALB_SUBNETS"];
  if (!Object.keys(env).some((name) => names.includes(name) || /^WIDAL_(AUTH|FACTORY|ALB|OIDC|REGISTRY|HUB)_/.test(name))) return undefined;
  if (env["WIDAL_AUTH_MODE"] !== "alb" || names.some((name) => !env[name]?.trim())) throw new Error("Complete ALB factory authentication configuration is required");
  return new FactoryAuth({ factory: env["WIDAL_FACTORY_ID"]!, owner: env["WIDAL_FACTORY_OWNER"]!, registryOrigin: env["WIDAL_REGISTRY_ORIGIN"]!, origin: env["WIDAL_FACTORY_ORIGIN"]!, loadBalancer: env["WIDAL_ALB_ARN"]!, issuer: env["WIDAL_OIDC_ISSUER"]!, clientId: env["WIDAL_OIDC_CLIENT_ID"]!, hubOrigin: env["WIDAL_HUB_ORIGIN"]!, trustedProxyCidrs: env["WIDAL_ALB_SUBNETS"]!.split(",").map((cidr) => cidr.trim()) });
}
