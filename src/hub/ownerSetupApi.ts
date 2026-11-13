// The registered owner factory's Setup API (shared/factory-setup.ts), called by the browser directly.
// Every secret the person enters or receives (a Claude code, a Linear code) goes here and nowhere else:
// never to the hub, never into a log, a URL the app keeps or browser storage. The transport is the
// verified direct one: credentialed, uncached, no redirects, and only the registered owner origin.
import type { GithubDevicePoll, GithubDeviceStart, LinearStart, SetupChoices, SetupSave, SetupSettings, SetupStatus } from "../../shared/factory-setup.ts";
import type { UsageLoginFollowed, UsageLoginPrompt } from "../../shared/usage-login.ts";
import { directTransport } from "./directTransport.ts";

/** The factory host could not be reached with the person's sign-in: usually its own sign-in cookie is missing. */
export class FactoryUnreachable extends Error {
  constructor() { super("Your factory did not answer. Its sign-in may have expired."); }
}
export class SetupApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : unsupported();
const unsupported = (): never => { throw new SetupApiError(502, "unsupported", "Your factory sent an answer this page does not understand. The factory reports it; try again later."); };
const str = (value: unknown): string => typeof value === "string" ? value : unsupported();
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : unsupported();
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : unsupported();
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : unsupported();

function status(value: unknown): SetupStatus {
  const body = obj(value);
  if (body["version"] !== 1) return unsupported();
  const github = obj(body["github"]);
  const linear = obj(body["linear"]);
  const settings = body["settings"] === null ? null : obj(body["settings"]);
  const next = body["next"] === null ? null : oneOf(body["next"], ["github", "linear", "settings", "claude"] as const);
  const repositories = settings ? (Array.isArray(settings["repositories"]) ? settings["repositories"].map(str) : unsupported()) : [];
  return {
    version: 1,
    github: { state: oneOf(github["state"], ["connected", "expired", "not_connected", "unavailable"] as const), ...(github["login"] !== undefined ? { login: str(github["login"]) } : {}), ...(github["id"] !== undefined ? { id: num(github["id"]) } : {}), ...(github["noreplyEmail"] !== undefined ? { noreplyEmail: str(github["noreplyEmail"]) } : {}), ...(github["expiresAt"] !== undefined ? { expiresAt: num(github["expiresAt"]) } : {}), ...(github["reason"] !== undefined ? { reason: str(github["reason"]) } : {}) },
    linear: { state: oneOf(linear["state"], ["connected", "expired", "not_connected", "not_used", "unavailable"] as const), ...(linear["name"] !== undefined ? { name: str(linear["name"]) } : {}), ...(linear["id"] !== undefined ? { id: str(linear["id"]) } : {}), ...(linear["expiresAt"] !== undefined ? { expiresAt: num(linear["expiresAt"]) } : {}), ...(linear["reason"] !== undefined ? { reason: str(linear["reason"]) } : {}) },
    settings: settings ? { repositories, linearTeam: settings["linearTeam"] === null ? null : str(settings["linearTeam"]), gitName: str(settings["gitName"]), gitEmail: str(settings["gitEmail"]) } : null,
    // absent from a factory older than this page: nothing reported unreachable
    unreachableRepositories: body["unreachableRepositories"] === undefined ? [] : Array.isArray(body["unreachableRepositories"]) ? body["unreachableRepositories"].map(str) : unsupported(),
    claude: { state: oneOf(obj(body["claude"])["state"], ["signed_in", "not_signed_in", "unavailable"] as const) },
    ready: bool(body["ready"]), next,
  };
}

function choices(value: unknown): SetupChoices {
  const body = obj(value);
  const list = (entry: unknown): unknown[] => Array.isArray(entry) ? entry : unsupported();
  return {
    repositories: list(body["repositories"]).map((item) => ({ fullName: str(obj(item)["fullName"]), private: bool(obj(item)["private"]) })),
    teams: list(body["teams"]).map((item) => ({ key: str(obj(item)["key"]), name: str(obj(item)["name"]) })),
    proposed: { gitName: str(obj(body["proposed"])["gitName"]), gitEmail: str(obj(body["proposed"])["gitEmail"]) },
  };
}

/** The sign-in address the CLI prints: only an HTTPS page on Claude's or Anthropic's own host is ever offered as a link. */
export function claudeSignInLink(url: string | null): string | null {
  if (!url) return null;
  try {
    const link = new URL(url);
    const host = link.hostname.toLowerCase();
    return link.protocol === "https:" && !link.username && !link.password && ["claude.ai", "claude.com", "anthropic.com"].some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? link.href : null;
  } catch { return null; }
}

const GITHUB_DEVICE_PAGE = "https://github.com/login/device";
const LINEAR_AUTHORIZE = "https://linear.app/oauth/authorize";

export interface OwnerSetupApi {
  /** A top-level address on the factory host that primes its sign-in and returns to a fixed hub page. */
  primeUrl(next?: "setup" | "my-factory"): string;
  status(signal?: AbortSignal): Promise<SetupStatus>;
  choices(signal?: AbortSignal): Promise<SetupChoices>;
  githubStart(): Promise<GithubDeviceStart>;
  githubPoll(signal?: AbortSignal): Promise<GithubDevicePoll>;
  githubDisconnect(): Promise<void>;
  linearStart(): Promise<LinearStart>;
  linearCallback(code: string, state: string): Promise<{ name: string }>;
  linearDisconnect(): Promise<void>;
  /** The choices and the accounts the page showed: the factory refuses them for any other account. */
  saveSettings(settings: SetupSave): Promise<SetupSettings>;
  claudeStart(replace: boolean): Promise<UsageLoginFollowed>;
  claudePrompt(login: string, signal?: AbortSignal): Promise<UsageLoginPrompt>;
  claudeCode(login: string, code: string): Promise<void>;
  claudeCancel(login: string): Promise<void>;
}

export function ownerSetupApi(ownerOrigin: string, hubOrigin: string, browserFetch?: typeof fetch): OwnerSetupApi {
  // throws for an origin that is not a registered HTTPS origin: a person is never sent anywhere else
  const transport = directTransport(ownerOrigin, hubOrigin, browserFetch ? { fetch: browserFetch, socket: () => { throw new Error("no socket"); }, events: () => { throw new Error("no events"); } } : undefined);
  async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await transport.fetch(path, { method, signal, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new FactoryUnreachable();
    }
    const value: unknown = await response.json().catch(() => null);
    if (response.ok) return value;
    if (response.status === 401) throw new FactoryUnreachable();
    const failure = value !== null && typeof value === "object" ? (value as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    // the gate's own refusal (identity or current ownership) says nothing useful; a Setup step's refusal is written for the page
    const gate = response.status === 403 && (failure?.code === "forbidden" || failure?.code === undefined);
    const message = gate ? "This factory is not registered to you." : typeof failure?.message === "string" && failure.message.length <= 400 ? failure.message : "Your factory could not complete this step. Try again.";
    throw new SetupApiError(response.status, typeof failure?.code === "string" ? failure.code : "failed", message);
  }
  const post = (path: string, body: unknown = {}) => call("POST", `/api/factory/setup${path}`, body);
  return {
    primeUrl: (next = "setup") => `${new URL(ownerOrigin).origin}/api/factory/setup/prime?next=${next}`,
    status: async (signal) => status(await call("GET", "/api/factory/setup", undefined, signal)),
    choices: async (signal) => choices(await call("GET", "/api/factory/setup/choices", undefined, signal)),
    githubStart: async () => {
      const body = obj(await post("/github/start"));
      // GitHub's own device page and nothing else is ever shown as the place to type the code
      if (body["verificationUri"] !== GITHUB_DEVICE_PAGE) return unsupported();
      return { userCode: str(body["userCode"]), verificationUri: GITHUB_DEVICE_PAGE, expiresIn: num(body["expiresIn"]), interval: num(body["interval"]) };
    },
    githubPoll: async (signal) => {
      const body = obj(await call("POST", "/api/factory/setup/github/poll", {}, signal));
      const state = oneOf(body["state"], ["pending", "connected", "failed"] as const);
      if (state === "pending") return { state, interval: num(body["interval"]) };
      if (state === "connected") return { state, login: str(body["login"]) };
      return { state, reason: oneOf(body["reason"], ["expired", "denied", "unavailable"] as const), message: str(body["message"]) };
    },
    githubDisconnect: async () => { await post("/github/disconnect"); },
    linearStart: async () => {
      const url = str(obj(await post("/linear/start"))["url"]);
      const link = new URL(url);
      if (link.origin + link.pathname !== LINEAR_AUTHORIZE) return unsupported();
      return { url: link.href };
    },
    linearCallback: async (code, state) => ({ name: str(obj(await post("/linear/callback", { code, state }))["name"]) }),
    linearDisconnect: async () => { await post("/linear/disconnect"); },
    saveSettings: async (settings) => {
      const body = obj(await call("PUT", "/api/factory/setup/settings", settings));
      return { repositories: Array.isArray(body["repositories"]) ? body["repositories"].map(str) : unsupported(), linearTeam: body["linearTeam"] === null ? null : str(body["linearTeam"]), gitName: str(body["gitName"]), gitEmail: str(body["gitEmail"]) };
    },
    // Claude Code's existing sign-in, run in the factory's own terminal host: only a link and a one-time code pass through here
    claudeStart: async (replace) => {
      const body = obj(await call("POST", "/api/usage/login", { provider: "claude", default: true, follow: true, ...(replace ? { replace: true } : {}) }));
      return { login_id: str(body["login_id"]), device_auth: bool(body["device_auth"]) };
    },
    claudePrompt: async (login, signal) => {
      const body = obj(await call("GET", `/api/usage/login/prompt?login=${encodeURIComponent(login)}`, undefined, signal));
      return { provider: "claude", url: body["url"] === null ? null : str(body["url"]), user_code: body["user_code"] === null ? null : str(body["user_code"]), wants_code: bool(body["wants_code"]), ended: bool(body["ended"]), ...(body["succeeded"] !== undefined ? { succeeded: bool(body["succeeded"]) } : {}), ...(body["account"] !== undefined ? { account: body["account"] === null ? null : str(body["account"]) } : {}) };
    },
    claudeCode: async (login, code) => { await call("POST", "/api/usage/login/code", { login, code }); },
    claudeCancel: async (login) => { await call("POST", "/api/usage/login/cancel", { login }); },
  };
}
