/**
 * `/api/factory/setup/*`: the owner factory's Setup routes (shared/factory-setup.ts). They exist only
 * behind the signed factory identity gate; a server without it answers 404, so a standalone server
 * never collects a person's GitHub or Linear connection.
 */
import { FactoryAuthError, type FactoryIdentity } from "./factory-auth.ts";
import { SetupError, type FactorySetup } from "./factory-setup.ts";
import { jsonResponse, readJsonObject } from "./http.ts";

export const SETUP_PREFIX = "/api/factory/setup";

/** Where a top-level visit to the factory host returns the person: fixed paths on the hub, never a caller's URL. */
const RETURNS: ReadonlyMap<string, string> = new Map([["setup", "/setup"], ["my-factory", "/my-factory"]]);

const NO_STORE = { "cache-control": "no-store" };
const refusal = (status: number, code: string, message: string): Response => jsonResponse({ error: { code, message } }, status, NO_STORE);

export function isSetupPath(pathname: string): boolean { return pathname === SETUP_PREFIX || pathname.startsWith(`${SETUP_PREFIX}/`); }

export async function handleSetupRequest(request: Request, pathname: string, setup: FactorySetup | undefined, identity: FactoryIdentity | undefined, hubOrigin: string | undefined): Promise<Response> {
  if (!setup || !identity) return refusal(404, "not_found", "not found");
  const route = pathname.slice(SETUP_PREFIX.length) || "/";
  const method = request.method;
  try {
    if (route === "/prime" && method === "GET") {
      // The factory host's own sign-in cookie is set by the load balancer on a top-level visit; this lands
      // here signed in and sends the person straight back to the hub page they came from.
      const target = RETURNS.get(new URL(request.url).searchParams.get("next") ?? "setup");
      if (!target || !hubOrigin) return refusal(400, "invalid_return", "Unknown return page");
      return new Response(null, { status: 302, headers: { location: `${hubOrigin}${target}`, ...NO_STORE } });
    }
    if (method === "GET") {
      if (route === "/") return jsonResponse(await setup.status(identity), 200, NO_STORE);
      if (route === "/choices") return jsonResponse(await setup.choices(identity), 200, NO_STORE);
      return refusal(404, "not_found", "not found");
    }
    if (method !== "POST" && method !== "PUT") return refusal(405, "method_not_allowed", "Use GET, POST or PUT");
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return refusal(415, "unsupported_media_type", "Send application/json");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (method === "POST") {
      switch (route) {
        case "/github/start": return jsonResponse(await setup.startGithub(identity), 200, NO_STORE);
        case "/github/poll": return jsonResponse(await setup.pollGithub(identity), 200, NO_STORE);
        case "/github/disconnect": await setup.disconnectGithub(identity); return jsonResponse({ ok: true }, 200, NO_STORE);
        case "/linear/start": return jsonResponse(await setup.startLinear(identity), 200, NO_STORE);
        case "/linear/callback": return jsonResponse(await setup.finishLinear(identity, body["code"], body["state"]), 200, NO_STORE);
        case "/linear/disconnect": await setup.disconnectLinear(identity); return jsonResponse({ ok: true }, 200, NO_STORE);
      }
    } else if (route === "/settings") {
      return jsonResponse(await setup.saveSettings(identity, body), 200, NO_STORE);
    }
    return refusal(404, "not_found", "not found");
  } catch (error) {
    // A refused or unverifiable identity is the gate's answer, not a Setup failure.
    if (error instanceof FactoryAuthError) throw error;
    // The message is written for the page; nothing upstream, no credential and no stack reaches it.
    if (error instanceof SetupError) return refusal(error.status, error.code, error.message);
    console.error("factory setup failed");
    return refusal(503, "setup_unavailable", "Setup could not complete this step. Try again.");
  }
}
