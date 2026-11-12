// Browser projection of factory hub v1 at 02c64480524283a116360aeeb81c3ef0e9ba168c.
// Keep this independent of the hub's Node/SQLite modules. Parse at the network boundary so a
// mismatched producer never turns missing fields into an empty queue or healthy dashboard.
export type Parser<T> = (value: unknown) => T;
type Parsed<S> = S extends Parser<infer T> ? T : never;
const invalid = (): never => { throw new Error("The hub returned an unsupported response. Refresh after the app and hub are updated together."); };
export const text: Parser<string> = (v) => typeof v === "string" ? v : invalid();
export const number: Parser<number> = (v) => typeof v === "number" && Number.isFinite(v) ? v : invalid();
const timestamp: Parser<number> = (v) => { const at = number(v); return Number.isFinite(new Date(at).getTime()) ? at : invalid(); };
export const boolean: Parser<boolean> = (v) => typeof v === "boolean" ? v : invalid();
export function literal<const T extends string | number | null>(expected: T): Parser<T> { return (v) => v === expected ? expected : invalid(); }
export function array<T>(parse: Parser<T>): Parser<T[]> { return (v) => Array.isArray(v) ? v.map(parse) : invalid(); }
export function optional<T>(parse: Parser<T>): Parser<T | undefined> { return (v) => v === undefined ? undefined : parse(v); }
export function union<A, B>(a: Parser<A>, b: Parser<B>): Parser<A | B> {
  return (v) => { try { return a(v); } catch { return b(v); } };
}
export function object<S extends Record<string, Parser<unknown>>>(shape: S): Parser<{ [K in keyof S]: Parsed<S[K]> }> {
  return (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return invalid();
    return Object.fromEntries(Object.entries(shape).map(([key, parse]) => [key, parse((v as Record<string, unknown>)[key])])) as { [K in keyof S]: Parsed<S[K]> };
  };
}
const nullableNumber = union(number, literal(null));
const role = union(literal("admin"), union(literal("engineer"), literal("viewer")));
export const unavailable = object({ state: literal("unavailable"), reason: text });
export type Unavailable = Parsed<typeof unavailable>;
const factory = object({ factory: text, owner: text, address: optional(text), state: union(literal("creating"), union(literal("ready"), union(literal("failed"), literal("removed")))), registeredAt: text, updatedAt: text });
export type Factory = Parsed<typeof factory>;
const waitKind = union(literal("person"), union(literal("broken"), union(literal("blocked"), union(literal("working"), union(literal("merge"), literal("queued"))))));
const wait = object({ kind: waitKind, actsNext: text, why: text, since: timestamp });
const card = object({ factory: text, id: text, title: text, status: text, priority: number, kind: waitKind, actsNext: text, why: text, since: timestamp, hours: number, externalRef: optional(text), pr: optional(text) });
export type Card = Parsed<typeof card>;
const errors = array(object({ factory: text, error: text }));
const cost = object({ usd: nullableNumber, beads: number, perFactory: array(object({ factory: text, usd: number })) });
export type Cost = Parsed<typeof cost>;
const window = object({ closedPerDay: number, rejectedShare: nullableNumber, medianHours: nullableNumber });
const trend = object({ last7: window, before: window });
const queue = object({ asOf: timestamp, factories: array(object({ factory: text, state: text, address: optional(text), cards: array(card), read: boolean })) });
const me = object({ person: text, role, factories: array(factory) });
export const parseBootstrap = object({ version: literal(1), me, links: object({ myFactory: text, today: text, quality: text, admin: union(text, literal(null)) }), beads: union(object({ state: literal("configured") }), unavailable) });
export type Bootstrap = Parsed<typeof parseBootstrap>;
export const parseOverview = object({
  version: literal(1), asOf: timestamp, factories: array(factory),
  live: array(object({ factory: text, connection: union(object({ state: literal("direct"), origin: text }), unavailable) })),
  work: union(object({ state: union(literal("ready"), literal("partial")), queue, cost, pullRequests: array(object({ factory: text, id: text, url: text, review: unavailable, ci: unavailable })), errors }), unavailable),
  usageLimits: unavailable,
});
export type Overview = Parsed<typeof parseOverview>;
export const parseToday = object({ asOf: timestamp, needsPerson: array(card), broken: array(card), actsNext: array(object({ who: text, count: number })), factories: array(object({ factory: text, owner: text, state: text, address: optional(text), open: number, working: number, waitingOnPerson: number, broken: number, closedInWindow: number, read: boolean })), cost, trend, errors });
export type Today = Parsed<typeof parseToday>;
export const parseQuality = object({ asOf: timestamp, closedPerDay: array(object({ day: text, closed: number })), weeks: array(object({ weekStart: text, closed: number, rejected: number, medianHours: nullableNumber })), perFactory: array(object({ factory: text, closed: number, medianHours: nullableNumber, rejected: number })), trend, errors });
export type Quality = Parsed<typeof parseQuality>;
export const parseItem = object({
  bead: object({ factory: text, id: text, title: text, status: text, priority: number, type: text, assignee: optional(text), owner: optional(text), createdAt: timestamp, updatedAt: timestamp, startedAt: optional(timestamp), closedAt: optional(timestamp), closeReason: optional(text), externalRef: optional(text), labels: array(text), blockedBy: array(text), parent: optional(text), pr: optional(text), costUsd: optional(number) }),
  wait: optional(wait), blockedBy: array(object({ id: text, status: optional(text), title: optional(text) })), events: array(object({ type: text, actor: text, at: timestamp, from: optional(text), to: optional(text), comment: optional(text) })),
});
export type Item = Parsed<typeof parseItem>;
export const parseAdmin = object({ version: literal(1), people: array(object({ person: text, role, addedAt: optional(text), source: union(literal("registry"), literal("log")) })), factories: array(factory), capabilities: object({ people: object({ state: literal("ready"), endpoint: text }), factories: object({ state: literal("ready"), endpoint: text }), onboarding: union(object({ state: literal("ready"), endpoint: text }), unavailable), identityProvider: unavailable, branding: unavailable, budgets: unavailable, telemetry: unavailable }) });
export type Admin = Parsed<typeof parseAdmin>;

export type Route = { page: "my" | "today" | "quality" | "setup" | "linearCallback" | "admin" } | { page: "item"; factory: string; id: string } | { page: "missing" };
export function routeFor(path: string): Route {
  if (path === "/" || path === "/my-factory") return { page: "my" };
  if (path === "/team") return { page: "today" };
  if (path === "/team/quality") return { page: "quality" };
  if (path === "/linear/callback") return { page: "linearCallback" };
  if (/^\/setup(?:\/[^/]+)?$/.test(path)) return { page: "setup" };
  if (/^\/admin(?:\/[^/]+)?$/.test(path)) return { page: "admin" };
  const match = /^\/team\/items\/([^/]+)\/([^/]+)$/.exec(path);
  if (match) {
    try {
      const factory = decodeURIComponent(match[1]!);
      const id = decodeURIComponent(match[2]!);
      if (/^[a-z][a-z0-9-]{0,19}[a-z0-9]$/.test(factory) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) return { page: "item", factory, id };
    } catch { /* malformed deep links are ordinary not-found pages */ }
  }
  return { page: "missing" };
}
export function itemPath(factory: string, id: string): string { return `/team/items/${encodeURIComponent(factory)}/${encodeURIComponent(id)}`; }

function httpsOrigin(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/** Only owner registration can supply a live target. Callers may not choose Team factories. */
export function ownerOrigin(data: Overview, person: string, factoryId: string): string | null {
  const owned = data.factories.find((f) => f.factory === factoryId && f.state === "ready" && f.owner.trim().toLowerCase() === person.trim().toLowerCase());
  const connection = data.live.find((f) => f.factory === factoryId)?.connection;
  if (!owned || connection?.state !== "direct") return null;
  const target = httpsOrigin(connection.origin);
  return target === connection.origin && target === httpsOrigin(owned.address ?? "") ? target : null;
}

export class HubError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** No transport singleton: hub reads must never follow a selected personal factory. */
export async function readHub<T>(path: string, parse: Parser<T>, signal: AbortSignal, request: typeof fetch = fetch): Promise<T> {
  if (!path.startsWith("/api/app/") || path.includes("\\") || path.includes("?") || path.includes("#")) throw new Error("Unsupported hub request.");
  const response = await request(path, { credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    const message = response.status === 401 ? "Your sign-in has expired. Reload to sign in again." : response.status === 403 ? "You no longer have access to this page." : response.status === 404 ? "This page or work item is not available." : "The hub could not load this page. Try again.";
    throw new HubError(response.status, message);
  }
  let value: unknown;
  try { value = await response.json(); } catch { return invalid(); }
  return parse(value);
}
