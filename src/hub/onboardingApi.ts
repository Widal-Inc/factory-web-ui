// The hub's browser onboarding API, version 1 (docs/hub-onboarding-api.md in the factory repository).
// Same-origin cookies only, no browser bearer token, and nothing personal: the hub gets the
// organization's non-secret app registration and invite progress, never a person's GitHub, Linear or
// Claude credential. Parsed at the boundary so a producer that drifts is shown as unsupported.
import { array, boolean, HubError, literal, number, object, optional, text, union, type Parser } from "./contract.ts";

const anyObject: Parser<Record<string, unknown>> = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : object({})(null) as never;
export interface OnboardingStatus {
  readonly version: 1;
  readonly github?: { readonly id: number; readonly clientId: string; readonly slug: string; readonly organization: string };
  readonly linear?: { readonly clientId: string };
  readonly usesLinear?: boolean;
  readonly linearCallback: string;
  readonly email: { readonly productionAccess: boolean; readonly sendingEnabled: boolean; readonly review: string };
}
const appRegistration = object({ id: number, clientId: text, slug: text, organization: text });
export const parseOnboardingStatus = object({
  version: literal(1), github: optional(appRegistration), linear: optional(object({ clientId: text })), usesLinear: optional(boolean), linearCallback: text,
  email: object({ productionAccess: boolean, sendingEnabled: boolean, review: text }),
}) as Parser<OnboardingStatus>;

export const INVITE_STATES = ["creating", "ready", "failed", "removed"] as const;
export const INVITE_DELIVERIES = ["waiting", "manual", "sent", "failed"] as const;
const inviteState = union(literal("creating"), union(literal("ready"), union(literal("failed"), literal("removed"))));
const inviteDelivery = union(literal("waiting"), union(literal("manual"), union(literal("sent"), literal("failed"))));
export interface Invite {
  readonly id: string; readonly owner: string; readonly factory: string; readonly link: string; readonly createdAt: string; readonly expiresAt: string;
  readonly usedAt?: string; readonly replacedAt?: string; readonly state: (typeof INVITE_STATES)[number]; readonly delivery: (typeof INVITE_DELIVERIES)[number]; readonly error?: string; readonly progressAt?: string;
}
const invite = object({ id: text, owner: text, factory: text, link: text, createdAt: text, expiresAt: text, usedAt: optional(text), replacedAt: optional(text), state: inviteState, delivery: inviteDelivery, error: optional(text), progressAt: optional(text) }) as Parser<Invite>;
export const parseInvites = object({ invites: array(invite) });
export const parseInviteResult = object({ person: text, role: text, invite: optional(invite), signIn: optional(anyObject) });
export const parseMyFactory = object({ invite });
export const parseManifest = object({ action: text, method: literal("POST"), manifest: anyObject, instructions: text });
export interface Installation { readonly installed: boolean; readonly installationId?: number }
export const parseInstallation = object({ installed: boolean, installationId: optional(number) }) as Parser<Installation>;
export const parseLinearSaved = union(object({ clientId: text, callback: text }), object({ usesLinear: boolean }));

const GITHUB_APP_FORM = /^https:\/\/github\.com\/organizations\/[A-Za-z0-9-]{1,39}\/settings\/apps\/new\?state=[A-Za-z0-9_-]{1,200}$/;
export const LINEAR_CLIENT_ID = /^[a-zA-Z0-9_-]{1,200}$/;
export const GITHUB_ORGANIZATION = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** Where the person goes to install the organization's app, from the slug the hub registered. Null for a slug that is not GitHub's. */
export function installUrl(slug: string): string | null { return /^[A-Za-z0-9-]{1,100}$/.test(slug) ? `https://github.com/apps/${slug}/installations/new` : null; }

/** GitHub's manifest form is posted by the browser itself, to GitHub's own organization page and nowhere else. */
export function manifestForm(value: { action: string; manifest: object }): { action: string; manifest: string } {
  if (!GITHUB_APP_FORM.test(value.action)) throw new Error("The hub returned an unexpected GitHub address. Start again after the hub is updated.");
  return { action: value.action, manifest: JSON.stringify(value.manifest) };
}

export interface OnboardingApi {
  status(signal?: AbortSignal): Promise<OnboardingStatus>;
  manifest(organization: string): Promise<{ action: string; manifest: object; instructions: string }>;
  installation(signal?: AbortSignal): Promise<Installation | null>;
  linear(change: { clientId: string } | { usesLinear: false }): Promise<ReturnType<typeof parseLinearSaved>>;
  invites(signal?: AbortSignal): Promise<Invite[]>;
  invite(input: { email: string; role: "engineer" | "admin" | "viewer"; factory?: string }): Promise<{ person: string; role: string; invite: Invite | null }>;
  createMine(): Promise<Invite>;
}

/** The hub's own message for an error it wrote for the person; anything else becomes a plain sentence. */
function failure(status: number, body: unknown): HubError {
  if (status === 401) return new HubError(status, "Your sign-in has expired. Reload to sign in again.");
  const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  const own = message.length > 0 && message.length <= 400 && !/[\u0000-\u001f]/.test(message) ? message : "";
  if (own && (status < 500 || status === 502 || status === 503)) return new HubError(status, own);
  if (status === 403) return new HubError(status, "You do not have access to this.");
  return new HubError(status, "The hub could not complete this. Try again.");
}

export function createOnboardingApi(request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): OnboardingApi {
  async function call<T>(method: "GET" | "POST" | "PUT", path: string, parse: Parser<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!path.startsWith("/api/app/") || path.includes("\\") || path.includes("#")) throw new Error("Unsupported hub request.");
    const response = await request(path, {
      method, credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let value: unknown = null;
    try { value = await response.json(); } catch { /* an error page: handled below */ }
    if (!response.ok) throw failure(response.status, value);
    try { return parse(value); } catch { throw new HubError(502, "The hub returned an unsupported response. Refresh after the app and hub are updated together."); }
  }
  return {
    status: (signal) => call("GET", "/api/app/admin/onboarding", parseOnboardingStatus, undefined, signal),
    manifest: (organization) => call("POST", "/api/app/admin/github/manifest", parseManifest, { organization }),
    installation: async (signal) => {
      try { return await call("GET", "/api/app/admin/github/installation", parseInstallation, undefined, signal); }
      // not installed yet is a state, not a failure
      catch (error) { if (error instanceof HubError && (error.status === 404 || error.status === 409)) return null; throw error; }
    },
    linear: (change) => call("PUT", "/api/app/admin/linear", parseLinearSaved, change),
    invites: async (signal) => (await call("GET", "/api/app/invites", parseInvites, undefined, signal)).invites,
    invite: async (input) => { const result = await call("POST", "/api/app/invites", parseInviteResult, input); return { person: result.person, role: result.role, invite: result.invite ?? null }; },
    createMine: async () => (await call("POST", "/api/app/my/factory", parseMyFactory, {})).invite,
  };
}
