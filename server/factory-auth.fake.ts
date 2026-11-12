import { generateKeyPairSync, sign } from "node:crypto";
import { FactoryAuth, type FactoryAudit, type FactoryAuthOptions } from "./factory-auth.ts";

/** Synthetic signed identities and an in-memory registry; never reaches AWS or a real hub. */
export function factoryFixture() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let now = 1_800_000_000_000;
  let me: unknown = { person: "ada@example.test", role: "engineer", factories: [{ factory: "ada-factory", owner: "ada@example.test", address: "https://ada.factory.example.test", state: "ready" }] };
  let status = 200;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const audits: FactoryAudit[] = [];
  const options: FactoryAuthOptions = {
    factory: "ada-factory", owner: "ada@example.test", origin: "https://ada.factory.example.test",
    hubOrigin: "https://factory.example.test", registryOrigin: "http://10.1.2.5:7373",
    loadBalancer: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/example/0123456789abcdef",
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example", clientId: "example-client",
    trustedProxyCidrs: ["10.1.2.0/24"], now: () => now, audit: (event) => audits.push(event),
    fetch: (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://public-keys.auth.elb.us-east-1.amazonaws.com/")) return new Response(keys.publicKey.export({ type: "spki", format: "pem" }));
      if (url === "http://10.1.2.5:7373/api/app/me") return Response.json(me, { status });
      throw new Error("Unexpected fixture fetch");
    }) as typeof fetch,
  };
  const token = (header: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, padded = false) => {
    const encode = (bytes: Buffer) => padded ? bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_") : bytes.toString("base64url");
    const h = encode(Buffer.from(JSON.stringify({ alg: "ES256", kid: "example-key", signer: options.loadBalancer, iss: options.issuer, client: options.clientId, exp: now / 1000 + 3600, ...header })));
    const p = encode(Buffer.from(JSON.stringify({ email: "ada@example.test", email_verified: true, ...payload })));
    return `${h}.${p}.${encode(sign("sha256", Buffer.from(`${h}.${p}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }))}`;
  };
  return {
    options, auth: new FactoryAuth(options), calls, audits, token,
    setMe: (value: unknown, code = 200) => { me = value; status = code; },
    advance: (milliseconds: number) => { now += milliseconds; },
    request: (path = "/api/preferences", init: RequestInit = {}) => new Request(`${options.origin}${path}`, {
      ...init, headers: { host: new URL(options.origin).host, "x-forwarded-proto": "https", "x-amzn-oidc-data": token(), origin: options.hubOrigin, ...Object.fromEntries(new Headers(init.headers)) },
    }),
  };
}
