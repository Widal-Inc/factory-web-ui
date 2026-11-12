import { BRAND } from "../shared/brand.ts";
import { factoryAuthResponse, type FactoryIdentity } from "./factory-auth.ts";
import { withFactoryAuthority } from "./factory-context.ts";
import { protectFactoryResponse } from "./factory-http.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { handleAlertWebhookRequest } from "./alert-webhook.ts";
import { connectionData, type createCore, type SocketData } from "./core/index.ts";
import type { ClientConnectionLog } from "./client-connection-log.ts";
import type { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleIntegrationsRequest } from "./integrations-routes.ts";
import type { OrderSequence } from "./order-sequence.ts";
import type { HealthAuth, SecuritySummary, SessionSnapshot } from "../shared/protocol.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { authClient, bearerMatches, handleAuthRequest, isAuthenticated, presentedToken, presentedTokenHeld, recordPresentedTokenFailure, requiresAuth, unauthorizedJson } from "./auth.ts";
import { bindScope, cameThroughProxy, decideAccess, forwardingHeaders, isLoopbackAddress, observedIngress, ownerAccess } from "./access.ts";
import { handlePreferencesRequest, type PreferenceStore } from "./preferences.ts";
import { handleSeenRequest, type SeenStore } from "./seen.ts";
import { remoteAccess } from "./tailscale.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
import { requestOrigin, serveStatic } from "./static.ts";
import { compressResponse } from "./compress.ts";
import { handleTasksRequest } from "./tasks-routes.ts";
import { handlePlanRequest } from "./plan-routes.ts";
import { handleArtifactsRequest } from "./claude-artifacts.ts";
import { handleBtwRequest } from "./omp-btw.ts";
import { paneTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";
import { handleAgentsRequest } from "./agents-routes.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { handleAgentCatalogRequest } from "./agent-catalog-routes.ts";
import { type AgentInstaller, INSTALL_PATH, SIGN_IN_PATH } from "./agent-catalog-install.ts";
import { forgetPageMedia } from "./file-view.ts";
import { textEditAllowed } from "./file-edit.ts";
import { handleFileRequest } from "./file-routes.ts";
import { BACKGROUND_AGENT_PATH, handleBackgroundAgentRequest } from "./background-agent.ts";
import { paneGet, ping, herdrSocketPath } from "./herdr/client.ts";
import { RUNTIME_MOVE_PATH, RUNTIME_MOVE_ROUTE } from "./runtime-move.ts";
import { MOVE_LOCK_UNSAFE, moveLockPath } from "./runtime-move-lock.ts";
import type { StopRefusal } from "./runtime-move-service.ts";
import type { MoveService } from "./runtime-move-service.ts";
import { defaultStateDir, handlePushRequest } from "./push.ts";
import { savedAlertIdentity } from "./alert-identity.ts";
import { handlePromptRequest, type OpenCodePromptState } from "./prompt.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest, updateRequestAllowed } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import { handleTelemetryRequest, visitSurface } from "./telemetry.ts";
import type { TelemetryIngress } from "../shared/telemetry.ts";
import { handleStatuslineRequest, handleUsageRequest } from "./usage.ts";
import { handleSystemRequest, type SystemSampler } from "./system-stats.ts";
import { handleUserFontsRequest } from "./user-fonts.ts";
import { USER_FONTS_PATH } from "../shared/user-fonts.ts";
import type { UsageAccountList } from "./usage-account-list.ts";
import { handleVoiceRequest } from "./voice.ts";
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity } from "./bridge.ts";
import { handleMachineRequest, nonCanonicalPath, slowMachinePath } from "./machine-api.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, SESSION_HISTORY_PATH, SESSION_RESUME_PATH } from "./session-history-routes.ts";
import type { PiSessionReader } from "./pi-session-metadata.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import { readHerdrUi } from "./herdr-ui.ts";
import { MachineRelay, type RelayReceiptIds } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";
import { handlePluginRequest } from "./plugin-routes.ts";
import type { createServer } from "./index.ts";
import type { CLIProxyRoutes } from "./cliproxy-routes.ts";
import type { UsageLoginService } from "./usage-login.ts";
import { handleSetupRequest, isSetupPath } from "./factory-setup-routes.ts";
import type { FactorySetup } from "./factory-setup.ts";
import type { UsageService } from "./usage.ts";
import type { VoiceService } from "./voice.ts";

/** Per-server services shared by socket requests and other dispatch callers. */
export interface RequestServices {
  /** the move of herdr's session to herdr-core, where the runtime can be switched from here */
  readonly runtimeMove: MoveService | null;
  readonly relayReceiptIds: RelayReceiptIds;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly preferences: PreferenceStore;
  readonly herdrSidebar: HerdrSidebarConfig;
  readonly shellAgents: ShellAgentLocator;
  readonly agentDetector: AgentDetector;
  readonly agentOffered: (kind: string) => Promise<boolean>;
  readonly agentInstaller: AgentInstaller;
  readonly openCodeState: OpenCodePromptState;
  readonly cliProxyRoutes: CLIProxyRoutes;
  readonly usageLogin: UsageLoginService;
  /** the owner factory's Setup (server/factory-setup.ts); only with the signed factory identity gate */
  readonly factorySetup?: FactorySetup;
  readonly usage: UsageService;
  readonly usageAccounts: UsageAccountList;
  readonly systemSampler: SystemSampler | null;
  /** the state folder's fonts/, served to every client that may read this PC (server/user-fonts.ts) */
  readonly fontsDir: string;
  readonly voice: VoiceService;
  readonly browserSnapshot: <S extends SessionSnapshot>(snapshot: S) => S;
  readonly core: ReturnType<typeof createCore>;
  readonly seen: SeenStore;
  readonly piReader: PiSessionReader;
  readonly orderSequence: OrderSequence;
  readonly clientConnectionLog: ClientConnectionLog;
  readonly requestLog: RequestLog;
}

/** The transport operations a request needs. */
export interface ServerContext {
  requestIP(request: Request): { address: string } | null;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options: { headers?: HeadersInit; data: SocketData }): boolean;
  readonly port: number | undefined;
  readonly services: RequestServices;
}

/** The routes that read or write files and folders on this disk (or run git and gh in them) for a pane, a workspace or a picker. */
const OTHER_MACHINE_FILES = /^\/api\/(?:fs\/|pane\/(?:files|docs|image)$|workspace\/(?:diff\/|git\/|directories$|pr(?:$|\/)))/;

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response | undefined> {
  const auth = ctx.services.options.factoryAuth;
  if (!auth) return handleAuthorizedRequest(request, ctx);
  const preflight = auth.preflight(request, ctx.requestIP(request)?.address ?? null);
  if (preflight) return preflight;
  const health = auth.health(request, ctx.requestIP(request)?.address ?? null);
  if (health) return health;
  let identity: FactoryIdentity | undefined;
  let response: Response | undefined;
  const action = `http.${["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method) ? request.method : "OTHER"}`;
  try {
    identity = await auth.admit(request, ctx.requestIP(request)?.address ?? null);
    const admitted = identity;
    const check = () => auth.checkOwner(admitted);
    response = await withFactoryAuthority(check, () => handleAuthorizedRequest(request, ctx, identity), { factory: auth.origin, hub: auth.browserOrigin });
    // An upgraded socket owns its own checks and can no longer receive an HTTP response.
    if (response === undefined) { auth.audit(identity, action); return undefined; }
    await check();
    auth.audit(identity, action);
    return protectFactoryResponse(request, response, auth, check);
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    auth.audit(identity, action, "denied");
    return factoryAuthResponse(error);
  }
}

async function handleAuthorizedRequest(request: Request, ctx: ServerContext, factoryIdentity?: FactoryIdentity): Promise<Response | undefined> {
  const { options, hostname, token, bridgeToken, bootId, preferences, herdrSidebar, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, clientConnectionLog, requestLog } = ctx.services;
  const { sidecar, serialize, push, alertWebhook, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage } = core;
  return requestLog.handle(request, async (headers) => {
  // the route's answer, gzipped for a browser that takes it (server/compress.ts)
  return compressResponse(request, await (async (): Promise<Response | undefined> => {
  const url = new URL(request.url);
  let { pathname } = url;
  const bridgeAuthorized = !factoryIdentity && isAuthenticated(request, bridgeToken);
  // the connection server that reaches this one as its PC reads its update status and asks for the
  // update on offer: an Ovis run on this PC by itself is updated through its own updater, never
  // replaced (server/machines.ts ownOffer). An install still names the offered revision and the
  // custom header (update-api.ts), and whoever holds the token already drives every pane here. Only those two
  // requests, each by its own method and with no query: the token opens nothing else of these routes (#2054)
  const bridgeUpdatePath = url.search === "" && (pathname === "/api/updates" ? request.method === "GET" : (pathname === "/api/updates/install" || pathname === "/api/updates/cancel") && request.method === "POST");
  // the same server runs the move to herdr-core here for the person on its side (docs/runtime-move.md,
  // "On another PC"); each move route still asks for the app's own header and no query (updateRequestAllowed)
  const bridgeMovePath = RUNTIME_MOVE_ROUTE.test(pathname);
  const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === SESSION_HISTORY_PATH || pathname === SESSION_RESUME_PATH || pathname === "/api/agents" || pathname === "/api/agent-catalog" || pathname === INSTALL_PATH || pathname === SIGN_IN_PATH || pathname === "/api/agent/rename" || pathname === "/api/agent/commands" || pathname === "/api/integrations" || (pathname === "/api/system" && request.method === "GET") || pathname === "/api/usage/statusline" || pathname === "/api/plugins/actions" || pathname === "/api/plugin/action" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/worktree/") || pathname.startsWith("/api/tab/") || pathname === "/api/layout/ratio" || pathname.startsWith("/api/fs/") || pathname === "/ws" || bridgeUpdatePath || bridgeMovePath;
  const ip = ctx.requestIP(request);
  const loopback = ip !== null && isLoopbackAddress(ip.address);
  const forwarded = cameThroughProxy(request.headers);
  const funnel = request.headers.has("tailscale-funnel-request");
  const proxyHeaders = forwardingHeaders(request.headers);
  const requestHost = request.headers.get("host");
  // the guessing budget of the address that asks (auth.ts): a token presented while it waits is not compared
  const client = authClient(ip?.address ?? null, request.headers);
  const presented = factoryIdentity ? "none" : presentedToken(request, token, client);
  // counted at once, before any await below lets a concurrent guess pass the same check. Every
  // wrong token counts; the connection server's own bridge token does not
  if (presented === "wrong" && !bridgeAuthorized) recordPresentedTokenFailure(client);
  const tokenMatched = presented === "match";
  const requestShape = { loopback, forwarded, funnel };
  const access = factoryIdentity ? { level: "full" as const, via: "alb" as const } : decideAccess({
    ...requestShape,
    forwardingHeaders: proxyHeaders,
    tokenMatched,
    tokenConfigured: token !== "",
  });
  const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);

  if (requiresAuth(pathname) && !authenticated) {
    setRequestRoute("auth-refusal");
    // a script's Bearer guess is told to wait; a browser's cookie gets the usual 401 and its sign-in form
    if (presented === "held" && pathname !== "/ws" && request.headers.has("authorization")) return presentedTokenHeld(client);
    // The WS client never parses a body, so the upgrade refusal stays plain text.
    return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson();
  }

  // who started a followed sign-in: only that signed-in browser reaches it again
  const loginOwner = access.level === "full" ? access.via : null;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (!factoryIdentity && pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
    setRequestRoute("origin-refusal");
    return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
  }
  // An empty segment ("//", or a trailing "/") or an encoded separator reads as another route to
  // the checks below, while the PC proxy drops empty segments before forwarding:
  // `/api/machines/<id>//fs/file` would pass as not a file read, `<id>/sessions/history/` as no history.
  if (factoryIdentity && pathname === "/api/auth") return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  if (factoryIdentity && request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (pathname.startsWith("/api/") && nonCanonicalPath(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  // a text file is edited (read for it and saved) only by whoever got in, here or through this PC on another PC (file-edit.ts)
  const textEdit = /^\/api\/(?:machines\/[^/]+\/)?fs\/text$/.test(pathname);
  if (textEdit && !textEditAllowed(access, bridgeAuthorized, pathname.startsWith("/api/machines/"))) {
    setRequestRoute("drive-refusal");
    return jsonResponse({ error: { code: "forbidden", message: "Only the owner can edit this PC's files" } }, 403);
  }
  // API reads can chain several bounded 10 s Herdr RPCs. Give the handler time to return
  // its JSON result or timeout instead of Bun closing the socket at its default 10 s idle
  // cutoff. Static files keep their default; streaming and long-operation routes override
  // this finite budget below, after access and origin checks have passed. Only a signed-in
  // request gets it: the routes open without sign-in (health, auth) keep the default,
  // so an unauthenticated client cannot hold idle sockets for a minute.
  if (pathname.startsWith("/api/") && authenticated) ctx.timeout(request, 60);

  // the panes' files are on another machine: this disk's would be shown, listed, diffed or written as theirs
  if (options.localFiles === false && OTHER_MACHINE_FILES.test(pathname)) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "unsupported", message: `Files on another machine of herdr-core are not reachable from ${BRAND.name} yet` } }, 501);
  }

  if (pathname === "/api/bridge") {
    setRequestRoute(pathname);
    if (token === "" && !bridgeAuthorized) return unauthorizedJson();
    try { return jsonResponse(await bridgeIdentity(sidecar)); } catch (error) { return errorResponse(error); }
  }
  if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
    if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
    // /local aliases preserve every existing endpoint without a self-proxy.
    if (pathname.startsWith("/api/machines/local/")) {
      if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
      pathname = pathname.replace("/api/machines/local/", "/api/");
      if (!/^\/api\/(session|agents|agent-catalog$|agent-catalog\/(?:install|sign-in)$|integrations|pane\/|workspace\/|worktree\/|tab\/|layout\/ratio$|agent\/(?:rename|commands)$|plugins\/actions$|plugin\/action$|sessions\/(?:history|resume)$)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
      url.pathname = pathname;
    } else {
      // a worktree made with an agent waits on git and then agent.start, up to 150 s on the PC, and a
      // resume on agent.start and then its store check (machine-api.ts slowMachinePath)
      // a move's install there is waited for 200 s (machine-api.ts): this connection is held a little longer still
      const machinePathAsked = pathname.split("/").slice(4).join("/");
      ctx.timeout(request, pathname === "/api/machines/events" ? 0 : machinePathAsked === "runtime/move/install" ? 210 : slowMachinePath(machinePathAsked) ? 180 : 80);
      const response = await handleMachineRequest(request, machines, preferences, herdrSidebar, seen);
      response.headers.set("cache-control", "no-store");
      return response;
    }
  }
  if (pathname === "/ws") {
    setRequestRoute(pathname);
    if (!factoryIdentity && !sameOrigin(request)) return new Response("invalid origin", { status: 403 });
    const machineId = url.searchParams.get("machine_id");
    if (machineId && machineId !== "local") {
      if (access.level === "none") return unauthorizedJson();
      if (!machines?.endpoint(machineId)) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
      let relay: MachineRelay | undefined;
      try {
        relay = new MachineRelay(machines, machineId, browserSnapshot,
          (browser) => ctx.services.relayReceiptIds.scope(machineId, browser));
        await relay.ready;
        const upgraded = ctx.upgrade(request, { headers, data: connectionData({ relay, factoryIdentity }) });
        if (upgraded) return undefined;
        relay.close();
      } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
      return new Response("websocket upgrade required", { status: 426 });
    }
    // what the daily active message counts of this visit: the page's kind of screen and the way it came in;
    // nothing for another server's bridge, or for a surface no page names (visitSurface)
    const observed = observedIngress({ ...requestShape, peerKnown: ip !== null, forwardingHeaders: proxyHeaders });
    const surface = bridgeAuthorized ? false : visitSurface(url.searchParams.get("surface"));
    const ingress: TelemetryIngress = observed === "direct" ? (loopback ? "local" : "lan") : observed;
    // Reuse the terminal socket for the same authorized event document as /api/machines/events.
    // A server-side switch keeps the old SSE path available for immediate transport rollback.
    const useMachineEvents = machines && !bridgeAuthorized && process.env["OVIS_MACHINE_EVENTS_WS"] !== "0";
    const machineEvents = useMachineEvents ? { manager: machines, preferences, herdrSidebar, seen } : undefined;
    const upgraded = ctx.upgrade(request, { headers, data: connectionData({ factoryIdentity, machineEvents, bridge: bridgeAuthorized, ...(surface ? { surface } : {}), ...(surface === false ? {} : { ingress }) }) });
    if (upgraded) return undefined;
    return new Response("websocket upgrade required", { status: 426 });
  }

  if (pathname === "/api/auth") {
    setRequestRoute(pathname);
    // signing out also ends the page media this browser was given (by its address)
    if (request.method === "DELETE" && authenticated) forgetPageMedia({ client });
    return handleAuthRequest(request, token, client);
  }
  // installing an update on this PC (Ovis or herdr; a check installs too where OVIS_AUTO_UPDATE=1) is the owner's, as changing its PCs is (machine-api.ts).
  // The connection server's bridge token asks its own install by revision (bridgeUpdatePath)
  if (request.method === "POST" && (pathname === "/api/updates/install" || pathname === "/api/updates/cancel" || pathname === "/api/updates/check" || pathname === "/api/herdr/update") && !ownerAccess(access) && !(bridgeAuthorized && bridgeUpdatePath)) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "forbidden", message: "Only the owner can update this PC, from this app's own page." } }, 403);
  }
  if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
    // the bridge token cannot read /api/access: where this server answers comes with its update status (#2191)
    // the port is this server's own; a tailscale that cannot be read only leaves the https address out
    const where = bridgeAuthorized ? async () => {
      const port = ctx.port ?? DEFAULT_PORT;
      const serving = await remoteAccess(port).then((access) => access.tailscale.serving_url, () => null);
      return { port, serving_url: serving };
    } : undefined;
    return handleUpdateRequest(request, pathname, options.updates, where);
  }
  if (pathname === "/api/herdr/update") { setRequestRoute(pathname); return handleHerdrUpdateRequest(request, options.herdrUpdate); }
  if (pathname === "/api/connection-diagnostics") { setRequestRoute(pathname); return clientConnectionLog.handle(request, client ?? "unknown"); }
  if (pathname === "/api/telemetry") { setRequestRoute(pathname); return handleTelemetryRequest(request, options.telemetry); }
  // what every browser of this server shares
  if (pathname === "/api/preferences") { setRequestRoute(pathname); return handlePreferencesRequest(request, preferences); }
  // the finishes read in some browser of this server
  if (pathname === "/api/seen") { setRequestRoute(pathname); return handleSeenRequest(request, seen); }

  if (pathname === "/api/system") { setRequestRoute(pathname); return handleSystemRequest(request, ctx.services.systemSampler); }
  if (pathname === USER_FONTS_PATH || pathname.startsWith(`${USER_FONTS_PATH}/`)) return handleUserFontsRequest(request, pathname, ctx.services.fontsDir, url.search);
  if (pathname === "/api/usage") { setRequestRoute(pathname); return handleUsageRequest(request, url, ctx.services.usageAccounts); }
  if (pathname === "/api/usage/accounts") { setRequestRoute(pathname); return ctx.services.usageAccounts.handle(request); }
  // on or off only: the server decides what is installed and where (server/statusline-install.ts)
  if (pathname === "/api/usage/statusline") { setRequestRoute(pathname); return handleStatuslineRequest(request, usage); }
  // the owner factory's Setup: only behind the signed identity gate, which every request here has passed
  if (isSetupPath(pathname)) { setRequestRoute("/api/factory/setup"); ctx.timeout(request, 30); return handleSetupRequest(request, pathname, ctx.services.factorySetup, factoryIdentity, ctx.services.options.factoryAuth?.browserOrigin); }
  if (pathname === "/api/usage/login") { setRequestRoute(pathname); ctx.timeout(request, 30); return usageLogin.handle(request, collector.trackPane, loginOwner); }
  // the browser's sign-in dialog: a followed login's prompt, the code its page showed, and stopping it
  if (pathname === "/api/usage/login/prompt" || pathname === "/api/usage/login/code" || pathname === "/api/usage/login/cancel") { setRequestRoute(pathname); return usageLogin.handlePrompt(request, loginOwner); }
  if (pathname === "/api/cliproxy" || pathname.startsWith("/api/cliproxy/")) { ctx.timeout(request, 60); return cliProxyRoutes.handle(request); }
  // a long clip can keep the provider silent past Bun's 10 s idle limit before the first line
  if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { ctx.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }

  // Settings → Alerts → Also send to: one destination this PC also posts its alerts to
  if (pathname === "/api/alerts/webhook" || pathname === "/api/alerts/webhook/test") {
    try { return (await handleAlertWebhookRequest(request, pathname, alertWebhook))!; } catch (error) { return errorResponse(error); }
  }
  if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
    try {
      const answered = await handlePushRequest(request, pathname, push);
      if (answered) return answered;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/health") {
    setRequestRoute(pathname);
    const auth: HealthAuth = access.level === "full"
      ? { required: false, authenticated: true, via: access.via, ...(access.via === "token" && bearerMatches(request, token) ? { bearer: true as const } : {}) }
      : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
    // what protects this server, for a client that got in and nobody else;
    // per request, so never stored. The ingress is this request's, proven or `unknown`.
    const ingress = observedIngress({ ...requestShape, peerKnown: ip !== null, forwardingHeaders: proxyHeaders });
    const security: SecuritySummary | undefined = access.level === "full" ? {
      token_configured: token !== "",
      bind_scope: bindScope(hostname),
      observed_ingress: ingress,
      public_exposure: ingress === "funnel" ? "observed" : "unknown",
    } : undefined;
    const securityHeaders: Record<string, string> = security ? { "cache-control": "no-store" } : {};
    // what this PC has of the Herdr app's runtime, for Settings: never waited for, no path in it.
    // Only the owner is told: a session name can name a project, which a stranger has no need to read
    const owner = ownerAccess(access);
    // the connection server that reaches this PC with its bridge token shows its move badge from them
    const herdr_runtime = owner || bridgeAuthorized ? options.runtimeService?.facts() : undefined;
    // Compatibility only: connected PCs keep saved notification exclusions by this public ID.
    const alertIdentity = owner || bridgeAuthorized ? savedAlertIdentity(options.stateDir ?? defaultStateDir()) : undefined;
    const alertKey = alertIdentity ? { server_id: alertIdentity } : {};
    // the boot id lets the launcher know its own new bridge without waiting on herdr (server/supervisor.ts);
    // the runtime facts ride along, so Settings can switch back while herdr's TUI is stopped
    if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL, ...(security ? { security } : {}), web_ui: { boot_id: bootId, ...alertKey }, runtime: runtime(), ...(options.launchAccepted ? { accepted: options.launchAccepted() } : {}), ...(herdr_runtime ? { herdr_runtime } : {}) }, 200, securityHeaders);
    const herdr_core = owner ? options.herdrCoreFacts?.() : undefined;
    try {
      const info = await ping();
      // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
      const herdr = attachableIdentity(info, sidecar);
      return jsonResponse({ ok: true, herdr, auth, ...(security ? { security } : {}), ...(herdr_core ? { herdr_core } : {}), ...(herdr_runtime ? { herdr_runtime } : {}),
        web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null, ...alertKey } }, 200, securityHeaders);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/runtime") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a runtime switch must come from this app's own page" } }, 403);
    // the same boundary as the facts: only the owner
    if (!ownerAccess(access)) return jsonResponse({ error: { code: "forbidden", message: "only the owner can switch this PC's runtime" } }, 403);
    if (!options.runtimeService) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"runtime\": \"herdr\" | \"herdr-core\" }"); }
    // a move to herdr-core switches by itself once everything is built there; checked after the body's
    // await, right before the switch, so a move that started meanwhile is seen
    if (ctx.services.runtimeMove?.busy()) return jsonResponse({ error: { code: "runtime_switching", message: "a move to herdr-core is waiting or running" } }, 409);
    const answer = options.runtimeService.request(body !== null && typeof body === "object" ? (body as Record<string, unknown>)["runtime"] : undefined);
    return answer.ok ? jsonResponse({ accepted: true }, 202) : jsonResponse({ error: { code: answer.code, message: answer.message } }, answer.status);
  }

  // who may move this PC's runtime: the owner, or the connection server holding the bridge token,
  // which already drives every pane here.
  const moveDriver = bridgeAuthorized || ownerAccess(access);

  if (pathname === `${RUNTIME_MOVE_PATH}/install`) {
    setRequestRoute(pathname);
    // downloads and runs a program on this PC: the runtime switch's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only the owner can install herdr-core" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // its download alone may take 120 s (herdr-core/install.ts): the answer outlasts the usual minute, as
    // another PC's proxy waits for it (machine-api.ts slowMachinePath)
    ctx.timeout(request, 180);
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "an install must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    try {
      const refused = await move.install();
      if (refused === null) return jsonResponse({ installed: true });
      return jsonResponse({ error: { code: refused, message: refused === "installing" ? "herdr-core is already being installed" : `${BRAND.name} offers no herdr-core install here` } }, 409);
    } catch (error) {
      return jsonResponse({ error: { code: "install_failed", message: error instanceof Error ? error.message : String(error) } }, 502);
    }
  }

  if (pathname === `${RUNTIME_MOVE_PATH}/stop`) {
    setRequestRoute(pathname);
    // ends a command in a pane of this PC: the move's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only the owner can end a pane's command" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a stop must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"pane_id\": \"...\", \"force\"?: true }"); }
    const fields = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const paneId = fields["pane_id"];
    if (typeof paneId !== "string" || paneId === "") return badRequest("invalid_pane", "pane_id must name a pane of the plan");
    if (fields["force"] !== undefined && typeof fields["force"] !== "boolean") return badRequest("invalid_force", "force must be true or false");
    const command = fields["command"];
    if (command !== undefined && typeof command !== "string") return badRequest("invalid_command", "command must name the command shown");
    try {
      const refused = await move.stopPane(paneId, fields["force"] === true, command);
      if (refused === null) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: refused, message: stopRefusalText(refused) } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === `${RUNTIME_MOVE_PATH}/stop-all`) {
    setRequestRoute(pathname);
    // ends commands in panes of this PC: the move's own boundary, and only from this app's page
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only the owner can end a pane's command" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a stop must come from this app's own page" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send {} to ask, or { \"token\": \"...\" } to confirm"); }
    const token = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["token"] : undefined;
    if (token !== undefined && (typeof token !== "string" || token === "")) return badRequest("invalid_token", "token must be the one the ask returned");
    try {
      if (token === undefined) {
        const offer = await move.prepareStopAll();
        return offer === "not_waiting" ? jsonResponse({ error: { code: offer, message: stopRefusalText(offer) } }, 409) : jsonResponse(offer);
      }
      const refused = await move.stopAll(token);
      if (refused === null) return jsonResponse({ ok: true });
      return jsonResponse({ error: { code: refused, message: refused === "no_offer" ? "that confirm is used or unknown: ask again" : stopRefusalText(refused) } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === RUNTIME_MOVE_PATH) {
    setRequestRoute(pathname);
    // folders and conversation ids of every pane, and agents ended and started: the runtime switch's own boundary
    if (!moveDriver) return jsonResponse({ error: { code: "forbidden", message: "only the owner can move this PC's runtime" } }, 403);
    const move = ctx.services.runtimeMove;
    if (!move) return jsonResponse({ error: { code: "runtime_locked", message: "this server cannot switch its runtime" } }, 409);
    if (request.method === "GET") {
      try { return jsonResponse(await move.read(), 200, { "cache-control": "no-store" }); } catch (error) { return errorResponse(error); }
    }
    if (request.method !== "POST" && request.method !== "DELETE") return badRequest("method_not_allowed", "use GET, POST or DELETE");
    if (!updateRequestAllowed(request)) return jsonResponse({ error: { code: "forbidden", message: "a runtime move must come from this app's own page" } }, 403);
    if (request.method === "DELETE") { move.cancel(); return jsonResponse({ ok: true }); }
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send { \"revision\": \"...\" }"); }
    const revision = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["revision"] : undefined;
    if (typeof revision !== "string" || revision === "") return badRequest("invalid_revision", "revision must name the plan shown");
    try {
      const refused = await move.start(revision);
      if (refused === null) return jsonResponse({ accepted: true }, 202);
      // another Ovis server of this herdr session (the PC's own, or a connection server's bridge) moves it
      if (refused === "locked") return jsonResponse({ error: { code: "already_moving", message: `Another ${BRAND.name} on this PC is moving this herdr session already. If none is (one that stopped without telling), delete ${moveLockPath(herdrSocketPath())} on this PC and try again.` } }, 409);
      if (refused === "lock_unsafe") return jsonResponse({ error: { code: "move_lock_unsafe", message: MOVE_LOCK_UNSAFE } }, 409);
      return jsonResponse({ error: { code: refused, message: refused === "plan_changed" ? "the panes changed since the plan was shown: look again" : refused === "already_moving" ? "a move is already waiting or running" : refused === "runtime_switching" ? "the server is switching its runtime: try again once it is back" : "no move to herdr-core is offered here" } }, 409);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/herdr-ui") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse(readHerdrUi(options.herdrConfigPath), 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/access") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse(await remoteAccess(ctx.port ?? DEFAULT_PORT), 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/session") {
    setRequestRoute(pathname);
    try {
      // another Ovis server reading this PC (its bridge token) applies its own rows; a browser gets this server's
      const snapshot = await clientSnapshot();
      return jsonResponse({ snapshot: bridgeAuthorized ? snapshot : browserSnapshot(snapshot) });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const agentsResponse = await handleAgentsRequest(request, pathname, shellAgents, agentOffered);
  if (agentsResponse) return agentsResponse;

  const installResponse = await agentInstaller.handle(request, pathname);
  if (installResponse) return installResponse;
  const catalogResponse = await handleAgentCatalogRequest(request, pathname, agentDetector);
  if (catalogResponse) return catalogResponse;

  const integrationsResponse = await handleIntegrationsRequest(request, pathname);
  if (integrationsResponse) return integrationsResponse;

  const filesResponse = await handleFileRequest(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client });
  if (filesResponse) return filesResponse;

  const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, ctx, broadcastAll, queueFirstMessage, () => {
    // the receipt first, then the roster read that can show it: not waited for, and its failure changes no answer
    const receipt = orderSequence.moved();
    void machines?.refreshLocal();
    return receipt;
  }, shellAgents, options.localFiles !== false);
  if (workspaceResponse) return workspaceResponse;

  const pluginResponse = await handlePluginRequest(request, url, pathname, options);
  if (pluginResponse) return pluginResponse;

  const paneResponse = await handlePaneRequest(request, url, pathname, options);
  if (paneResponse) return paneResponse;

  const tasksResponse = await handleTasksRequest(request, url, pathname, { omo, claudeAgents, opencodeAgents });
  if (tasksResponse) return tasksResponse;

  // a subagent's prose and tool-call arguments (which can carry file contents) are what the live conversation already shows of the agents of this pane
  if (pathname === BACKGROUND_AGENT_PATH) {
    return handleBackgroundAgentRequest(request, url, { paneGet, omoPane: (paneId) => omo.sessionOf(paneId) !== null, claudeAgents, opencodeAgents, read: options.backgroundAgentRead });
  }

  const planResponse = await handlePlanRequest(request, url, pathname, { omo, claudeAgents, plans });
  if (planResponse) return planResponse;

  const artifactsResponse = await handleArtifactsRequest(request, url, pathname, { claudeAgents });
  if (artifactsResponse) return artifactsResponse;

  // the pane's transcript as its conversation finds it: a pane that runs no OMP session, or one not written yet, has none
  const btwResponse = await handleBtwRequest(request, url, pathname, {
    transcript: (paneId) => paneTranscript(paneId, options.codexHome, undefined, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData).then(
      (found) => found.source === "omp-transcript" ? found.path : null,
      (error: unknown) => { if (error instanceof ConversationUnavailable) return null; throw error; },
    ),
  });
  if (btwResponse) return btwResponse;

  if (pathname === SESSION_HISTORY_PATH) {
    setRequestRoute(SESSION_HISTORY_PATH);
    return handleSessionHistoryRequest(request, url, { stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome, piReader } });
  }

  if (pathname === SESSION_RESUME_PATH) {
    setRequestRoute(SESSION_RESUME_PATH);
    // agent.start can legitimately take a minute; Bun's default idle timeout is shorter
    return handleSessionResumeRequest(request, { stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome }, holdOpen: (seconds) => ctx.timeout(request, seconds) });
  }

  if (pathname.startsWith("/api/pane/prompt")) {
    try {
      const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, openCodeStateDir: options.openCodeStateDir, openCodeState, onAnswered: () => options.telemetry?.tally("prompt_answers") });
      if (response) return response;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname.startsWith("/api/")) {
    return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
  }

  // static client - public even when the API is gated, so the login UI can load
  setRequestRoute("static");
  return serveStatic(pathname, request.headers.get("accept-encoding"), requestOrigin(request));
  })());
  });
}

/** Why a stop of a busy pane did nothing, in the words the move's dialog shows. */
function stopRefusalText(refused: StopRefusal): string {
  switch (refused) {
    case "not_waiting": return "no move is waiting";
    case "not_running": return "that pane is not a shell running a command";
    case "changed": return "the panes changed since you looked: look again";
    case "own_server": return `that pane runs this ${BRAND.name} server`;
    case "own_group_unknown": return `${BRAND.name} cannot tell its own process group here, so it ends nothing`;
    case "not_tried": return "send Ctrl+C first, and force only once it has had a few seconds";
    case "not_local": return `this PC does not show that command in front of its shell, so ${BRAND.name} does not signal it`;
  }
}
