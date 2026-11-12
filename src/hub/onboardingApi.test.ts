import { describe, expect, it } from "bun:test";
import { createOnboardingApi, installUrl, manifestForm } from "./onboardingApi.ts";
import { HubError } from "./contract.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = { version: 1, github: { id: 7, clientId: "Iv1.example", slug: "example-factory", organization: "example-org" }, linearCallback: "https://hub.example.com/linear/callback", email: { productionAccess: false, sendingEnabled: false, review: "Email is in review." } };
const invite = { id: "i1", owner: "ada@example.com", factory: "ada-factory", link: "https://hub.example.com/join#code", createdAt: "2026-11-12T00:00:00Z", expiresAt: "2026-11-19T00:00:00Z", state: "creating", delivery: "waiting" };

function recorder(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, request: (async (input: RequestInfo | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return answer(String(input), init); }) as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
}

describe("hub onboarding client", () => {
  it("reads the onboarding status with same-origin cookies, no redirects and no bearer token", async () => {
    const r = recorder(() => json(status));
    expect((await createOnboardingApi(r.request).status()).github?.slug).toBe("example-factory");
    expect(r.calls[0]!.url).toBe("/api/app/admin/onboarding");
    expect(r.calls[0]!.init).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(JSON.stringify(r.calls[0]!.init.headers)).not.toContain("uthorization");
  });

  it("sends writes as JSON and parses a deployment invite and a role-only answer", async () => {
    const r = recorder((url) => url.endsWith("/invites") ? json({ person: "ada@example.com", role: "engineer", invite }, 202) : json({ invite }, 202));
    const api = createOnboardingApi(r.request);
    expect((await api.invite({ email: "ada@example.com", role: "engineer" })).invite?.factory).toBe("ada-factory");
    expect(r.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({ email: "ada@example.com", role: "engineer" });
    expect((await api.createMine()).state).toBe("creating");
    expect(r.calls[1]!.url).toBe("/api/app/my/factory");
    const role = createOnboardingApi(recorder(() => json({ person: "grace@example.com", role: "admin", signIn: { account: "grace@example.com" } })).request);
    expect(await role.invite({ email: "grace@example.com", role: "admin" })).toEqual({ person: "grace@example.com", role: "admin", invite: null });
  });

  it("shows the hub's own message for a refusal, a plain sentence for anything else, and never a body it did not write", async () => {
    const refusal = (code: number, body: unknown) => createOnboardingApi(recorder(() => json(body, code)).request).status().then(() => null, (error: unknown) => error as HubError);
    expect((await refusal(409, { error: "Create the organization's GitHub App before inviting people." }))?.message).toBe("Create the organization's GitHub App before inviting people.");
    expect((await refusal(401, { error: "x" }))?.message).toContain("sign-in has expired");
    expect((await refusal(500, { error: "SQLITE_BUSY at /srv/hub/db" }))?.message).toBe("The hub could not complete this. Try again.");
    expect((await refusal(503, { error: "Browser onboarding is not configured on this hub." }))?.message).toContain("not configured");
    expect((await refusal(403, "<html>"))?.message).toBe("You do not have access to this.");
    expect((await refusal(409, { error: "x".repeat(500) }))?.message).toBe("The hub could not complete this. Try again.");
  });

  it("treats a producer that drifted as unsupported rather than as an empty answer", async () => {
    const api = createOnboardingApi(recorder(() => json({ version: 2 })).request);
    await expect(api.status()).rejects.toMatchObject({ status: 502 });
    await expect(createOnboardingApi(recorder(() => json({ invites: "none" })).request).invites()).rejects.toMatchObject({ status: 502 });
  });

  it("reads 'not installed yet' as a state, and other failures as failures", async () => {
    expect(await createOnboardingApi(recorder(() => json({ error: "No installation." }, 404)).request).installation()).toBeNull();
    expect(await createOnboardingApi(recorder(() => json({ installed: true, installationId: 9 })).request).installation()).toEqual({ installed: true, installationId: 9 });
    await expect(createOnboardingApi(recorder(() => json({ error: "x" }, 502)).request).installation()).rejects.toBeInstanceOf(HubError);
  });

  it("only ever posts the GitHub manifest to GitHub's own organization page", () => {
    const action = "https://github.com/organizations/example-org/settings/apps/new?state=abc_DEF-123";
    expect(manifestForm({ action, manifest: { name: "x" } })).toEqual({ action, manifest: "{\"name\":\"x\"}" });
    for (const bad of ["https://evil.example.com/organizations/example-org/settings/apps/new?state=a", "http://github.com/organizations/o/settings/apps/new?state=a", "https://github.com.evil.example/organizations/o/settings/apps/new?state=a", "https://github.com/organizations/o/settings/apps/new?state=a&x=1", "https://user@github.com/organizations/o/settings/apps/new?state=a", "javascript:alert(1)"]) {
      expect(() => manifestForm({ action: bad, manifest: {} }), bad).toThrow();
    }
  });

  it("builds the install link only from a GitHub slug", () => {
    expect(installUrl("example-factory")).toBe("https://github.com/apps/example-factory/installations/new");
    expect(installUrl("../evil")).toBeNull();
    expect(installUrl("a/b")).toBeNull();
  });
});
