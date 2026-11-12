import { describe, expect, it } from "bun:test";
import { claudeSignInLink, FactoryUnreachable, ownerSetupApi, SetupApiError } from "./ownerSetupApi.ts";

const OWNER = "https://ada.factory.example.com";
const HUB = "https://hub.example.com";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CANARY_CODE = "claude-code-canary#state-canary";

function setup(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return answer(String(input), init); }) as typeof fetch;
  return { calls, api: ownerSetupApi(OWNER, HUB, fetcher) };
}
const status = { version: 1, github: { state: "connected", login: "ada-dev", noreplyEmail: "4242+ada-dev@users.noreply.github.com" }, linear: { state: "not_connected" }, settings: null, claude: { state: "not_signed_in" }, ready: false, next: "linear" };

describe("owner Setup client", () => {
  it("talks only to the registered owner origin, with its cookies, uncached and without redirects", async () => {
    const { api, calls } = setup(() => json(status));
    expect((await api.status()).next).toBe("linear");
    expect(calls[0]!.url).toBe(`${OWNER}/api/factory/setup`);
    expect(calls[0]!.init).toMatchObject({ credentials: "include", redirect: "error", cache: "no-store" });
  });

  it("refuses an origin that is not a registered HTTPS origin before any request", () => {
    for (const origin of ["http://ada.factory.example.com", "https://ada.factory.example.com/path", "https://user@ada.factory.example.com"]) {
      expect(() => ownerSetupApi(origin, HUB, (async () => json({})) as unknown as typeof fetch), origin).toThrow();
    }
  });

  it("sends a Claude code and a Linear code to the factory and never anywhere else", async () => {
    const { api, calls } = setup((url) => url.includes("/linear/callback") ? json({ name: "Ada" }) : json({}));
    await api.claudeCode("login-1", CANARY_CODE);
    await api.linearCallback("linear-code-canary", "state-1");
    expect(calls.every((call) => call.url.startsWith(`${OWNER}/`))).toBe(true);
    expect(calls.some((call) => call.url.startsWith(HUB))).toBe(false);
    expect(String(calls[0]!.init.body)).toContain(CANARY_CODE);
    // the secret travels in the body, never in an address
    expect(calls.map((call) => call.url).join(" ")).not.toContain("canary");
  });

  it("turns a network failure, a redirect to a sign-in page and a 401 into 'sign in to your factory'", async () => {
    await expect(setup(() => { throw new TypeError("Failed to fetch"); }).api.status()).rejects.toBeInstanceOf(FactoryUnreachable);
    await expect(setup(() => json({}, 401)).api.status()).rejects.toBeInstanceOf(FactoryUnreachable);
  });

  it("shows the factory's own message for a refused step, and a plain one for anything else", async () => {
    const refused = await setup(() => json({ error: { code: "github_expired", message: "The GitHub connection no longer works. Connect GitHub again." } }, 409)).api.choices().then(() => null, (e: unknown) => e as SetupApiError);
    expect(refused).toMatchObject({ status: 409, code: "github_expired", message: "The GitHub connection no longer works. Connect GitHub again." });
    expect((await setup(() => json("<html>stack trace</html>", 500)).api.choices().then(() => null, (e: unknown) => e as SetupApiError))?.message).toBe("Your factory could not complete this step. Try again.");
    expect((await setup(() => json({}, 403)).api.status().then(() => null, (e: unknown) => e as SetupApiError))?.message).toBe("This factory is not registered to you.");
  });

  it("treats a drifted answer as unsupported, never as a ready factory", async () => {
    await expect(setup(() => json({ version: 2 })).api.status()).rejects.toMatchObject({ code: "unsupported" });
    await expect(setup(() => json({ ...status, ready: "yes" })).api.status()).rejects.toMatchObject({ code: "unsupported" });
    await expect(setup(() => json({ repositories: "x" })).api.choices()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("only offers GitHub's device page and Linear's authorize page", async () => {
    const device = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresIn: 900, interval: 5 };
    expect((await setup(() => json(device)).api.githubStart()).userCode).toBe("WDJB-MJHT");
    await expect(setup(() => json({ ...device, verificationUri: "https://evil.example.com/login/device" })).api.githubStart()).rejects.toMatchObject({ code: "unsupported" });
    expect((await setup(() => json({ url: "https://linear.app/oauth/authorize?client_id=c&state=s" })).api.linearStart()).url).toContain("https://linear.app/oauth/authorize?");
    await expect(setup(() => json({ url: "https://linear.app.evil.example/oauth/authorize?x=1" })).api.linearStart()).rejects.toMatchObject({ code: "unsupported" });
    await expect(setup(() => json({ url: "https://linear.app/oauth/authorize/../evil" })).api.linearStart()).rejects.toMatchObject({ code: "unsupported" });
  });

  it("starts Claude's existing followed sign-in in the factory's default home, and reads its prompt", async () => {
    const { api, calls } = setup((url) => url.includes("/prompt") ? json({ provider: "claude", url: "https://claude.ai/oauth/authorize?x=1", user_code: null, wants_code: true, ended: false }) : json({ login_id: "L1", device_auth: false }));
    expect((await api.claudeStart(false)).login_id).toBe("L1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ provider: "claude", default: true, follow: true });
    expect((await api.claudePrompt("L 1")).wants_code).toBe(true);
    expect(calls[1]!.url).toBe(`${OWNER}/api/usage/login/prompt?login=L%201`);
    await api.claudeStart(true);
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ replace: true });
  });

  it("links only to Claude's or Anthropic's own HTTPS page", () => {
    expect(claudeSignInLink("https://claude.ai/oauth/authorize?code=true")).toBe("https://claude.ai/oauth/authorize?code=true");
    expect(claudeSignInLink("https://console.anthropic.com/oauth/authorize")).not.toBeNull();
    for (const bad of [null, "", "http://claude.ai/x", "https://claude.ai.evil.example/x", "https://evilclaude.ai/x", "javascript:alert(1)", "https://user:pw@claude.ai/x", "not a url"]) expect(claudeSignInLink(bad), String(bad)).toBeNull();
  });

  it("primes the factory host's sign-in with a fixed top-level address", () => {
    const { api } = setup(() => json({}));
    expect(api.primeUrl()).toBe(`${OWNER}/api/factory/setup/prime?next=setup`);
    expect(api.primeUrl("my-factory")).toBe(`${OWNER}/api/factory/setup/prime?next=my-factory`);
  });
});
