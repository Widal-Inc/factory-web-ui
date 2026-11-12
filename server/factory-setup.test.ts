import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitHerdrOnly } from "../scripts/test-herdr.ts";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import { factoryFixture } from "./factory-auth.fake.ts";
import { FactorySetup, GITHUB_API, GITHUB_DEVICE_CODE_URL, GITHUB_DEVICE_PAGE, GITHUB_TOKEN_URL, LINEAR_GRAPHQL_URL, LINEAR_TOKEN_URL } from "./factory-setup.ts";
import { handleSetupRequest } from "./factory-setup-routes.ts";
import { createServer } from "./index.ts";
import { UsageLoginService } from "./usage-login.ts";

// Setup talks to stand-ins for GitHub, Linear and Claude only, with made-up canaries. Nothing here reaches a
// real account, the hub, AWS or the user's herdr session.
const restoreHerdr = unitHerdrOnly();
afterAll(restoreHerdr);

const CANARY_GITHUB = "ghu_canary_github_token_0000";
const CANARY_LINEAR = "lin_oauth_canary_token_0000";
const CANARY_LINEAR_REFRESH = "lin_refresh_canary_token_0000";
const CANARY_DEVICE = "device_canary_code_0000";

/** A stand-in for the three upstream services, recording what each was sent. */
function upstream() {
  const calls: { url: string; body: string; authorization: string | null }[] = [];
  const state = { pollsBeforeGrant: 1, tokenLifetime: 28800 as number | null, linearLifetime: 86400, repositories: [{ full_name: "example-org/widgets", private: true }, { full_name: "example-org/docs", private: false }], teams: [{ key: "ENG", name: "Engineering" }], githubUser: { login: "ada-dev", id: 4242, name: "Ada Example", email: null as string | null }, linearUser: { id: "lin-user-1", name: "Ada Example" }, deviceError: null as string | null, tokenError: null as string | null, liveRefresh: CANARY_LINEAR_REFRESH, renewals: 0, listStatus: 200 };
  let polls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    calls.push({ url, body, authorization: headers.get("authorization") });
    if (url === GITHUB_DEVICE_CODE_URL) return state.deviceError ? Response.json({ error: state.deviceError }) : Response.json({ device_code: CANARY_DEVICE, user_code: "WDJB-MJHT", verification_uri: GITHUB_DEVICE_PAGE, expires_in: 900, interval: 5 });
    if (url === GITHUB_TOKEN_URL) {
      if (state.tokenError) return Response.json({ error: state.tokenError });
      polls += 1;
      if (polls <= state.pollsBeforeGrant) return Response.json({ error: "authorization_pending" });
      return Response.json({ access_token: CANARY_GITHUB, token_type: "bearer", ...(state.tokenLifetime ? { expires_in: state.tokenLifetime } : {}) });
    }
    if (url === `${GITHUB_API}/user`) return headers.get("authorization") === `Bearer ${CANARY_GITHUB}` ? Response.json(state.githubUser) : new Response("{}", { status: 401 });
    if (url.startsWith(`${GITHUB_API}/user/installations?`) && state.listStatus !== 200) return new Response("{}", { status: state.listStatus });
    if (url.startsWith(`${GITHUB_API}/user/installations?`)) return Response.json({ installations: [{ id: 77 }] });
    if (url.startsWith(`${GITHUB_API}/user/installations/77/repositories`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return Response.json({ repositories: state.repositories.slice((page - 1) * 100, page * 100) });
    }
    if (url === LINEAR_TOKEN_URL) {
      // Linear rotates the refresh token: each renewal hands out a new one, and the old one is spent
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token") return Response.json({ access_token: CANARY_LINEAR, refresh_token: CANARY_LINEAR_REFRESH, expires_in: state.linearLifetime });
      if (form.get("refresh_token") !== state.liveRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      state.liveRefresh = `${CANARY_LINEAR_REFRESH}-${++state.renewals}`;
      return Response.json({ access_token: `${CANARY_LINEAR}-${state.renewals}`, refresh_token: state.liveRefresh, expires_in: state.linearLifetime });
    }
    if (url === LINEAR_GRAPHQL_URL) return init?.body && String(init.body).includes("viewer") ? Response.json({ data: { viewer: state.linearUser } }) : Response.json({ data: { teams: { nodes: state.teams } } });
    throw new Error(`unexpected upstream request ${url}`);
  }) as typeof fetch;
  return { fetcher, calls, state, resetPolls: () => { polls = 0; } };
}

describe("owner Setup", () => {
  const f = factoryFixture();
  let dir: string;
  let secrets: string;
  let clock: number;
  let up: ReturnType<typeof upstream>;
  let claude: boolean | null;
  let setup: FactorySetup;
  const identity = () => ({ person: "ada@example.test", token: f.token(), expires: Number.MAX_SAFE_INTEGER });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-setup-"));
    secrets = join(dir, "config", "secrets.env");
    clock = 1_800_000_000_000;
    up = upstream();
    claude = false;
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" }, linear: { clientId: "fixture-linear-client" } });
    setup = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: (who) => f.auth.setupApps(who), claudeSignedIn: async () => claude, fetch: up.fetcher, now: () => clock });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function connectGithub() {
    await setup.startGithub(identity());
    clock += 6_000;
    expect(await setup.pollGithub(identity())).toEqual({ state: "pending", interval: 5 });
    clock += 6_000;
    return setup.pollGithub(identity());
  }
  async function connectLinear() {
    const { url } = await setup.startLinear(identity());
    return { url, done: (state = new URL(url).searchParams.get("state")) => setup.finishLinear(identity(), "code-from-linear", state) };
  }

  it("starts at GitHub and says what is missing", async () => {
    const status = await setup.status(identity());
    expect(status).toMatchObject({ version: 1, ready: false, next: "github", github: { state: "not_connected" }, linear: { state: "not_connected" }, settings: null, claude: { state: "not_signed_in" } });
  });

  it("connects GitHub through the organization's app with the hub's client id, and keeps the token on this host", async () => {
    const start = await setup.startGithub(identity());
    expect(start).toEqual({ userCode: "WDJB-MJHT", verificationUri: GITHUB_DEVICE_PAGE, expiresIn: 900, interval: 5 });
    expect(new URLSearchParams(up.calls[0]!.body).get("client_id")).toBe("Iv1.fixture-github");
    // polling faster than GitHub's interval never reaches GitHub
    const before = up.calls.length;
    expect(await setup.pollGithub(identity())).toEqual({ state: "pending", interval: 5 });
    expect(up.calls.length).toBe(before);
    clock += 6_000;
    expect(await setup.pollGithub(identity())).toEqual({ state: "pending", interval: 5 });
    clock += 6_000;
    const done = await setup.pollGithub(identity());
    expect(done).toEqual({ state: "connected", login: "ada-dev" });
    const body = JSON.stringify([start, done, await setup.status(identity())]);
    for (const secret of [CANARY_GITHUB, CANARY_DEVICE]) expect(body).not.toContain(secret);
    expect(readFileSync(secrets, "utf8")).toContain(`GH_TOKEN=${CANARY_GITHUB}`);
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    const record = readFileSync(join(dir, "factory-setup.json"), "utf8");
    expect(record).not.toContain(CANARY_GITHUB);
    expect(record).toContain("ada-dev");
    expect((await setup.status(identity())).github).toEqual({ state: "connected", login: "ada-dev", id: 4242, noreplyEmail: "4242+ada-dev@users.noreply.github.com", expiresAt: clock + 28_800_000 });
  });

  it("slows down when GitHub says so, reports a denial and an expired code, and refuses a poll nobody started", async () => {
    await expect(setup.pollGithub(identity())).rejects.toMatchObject({ code: "no_github_sign_in" });
    await setup.startGithub(identity());
    clock += 6_000;
    up.state.tokenError = "slow_down";
    expect(await setup.pollGithub(identity())).toEqual({ state: "pending", interval: 10 });
    clock += 11_000;
    up.state.tokenError = "access_denied";
    expect(await setup.pollGithub(identity())).toMatchObject({ state: "failed", reason: "denied" });
    await setup.startGithub(identity());
    clock += 901_000;
    expect(await setup.pollGithub(identity())).toMatchObject({ state: "failed", reason: "expired" });
  });

  it("explains an organization app without Device Flow, and one that is not registered", async () => {
    up.state.deviceError = "device_flow_disabled";
    await expect(setup.startGithub(identity())).rejects.toMatchObject({ code: "device_flow_disabled" });
    f.setSetup({ version: 1, factories: [], invitation: null, github: null, linear: null });
    await expect(setup.startGithub(identity())).rejects.toMatchObject({ code: "github_not_registered" });
    expect((await setup.status(identity())).linear).toEqual({ state: "not_used" });
  });

  it("ignores a client id the browser might send: only the hub's answer is used", async () => {
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "not valid!" }, linear: null });
    await expect(setup.startGithub(identity())).rejects.toMatchObject({ status: 503, code: "hub_unavailable" });
  });

  it("never turns a malformed or missing Linear registration into 'Linear is not used'", async () => {
    for (const linear of [{ clientId: 42 }, { clientId: "not valid!" }, "linear", {}, []]) {
      f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" }, linear });
      expect(await setup.status(identity()), JSON.stringify(linear)).toMatchObject({ ready: false, linear: { state: "unavailable" }, github: { state: "unavailable" } });
      await expect(setup.startLinear(identity())).rejects.toMatchObject({ code: "hub_unavailable" });
    }
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" } });
    expect((await setup.status(identity())).linear.state).toBe("unavailable");
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" }, linear: null });
    expect((await setup.status(identity())).linear).toEqual({ state: "not_used" });
  });

  it("connects Linear with PKCE, returning to the hub, and uses the state once", async () => {
    const { url, done } = await connectLinear();
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe("https://linear.app/oauth/authorize");
    expect(link.searchParams.get("client_id")).toBe("fixture-linear-client");
    expect(link.searchParams.get("redirect_uri")).toBe(`${f.options.hubOrigin}/linear/callback`);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("response_type")).toBe("code");
    expect(link.searchParams.get("actor")).toBe("user");
    expect(url).not.toContain(CANARY_LINEAR);
    expect(await done()).toEqual({ name: "Ada Example" });
    const exchange = new URLSearchParams(up.calls.find((call) => call.url === LINEAR_TOKEN_URL)!.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("redirect_uri")).toBe(`${f.options.hubOrigin}/linear/callback`);
    // the verifier the factory kept matches the challenge Linear was given
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(link.searchParams.get("code_challenge")!);
    expect(exchange.has("client_secret")).toBe(false);
    expect(readFileSync(secrets, "utf8")).toContain(`LINEAR_ACCESS_TOKEN=${CANARY_LINEAR}`);
    expect(readFileSync(join(dir, "factory-setup.json"), "utf8")).not.toContain(CANARY_LINEAR);
    expect(JSON.stringify(await setup.status(identity()))).not.toContain(CANARY_LINEAR);
    // a replayed callback finds nothing
    await expect(done(link.searchParams.get("state"))).rejects.toMatchObject({ status: 403, code: "stale_callback" });
  });

  it("refuses a Linear callback with an unknown, expired, malformed or other person's state, and a failed exchange", async () => {
    const { url, done } = await connectLinear();
    const state = new URL(url).searchParams.get("state")!;
    await expect(done("unknown-state")).rejects.toMatchObject({ code: "stale_callback" });
    await expect(setup.finishLinear(identity(), "code", "../etc")).rejects.toMatchObject({ status: 400 });
    await expect(setup.finishLinear(identity(), 42, state)).rejects.toMatchObject({ status: 400 });
    await expect(setup.finishLinear({ ...identity(), person: "grace@example.test" }, "code", state)).rejects.toMatchObject({ status: 403 });
    // the other person's attempt consumed it: the owner must start again, never reuse it
    await expect(done(state)).rejects.toMatchObject({ code: "stale_callback" });
    const second = await connectLinear();
    clock += 11 * 60_000;
    await expect(second.done()).rejects.toMatchObject({ code: "stale_callback" });
    expect(readdirSync(dir).includes("factory-setup.json")).toBe(false);
  });

  it("renews an expiring Linear token with the refresh token, and says so when it cannot", async () => {
    await (await connectLinear()).done();
    clock += 86_400_000 - 60_000;
    expect((await setup.status(identity())).linear.state).toBe("connected");
    expect(up.calls.filter((call) => call.url === LINEAR_TOKEN_URL).map((call) => new URLSearchParams(call.body).get("grant_type"))).toEqual(["authorization_code", "refresh_token"]);
    clock += 2 * 86_400_000;
    const original = up.fetcher;
    const refused = (async (input: string | URL | Request, init?: RequestInit) => String(input) === LINEAR_TOKEN_URL ? Response.json({ error: "invalid_grant" }, { status: 400 }) : original(input, init)) as typeof fetch;
    const stale = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: (who) => f.auth.setupApps(who), claudeSignedIn: async () => true, fetch: refused, now: () => clock });
    expect((await stale.status(identity())).linear).toMatchObject({ state: "expired" });
  });

  it("reports an expired GitHub token as expired, never as connected", async () => {
    await connectGithub();
    clock += 9 * 3600_000;
    expect((await setup.status(identity())).github).toMatchObject({ state: "expired", login: "ada-dev" });
    expect((await setup.status(identity())).next).toBe("github");
  });

  it("lists only what the person's connections reach, and validates every choice against it", async () => {
    await connectGithub();
    await (await connectLinear()).done();
    const choices = await setup.choices(identity());
    expect(choices.repositories).toEqual([{ fullName: "example-org/docs", private: false }, { fullName: "example-org/widgets", private: true }]);
    expect(choices.teams).toEqual([{ key: "ENG", name: "Engineering" }]);
    expect(choices.proposed).toEqual({ gitName: "Ada Example", gitEmail: "4242+ada-dev@users.noreply.github.com" });
    const good = { repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "ada@example.test", accounts: { github: 4242, linear: "lin-user-1" } };
    await expect(setup.saveSettings(identity(), { ...good, repositories: ["example-org/secret"] })).rejects.toMatchObject({ code: "repository_not_available" });
    await expect(setup.saveSettings(identity(), { ...good, repositories: [] })).rejects.toMatchObject({ code: "invalid_repositories" });
    await expect(setup.saveSettings(identity(), { ...good, linearTeam: "OPS" })).rejects.toMatchObject({ code: "invalid_team" });
    await expect(setup.saveSettings(identity(), { ...good, gitEmail: "not an email" })).rejects.toMatchObject({ code: "invalid_git_email" });
    await expect(setup.saveSettings(identity(), { ...good, gitName: "Ada\nExample" })).rejects.toMatchObject({ code: "invalid_git_name" });
    expect(await setup.saveSettings(identity(), good)).toEqual({ repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "ada@example.test" });
  });

  it("is ready only when GitHub, Linear, the choices and Claude all exist, and records that for the factory", async () => {
    await connectGithub();
    await (await connectLinear()).done();
    expect((await setup.status(identity())).next).toBe("settings");
    await setup.saveSettings(identity(), { repositories: ["example-org/docs"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "ada@example.test", accounts: { github: 4242, linear: "lin-user-1" } });
    expect(await setup.status(identity())).toMatchObject({ ready: false, next: "claude", claude: { state: "not_signed_in" } });
    expect(JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8")).ready).toBe(false);
    claude = true;
    expect(await setup.status(identity())).toMatchObject({ ready: true, next: null });
    expect(JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8"))).toMatchObject({ ready: true, owner: "ada@example.test" });
    claude = null;
    expect(await setup.status(identity())).toMatchObject({ ready: false, claude: { state: "unavailable" } });
  });

  it("needs no Linear when the organization does not use it", async () => {
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" }, linear: null });
    await connectGithub();
    claude = true;
    expect((await setup.status(identity())).next).toBe("settings");
    await setup.saveSettings(identity(), { repositories: ["example-org/docs"], gitName: "Ada Example", gitEmail: "ada@example.test", accounts: { github: 4242, linear: null } });
    expect(await setup.status(identity())).toMatchObject({ ready: true, linear: { state: "not_used" }, settings: { linearTeam: null } });
  });

  const good = { repositories: ["example-org/widgets"], linearTeam: "ENG", gitName: "Ada Example", gitEmail: "ada@example.test", accounts: { github: 4242, linear: "lin-user-1" } };
  async function completeAsAda() {
    await connectGithub();
    await (await connectLinear()).done();
    await setup.saveSettings(identity(), good);
    claude = true;
    expect((await setup.status(identity())).ready).toBe(true);
  }

  it("does not carry saved choices over to another GitHub account, and keeps them for the same one", async () => {
    await completeAsAda();
    // the same account connecting again keeps its choices
    up.resetPolls();
    await connectGithub();
    const { accounts: _accounts, ...saved } = good;
    expect(await setup.status(identity())).toMatchObject({ ready: true, settings: saved });
    // another account has none: the repositories and identity were chosen for the first
    up.resetPolls();
    up.state.githubUser = { login: "grace-dev", id: 9999, name: "Grace Example", email: null };
    up.state.repositories = [{ full_name: "other-org/tools", private: false }];
    await connectGithub();
    const after = await setup.status(identity());
    expect(after).toMatchObject({ ready: false, settings: null, next: "settings", github: { login: "grace-dev", id: 9999 } });
    expect(JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8")).ready).toBe(false);
    // a second tab still showing the first account cannot save its choices under the new one
    await expect(setup.saveSettings(identity(), good)).rejects.toMatchObject({ status: 409, code: "account_changed" });
    await expect(setup.saveSettings(identity(), { ...good, accounts: { github: 9999, linear: "lin-user-1" } })).rejects.toMatchObject({ code: "repository_not_available" });
    expect((await setup.choices(identity())).proposed.gitName).toBe("Grace Example");
  });

  it("does not carry saved choices over to another Linear account, nor across a disconnect of a different one", async () => {
    await completeAsAda();
    await setup.disconnectLinear(identity());
    expect(await setup.status(identity())).toMatchObject({ ready: false, settings: null, next: "linear" });
    // the same Linear account again: its choices are valid again
    await (await connectLinear()).done();
    expect(await setup.status(identity())).toMatchObject({ ready: true });
    up.state.linearUser = { id: "lin-user-2", name: "Grace Example" };
    await (await connectLinear()).done();
    expect(await setup.status(identity())).toMatchObject({ ready: false, settings: null, next: "settings", linear: { name: "Grace Example", id: "lin-user-2" } });
    await expect(setup.saveSettings(identity(), good)).rejects.toMatchObject({ code: "account_changed" });
    await expect(setup.saveSettings(identity(), { ...good, accounts: { github: 4242, linear: null } })).rejects.toMatchObject({ code: "account_changed" });
    await expect(setup.saveSettings(identity(), { ...good, accounts: undefined })).rejects.toMatchObject({ status: 400, code: "invalid_accounts" });
    expect(await setup.saveSettings(identity(), { ...good, accounts: { github: 4242, linear: "lin-user-2" } })).toMatchObject({ linearTeam: "ENG" });
  });

  it("reports saved repositories the GitHub App no longer reaches, and is not ready until the choices are saved again", async () => {
    await completeAsAda();
    up.state.repositories = [{ full_name: "example-org/docs", private: false }];
    // the list is read again at most every minute
    expect((await setup.status(identity())).ready).toBe(true);
    clock += 61_000;
    const status = await setup.status(identity());
    expect(status).toMatchObject({ ready: false, next: "settings", unreachableRepositories: ["example-org/widgets"], settings: { repositories: ["example-org/widgets"] } });
    expect(record().ready).toBe(false);
    // GitHub not answering keeps the last answer: it neither clears nor invents a lost repository
    const original = up.fetcher;
    const down = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: (who) => f.auth.setupApps(who), claudeSignedIn: async () => true, fetch: (async (input: string | URL | Request, init?: RequestInit) => String(input).startsWith(GITHUB_API) ? new Response("{}", { status: 502 }) : original(input, init)) as typeof fetch, now: () => clock });
    expect(await down.status(identity())).toMatchObject({ ready: true, unreachableRepositories: [] });
    expect((await setup.status(identity())).unreachableRepositories).toEqual(["example-org/widgets"]);
    await setup.saveSettings(identity(), { ...good, repositories: ["example-org/docs"] });
    expect(await setup.status(identity())).toMatchObject({ ready: true, unreachableRepositories: [] });
  });

  it("removes the previous owner's credentials and record when the factory changes owner", async () => {
    await completeAsAda();
    writeFileSync(secrets, `${readFileSync(secrets, "utf8")}OTHER_SETTING=kept\n`);
    // the factory is redeployed for another owner: the hub confirms her, and the state folder is the same
    const grace = { person: "grace@example.test", token: "fixture-identity", expires: Number.MAX_SAFE_INTEGER };
    const hers = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => ({ githubClientId: "Iv1.fixture-github", linearClientId: "fixture-linear-client" }), claudeSignedIn: async () => true, fetch: up.fetcher, now: () => clock });
    expect(await hers.status(grace)).toMatchObject({ ready: false, github: { state: "not_connected" }, linear: { state: "not_connected" }, settings: null });
    const file = readFileSync(secrets, "utf8");
    for (const name of ["GH_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN"]) expect(file).not.toContain(`${name}=`);
    expect(file).toContain("OTHER_SETTING=kept\n");
    expect(record()).toMatchObject({ owner: "grace@example.test", ready: false });
    expect(record().linear).toBeUndefined();
  });

  it("renews only the configured owner's Linear token on its own, and clears a previous owner's", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    writeFileSync(secrets, `${readFileSync(secrets, "utf8")}OTHER_SETTING=kept\n`);
    const timer = (owner: string) => new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => { throw new Error("the timer asks no hub"); }, claudeSignedIn: async () => true, owner, fetch: up.fetcher, now: () => clock });
    // the owner's own token is renewed, however the configured address is cased
    clock += 86_400_000 - 60_000;
    await timer(" ADA@example.test").maintain();
    expect(renewals().length).toBe(1);
    expect(record()).toMatchObject({ owner: "ada@example.test", ready: true });
    // the factory is redeployed for another owner on the same state folder, and she has not opened Setup yet
    clock += 86_400_000 - 60_000;
    await timer("grace@example.test").maintain();
    expect(renewals().length).toBe(1);
    const file = readFileSync(secrets, "utf8");
    for (const name of ["GH_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN"]) expect(file).not.toContain(`${name}=`);
    expect(file).toContain("OTHER_SETTING=kept\n");
    expect(record()).toMatchObject({ owner: "grace@example.test", ready: false });
    expect(record().linear).toBeUndefined();
  });

  it("reports and persists one answer when a status races a Linear renewal, and loses neither the renewal nor a settings write", async () => {
    up.state.tokenLifetime = null; // a GitHub token that does not expire, so only Linear's renewal is in play
    await completeAsAda();
    clock += 86_400_000 - 60_000;
    const [first, second] = await Promise.all([setup.status(identity()), setup.status(identity())]);
    expect([first.ready, second.ready]).toEqual([true, true]);
    const stored = JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8"));
    expect(stored.ready).toBe(true);
    expect(stored.linear.expiresAt).toBe(clock + 86_400_000);
    // a status and a settings write started together end consistent, whichever the lane runs first
    const next = { ...good, repositories: ["example-org/docs"] };
    const [, saved] = await Promise.all([setup.status(identity()), setup.saveSettings(identity(), next)]);
    expect(saved.repositories).toEqual(["example-org/docs"]);
    const final = await setup.status(identity());
    const persisted = JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8"));
    expect(persisted.settings.repositories).toEqual(["example-org/docs"]);
    expect(persisted.ready).toBe(final.ready);
    expect(final.ready).toBe(true);
    expect(persisted.linear.expiresAt).toBe(clock + 86_400_000);
  });

  it("disconnecting removes the credential from this host and makes Setup incomplete again", async () => {
    await connectGithub();
    await (await connectLinear()).done();
    await setup.disconnectGithub(identity());
    await setup.disconnectLinear(identity());
    expect(readFileSync(secrets, "utf8")).not.toContain("canary");
    expect(await setup.status(identity())).toMatchObject({ ready: false, github: { state: "not_connected" }, linear: { state: "not_connected" } });
  });

  it("never lets a hub failure look like a connected or empty Setup", async () => {
    f.setMe({ person: "ada@example.test", role: "engineer", factories: [] });
    await expect(setup.startGithub(identity())).rejects.toMatchObject({ status: 403 });
    f.setMe({ person: "ada@example.test", role: "engineer", factories: [{ factory: "ada-factory", owner: "ada@example.test", address: "https://ada.factory.example.test", state: "ready" }] });
    f.setSetup("not an object");
    expect((await setup.status(identity())).github).toMatchObject({ state: "unavailable" });
  });

  const record = () => JSON.parse(readFileSync(join(dir, "factory-setup.json"), "utf8"));
  const renewals = () => up.calls.filter((call) => call.url === LINEAR_TOKEN_URL && new URLSearchParams(call.body).get("grant_type") === "refresh_token");

  it("renews the Linear token on its own, with nobody opening Setup, and keeps the factory ready", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    expect(record().linear.clientId).toBe("fixture-linear-client");
    clock += 86_400_000 - 60_000;
    // the hub is not asked: the timer has no person's identity, and the token is renewed with the app it was issued to
    f.setSetup("not an object");
    await setup.maintain();
    expect(renewals().map((call) => new URLSearchParams(call.body).get("client_id"))).toEqual(["fixture-linear-client"]);
    expect(readFileSync(secrets, "utf8")).toContain(`LINEAR_ACCESS_TOKEN=${CANARY_LINEAR}-1\n`);
    expect(readFileSync(secrets, "utf8")).toContain(`LINEAR_REFRESH_TOKEN=${CANARY_LINEAR_REFRESH}-1\n`);
    expect(record()).toMatchObject({ ready: true, linear: { expiresAt: clock + 86_400_000 } });
    // the next one spends the rotated refresh token
    clock += 86_400_000 - 60_000;
    await setup.maintain();
    expect(new URLSearchParams(renewals().at(-1)!.body).get("refresh_token")).toBe(`${CANARY_LINEAR_REFRESH}-1`);
    expect(record().ready).toBe(true);
  });

  it("spends the refresh token once when the timer and status reads renew together", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    clock += 86_400_000 - 60_000;
    const [, first, , second] = await Promise.all([setup.maintain(), setup.status(identity()), setup.maintain(), setup.status(identity())]);
    expect(renewals().length).toBe(1);
    expect([first.ready, second.ready]).toEqual([true, true]);
    expect(first.linear.expiresAt).toBe(clock + 86_400_000);
    expect(record().ready).toBe(true);
  });

  it("takes ready back in the factory's record when the GitHub token expires, with nobody opening Setup", async () => {
    await completeAsAda();
    const status = await setup.status(identity());
    expect(status.github.expiresAt).toBe(record().github.expiresAt);
    clock = status.github.expiresAt! - 1;
    await setup.maintain();
    expect(record().ready).toBe(true);
    clock += 1;
    await setup.maintain();
    expect(record().ready).toBe(false);
    expect(await setup.status(identity())).toMatchObject({ ready: false, next: "github", github: { state: "expired" } });
  });

  it("takes ready back when Linear refuses the renewal and the token expires, and does not keep asking", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    up.state.liveRefresh = "spent-elsewhere";
    clock += 86_400_000 - 60_000;
    await setup.maintain();
    await setup.maintain();
    expect(renewals().length).toBe(1);
    expect(record().ready).toBe(true);
    clock += 60_000;
    await setup.maintain();
    expect(record().ready).toBe(false);
    // Linear said the refresh token is dead for good: it is not offered again, however long the factory runs
    for (let minute = 0; minute < 30; minute += 1) { clock += 60_000; await setup.maintain(); }
    expect(renewals().length).toBe(1);
    expect(await setup.status(identity())).toMatchObject({ ready: false, linear: { state: "expired" } });
    expect(renewals().length).toBe(1);
    // connecting Linear again brings a refresh token of its own, which is renewed as usual
    up.state.liveRefresh = CANARY_LINEAR_REFRESH;
    await (await connectLinear()).done();
    clock += 86_400_000 - 60_000;
    await setup.maintain();
    expect(renewals().length).toBe(2);
  });

  it("retries a renewal Linear did not answer before the token runs out, not after", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    let attempts = 0;
    const original = up.fetcher;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === LINEAR_TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") { attempts += 1; return new Response("{}", { status: 503 }); }
      return original(input, init);
    }) as typeof fetch;
    const timer = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => { throw new Error("the timer asks no hub"); }, claudeSignedIn: async () => true, owner: "ada@example.test", fetch: flaky, now: () => clock });
    // the margin is five minutes: the first attempt comes with 300 s left, and the next at half of what is left
    clock += 86_400_000 - 300_000;
    await timer.maintain();
    expect(attempts).toBe(1);
    clock += 149_000;
    await timer.maintain();
    expect(attempts).toBe(1);
    clock += 1_000;
    await timer.maintain();
    expect(attempts).toBe(2);
    // 150 s left: 75 s; then 75 s left: 37.5 s
    clock += 74_000;
    await timer.maintain();
    expect(attempts).toBe(2);
    clock += 1_000;
    await timer.maintain();
    expect(attempts).toBe(3);
    clock += 37_500;
    await timer.maintain();
    expect(attempts).toBe(4);
    expect(record().ready).toBe(true);
  });

  it("never sets ready on its own, and takes it back when a credential is gone from the secrets file", async () => {
    await connectGithub();
    claude = true;
    await setup.maintain();
    expect(record().ready).toBe(false);
    await (await connectLinear()).done();
    await setup.saveSettings(identity(), good);
    await setup.maintain();
    expect(record().ready).toBe(false);
    expect((await setup.status(identity())).ready).toBe(true);
    writeFileSync(secrets, readFileSync(secrets, "utf8").replace(/^LINEAR_ACCESS_TOKEN=.*\n/m, ""));
    await setup.maintain();
    expect(record().ready).toBe(false);
  });

  it("treats a GitHub token that GitHub rejects as no longer connected, and does not ask again for it", async () => {
    await completeAsAda();
    clock += 61_000;
    up.state.listStatus = 401;
    const status = await setup.status(identity());
    expect(status).toMatchObject({ ready: false, next: "github", github: { state: "expired", login: "ada-dev" } });
    expect(record().ready).toBe(false);
    const listings = () => up.calls.filter((call) => call.url.startsWith(`${GITHUB_API}/user/installations?`)).length;
    const before = listings();
    clock += 120_000;
    expect((await setup.status(identity())).github.state).toBe("expired");
    expect(listings()).toBe(before);
  });

  it("asks GitHub for the repositories once for a status and the choices page, and does not repeat a failed listing at once", async () => {
    await completeAsAda();
    const listings = () => up.calls.filter((call) => call.url.startsWith(`${GITHUB_API}/user/installations?`)).length;
    const before = listings();
    await setup.status(identity());
    await setup.choices(identity());
    expect(listings()).toBe(before);
    clock += 61_000;
    await setup.choices(identity());
    expect(listings()).toBe(before + 1);
    clock += 61_000;
    up.state.listStatus = 502;
    expect((await setup.status(identity())).ready).toBe(true);
    const failed = listings();
    for (let i = 0; i < 3; i += 1) { clock += 1_000; expect((await setup.status(identity())).unreachableRepositories).toEqual([]); }
    expect(listings()).toBe(failed);
    clock += 15_000;
    await setup.status(identity());
    expect(listings()).toBe(failed + 1);
  });

  it("lists every page of a large installation, and never reports a repository lost from a listing that stopped at a limit", async () => {
    up.state.repositories = Array.from({ length: 230 }, (_, i) => ({ full_name: `example-org/repo-${String(i).padStart(3, "0")}`, private: false }));
    await connectGithub();
    await (await connectLinear()).done();
    const everything = await setup.choices(identity());
    expect(everything.repositories.length).toBe(230);
    await setup.saveSettings(identity(), { ...good, repositories: ["example-org/repo-229"] });
    claude = true;
    expect(await setup.status(identity())).toMatchObject({ ready: true, unreachableRepositories: [] });
    // an organization with more installations than one listing can follow: what it did not get to is unknown, not lost
    const original = up.fetcher;
    const vast = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${GITHUB_API}/user/installations?`)) return Response.json({ installations: Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i })) });
      if (url.startsWith(`${GITHUB_API}/user/installations/`)) return Response.json({ repositories: Array.from({ length: 100 }, (_, i) => ({ full_name: `elsewhere/r-${url.length}-${i}`, private: false })) });
      return original(input, init);
    }) as typeof fetch;
    const big = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: (who) => f.auth.setupApps(who), claudeSignedIn: async () => true, fetch: vast, now: () => clock });
    expect(await big.status(identity())).toMatchObject({ ready: true, unreachableRepositories: [] });
  });

  it("takes a previous owner's other credential away on a disconnect or a start, not only on a connection", async () => {
    const grace = { person: "grace@example.test", token: "fixture-identity", expires: Number.MAX_SAFE_INTEGER };
    const hers = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => ({ githubClientId: "Iv1.fixture-github", linearClientId: "fixture-linear-client" }), claudeSignedIn: async () => true, fetch: up.fetcher, now: () => clock });
    const credentials = () => ["GH_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_REFRESH_TOKEN"].filter((name) => readFileSync(secrets, "utf8").includes(`${name}=`));
    const acts: [string, () => Promise<unknown>][] = [["disconnectGithub", () => hers.disconnectGithub(grace)], ["disconnectLinear", () => hers.disconnectLinear(grace)], ["startLinear", () => hers.startLinear(grace)], ["startGithub", () => hers.startGithub(grace)]];
    for (const [name, act] of acts) {
      up.resetPolls();
      await completeAsAda();
      expect(credentials().length, name).toBe(3);
      await act();
      expect(credentials(), name).toEqual([]);
      expect(record(), name).toMatchObject({ owner: "grace@example.test", ready: false });
      expect(record().linear, name).toBeUndefined();
    }
  });

  it("takes the previous owner's ready back before it removes their credentials, so a failed removal cannot leave them ready", async () => {
    await completeAsAda();
    expect(record().ready).toBe(true);
    // the secrets file cannot be rewritten: a folder stands where it was
    rmSync(secrets);
    mkdirSync(secrets);
    const grace = { person: "grace@example.test", token: "fixture-identity", expires: Number.MAX_SAFE_INTEGER };
    const hers = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => ({ githubClientId: "Iv1.fixture-github", linearClientId: "fixture-linear-client" }), claudeSignedIn: async () => true, fetch: up.fetcher, now: () => clock });
    await expect(hers.status(grace)).rejects.toThrow();
    expect(record()).toMatchObject({ owner: "ada@example.test", ready: false });
    // still her record, so the change of owner is tried again until it succeeds
    rmSync(secrets, { recursive: true });
    writeFileSync(secrets, `GH_TOKEN=${CANARY_GITHUB}\n`);
    expect(await hers.status(grace)).toMatchObject({ ready: false, github: { state: "not_connected" } });
    expect(record()).toMatchObject({ owner: "grace@example.test", ready: false });
    expect(readFileSync(secrets, "utf8")).not.toContain("GH_TOKEN=");
  });

  it("never writes a credential that is not safe in a file a shell may source", async () => {
    up.state.tokenLifetime = null;
    const original = up.fetcher;
    let token = "ghu_ok";
    const odd = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === GITHUB_TOKEN_URL) return Response.json({ access_token: token });
      if (String(input) === `${GITHUB_API}/user`) return Response.json(up.state.githubUser);
      return original(input, init);
    }) as typeof fetch;
    const unsafe = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: (who) => f.auth.setupApps(who), claudeSignedIn: async () => true, fetch: odd, now: () => clock });
    for (const bad of ["tok en", "tok;id", "$(id)", "`id`", "tok'en", "a#b", "a\\b", "aéb"]) {
      token = bad;
      await unsafe.startGithub(identity());
      clock += 6_000;
      expect(await unsafe.pollGithub(identity()), bad).toMatchObject({ state: "failed", reason: "unavailable" });
    }
    expect(() => readFileSync(secrets, "utf8")).toThrow();
    token = "ghu_AbC-1.2_3+4/5=";
    await unsafe.startGithub(identity());
    clock += 6_000;
    expect(await unsafe.pollGithub(identity())).toMatchObject({ state: "connected" });
    expect(readFileSync(secrets, "utf8")).toContain("GH_TOKEN=ghu_AbC-1.2_3+4/5=\n");
  });

  it("finishes the turn it is in when it stops, and starts none after", async () => {
    up.state.tokenLifetime = null;
    await completeAsAda();
    const original = up.fetcher;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let renewing = 0;
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === LINEAR_TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token") { renewing += 1; await gate; }
      return original(input, init);
    }) as typeof fetch;
    const timer = new FactorySetup({ stateDir: dir, secretsPath: secrets, hubOrigin: f.options.hubOrigin, apps: async () => { throw new Error("the timer asks no hub"); }, claudeSignedIn: async () => true, owner: "ada@example.test", fetch: slow, now: () => clock });
    clock += 86_400_000 - 60_000;
    const running = timer.maintain();
    const queued = timer.maintain();
    const deadline = Date.now() + 10_000;
    while (renewing === 0) { if (Date.now() > deadline) throw new Error("the renewal never started"); await new Promise((resolve) => setImmediate(resolve)); }
    expect(renewing).toBe(1);
    let stopped = false;
    const stopping = timer.stop().then(() => { stopped = true; });
    // the renewal is held at Linear: however many turns of the event loop pass, stop has not come back
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    await Promise.all([running, queued]);
    // the renewal in flight was kept (Linear had already rotated the token), and the queued turn did nothing
    expect(readFileSync(secrets, "utf8")).toContain("LINEAR_REFRESH_TOKEN=lin_refresh_canary_token_0000-1\n");
    const written = readFileSync(join(dir, "factory-setup.json"), "utf8");
    clock += 86_400_000;
    await timer.maintain();
    expect(renewing).toBe(1);
    expect(readFileSync(join(dir, "factory-setup.json"), "utf8")).toBe(written);
  });
});

describe("Setup routes behind the factory gate", () => {
  const f = factoryFixture();
  let dir: string;
  let app: ReturnType<typeof createServer>;
  let ctx: ServerContext;
  let up: ReturnType<typeof upstream>;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-setup-http-"));
    home = mkdtempSync(join(tmpdir(), "factory-setup-home-"));
    up = upstream();
    app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, sidecar: false, machines: false, factoryAuth: f.auth, token: "fixture-legacy-token", factorySecretsPath: join(dir, "secrets.env"), factorySetupFetch: up.fetcher, usageLogin: new UsageLoginService(home, { PATH: "" }) });
    ctx = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => true };
    f.setMe({ person: "ada@example.test", role: "engineer", factories: [{ factory: "ada-factory", owner: "ada@example.test", address: "https://ada.factory.example.test", state: "ready" }] });
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.fixture-github" }, linear: { clientId: "fixture-linear-client" } });
  });
  afterEach(() => { app.stop(); rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => f.request(`/api/factory/setup${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  it("needs the signed identity, the current owner and the hub's origin on writes", async () => {
    const unsigned = f.request("/api/factory/setup");
    unsigned.headers.delete("x-amzn-oidc-data");
    expect((await handleRequest(unsigned, ctx))?.status).toBe(401);
    expect((await handleRequest(post("/github/start", {}, { origin: "https://evil.example.test" }), ctx))?.status).toBe(403);
    f.setMe({ person: "ada@example.test", role: "engineer", factories: [] });
    expect((await handleRequest(f.request("/api/factory/setup"), ctx))?.status).toBe(403);
    expect((await handleRequest(post("/github/start"), ctx))?.status).toBe(403);
    expect(up.calls).toEqual([]);
  });

  it("serves the whole GitHub and Linear flow to the owner without a credential in any body", async () => {
    const seen: string[] = [];
    const json = async (response: Response | undefined) => { const text = await response!.text(); seen.push(text); return { status: response!.status, body: JSON.parse(text) as Record<string, any>, headers: response!.headers }; };
    const first = await json(await handleRequest(f.request("/api/factory/setup"), ctx));
    expect(first.body).toMatchObject({ next: "github", claude: { state: "not_signed_in" } });
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("access-control-allow-origin")).toBe(f.options.hubOrigin);
    expect((await json(await handleRequest(post("/github/start"), ctx))).body.userCode).toBe("WDJB-MJHT");
    expect((await json(await handleRequest(post("/linear/start"), ctx))).body.url).toContain("https://linear.app/oauth/authorize?");
    expect((await json(await handleRequest(post("/linear/callback", { code: "abc", state: "never-issued" }), ctx))).status).toBe(403);
    for (const text of seen) for (const secret of [CANARY_GITHUB, CANARY_LINEAR, CANARY_DEVICE]) expect(text).not.toContain(secret);
  });

  it("answers wrong content types, other methods and unknown routes plainly", async () => {
    const wrong = f.request("/api/factory/setup/github/start", { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
    expect((await handleRequest(wrong, ctx))?.status).toBe(415);
    expect((await handleRequest(f.request("/api/factory/setup/nothing"), ctx))?.status).toBe(404);
    expect((await handleRequest(f.request("/api/factory/setup", { method: "DELETE" }), ctx))?.status).toBe(405);
    expect((await handleRequest(post("/github/start", []), ctx))?.status).toBe(400);
  });

  it("primes the factory host's sign-in and returns only to a fixed hub page", async () => {
    // a top-level navigation carries no Origin header
    const visit = (query: string) => { const request = f.request(`/api/factory/setup/prime${query}`); request.headers.delete("origin"); return request; };
    const ok = await handleRequest(visit("?next=setup"), ctx);
    expect(ok?.status).toBe(302);
    expect(ok?.headers.get("location")).toBe(`${f.options.hubOrigin}/setup`);
    for (const next of ["https://evil.example.test", "//evil.example.test", "/setup", "..%2f", "", "constructor", "__proto__", "toString"]) {
      const refused = await handleRequest(visit(`?next=${encodeURIComponent(next)}`), ctx);
      expect(refused?.status, next).toBe(400);
      expect(refused?.headers.get("location")).toBeNull();
    }
  });

  it("is absent from a server without the factory gate", async () => {
    expect((await handleSetupRequest(new Request("http://127.0.0.1/api/factory/setup"), "/api/factory/setup", undefined, undefined, undefined)).status).toBe(404);
    expect(readdirSync(dir).includes("factory-setup.json")).toBe(false);
  });
});
