import { subscribeMachineEvents } from "./machine-events.ts";
import type { MachineRoster, PcInstallJob, PcInstallRequest, PcUpdateAll, PcUpdateStarted, SetupAction, SetupRequest } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import type { SeenFinish } from "../shared/seen.ts";
import { MachineActionRequired, MachineManager, PcUpdateRefused } from "./machines.ts";
import { canSendSecret, sameOrigin } from "./machine-security.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { crossSiteFileRead } from "./file-view.ts";
import { snapshotWithoutHiddenTokens, withoutHiddenTokens } from "./herdr-sidebar.ts";
import { parseJson, readCapped, REMOTE_LIMITS, RemoteResponseInvalid, RemoteResponseTooLarge } from "./remote-json.ts";
import { answerCode, moveAll, moveAllPlans, PC_MOVE_PATH, PC_UPDATE_REQUIRED, tooOldToMove } from "./remote-move.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);
/**
 * Updating this PC's PCs, as switching its own runtime (dispatch.ts): only from this app's own page (the
 * update header, same origin, no query).
 */
const OWNER_ONLY = "Only this app's own page can change this PC's PCs.";
const MOVE_FROM_PAGE = "A move must come from this app's own page";

/**
 * How far one browser's machine events may fall behind before its stream is ended (it reconnects and
 * reads the roster afresh). Counted in bytes, not frames: a burst of status changes from 20 or more
 * agents queues more small frames than a frame count allowed before the browser has read any.
 * A frame larger than this (the roster of thousands of panes) is let through on top of it while it
 * is still queued, never afterwards, so a stream opening with one does not end at its next frame.
 */
export const MACHINE_EVENTS_QUEUE_BYTES = 4 * 1024 * 1024;
/**
 * What every machine events stream together may hold, every queued byte counted, large frames and
 * Past it, the streams that stopped reading are ended, the one holding
 * the most first: a stream whose browser has taken nothing from its queue for MACHINE_EVENTS_STALL_MS.
 * One that reads on is never that, however much it has waiting, and one that has just been sent its
 * roster has not stopped reading either, so neither is ended nor ends another.
 */
export const MACHINE_EVENTS_TOTAL_BYTES = 32 * 1024 * 1024;
/** How long a browser may take nothing from a waiting queue before its stream counts as stopped reading. */
export const MACHINE_EVENTS_STALL_MS = 30_000;
/**
 * What every stream together may hold even while none has stopped reading yet (browsers opening at
 * once with large rosters): past it a frame is refused and its stream ended, and the browser opens it
 * again. A frame its stream is alone in holding always goes, so one roster larger than this does too.
 */
export const MACHINE_EVENTS_CEILING_BYTES = 64 * 1024 * 1024;
/** When a browser last took from its queue is read from this; tests move it on instead of waiting. */
export const machineEventsClock = {
  now: (): number => performance.now(),
  heartbeat: (send: () => void): ReturnType<typeof setInterval> => setInterval(send, 15_000),
};

/**
 * `told`: what the stream held when it was last written to; a queue only shrinks between writes, so it
 * is never less. `taken`: every byte its browser has taken so far; `movedAt`: when that was last seen
 * to grow, or the queue to be empty.
 */
interface EventsQueue { queued: () => number; taken: () => number; drop: () => void; told: number; seenTaken: number; movedAt: number }
/** Notes whether the browser has taken anything since it was last looked at: reading on, however slowly, is no stall. */
const observe = (queue: EventsQueue, now: number): void => {
  const taken = queue.taken();
  if (taken !== queue.seenTaken || queue.queued() === 0) { queue.seenTaken = taken; queue.movedAt = now; }
};
const eventsQueues = new Set<EventsQueue>();
/** The sum of every stream's `told`: never less than what all of them hold, so the total is counted exactly only near it. */
let toldTotal = 0;
const forgetQueue = (queue: EventsQueue): void => {
  if (!eventsQueues.delete(queue)) return;
  toldTotal -= queue.told;
  queue.told = 0;
};
/** Bytes waiting in every open machine events stream. */
export const machineEventsQueuedBytes = (): number => {
  let total = 0;
  for (const queue of eventsQueues) total += queue.queued();
  return total;
};

/**
 * A PC route whose answer can take longer than the proxy's usual 75 s: a worktree's creation waits on
 * git and then an agent's start, and a resume on the agent's start and then the check of its store.
 */
// runtime/move/install waits 200 s here: that PC holds the request up to 180 s (dispatch.ts), so an install that ends late is still told
export const slowMachinePath = (path: string): boolean => path === "worktree/create" || path === "sessions/resume" || path === "runtime/move/install";

/**
 * A path no route is spelled as: an empty segment (`//`, or a trailing `/`) or an encoded separator.
 * Path checks match the canonical spelling, and the PC proxy drops empty segments before it
 * forwards, so such a path must be no route at all rather than "some other route".
 */
export const nonCanonicalPath = (pathname: string): boolean => pathname.includes("//") || (pathname.length > 1 && pathname.endsWith("/")) || /%2f|%5c/i.test(pathname);
export const MACHINE_PROXY_PATH = /^(?:session|sessions\/(?:history|resume)|agents|agent-catalog(?:\/(?:install|sign-in))?|integrations|system|usage\/statusline|pane\/(?:read|scroll|find|selection|conversation(?:\/image|\/tool-output)?|commands|files|docs|omo-tasks|background-agent|plan|artifacts|btw|prompt|prompt\/answer|input|keys|close|rename|image|split|zoom|swap|move|resize|clear|focus)|workspace\/(?:create|rename|move|close|directories|diff\/files|diff\/file|diff\/refs|git\/log|git\/branches|git\/show|pr|pr\/log|pr\/merge)|worktree\/(?:create|list|inventory|open|remove)|tab\/(?:create|rename|close|move|move-to-workspace)|layout\/ratio|agent\/(?:rename|commands)|plugins\/actions|plugin\/action|fs\/(?:stat|file|favicon|text))$/;


/**
 * A PC that could not be reached. A timed-out or aborted call is not a broken connection:
 * the PC is there and the answer did not come in time (or the client gave up first), so it
 * says so, and the cause is logged either way — the cause is the only thing that tells a
 * slow PC from an offline one.
 */
function transportFailure(id: string, path: string, error: unknown): Response {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  console.error(`machine proxy ${id}${path}: ${timedOut ? "timed out" : "unreachable"}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  return timedOut
    ? fail("machine_timeout", "The PC did not answer in time; retry after reconnecting", 504)
    : fail("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502);
}

/**
 * An answer this app will not pass on: too large to hold, or unreadable where it must be redacted.
 * Its fixed message names none of it; the browser shows it in the UI language by the code (src/lib/api.ts).
 */
function unusableAnswer(id: string, path: string, error: RemoteResponseTooLarge | RemoteResponseInvalid): Response {
  const tooLarge = error instanceof RemoteResponseTooLarge;
  console.error(`machine proxy ${id}${path}: ${tooLarge ? "answer too large" : "answer unreadable"}`);
  return fail(tooLarge ? "remote_response_too_large" : "remote_response_invalid", error.message, 502);
}

export async function handleMachineRequest(request: Request, manager: MachineManager,
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void },
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void },
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void }): Promise<Response> {
  const url = new URL(request.url);
  // A PC's file opens as this PC's /api/fs/file does, from any navigation: reading it changes
  // nothing, and Chrome on Android shows a PDF in the viewer's frame as an "Open" button whose
  // navigation is cross-site. Every other PC route still answers only this app.
  const fileRead = ["GET", "HEAD"].includes(request.method) && /^\/api\/machines\/[^/]+\/fs\/file$/.test(url.pathname);
  if (!fileRead && !sameOrigin(request)) return fail("invalid_origin", "Use PC controls from this app", 403);
  // a navigation may open a PC's file from anywhere; another page loading it as a picture may not
  if (fileRead && crossSiteFileRead(request)) return fail("cross_site", "A file is read from this app or opened in a tab, not loaded by another page", 403);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_machine_request", "Use PC controls from this app", 403);
  // an empty segment is never a route: dropping it would forward `<id>//fs/file` as `fs/file`
  if (nonCanonicalPath(url.pathname)) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  // one rule for every change to this PC's PCs (adding, setting up, approving, updating, turning on or off, removing,
  // its settings): from this app's own page. A PC's own
  // routes (its panes, workspaces and files, MACHINE_PROXY_PATH) are driven as this PC's are, and keep their rules
  const managing = !["GET", "HEAD", "OPTIONS"].includes(request.method) && !(parts.length >= 2 && MACHINE_PROXY_PATH.test(parts.slice(1).join("/")));
  if (managing && !updateRequestAllowed(request)) return fail("forbidden", OWNER_ONLY, 403);
  try {
    if (!parts.length && request.method === "GET") {
      setRequestRoute("/api/machines");
      const asked = url.searchParams.getAll("verify_source_boot");
      // as the machine events tell it: without the token values herdr's rows hide (withoutHiddenTokens)
      const shown = () => withoutHiddenTokens(herdrSidebar?.get() ?? null, manager.list());
      if (asked.length === 0) return jsonResponse({ machines: shown() } satisfies MachineRoster);
      if (asked.length > 1 || asked[0] === "") return fail("invalid_query", "verify_source_boot names one PC", 400);
      const machineId = asked[0]!;
      const proof = await manager.verifySourceBoot(machineId, request.signal);
      if ("refused" in proof) {
        if (proof.refused === "unknown") return fail("machine_not_found", "PC not found", 404);
        const response = fail("source_unverified", proof.refused === "interval" ? "This PC's server was asked a moment ago; ask again shortly" : "This PC's server could not be verified now", 503);
        response.headers.set("cache-control", "no-store");
        if (proof.refused === "interval") response.headers.set("retry-after", "1");
        return response;
      }
      return jsonResponse({ machines: shown(), verified_source_boot: { machine_id: machineId, boot_id: proof.boot_id } } satisfies MachineRoster, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "events" && parts.length === 1 && request.method === "GET") {
      setRequestRoute("/api/machines/events");
      let stop: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let close = () => {};
      let drop = () => {};
      let queue: EventsQueue | undefined;
      // the browser went away: what still waits for it is dropped, not kept for a reader that is gone
      const aborted = () => drop();
      const cleanup = () => {
        stop?.(); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", aborted);
        if (queue) forgetQueue(queue);
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
          // fallen behind, refused or gone: an error, not a close, so what waits is dropped instead of still delivered
          drop = () => { if (closed) return; closed = true; cleanup(); try { controller.error(new Error("machine events: stream ended")); } catch {} };
          const queued = () => MACHINE_EVENTS_QUEUE_BYTES - (controller.desiredSize ?? MACHINE_EVENTS_QUEUE_BYTES);
          // frames larger than the bound, by where they end in the stream: each counts only until it has left the queue
          let written = 0;
          const large: { end: number; bytes: number }[] = [];
          const largeQueued = (): number => {
            const left = written - queued();
            while (large.length > 0 && large[0]!.end <= left) large.shift();
            return large.reduce((most, frame) => Math.max(most, frame.bytes), 0);
          };
          const own: EventsQueue = { queued, taken: () => written - queued(), drop, told: 0, seenTaken: 0, movedAt: machineEventsClock.now() };
          queue = own;
          eventsQueues.add(own);
          const retell = (): void => { const now = queued(); toldTotal += now - own.told; own.told = now; };
          const stalled = (other: EventsQueue, now: number): boolean => other.told > 0 && now - other.movedAt >= MACHINE_EVENTS_STALL_MS;
          const send = (text: string) => {
            if (closed) return;
            const bytes = encoder.encode(text);
            const now = machineEventsClock.now();
            retell();
            observe(own, now);
            // the backlog this frame adds beyond the one large frame a stream may hold: all of a small frame, of a
            // large one what the large one already waiting leaves uncovered (none when it is the first)
            const counted = bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES ? Math.min(bytes.byteLength, largeQueued()) : bytes.byteLength;
            if (own.told - largeQueued() + counted > MACHINE_EVENTS_QUEUE_BYTES) { drop(); return; }
            if (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
              // perhaps over the total: count every stream exactly, then end those that stopped reading, the one
              // holding the most first, this one too if it is that one
              toldTotal = 0;
              for (const other of eventsQueues) { other.told = other.queued(); toldTotal += other.told; observe(other, now); }
              while (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
                let most: EventsQueue | undefined;
                for (const other of eventsQueues) if (stalled(other, now) && (most === undefined || other.told > most.told)) most = other;
                if (most === undefined) break;
                most.drop();
                if (most === own) return;
              }
              // still past the ceiling with no stopped reader left to end: refused, unless this stream is alone in holding any
              if (toldTotal + bytes.byteLength > MACHINE_EVENTS_CEILING_BYTES && toldTotal - own.told > 0) { drop(); return; }
            }
            try { controller.enqueue(bytes); } catch { drop(); return; }
            written += bytes.byteLength;
            if (bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES) large.push({ end: written, bytes: bytes.byteLength });
            retell();
          };
          stop = subscribeMachineEvents({ manager, preferences, herdrSidebar, seen },
            (event) => send(`data: ${JSON.stringify(event)}\n\n`));
          if (closed) { cleanup(); return; }
          heartbeat = machineEventsClock.heartbeat(() => send(": heartbeat\n\n"));
          request.signal.addEventListener("abort", aborted, { once: true });
          if (request.signal.aborted) aborted();
        },
        cancel() { close(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MACHINE_EVENTS_QUEUE_BYTES }));
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    if (parts[0] === "ssh-candidates" && parts.length === 1) {
      setRequestRoute("/api/machines/ssh-candidates");
      if (request.method !== "GET") return fail("method_not_allowed", "Use GET", 405);
      return jsonResponse({ pcs: await manager.listSshCandidates() }, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "setup") {
      if (parts.length === 1 && request.method === "POST") {
        setRequestRoute("/api/machines/setup");
        const body = await request.json() as SetupRequest;
        // a setup that updates what runs there is an update of that PC: from this app's own page only, as above
        // the addresses its one-job-per-PC check compares, resolved first (ssh -G, off the event loop, 3 s at most)
        await manager.resolveFor(body);
        return jsonResponse(manager.setup(body), 202);
      }
      if (parts.length === 2) {
        setRequestRoute("/api/machines/setup/:job_id");
        const action = request.method === "POST" ? await request.json().catch(() => null) as SetupAction | null : null;
        const job = manager.job(parts[1]!);
        if (!job) return fail("job_not_found", "Setup job not found", 404);
        if (request.method === "POST") {
          if (!isJsonObject(action)) return fail("invalid_body", "Expected a setup action", 400);
          if (action.action === "answer" && job.challenge?.kind === "secret" && !canSendSecret(request)) return fail("https_required", "Passwords and key passphrases require HTTPS or localhost", 403);
          manager.action(parts[1]!, action);
        } else if (request.method === "DELETE") manager.action(parts[1]!, { action: "cancel" });
        else if (request.method !== "GET") return fail("method_not_allowed", "Use GET, POST or DELETE", 405);
        return jsonResponse(manager.job(parts[1]!));
      }
    }
    if (parts[0] === "settings" && parts.length === 1) {
      setRequestRoute("/api/machines/settings");
      if (request.method === "GET") return jsonResponse(manager.settings());
      if (request.method !== "PATCH") return fail("method_not_allowed", "Use GET or PATCH", 405);
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected PC settings", 400);
      return jsonResponse(manager.updateSettings(patch));
    }
    if (parts[0] === "install" && parts.length <= 2) {
      if (parts.length === 1) {
        setRequestRoute("/api/machines/install");
        if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
        const body: unknown = await request.json().catch(() => null);
        if (!isJsonObject(body)) return fail("invalid_body", "Expected an SSH address, or the machine_id of a PC added here", 400);
        await manager.resolveFor(body);
        try { return jsonResponse(manager.install(body as unknown as PcInstallRequest) satisfies PcInstallJob, 202); }
        catch (error) {
          if (error instanceof PcUpdateRefused) return fail("install_unavailable", error.message, 409);
          throw error;
        }
      }
      setRequestRoute("/api/machines/install/:job_id");
      if (request.method === "DELETE") manager.cancelInstall(parts[1]!);
      else if (request.method !== "GET") return fail("method_not_allowed", "Use GET or DELETE", 405);
      const job = manager.installJob(parts[1]!);
      return job ? jsonResponse(job) : fail("job_not_found", "Install job not found", 404);
    }
    if (parts[0] === "update-all" && parts.length === 1) {
      setRequestRoute("/api/machines/update-all");
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
      return jsonResponse(manager.updateAll() satisfies PcUpdateAll, 202);
    }
    if (parts[0] === "runtime" && parts[1] === "move-all" && parts.length === 2) {
      setRequestRoute("/api/machines/runtime/move-all");
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST", 405);
      if (!updateRequestAllowed(request)) return fail("forbidden", MOVE_FROM_PAGE, 403);
      const plans = moveAllPlans(await request.json().catch(() => null), manager.list().length);
      if (!plans) return fail("invalid_body", "Expected { plans: [{ machine_id, revision }] }, each PC once", 400);
      return jsonResponse(await moveAll(manager, plans), 202);
    }
    const id = parts[0]!;
    if (parts.length === 2 && parts[1] === "update") {
      setRequestRoute("/api/machines/:machine_id/update");
      if (request.method === "DELETE") return jsonResponse({ cancelled: manager.cancelUpdate(id) });
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST or DELETE", 405);
      const text = await request.text();
      let body: unknown = {};
      if (text.trim() !== "") { try { body = JSON.parse(text); } catch { body = null; } }
      const shown = isJsonObject(body) ? body.revision : undefined;
      if (!isJsonObject(body) || shown !== undefined && typeof shown !== "string") return fail("invalid_body", "Expected nothing, or { revision } of the offer shown", 400);
      try { return jsonResponse(manager.update(id, shown as string | undefined) satisfies PcUpdateStarted, 202); }
      catch (error) {
        // one that cannot run now, whatever stopped it, is told the same way (docs/remote-pcs.md)
        if (error instanceof PcUpdateRefused || error instanceof MachineActionRequired) return fail("update_unavailable", error.message, 409);
        throw error;
      }
    }
    if (parts.length === 2 && parts[1] === "update-bridge" && request.method === "POST") {
      setRequestRoute("/api/machines/:machine_id/update-bridge");
      // the release the card showed, when the client names it; otherwise the PC's last read offer (MachineManager.updateBridge)
      const text = await request.text();
      const body: unknown = text.trim() === "" ? {} : (() => { try { return JSON.parse(text); } catch { return null; } })();
      const shown = isJsonObject(body) ? body.revision : undefined;
      if (!isJsonObject(body) || shown !== undefined && typeof shown !== "string") return fail("invalid_body", "Expected nothing, or { revision } of the offer shown", 400);
      // its address and those of the running jobs, resolved first, as for a setup
      await manager.resolveFor({ machine_id: id });
      return jsonResponse(manager.updateBridge(id, false, shown as string | undefined), 202);
    }
    if (parts.length === 1 && request.method === "PATCH") {
      setRequestRoute("/api/machines/:machine_id");
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected a PC update", 400);
      manager.patch(id, patch); return jsonResponse({ ok: true });
    }
    if (parts.length === 1 && request.method === "DELETE") { setRequestRoute("/api/machines/:machine_id"); manager.remove(id); return jsonResponse({ ok: true }); }
    const path = parts.slice(1).join("/");
    const movePath = PC_MOVE_PATH.test(path);
    // that PC refuses a move route with a query (updateRequestAllowed), which would read as an Ovis too old below
    if (movePath && url.search !== "") return fail("invalid_query", "The move routes take no query", 400);
    if (movePath && request.method !== "GET" && !updateRequestAllowed(request)) return fail("forbidden", MOVE_FROM_PAGE, 403);
    if (MACHINE_PROXY_PATH.test(path) || movePath) {
      // `path` is a finite endpoint literal, never the machine id or an arbitrary suffix.
      setRequestRoute(`/api/machines/:machine_id/${path}`);
      const endpoint = manager.endpoint(id);
      if (!endpoint) {
        // a chat opened while the PC waits to reconnect asks it to try now, not after its delay
        manager.retryNow(id);
        return fail("machine_offline", "This PC is disconnected", 503);
      }
      // Explicit header allowlist: cookies, browser Authorization, forwarded headers
      // and remote Set-Cookie never cross this boundary. No arbitrary target URLs.
      const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      // a remote conversation answers 304 when unchanged, as a local one does
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);
      // what that PC asks of a move from its own page; this server's own guards already passed it here
      if (movePath) headers.set("x-herdr-update", "1");
      const abort = new AbortController();
      if (path === "fs/file") {
        // a file (a video, say) streams through, with its ranges, never held here; it can
        // play for longer than any request timeout
        const range = request.headers.get("range");
        if (range) headers.set("range", range);
        try {
          const response = await fetch(`${endpoint.url}/api/${path}${url.search}`, { method: request.method, headers, redirect: "error", signal: request.signal });
          const passed = new Headers({ "cache-control": "private, no-store" });
          for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "content-security-policy", "x-content-type-options"]) {
            const value = response.headers.get(name);
            if (value) passed.set(name, value);
          }
          return new Response(response.body, { status: response.status, headers: passed });
        } catch (error) { return transportFailure(id, path, error); }
      }
      const target = new URL(`${endpoint.url}/api/${path}${url.search}`);
      const untrack = manager.trackTerminal(id, () => abort.abort());
      // a move's PC reads its roster again once the move is confirmed, so its receipt is soon shown
      const moved = path === "workspace/move" && request.method === "POST" ? manager.refreshAfterMove(id) : null;
      try {
        const response = await fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "error", signal: AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(path === "runtime/move/install" ? 200_000 : slowMachinePath(path) ? 165_000 : 75_000)]) });
        if (moved && response.ok) moved();
        // a start, cancel or stop shows on the PC's badge soon, not at its next slow read
        if (movePath && request.method !== "GET" && response.ok) manager.moveOfferSoon(id);
        const etag = response.headers.get("etag");
        // that PC's clock as it answered a conversation read, a 304 too (src/lib/sentWaiting.ts)
        const serverTime = response.headers.get("x-server-time");
        // a PC's "try again in a moment" (a 503 file_busy: its file threads or a commands scan were busy)
        const retryAfter = response.status === 503 ? response.headers.get("retry-after") : null;
        // held whole before it is passed on, so only up to a size
        let body: Uint8Array<ArrayBuffer> | null = response.status === 304 ? null : await readCapped(response, REMOTE_LIMITS.proxy);
        if (movePath && tooOldToMove(manager.list().find((machine) => machine.id === id)?.kind, response.status, answerCode(body))) return fail("pc_update_required", PC_UPDATE_REQUIRED, 409);
        // a PC's session as the roster tells it, without the token values this server's rows hide (#2160)
        // any method the PC answers with a body (its route takes them all); a HEAD's is empty
        if (path === "session" && response.ok && body && body.byteLength > 0) {
          const answer = parseJson<{ snapshot?: SessionSnapshot }>(body);
          const shown = answer.snapshot && snapshotWithoutHiddenTokens(herdrSidebar?.get() ?? null, answer.snapshot);
          if (shown && shown !== answer.snapshot) body = new TextEncoder().encode(JSON.stringify({ ...answer, snapshot: shown }));
        }
        return new Response(body, { status: response.status, headers: {
          "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(etag ? { etag } : {}),
          ...(retryAfter ? { "retry-after": retryAfter } : {}), ...(serverTime ? { "x-server-time": serverTime } : {}),
        } });
      } catch (error) {
        if (error instanceof RemoteResponseTooLarge || error instanceof RemoteResponseInvalid) return unusableAnswer(id, path, error);
        return transportFailure(id, path, error);
      }
      finally { untrack(); }
    }
    return fail("not_found", "Unknown PC endpoint", 404);
  } catch (e) { return fail("machine_request_failed", e instanceof Error ? e.message : String(e), 400); }
}
