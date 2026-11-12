import { AsyncLocalStorage } from "node:async_hooks";

/** An operation carries its owner check through awaits and queued RPC writes. Never an authorization answer. */
interface FactoryOrigins { factory: string; hub: string }
const authority = new AsyncLocalStorage<{ check: () => Promise<void>; origins?: FactoryOrigins }>();

export function withFactoryAuthority<T>(check: (() => Promise<void>) | undefined, operation: () => T, origins?: FactoryOrigins): T {
  return check ? authority.run({ check, origins }, operation) : operation();
}

export function currentFactoryAuthority(): (() => Promise<void>) | undefined { return authority.getStore()?.check; }

/** Deployment configuration carried only inside a signed, current-owner HTTP request. */
export function currentFactoryHubOrigin(): string | undefined { return authority.getStore()?.origins?.hub; }

/** Existing per-route origin guards use the same configured browser origins as the outer gate. */
export function factoryOriginAllowed(request: Request): boolean | undefined {
  const origins = authority.getStore()?.origins;
  if (!origins) return undefined;
  const origin = request.headers.get("origin");
  return origin === null ? ["GET", "HEAD"].includes(request.method) : origin === origins.factory || origin === origins.hub;
}

/** Shared readers and cleanup belong to the server; their delivery still checks each recipient. */
export function withoutFactoryAuthority<T>(cleanup: () => T): T { return authority.exit(cleanup); }
