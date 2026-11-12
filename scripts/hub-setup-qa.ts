// Browser QA of the built hub app's Admin onboarding and owner Setup, with stand-ins only.
//
// The page is the real production entry (src/hub/main.tsx) served for the fake https origin
// https://factory.example.test. The owner factory behind https://ada.factory.example.test is the REAL
// server (createServer with the signed-identity gate, a synthetic ALB key and registry): the browser's
// requests are handed to its request handler with the signed identity the load balancer would add.
// The hub's APIs, GitHub, Linear and Claude are in-process stand-ins with made-up canary values.
// No real network, account, AWS or herdr session is touched. Run: bun scripts/hub-setup-qa.ts
import { chromium, type Browser, type BrowserContext, type Route } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { handleRequest, type ServerContext } from "../server/dispatch.ts";
import { factoryFixture } from "../server/factory-auth.fake.ts";
import { GITHUB_API, GITHUB_DEVICE_CODE_URL, GITHUB_DEVICE_PAGE, GITHUB_TOKEN_URL, LINEAR_GRAPHQL_URL, LINEAR_TOKEN_URL } from "../server/factory-setup.ts";
import { createServer } from "../server/index.ts";
import { UsageLoginService } from "../server/usage-login.ts";

const HUB = "https://factory.example.test";
const OWNER = "https://ada.factory.example.test";
const CANARY = { github: "ghu_qa_canary_github_0000", linear: "lin_qa_canary_linear_0000", claude: "qa-claude-code-canary#state", linearCode: "qa-linear-code-canary" };
const state = { setupDone: false };

const build = await Bun.build({
  entrypoints: [new URL("../src/hub/main.tsx", import.meta.url).pathname],
  target: "browser", minify: true, publicPath: "/", naming: "[name]-[hash].[ext]",
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));
const assets = new Map(build.outputs.map((out) => [`/${basename(out.path)}`, out]));
const script = build.outputs.find((out) => out.kind === "entry-point" && out.path.endsWith(".js"))!;
const css = build.outputs.filter((out) => out.path.endsWith(".css")).map((out) => `<link rel="stylesheet" href="/${basename(out.path)}">`).join("");
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hub</title>${css}</head><body><div id="root"></div><script type="module" src="/${basename(script.path)}"></script></body></html>`;

// ----- the owner factory: the real server, with stand-in upstreams -----
const f = factoryFixture();
const dir = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "hub-setup-qa-"));
const home = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "hub-setup-qa-home-"));
let polls = 0;
const upstreamCalls: string[] = [];
const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  upstreamCalls.push(url);
  const body = typeof init?.body === "string" ? init.body : "";
  if (url === GITHUB_DEVICE_CODE_URL) return Response.json({ device_code: "qa-device-code", user_code: "QA42-CODE", verification_uri: GITHUB_DEVICE_PAGE, expires_in: 900, interval: 1 });
  if (url === GITHUB_TOKEN_URL) { polls += 1; return polls < 2 ? Response.json({ error: "authorization_pending" }) : Response.json({ access_token: CANARY.github, token_type: "bearer", expires_in: 28800 }); }
  if (url === `${GITHUB_API}/user`) return Response.json({ login: "ada-dev", id: 4242, name: "Ada Example", email: null });
  if (url.startsWith(`${GITHUB_API}/user/installations?`)) return Response.json({ installations: [{ id: 77 }] });
  if (url.startsWith(`${GITHUB_API}/user/installations/77/repositories`)) return Response.json({ repositories: [{ full_name: "example-org/widgets", private: true }, { full_name: "example-org/docs", private: false }] });
  if (url === LINEAR_TOKEN_URL) { if (!new URLSearchParams(body).get("code_verifier")) throw new Error("PKCE verifier missing"); return Response.json({ access_token: CANARY.linear, refresh_token: "lin_qa_refresh", expires_in: 86400 }); }
  if (url === LINEAR_GRAPHQL_URL) return body.includes("viewer") ? Response.json({ data: { viewer: { id: "qa-linear-user", name: "Ada Example" } } }) : Response.json({ data: { teams: { nodes: [{ key: "ENG", name: "Engineering" }] } } });
  throw new Error(`unexpected upstream ${url}`);
}) as typeof fetch;

/** Claude's real followed sign-in needs the CLI; this stand-in speaks the same routes. */
class QaClaudeLogin extends UsageLoginService {
  code: string | null = null;
  override async signedInAccounts(): Promise<(string | null)[]> { return this.code ? ["qa"] : []; }
  override async handle(): Promise<Response> { return Response.json({ login_id: "qa-login", device_auth: false }); }
  override async handlePrompt(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/code")) { this.code = String(((await request.json()) as { code: string }).code); return Response.json({ ok: true }); }
    if (request.method === "POST") return Response.json({ ok: true });
    const done = this.code !== null;
    return Response.json({ provider: "claude", url: done ? null : "https://claude.ai/oauth/authorize?qa=1", user_code: null, wants_code: !done, ended: done, ...(done ? { succeeded: true, account: "qa" } : {}) });
  }
}
const claude = new QaClaudeLogin(home, { PATH: "" });
const secretsPath = join(dir, "secrets.env");
const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, sidecar: false, machines: false, factoryAuth: f.auth, token: "qa-legacy-token", factorySecretsPath: secretsPath, factorySetupFetch: upstream, usageLogin: claude });
const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "10.1.2.4" }), timeout: () => {}, upgrade: () => true };
const ownerRequests: { method: string; url: string }[] = [];
const hubRequests: { url: string; body: string }[] = [];

async function ownerRoute(route: Route) {
  const request = route.request();
  const headers: Record<string, string> = { host: new URL(OWNER).host, "x-forwarded-proto": "https", "x-amzn-oidc-data": f.token(), ...(request.headers()["origin"] ? { origin: request.headers()["origin"]! } : {}), ...(request.headers()["content-type"] ? { "content-type": request.headers()["content-type"]! } : {}) };
  const real = new Request(request.url(), { method: request.method(), headers, ...(request.postData() ? { body: request.postData()! } : {}) });
  ownerRequests.push({ method: request.method(), url: request.url() });
  const response = await handleRequest(real, ctx);
  if (!response) { await route.abort(); return; }
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => { out[key] = value; });
  await route.fulfill({ status: response.status, headers: out, body: Buffer.from(await response.arrayBuffer()) });
}

// ----- the hub: stand-in APIs the page reads and writes -----
const me = { person: "ada@example.test", role: "admin", factories: [{ factory: "ada-factory", owner: "ada@example.test", address: OWNER, state: "ready", registeredAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }] };
const unavailable = { state: "unavailable", reason: "Not part of this QA." };
const hub = {
  github: undefined as undefined | { id: number; clientId: string; slug: string; organization: string },
  linear: undefined as undefined | { clientId: string },
  usesLinear: undefined as undefined | boolean,
  invites: [] as Record<string, unknown>[],
  manifestPosted: null as null | { action: string; manifest: string },
  factoryReady: true,
};
function hubApi(path: string, method: string, body: Record<string, unknown>): { status: number; body: unknown } {
  const factories = hub.factoryReady ? me.factories : [];
  if (path === "/api/app/bootstrap") return { status: 200, body: { version: 1, me: { ...me, factories }, links: { myFactory: "/api/app/my/overview", today: "/api/app/team/today", quality: "/api/app/team/quality", admin: "/api/app/admin" }, beads: { state: "unavailable", reason: "Not part of this QA." } } };
  if (path === "/api/app/my/overview") return { status: 200, body: { version: 1, asOf: Date.now(), factories, live: hub.factoryReady ? [{ factory: "ada-factory", connection: { state: "direct", origin: OWNER } }] : [], work: unavailable, usageLimits: unavailable } };
  if (path === "/api/app/setup") return { status: 200, body: { version: 1, factories, invitation: hub.factoryReady ? null : { factory: "ada-factory", state: "creating", delivery: "waiting", progressAt: new Date().toISOString() }, github: { clientId: "Iv1.qa" }, linear: { clientId: "qa-linear-client" } } };
  if (path === "/api/app/admin") return { status: 200, body: { version: 1, people: [{ person: me.person, role: "admin", source: "registry" }], factories, capabilities: { people: { state: "ready", endpoint: "/people" }, factories: { state: "ready", endpoint: "/factories" }, onboarding: { state: "ready", endpoint: "/api/app/admin/onboarding" }, identityProvider: unavailable, branding: unavailable, budgets: unavailable, telemetry: unavailable } } };
  if (path === "/api/app/admin/onboarding") return { status: 200, body: { version: 1, ...(hub.github ? { github: hub.github } : {}), ...(hub.linear ? { linear: hub.linear } : {}), ...(hub.usesLinear !== undefined ? { usesLinear: hub.usesLinear } : {}), linearCallback: `${HUB}/linear/callback`, email: { productionAccess: false, sendingEnabled: false, review: "Email production access is in review." } } };
  if (path === "/api/app/admin/github/manifest") return { status: 200, body: { action: "https://github.com/organizations/example-org/settings/apps/new?state=qa-state", method: "POST", manifest: { name: `${String(body["organization"])} Factory`, redirect_url: `${HUB}/admin/github/callback` }, instructions: "Create the app." } };
  if (path === "/api/app/admin/github/installation") return hub.github ? { status: 200, body: { installed: true, installationId: 9 } } : { status: 404, body: { error: "No app." } };
  if (path === "/api/app/admin/linear" && method === "PUT") { if (body["usesLinear"] === false) { hub.usesLinear = false; hub.linear = undefined; return { status: 200, body: { usesLinear: false } }; } hub.linear = { clientId: String(body["clientId"]) }; hub.usesLinear = true; return { status: 200, body: { clientId: hub.linear.clientId, callback: `${HUB}/linear/callback` } }; }
  if (path === "/api/app/invites" && method === "GET") return { status: 200, body: { invites: hub.invites } };
  if (path === "/api/app/invites" && method === "POST") {
    const invite = { id: "inv-1", owner: String(body["email"]), factory: "grace-factory", link: `${HUB}/join#qa-one-time-link`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(), state: "creating", delivery: "waiting", progressAt: new Date().toISOString() };
    hub.invites = [invite];
    setTimeout(() => { hub.invites = [{ ...invite, state: "ready", delivery: "manual" }]; }, 1500);
    return { status: 202, body: { person: body["email"], role: "engineer", invite } };
  }
  return { status: 404, body: { error: "QA stand-in has no such route." } };
}
async function hubRoute(route: Route) {
  try { await hubRouteInner(route); } catch (error) { failures.push(`hub route ${route.request().url()}: ${error instanceof Error ? error.message : String(error)}`); }
}
async function hubRouteInner(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : {};
    hubRequests.push({ url: request.url(), body: request.postData() ?? "" });
    const answer = hubApi(url.pathname, request.method(), body);
    await route.fulfill({ status: answer.status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(answer.body) });
    answered.push(request.url());
    return;
  }
  const asset = assets.get(url.pathname);
  if (asset) { await route.fulfill({ status: 200, contentType: asset.type, body: Buffer.from(await asset.arrayBuffer()) }); return; }
  if (/\.(png|svg|ico|webp)$/.test(url.pathname)) { await route.fulfill({ status: 404, body: "" }); return; }
  await route.fulfill({ status: 200, contentType: "text/html", headers: { "cache-control": "no-store" }, body: html });
}
async function externalRoute(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname === "linear.app") {
    // Linear approves at once and sends the person back with a one-time code and the state it was given
    // (a script, not a 302: Chromium does not route the target of a redirect a route fulfilled)
    const back = `${HUB}/linear/callback?code=${CANARY.linearCode}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}`;
    await route.fulfill({ status: 200, contentType: "text/html", body: `<title>Linear (stand-in)</title><script>location.replace(${JSON.stringify(back)})</script>` });
    return;
  }
  if (url.hostname === "github.com" && request.method() === "POST") {
    hub.manifestPosted = { action: request.url(), manifest: new URLSearchParams(request.postData() ?? "").get("manifest") ?? "" };
    hub.github = { id: 7, clientId: "Iv1.qa", slug: "example-factory", organization: "example-org" };
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>GitHub (stand-in)</title><p>App created</p>" });
    return;
  }
  await route.fulfill({ status: 200, contentType: "text/html", body: "<title>External stand-in</title>" });
}

const failures: string[] = [];
const answered: string[] = [];
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
let browser: Browser | undefined;
try {
  const executablePath = process.env["CHROME_PATH"] ?? join(homedir(), ".cache/ms-playwright/chromium-1194/chrome-linux/chrome");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    // each viewport starts from a factory with nothing connected
    rmSync(secretsPath, { force: true }); rmSync(join(dir, "factory-setup.json"), { force: true });
    polls = 0; claude.code = null; hub.github = undefined; hub.linear = undefined; hub.usesLinear = undefined; hub.invites = []; hub.manifestPosted = null; hub.factoryReady = true;
    f.setMe(me);
    f.setSetup({ version: 1, factories: [], invitation: null, github: { clientId: "Iv1.qa" }, linear: { clientId: "qa-linear-client" } });
    ownerRequests.length = 0; hubRequests.length = 0;
    const context: BrowserContext = await browser.newContext({ viewport });
    try {
      await context.route(`${HUB}/**`, hubRoute);
      await context.route(`${OWNER}/**`, ownerRoute);
      await context.route(/https:\/\/(github\.com|linear\.app|claude\.ai)\/.*/, externalRoute);
      const page = await context.newPage();
      // the machine is shared and often loaded: give actions room instead of failing on a slow frame
      page.setDefaultTimeout(60_000);
      const errors: string[] = [];
      failures.length = 0;
      page.on("requestfailed", (request) => failures.push(`${request.url()} ${request.failure()?.errorText}`));
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      const noOverflow = async () => { check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `Horizontal overflow at ${viewport.width}`); };
      const tag = `${viewport.width}x${viewport.height}`;

      // --- Admin onboarding: GitHub App, Linear app, invite an engineer, copy the link ---
      hub.factoryReady = true;
      await page.goto(`${HUB}/admin`, { waitUntil: "commit" });
      await page.getByRole("heading", { name: "1. GitHub App" }).waitFor();
      check(await page.getByRole("button", { name: "Invite" }).isDisabled(), "Invite must wait for GitHub and Linear");
      await page.getByLabel("GitHub organization").fill("example-org");
      await page.getByRole("button", { name: "Create the GitHub App" }).click();
      await page.waitForURL(/github\.com/, { waitUntil: "commit" });
      check(hub.manifestPosted?.action === "https://github.com/organizations/example-org/settings/apps/new?state=qa-state", "manifest went somewhere other than GitHub's organization page");
      check(JSON.parse(hub.manifestPosted!.manifest).name === "example-org Factory", "manifest body missing");
      await page.goto(`${HUB}/admin`, { waitUntil: "commit" });
      await page.getByText("Connected: example-factory", { exact: false }).waitFor();
      await page.getByText("installed on the organization's repositories").waitFor();
      await page.getByLabel("Client ID").fill("qa-linear-client");
      await page.getByRole("button", { name: "Save client ID" }).click();
      await page.getByText("Registered. Client ID qa-linear-client.", { exact: false }).waitFor();
      await page.getByLabel("Email", { exact: true }).fill("grace@example.test");
      await page.getByRole("button", { name: "Invite" }).click();
      await page.getByText("Deploying grace-factory for grace@example.test.", { exact: false }).waitFor();
      await page.getByText("Deploying…").waitFor();
      await page.getByLabel("Ready link for grace@example.test").waitFor({ timeout: 15_000 });
      check((await page.getByLabel("Ready link for grace@example.test").inputValue()) === `${HUB}/join#qa-one-time-link`, "manual link not shown");
      await noOverflow();
      await page.screenshot({ path: join(dir, `admin-${tag}.png`), fullPage: true });

      // --- Setup: the person's own factory; sign in prime is not needed here (the stand-in ALB signs requests) ---
      await page.goto(`${HUB}/setup`, { waitUntil: "commit" });
      await page.getByRole("heading", { name: "1. Connect GitHub" }).waitFor();
      await page.getByRole("button", { name: "Connect GitHub" }).click();
      await page.getByLabel("GitHub code").waitFor();
      check((await page.getByLabel("GitHub code").textContent()) === "QA42-CODE", "device code not shown");
      await page.getByText("Connected as ada-dev.").waitFor({ timeout: 20_000 });
      await noOverflow();
      // Linear: leaves for Linear's own page and returns with the one-time code, which must leave the address bar
      await page.getByRole("button", { name: "Connect Linear" }).click();
      await page.waitForURL(/\/linear\/callback/, { timeout: 30_000, waitUntil: "commit" });
      await page.waitForURL(`${HUB}/setup`, { timeout: 30_000, waitUntil: "commit" });
      await page.getByText("Connected as Ada Example.").waitFor();
      check(!page.url().includes("code="), "Linear's one-time code stayed in the address");
      // choices
      await page.getByLabel("example-org/widgets (private)").check();
      await page.getByLabel("Linear team").selectOption("ENG");
      await page.getByRole("button", { name: "Save choices" }).click();
      await page.getByText("Saved: 1 repository, team ENG.").waitFor();
      // Claude
      await page.getByRole("button", { name: "Sign in to Claude" }).click();
      await page.getByLabel("Code from Claude").fill(CANARY.claude);
      await page.getByRole("button", { name: "Submit code" }).click();
      await page.getByRole("heading", { name: "Setup is complete" }).waitFor({ timeout: 20_000 });
      await noOverflow();
      await page.screenshot({ path: join(dir, `setup-${tag}.png`), fullPage: true });

      // --- secrets stay on the factory ---
      const secrets = readFileSync(secretsPath, "utf8");
      check(secrets.includes(`GH_TOKEN=${CANARY.github}`) && secrets.includes(`LINEAR_ACCESS_TOKEN=${CANARY.linear}`), "tokens are not in the factory's secrets file");
      const record = readFileSync(join(dir, "factory-setup.json"), "utf8");
      for (const secret of [CANARY.github, CANARY.linear, CANARY.claude, CANARY.linearCode]) check(!record.includes(secret), "a secret reached factory-setup.json");
      check(claude.code === CANARY.claude, "the Claude code did not reach the factory");
      const everywhereElse = JSON.stringify(hubRequests);
      for (const secret of [CANARY.github, CANARY.linear, CANARY.claude, CANARY.linearCode, "qa-device-code"]) check(!everywhereElse.includes(secret), `a secret reached the hub: ${secret}`);
      check(hubRequests.every((entry) => !entry.url.includes("canary")), "a secret is in a hub address");
      check(ownerRequests.every((entry) => entry.url.startsWith(`${OWNER}/`)), "an owner request went elsewhere");
      const pageText = await page.locator("body").innerText();
      for (const secret of [CANARY.github, CANARY.linear, CANARY.claude, CANARY.linearCode]) check(!pageText.includes(secret), "a secret is on the page");

      // --- revoked ownership is refused by the factory, and the page says so ---
      f.setMe({ ...me, factories: [] });
      await page.goto(`${HUB}/setup`, { waitUntil: "commit" });
      await page.getByText("This factory is not registered to you.", { exact: false }).waitFor();
      check(!(await page.getByRole("button", { name: "Connect GitHub" }).count()), "a revoked owner was offered the Setup steps");
      f.setMe(me);

      // --- a factory still being created: nothing is asked of the person ---
      hub.factoryReady = false;
      await page.goto(`${HUB}/setup`, { waitUntil: "commit" });
      await page.getByText("is being created", { exact: false }).waitFor();
      check(!(await page.getByRole("button", { name: "Connect GitHub" }).count()), "Setup asked for credentials before the factory exists");
      hub.factoryReady = true;

      // --- the factory host's sign-in is missing: the person is sent through the prime address only ---
      let primed = "";
      await context.route(`${OWNER}/**`, async (route) => { const request = route.request(); if (request.url().includes("/api/factory/setup/prime")) { primed = request.url(); await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Factory sign-in (stand-in)</title>" }); } else await route.abort(); });
      await page.goto(`${HUB}/setup`, { waitUntil: "commit" });
      await page.getByRole("button", { name: "Sign in to ada-factory" }).click();
      await page.waitForURL(/api\/factory\/setup\/prime/, { waitUntil: "commit" });
      check(primed === `${OWNER}/api/factory/setup/prime?next=setup`, "unexpected prime address");
      check(!errors.length, errors.join("\n"));
      check(upstreamCalls.every((url) => /^https:\/\/(github\.com|api\.github\.com|api\.linear\.app)\//.test(url)), "an upstream call went to an unexpected host");
      console.log(`Hub onboarding and Setup QA passed at ${tag} (screenshots in ${dir})`);
    } catch (error) {
      for (const open of context.pages()) console.error(`PAGE ${open.url()}\n${await open.locator("body").innerText().catch(() => "(no body)")}`);
      console.error(`owner requests: ${JSON.stringify(ownerRequests.slice(-8))}\nhub requests: ${JSON.stringify(hubRequests.slice(-6).map((entry) => entry.url))}\nanswered: ${JSON.stringify(answered.slice(-6))}\npage errors: ${JSON.stringify(failures)}`);
      throw error;
    } finally { await context.close(); }
  }
} finally {
  try { await browser?.close(); } finally { app.stop(); if (!process.env["KEEP_QA"]) { rmSync(dir, { recursive: true, force: true }); } rmSync(home, { recursive: true, force: true }); }
}
// the server's own timers would otherwise keep the process alive after a pass
process.exit(0);
