/**
 * The version this install runs, and a report when its last run ended on an uncaught error: the two
 * messages of shared/telemetry.ts, and nothing else, sent to the endpoint the operator configures
 * (WIDAL_TELEMETRY_URL). With none configured the real entrypoint (index.ts) makes no Telemetry at
 * all, so nothing is sent and the API answers 404. No message goes out before the app has shown its
 * notice once, while the switch is off, or where the environment says not to; every body is checked
 * with `telemetryEvent` right before it goes, so a field outside the schema never leaves this PC.
 * Only the real entrypoint makes one of these, so tests and a remote PC's bridge send nothing.
 */
import { mkdirSync, accessSync, constants, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOTICE_VERSION, TELEMETRY_ERROR_KINDS, telemetryEvent, telemetryVersion, type TelemetryChange, type TelemetryErrorKind, type TelemetryEvent, type TelemetryStatus } from "../shared/telemetry.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { updateRequestAllowed } from "./update-api.ts";

const FILE = "telemetry.json";
/**
 * The switch turned off, as a file of its own beside FILE that only the switch writes or removes. Every other
 * write saves the whole of FILE as it was read, so a server on the same state directory that read the switch on
 * a moment before it was turned off would write it back on; none of them touches this file, so off holds.
 */
const OFF_FILE = "telemetry-off";
const SEND_TIMEOUT_MS = 10_000;
/** after a start, long enough for the app to have shown its notice and the user to have read it */
const START_DELAY_MS = 15_000;
/** after the notice was shown, time to read it and press Turn off before the first message goes */
export const NOTICE_GRACE_MS = 10 * 60_000;
const TELEMETRY_CHANGE_KEYS = new Set(["enabled", "notice_seen", "notice_version"]);
/** a change is two small fields; anything larger is not one of ours */
const MAX_CHANGE_BYTES = 4 * 1024;

type Env = Record<string, string | undefined>;

export function telemetryBlocked(env: Env): boolean {
  const own = env["OVIS_TELEMETRY"]?.trim().toLowerCase();
  if (own && ["0", "false", "off", "no"].includes(own)) return true;
  const dnt = env["DO_NOT_TRACK"]?.trim();
  if (dnt && dnt !== "0") return true;
  return Boolean(env["CI"] || env["HERDR_TEST_MODE"] || env["HERDR_TEST_SESSION"]);
}

/**
 * The endpoint WIDAL_TELEMETRY_URL names, or null for none or one that is not usable: an https address
 * with no credentials, or an http one on this PC itself (a collector run beside the app). Nothing is
 * sent by default: no address is built in.
 */
export function telemetryUrl(env: Env): string | null {
  const raw = env["WIDAL_TELEMETRY_URL"]?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.href;
}

function telemetryChange(value: unknown): TelemetryChange | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !TELEMETRY_CHANGE_KEYS.has(key))) return null;

    const clean: TelemetryChange = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      switch (key) {
        case "enabled":
          if (typeof descriptor.value !== "boolean") return null;
          clean.enabled = descriptor.value;
          break;
        case "notice_seen":
          if (descriptor.value !== true) return null;
          clean.notice_seen = true;
          break;
        case "notice_version":
          if (descriptor.value !== NOTICE_VERSION) return null;
          clean.notice_version = NOTICE_VERSION;
          break;
      }
    }
    if (clean.notice_seen === true && clean.notice_version !== NOTICE_VERSION) return null;
    return clean;
  } catch {
    return null;
  }
}

interface PendingError {
  kind: TelemetryErrorKind;
  /** the version of the run that ended on it */
  version: string;
}

interface Saved {
  enabled: boolean;
  /** when the current notice (notice_version) was shown; null before, and for a file that saw only an older notice */
  notice_seen_at: string | null;
  notice_version: number;
  /** the version the last delivered message was for; null before the first one */
  reported_version: string | null;
  /** an error the last run ended on that was not delivered yet; at most one, so a crash loop sends one report a start */
  pending_error: PendingError | null;
}

/**
 * Whether OFF_FILE marks the messages off. It fails closed: only a name that is not there, in a state directory this
 * process can read, counts as no mark. Anything at the name (a dangling link too) or any failure to tell is off.
 */
function offMarked(offFile: string): boolean {
  try {
    lstatSync(offFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  try {
    accessSync(dirname(offFile), constants.R_OK | constants.X_OK);
    return false;
  } catch { return true; }
}

function readPending(value: unknown): PendingError | null {
  if (!isJsonObject(value)) return null;
  const kind = value["kind"];
  const version = telemetryVersion(value["version"]);
  if (typeof kind !== "string" || !(TELEMETRY_ERROR_KINDS as readonly string[]).includes(kind) || version === null) return null;
  return { kind: kind as TelemetryErrorKind, version };
}

function readSaved(file: string, offFile: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isJsonObject(value)) return null;
    // a switch an older build turned off is copied into OFF_FILE whenever it is read, so no late write of FILE can turn it
    // on; a read that cannot write it now still reads off, and the next read tries again
    if (value["enabled"] === false && !offMarked(offFile)) {
      try { writeFileSync(offFile, "", { mode: 0o600 }); } catch { /* read-only for now: still off, marked at a later read */ }
    }
    // a notice from before it said what is sent now does not count: it is shown again first. Anything else an older
    // build kept in the file (an install id, settings, visit days) is not read, and the next write drops it
    const noticeSeenAt = value["notice_version"] === NOTICE_VERSION && typeof value["notice_seen_at"] === "string" ? value["notice_seen_at"] : null;
    return {
      enabled: value["enabled"] !== false && !offMarked(offFile),
      notice_seen_at: noticeSeenAt,
      notice_version: NOTICE_VERSION,
      reported_version: telemetryVersion(value["reported_version"]),
      pending_error: readPending(value["pending_error"]),
    };
  } catch { return null; }
}

export class Telemetry {
  private saved: Saved;
  private sending: Promise<void> | null = null;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly file: string;
  private readonly offFile: string;
  /** false when the state file could not be written: then nothing is sent (it could not be remembered) */
  private writable = true;

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    /** where messages go: telemetryUrl(env), already checked */
    url: string;
    /** tests move the clock; the notice's grace is measured with it */
    now?: () => number;
    noticeGraceMs?: number;
  }) {
    this.file = join(options.stateDir, FILE);
    this.offFile = join(options.stateDir, OFF_FILE);
    // a first run's state directory is made before the mark is looked for: one that is not there reads off (offMarked)
    try { mkdirSync(options.stateDir, { recursive: true, mode: 0o700 }); } catch { /* not made: offMarked reads off */ }
    const saved = readSaved(this.file, this.offFile);
    this.saved = saved ?? { enabled: !offMarked(this.offFile), notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: null, pending_error: null };
    // a file from an older build is rewritten at once, so what it kept beyond these fields does not outlive this start
    try { this.persist(); } catch (error) {
      // the app still starts; telemetry just stays silent
      this.writable = false;
      console.error(`telemetry: ${this.file} could not be written, so nothing will be sent (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** another server on the same state directory may have changed the switch: its file wins */
  private refresh(): void {
    const latest = readSaved(this.file, this.offFile);
    if (latest) this.saved = latest;
    // the file could not be read: what is known of it stays, but an off, or no way to tell, wins
    else if (offMarked(this.offFile)) this.saved.enabled = false;
  }

  private markOff(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.offFile, "", { mode: 0o600 });
  }

  private persist(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.saved), { mode: 0o600 });
    renameSync(temp, this.file);
    this.writable = true;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.report(), ms);
    this.timer.unref?.();
  }

  private blocked(): boolean { return telemetryBlocked(this.options.env); }

  /** the messages this version still owes, whether or not they may be sent now: the last run's error, then the version */
  private pending(): TelemetryEvent[] {
    const { version } = this.options;
    const owed: TelemetryEvent[] = [];
    const error = this.saved.pending_error;
    if (error) owed.push({ event: "error", version: error.version, error: error.kind });
    if (this.saved.reported_version !== version) owed.push({ event: "version", version });
    return owed;
  }

  status(): TelemetryStatus {
    this.refresh();
    return {
      enabled: this.saved.enabled,
      blocked_by_env: this.blocked(),
      notice_seen: this.saved.notice_seen_at !== null,
      next: this.pending().flatMap((event) => { const clean = telemetryEvent(event); return clean ? [clean] : []; }),
      error_kinds: TELEMETRY_ERROR_KINDS,
    };
  }

  change(patch: TelemetryChange): TelemetryStatus {
    const clean = telemetryChange(patch);
    if (!clean) throw new TypeError("Invalid telemetry change");
    // turned off while a message is on its way: stop it before anything is read or written (a read may write the mark), and
    // even if OFF_FILE cannot be written
    if (clean.enabled === false) this.abort?.abort();
    this.refresh();
    // off is marked before FILE is written, whatever another server writes to FILE meanwhile
    if (clean.enabled === false) this.markOff();
    if (clean.enabled !== undefined) this.saved.enabled = clean.enabled;
    if (clean.notice_seen && this.saved.notice_seen_at === null) this.saved.notice_seen_at = new Date(this.now()).toISOString();
    // off, an error that was waiting is not kept for when the switch is turned on again
    if (clean.enabled === false) this.saved.pending_error = null;
    this.persist();
    // and again after: an on from another server between the two writes cannot leave this off without its mark
    if (clean.enabled === false) this.markOff();
    // on removes the mark only once FILE says on, so no read in between finds FILE off and no mark (readSaved would mark it)
    if (clean.enabled === true) rmSync(this.offFile, { force: true });
    void this.report();
    return this.status();
  }

  /**
   * Notes that this run is ending on an uncaught error of `kind`, to be reported at the next start: the process is
   * about to exit, so nothing is sent now, and the one write is synchronous. It keeps only the kind and the version,
   * never the error, and never throws: it runs while the process is already failing.
   */
  recordError(kind: TelemetryErrorKind): void {
    try {
      if (!this.writable) return;
      this.refresh();
      if (!this.saved.enabled || this.blocked() || this.saved.notice_seen_at === null) return;
      this.saved.pending_error = { kind, version: this.options.version };
      this.persist();
    } catch { /* the process is failing already: a report that cannot be kept is dropped */ }
  }

  start(): void { this.schedule(START_DELAY_MS); }
  stop(): void { clearTimeout(this.timer); this.abort?.abort(); }

  /**
   * Sends what is owed, oldest first, no sooner than NOTICE_GRACE_MS after the notice was shown; a failure is
   * logged and tried again at the next start or change. Every body is checked against the schema right before it goes.
   */
  report(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.writable) return Promise.resolve();
    this.refresh();
    const seen = this.saved.notice_seen_at === null ? NaN : Date.parse(this.saved.notice_seen_at);
    if (this.pending().length === 0 || !this.saved.enabled || Number.isNaN(seen) || this.blocked()) return Promise.resolve();
    const wait = seen + (this.options.noticeGraceMs ?? NOTICE_GRACE_MS) - this.now();
    if (wait > 0) { this.schedule(wait); return Promise.resolve(); }
    const abort = new AbortController();
    this.abort = abort;
    this.sending = (async () => {
      for (const owed of this.pending()) {
        if (abort.signal.aborted) return;
        // a body the schema does not return whole is not sent, and not retried: it would fail again the same way
        const event = telemetryEvent(owed);
        if (!event) {
          console.error("telemetry: a message did not match the schema and was not sent");
          this.settle(owed);
          continue;
        }
        try {
          // right before it goes: turned off by another server on the same state directory since the read above
          if (offMarked(this.offFile)) return;
          const response = await this.options.fetch(this.options.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.refresh();
          this.settle(event);
        } catch (error) {
          if (!abort.signal.aborted) console.error(`telemetry: the ${event.event} message was not delivered (${error instanceof Error ? error.message : String(error)})`);
          return;
        }
      }
    })().finally(() => {
      // after the assignment, even when the off check returned before any await: else the finished send would stand as
      // in flight and the owed message would wait for a restart
      this.sending = null;
      this.abort = undefined;
    });
    return this.sending;
  }

  /** the message is delivered, or will never be: it is no longer owed */
  private settle(event: TelemetryEvent | { event: string; version?: unknown }): void {
    if (event.event === "error") this.saved.pending_error = null;
    else this.saved.reported_version = this.options.version;
    try { this.persist(); } catch (error) {
      console.error(`telemetry: ${this.file} could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

export async function handleTelemetryRequest(request: Request, telemetry?: Telemetry): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (!telemetry) return reply({ error: { code: "not_found", message: "This server sends no telemetry" } }, 404);
  if (request.method === "GET") return reply(telemetry.status());
  if (request.method !== "POST") return reply({ error: { code: "method_not_allowed", message: "Use GET or POST /api/telemetry" } }, 405);
  if (!updateRequestAllowed(request)) return reply({ error: { code: "invalid_telemetry_request", message: "Use the controls from this app." } }, 403);
  // a body announced over the limit is refused unread; one that lies about its length is measured. Nothing is counted
  const tooLarge = () => reply({ error: { code: "too_large", message: "The telemetry change is too large" } }, 413);
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_CHANGE_BYTES) return tooLarge();
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_CHANGE_BYTES) return tooLarge();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  if (!isJsonObject(body)) return badRequest("invalid_body", "Send an object");
  const change = telemetryChange(body);
  if (!change) return badRequest("invalid_body", "Send enabled, or the current notice acknowledgement");
  try { return reply(telemetry.change(change)); }
  catch (error) { return errorResponse(error); }
}
