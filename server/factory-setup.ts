/**
 * The owner factory's Setup: connects the signed-in person's own GitHub (the organization's app, device
 * flow) and Linear (PKCE) accounts, saves their repository, team and git identity choices, and reports
 * whether this factory is ready to start agents. Claude's sign-in is the existing followed sign-in
 * (`/api/usage/login`); Setup only reads whether it is done.
 *
 * Every credential stays on this host: the browser never receives one and the hub never sees one.
 * The client IDs come from the hub's own Setup answer, read with the person's verified identity, and
 * every upstream host is fixed here. A pending device code or PKCE verifier lives in memory only.
 */
import { createHash, randomBytes } from "node:crypto";
import { FactoryAuthError, type FactoryIdentity } from "./factory-auth.ts";
import type { GithubDevicePoll, GithubDeviceStart, LinearStart, SetupChoices, SetupGithub, SetupLinear, SetupSettings, SetupStatus, SetupStep } from "../shared/factory-setup.ts";
import { SECRET_GITHUB, SECRET_LINEAR, SECRET_LINEAR_REFRESH, SetupStore, type StoredGithub, type StoredLinear, type StoredSetup } from "./factory-setup-store.ts";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_API = "https://api.github.com";
export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Read tickets and comments, move tickets and label them: what the factory does as this person. */
export const LINEAR_SCOPE = "read,write";
export const LINEAR_CALLBACK_PATH = "/linear/callback";

const TIMEOUT_MS = 10_000;
const PENDING_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_PENDING = 8;

export class SetupError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface FactorySetupOptions {
  readonly stateDir: string;
  readonly secretsPath: string;
  /** The hub's browser origin: Linear sends the person back to `<hubOrigin>/linear/callback`. */
  readonly hubOrigin: string;
  /** The client IDs the hub names for this person (FactoryAuth.setupApps). */
  readonly apps: (identity: FactoryIdentity) => Promise<{ githubClientId: string | null; linearClientId: string | null }>;
  /** Whether Claude Code is signed in on this host; null when that cannot be told. */
  readonly claudeSignedIn: () => Promise<boolean | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
}

interface Device { readonly deviceCode: string; readonly clientId: string; readonly person: string; readonly expiresAt: number; interval: number; nextPollAt: number }
interface Verifier { readonly verifier: string; readonly clientId: string; readonly person: string; readonly expiresAt: number }

const text = (value: unknown, max = 500): string | null => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const EMAIL = /^[^\s@/<>]{1,64}@[^\s@/<>]{1,255}\.[^\s@/<>]{2,}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export class FactorySetup {
  private readonly store: SetupStore;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;
  private device: Device | null = null;
  private readonly verifiers = new Map<string, Verifier>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: FactorySetupOptions) {
    this.store = new SetupStore(options.stateDir, options.secretsPath);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
  }

  /** The hub's client IDs; an answer that cannot be used is a plain, retryable failure, never a missing app. */
  private async appsFor(who: FactoryIdentity): Promise<{ githubClientId: string | null; linearClientId: string | null }> {
    try { return await this.options.apps(who); } catch (error) {
      if (error instanceof FactoryAuthError && error.status === 503) throw new SetupError(503, "hub_unavailable", "The hub's Setup answer could not be used. Try again.");
      throw error;
    }
  }

  /** One change at a time: two tabs cannot interleave a token write with a disconnect. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new SetupError(502, "upstream_unreachable", "The service could not be reached from this factory. Try again.");
    }
  }

  private async form(url: string, values: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() });
    const body = record(await response.json().catch(() => null)) ?? {};
    return { status: response.status, body };
  }

  // ----- status -----

  /**
   * The whole read-compute-persist runs in the serial lane, beside every change: a status can neither
   * snapshot before a refresh or a settings write and then record over it, nor report a `ready` that the
   * persisted record disagrees with.
   */
  status(who: FactoryIdentity): Promise<SetupStatus> {
    return this.serial(() => this.compute(who));
  }

  private async compute(who: FactoryIdentity): Promise<SetupStatus> {
    const person = who.person;
    const apps = await this.options.apps(who).then((found) => found, () => null);
    // an expiring Linear token is renewed before anything is read, so the rest sees the renewed record
    if (apps?.linearClientId) await this.renewLinear(person, apps.linearClientId);
    const stored = this.store.read();
    const mine = stored && stored.owner.toLowerCase() === person.toLowerCase() ? stored : null;
    const secrets = this.store.secrets();
    const github = this.githubState(mine, secrets, apps !== null);
    const linear = this.linearState(mine, secrets, apps);
    const claudeKnown = await this.options.claudeSignedIn().then((signedIn) => signedIn, () => null);
    const claude: SetupStatus["claude"] = { state: claudeKnown === null ? "unavailable" : claudeKnown ? "signed_in" : "not_signed_in" };
    const needsLinear = linear.state !== "not_used";
    // Choices belong to the accounts they were made with: another GitHub or Linear account has none.
    const accounts = mine?.settingsAccounts;
    const settings = mine?.settings && accounts && accounts.github === mine.github?.id && accounts.linear === (needsLinear ? mine.linear?.id ?? null : null) ? mine.settings : null;
    const ready = github.state === "connected" && (!needsLinear || linear.state === "connected") && settings !== null && claude.state === "signed_in";
    const next: SetupStep | null = github.state !== "connected" ? "github"
      : needsLinear && linear.state !== "connected" ? "linear"
        : settings === null ? "settings"
          : claude.state !== "signed_in" ? "claude" : null;
    this.record(person, mine, ready, claude.state === "signed_in");
    return { version: 1, github, linear, settings, claude, ready, next };
  }

  private githubState(stored: StoredSetup | null, secrets: Record<string, string>, hubKnown: boolean): SetupGithub {
    const github = stored?.github;
    if (!github || !secrets[SECRET_GITHUB]) {
      return hubKnown ? { state: "not_connected" } : { state: "unavailable", reason: "The hub did not answer Setup. Try again." };
    }
    const noreplyEmail = `${github.id}+${github.login}@users.noreply.github.com`;
    if (github.expiresAt !== undefined && github.expiresAt <= this.now()) return { state: "expired", login: github.login, noreplyEmail, reason: "The GitHub connection has expired. Connect again." };
    return { state: "connected", login: github.login, noreplyEmail };
  }

  private linearState(stored: StoredSetup | null, secrets: Record<string, string>, apps: { linearClientId: string | null } | null): SetupLinear {
    if (apps === null) return { state: "unavailable", reason: "The hub did not answer Setup. Try again." };
    if (apps.linearClientId === null) return { state: "not_used" };
    const linear = stored?.linear;
    if (!linear || !secrets[SECRET_LINEAR]) return { state: "not_connected" };
    if (linear.expiresAt !== undefined && linear.expiresAt <= this.now()) return { state: "expired", name: linear.name, reason: "The Linear connection has expired. Connect again." };
    return { state: "connected", name: linear.name };
  }

  /** Renews a Linear token that is about to expire, if the person has one. Runs inside the serial lane. */
  private async renewLinear(person: string, clientId: string): Promise<void> {
    const stored = this.store.read();
    if (!stored || stored.owner.toLowerCase() !== person.toLowerCase() || !stored.linear?.expiresAt) return;
    if (stored.linear.expiresAt - REFRESH_MARGIN_MS <= this.now()) await this.refreshLinear(clientId, stored);
  }

  /** Whether Setup is complete is recorded for the factory itself, which starts no agent before it is. */
  private record(person: string, stored: StoredSetup | null, ready: boolean, claude: boolean): void {
    if (!stored && !ready) return;
    if (stored && stored.ready === ready && stored.claude === claude) return;
    try { this.store.write({ ...(stored ?? { version: 1 as const, owner: person }), version: 1, owner: stored?.owner ?? person, claude, ready, updatedAt: new Date(this.now()).toISOString() }); } catch { /* the page still tells the truth from the live state */ }
  }

  private save(person: string, change: (current: StoredSetup) => StoredSetup): void {
    const stored = this.store.read();
    const base: StoredSetup = stored && stored.owner.toLowerCase() === person.toLowerCase() ? stored : { version: 1, owner: person, ready: false, updatedAt: new Date(this.now()).toISOString() };
    // Whatever the change did, Setup is complete only after the next status read confirms every part.
    this.store.write({ ...change(base), ready: false, updatedAt: new Date(this.now()).toISOString() });
  }

  // ----- GitHub: the organization's app, device flow -----

  startGithub(who: FactoryIdentity): Promise<GithubDeviceStart> {
    const person = who.person;
    return this.serial(async () => {
      const { githubClientId } = await this.appsFor(who);
      if (!githubClientId) throw new SetupError(409, "github_not_registered", "The organization has not connected its GitHub App yet. Ask an administrator.");
      const { status, body } = await this.form(GITHUB_DEVICE_CODE_URL, { client_id: githubClientId });
      const deviceCode = text(body["device_code"], 200);
      const userCode = text(body["user_code"], 40);
      const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 0;
      const interval = typeof body["interval"] === "number" && body["interval"] >= 1 ? Math.min(body["interval"], 60) : 5;
      if (body["error"] === "device_flow_disabled") throw new SetupError(409, "device_flow_disabled", "Device Flow is not enabled for the organization's GitHub App. An administrator enables it in the app's settings.");
      if (status !== 200 || !deviceCode || !userCode || expiresIn <= 0 || body["verification_uri"] !== GITHUB_DEVICE_PAGE) throw new SetupError(502, "github_unavailable", "GitHub did not start the sign-in. Try again.");
      this.device = { deviceCode, clientId: githubClientId, person, expiresAt: this.now() + Math.min(expiresIn, 900) * 1000, interval, nextPollAt: this.now() + interval * 1000 };
      return { userCode, verificationUri: GITHUB_DEVICE_PAGE, expiresIn: Math.min(expiresIn, 900), interval };
    });
  }

  pollGithub(who: FactoryIdentity): Promise<GithubDevicePoll> {
    const person = who.person;
    return this.serial(async () => {
      const device = this.device;
      if (!device || device.person.toLowerCase() !== person.toLowerCase()) throw new SetupError(409, "no_github_sign_in", "Start the GitHub sign-in first.");
      if (device.expiresAt <= this.now()) { this.device = null; return { state: "failed", reason: "expired", message: "The GitHub code expired. Start again." }; }
      if (this.now() < device.nextPollAt) return { state: "pending", interval: device.interval };
      const { body } = await this.form(GITHUB_TOKEN_URL, { client_id: device.clientId, device_code: device.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      device.nextPollAt = this.now() + device.interval * 1000;
      const error = body["error"];
      if (error === "authorization_pending") return { state: "pending", interval: device.interval };
      if (error === "slow_down") { device.interval = typeof body["interval"] === "number" ? Math.min(body["interval"], 120) : device.interval + 5; device.nextPollAt = this.now() + device.interval * 1000; return { state: "pending", interval: device.interval }; }
      if (error === "expired_token") { this.device = null; return { state: "failed", reason: "expired", message: "The GitHub code expired. Start again." }; }
      if (error === "access_denied") { this.device = null; return { state: "failed", reason: "denied", message: "GitHub sign-in was cancelled. Start again when you are ready." }; }
      const token = text(body["access_token"], 400);
      if (!token) { this.device = null; return { state: "failed", reason: "unavailable", message: "GitHub did not complete the sign-in. Start again." }; }
      const lifetime = typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : null;
      const user = await this.githubJson(token, "/user");
      const login = text(user["login"], 100);
      const id = typeof user["id"] === "number" && Number.isSafeInteger(user["id"]) ? user["id"] : null;
      if (!login || id === null || !/^[A-Za-z0-9-]+$/.test(login)) { this.device = null; return { state: "failed", reason: "unavailable", message: "GitHub did not say whose account this is. Start again." }; }
      this.device = null;
      const connected: StoredGithub = { login, id, name: text(user["name"], 200), email: text(user["email"], 320), connectedAt: new Date(this.now()).toISOString(), ...(lifetime !== null ? { expiresAt: this.now() + lifetime * 1000 } : {}) };
      this.store.saveSecrets({ [SECRET_GITHUB]: token });
      this.save(person, (current) => ({ ...current, github: connected }));
      return { state: "connected", login };
    });
  }

  private async githubJson(token: string, path: string): Promise<Record<string, unknown>> {
    const response = await this.request(`${GITHUB_API}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "widal-factory-setup" } });
    if (response.status === 401) throw new SetupError(409, "github_expired", "The GitHub connection no longer works. Connect GitHub again.");
    if (!response.ok) throw new SetupError(502, "github_unavailable", "GitHub did not answer. Try again.");
    const body = record(await response.json().catch(() => null));
    if (!body) throw new SetupError(502, "github_unavailable", "GitHub did not answer. Try again.");
    return body;
  }

  disconnectGithub(who: FactoryIdentity): Promise<void> {
    const person = who.person;
    return this.serial(async () => {
      this.device = null;
      this.store.saveSecrets({}, [SECRET_GITHUB]);
      this.save(person, ({ github: _github, ...rest }) => rest);
    });
  }

  // ----- Linear: this person's own account, PKCE -----

  startLinear(who: FactoryIdentity): Promise<LinearStart> {
    const person = who.person;
    return this.serial(async () => {
      const { linearClientId } = await this.appsFor(who);
      if (!linearClientId) throw new SetupError(409, "linear_not_registered", "The organization has not registered its Linear app, or does not use Linear.");
      this.sweep();
      for (const [key, pending] of this.verifiers) if (pending.person.toLowerCase() === person.toLowerCase()) this.verifiers.delete(key);
      while (this.verifiers.size >= MAX_PENDING) this.verifiers.delete(this.verifiers.keys().next().value!);
      const verifier = this.random(48).toString("base64url");
      const state = this.random(24).toString("base64url");
      this.verifiers.set(state, { verifier, clientId: linearClientId, person, expiresAt: this.now() + PENDING_MS });
      const url = new URL(LINEAR_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: linearClientId, redirect_uri: this.callback(), response_type: "code", scope: LINEAR_SCOPE, state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      }).toString();
      return { url: url.href };
    });
  }

  private callback(): string { return `${this.options.hubOrigin}${LINEAR_CALLBACK_PATH}`; }

  private sweep(): void { for (const [key, pending] of this.verifiers) if (pending.expiresAt <= this.now()) this.verifiers.delete(key); }

  /** The hub's callback page hands the code and state here. The state is single use and belongs to the person who started. */
  finishLinear(who: FactoryIdentity, code: unknown, state: unknown): Promise<{ name: string }> {
    const person = who.person;
    return this.serial(async () => {
      if (typeof code !== "string" || !/^[A-Za-z0-9._~-]{1,512}$/.test(code) || typeof state !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(state)) throw new SetupError(400, "invalid_callback", "Linear returned no valid code. Connect Linear again.");
      const pending = this.verifiers.get(state);
      // Consumed before the exchange: a replayed or failed callback needs a new start.
      this.verifiers.delete(state);
      if (!pending || pending.expiresAt <= this.now() || pending.person.toLowerCase() !== person.toLowerCase()) throw new SetupError(403, "stale_callback", "This Linear link expired or was not started here. Connect Linear again.");
      const { status, body } = await this.form(LINEAR_TOKEN_URL, { grant_type: "authorization_code", code, redirect_uri: this.callback(), client_id: pending.clientId, code_verifier: pending.verifier });
      const token = text(body["access_token"], 600);
      if (status !== 200 || !token) throw new SetupError(502, "linear_refused", "Linear did not accept the sign-in. Connect Linear again.");
      const viewer = await this.linearViewer(token);
      const refresh = text(body["refresh_token"], 600);
      const lifetime = typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : null;
      const connected: StoredLinear = { id: viewer.id, name: viewer.name, connectedAt: new Date(this.now()).toISOString(), ...(lifetime !== null ? { expiresAt: this.now() + lifetime * 1000 } : {}) };
      this.store.saveSecrets({ [SECRET_LINEAR]: token, ...(refresh ? { [SECRET_LINEAR_REFRESH]: refresh } : {}) }, refresh ? [] : [SECRET_LINEAR_REFRESH]);
      this.save(person, (current) => ({ ...current, linear: connected }));
      return { name: viewer.name };
    });
  }

  private async linearGraph(token: string, query: string): Promise<Record<string, unknown>> {
    const response = await this.request(LINEAR_GRAPHQL_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ query }) });
    if (response.status === 401) throw new SetupError(409, "linear_expired", "The Linear connection no longer works. Connect Linear again.");
    const body = record(await response.json().catch(() => null));
    const data = record(body?.["data"]);
    if (!response.ok || !data) throw new SetupError(502, "linear_unavailable", "Linear did not answer. Try again.");
    return data;
  }

  private async linearViewer(token: string): Promise<{ id: string; name: string }> {
    const viewer = record((await this.linearGraph(token, "{ viewer { id name } }"))["viewer"]);
    const id = text(viewer?.["id"], 100);
    if (!id) throw new SetupError(502, "linear_unavailable", "Linear did not say whose account this is. Connect Linear again.");
    return { id, name: text(viewer?.["name"], 200) ?? "Linear account" };
  }

  /** True when the stored token is usable (renewed if it was about to expire). Runs inside `serial`. */
  private async refreshLinear(clientId: string, stored: StoredSetup): Promise<boolean> {
    const refresh = this.store.secrets()[SECRET_LINEAR_REFRESH];
    if (!refresh || !stored.linear) return false;
    try {
      const { status, body } = await this.form(LINEAR_TOKEN_URL, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId });
      const token = text(body["access_token"], 600);
      if (status !== 200 || !token) return false;
      const next = text(body["refresh_token"], 600);
      const lifetime = typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : null;
      this.store.saveSecrets({ [SECRET_LINEAR]: token, ...(next ? { [SECRET_LINEAR_REFRESH]: next } : {}) });
      this.save(stored.owner, (current) => ({ ...current, linear: { ...current.linear!, ...(lifetime !== null ? { expiresAt: this.now() + lifetime * 1000 } : { expiresAt: undefined }) } }));
      return true;
    } catch { return false; }
  }

  disconnectLinear(who: FactoryIdentity): Promise<void> {
    const person = who.person;
    return this.serial(async () => {
      for (const [key, pending] of this.verifiers) if (pending.person.toLowerCase() === person.toLowerCase()) this.verifiers.delete(key);
      this.store.saveSecrets({}, [SECRET_LINEAR, SECRET_LINEAR_REFRESH]);
      this.save(person, ({ linear: _linear, ...rest }) => rest);
    });
  }

  // ----- choices -----

  async choices(who: FactoryIdentity): Promise<SetupChoices> {
    const status = await this.status(who);
    const secrets = this.store.secrets();
    if (status.github.state !== "connected" || !secrets[SECRET_GITHUB]) throw new SetupError(409, "github_not_connected", "Connect GitHub first.");
    const repositories = await this.repositories(secrets[SECRET_GITHUB]!);
    let teams: SetupChoices["teams"] = [];
    if (status.linear.state === "connected" && secrets[SECRET_LINEAR]) teams = await this.teams(secrets[SECRET_LINEAR]!);
    const stored = this.store.read();
    const github = stored?.github;
    const gitName = github?.name ?? github?.login ?? "";
    const gitEmail = github?.email ?? status.github.noreplyEmail ?? "";
    return { repositories, teams, proposed: { gitName, gitEmail } };
  }

  private async repositories(token: string): Promise<SetupChoices["repositories"]> {
    const installs = await this.githubJson(token, "/user/installations?per_page=100");
    const found = new Map<string, boolean>();
    for (const install of Array.isArray(installs["installations"]) ? installs["installations"].slice(0, 20) : []) {
      const id = record(install)?.["id"];
      if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;
      for (let page = 1; page <= 5; page += 1) {
        const body = await this.githubJson(token, `/user/installations/${id}/repositories?per_page=100&page=${page}`);
        const list = Array.isArray(body["repositories"]) ? body["repositories"] : [];
        for (const item of list) {
          const repo = record(item);
          const fullName = text(repo?.["full_name"], 140);
          if (fullName && REPOSITORY.test(fullName)) found.set(fullName, repo?.["private"] === true);
        }
        if (list.length < 100) break;
      }
    }
    return [...found].map(([fullName, isPrivate]) => ({ fullName, private: isPrivate })).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  private async teams(token: string): Promise<SetupChoices["teams"]> {
    const data = await this.linearGraph(token, "{ teams(first: 100) { nodes { key name } } }");
    const nodes = record(data["teams"])?.["nodes"];
    const out: { key: string; name: string }[] = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const team = record(node);
      const key = text(team?.["key"], 20);
      const name = text(team?.["name"], 200);
      if (key && name && /^[A-Za-z0-9]+$/.test(key)) out.push({ key, name });
    }
    return out;
  }

  /** The person's choices. Each repository and the team are checked against what their own connections can reach, now. */
  saveSettings(who: FactoryIdentity, input: unknown): Promise<SetupSettings> {
    const person = who.person;
    return this.serial(async () => {
      const body = record(input);
      const gitName = text(body?.["gitName"], 100)?.trim() ?? "";
      const gitEmail = text(body?.["gitEmail"], 320)?.trim() ?? "";
      if (!gitName) throw new SetupError(400, "invalid_git_name", "Give the name your agents commit with.");
      if (!EMAIL.test(gitEmail)) throw new SetupError(400, "invalid_git_email", "Give the email your agents commit with.");
      const wanted = Array.isArray(body?.["repositories"]) ? body["repositories"] : null;
      if (!wanted || wanted.length === 0 || wanted.length > 100 || !wanted.every((value) => typeof value === "string")) throw new SetupError(400, "invalid_repositories", "Choose at least one repository.");
      const secrets = this.store.secrets();
      const stored = this.store.read();
      if (!stored?.github || !secrets[SECRET_GITHUB]) throw new SetupError(409, "github_not_connected", "Connect GitHub first.");
      if (stored.github.expiresAt !== undefined && stored.github.expiresAt <= this.now()) throw new SetupError(409, "github_expired", "The GitHub connection has expired. Connect GitHub again.");
      const allowed = new Set((await this.repositories(secrets[SECRET_GITHUB]!)).map((repo) => repo.fullName));
      const repositories = [...new Set(wanted as string[])];
      if (!repositories.every((name) => allowed.has(name))) throw new SetupError(400, "repository_not_available", "A chosen repository is not one the organization's GitHub App can reach for you.");
      const { linearClientId } = await this.appsFor(who);
      let linearTeam: string | null = null;
      if (linearClientId) {
        if (!stored.linear || !secrets[SECRET_LINEAR]) throw new SetupError(409, "linear_not_connected", "Connect Linear first.");
        const key = body?.["linearTeam"];
        const teams = await this.teams(secrets[SECRET_LINEAR]!);
        if (typeof key !== "string" || !teams.some((team) => team.key === key)) throw new SetupError(400, "invalid_team", "Choose one of your Linear teams.");
        linearTeam = key;
      }
      const settings: SetupSettings = { repositories, linearTeam, gitName, gitEmail };
      // remembered with the accounts they were made with: a different account is not covered by them
      const settingsAccounts = { github: stored.github.id, linear: linearClientId ? stored.linear!.id : null };
      this.save(person, (current) => ({ ...current, settings, settingsAccounts }));
      return settings;
    });
  }
}
