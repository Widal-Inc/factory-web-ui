import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTICE_VERSION, TELEMETRY_ERROR_KINDS, TELEMETRY_FIELDS, telemetryEvent, type TelemetryEvent } from "../shared/telemetry.ts";
import { handleTelemetryRequest, Telemetry, telemetryBlocked, telemetryUrl } from "./telemetry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** a fixture receiver, never a real one */
const TEST_URL = "https://telemetry.test/v1/events";

function setup(options: { version?: string; env?: Record<string, string>; status?: number; stateDir?: string; grace?: number; fetch?: typeof fetch; now?: string } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "telemetry-"));
  if (!options.stateDir) dirs.push(stateDir);
  /** every request body the fixture receiver was sent, as the raw text it read */
  const bodies: string[] = [];
  const urls: string[] = [];
  const answer = { status: options.status ?? 204 };
  const fake = options.fetch ?? (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(String(init?.body));
    return new Response(null, { status: answer.status });
  }) as typeof fetch;
  const clock = { now: Date.parse(options.now ?? "2026-10-08T12:00:00Z") };
  const telemetry = new Telemetry({
    stateDir, version: options.version ?? "0.4.1", env: options.env ?? {}, fetch: fake, url: TEST_URL,
    now: () => clock.now, noticeGraceMs: options.grace ?? 0,
  });
  const sent = () => bodies.map((body) => JSON.parse(body) as TelemetryEvent);
  return { telemetry, bodies, sent, urls, answer, stateDir, clock };
}

function savedFile(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));
}

function seen(telemetry: Telemetry) {
  telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
}

describe("the fixed schema", () => {
  test("a version message and an error message are the only two, with exactly their fields", () => {
    expect(telemetryEvent({ event: "version", version: "0.4.1" })).toEqual({ event: "version", version: "0.4.1" });
    expect(telemetryEvent({ event: "error", version: "0.4.1-rc.1", error: "uncaught_exception" })).toEqual({ event: "error", version: "0.4.1-rc.1", error: "uncaught_exception" });
    expect(Object.keys(TELEMETRY_FIELDS).sort()).toEqual(["error", "version"]);
    expect([...TELEMETRY_ERROR_KINDS]).toEqual(["uncaught_exception"]);
  });

  test("a field outside the schema, a missing one or a value outside its set makes the message no message", () => {
    const version = { event: "version", version: "0.4.1" };
    const error = { event: "error", version: "0.4.1", error: "uncaught_exception" };
    for (const extra of ["install_id", "os", "arch", "settings", "usage", "harnesses", "message", "stack", "path", "country"]) {
      expect(telemetryEvent({ ...version, [extra]: "x" })).toBeNull();
      expect(telemetryEvent({ ...error, [extra]: "x" })).toBeNull();
    }
    expect(telemetryEvent({ event: "version" })).toBeNull();
    expect(telemetryEvent({ event: "version", version: "0.4.1", error: "uncaught_exception" })).toBeNull();
    expect(telemetryEvent({ event: "error", version: "0.4.1" })).toBeNull();
    expect(telemetryEvent({ event: "error", version: "0.4.1", error: "TypeError: x is not a function at /home/me/app.ts:1" })).toBeNull();
    expect(telemetryEvent({ event: "install", version: "0.4.1" })).toBeNull();
    expect(telemetryEvent({ event: "active", version: "0.4.1" })).toBeNull();
    for (const bad of ["", " 0.4.1", "0.4.1\n", "v0.4.1", "0.4.1 /home/me", "a".repeat(65), "0.4.1/../x", 4, null]) {
      expect(telemetryEvent({ event: "version", version: bad })).toBeNull();
    }
    for (const notAnObject of [null, undefined, "version", 3, [], [{ event: "version", version: "0.4.1" }]]) expect(telemetryEvent(notAnObject)).toBeNull();
    expect(telemetryEvent(Object.assign(Object.create({ inherited: true }), version))).toBeNull();
    expect(telemetryEvent({ ...version, [Symbol("extra")]: 1 })).toBeNull();
    const accessor = { event: "version" } as Record<string, unknown>;
    Object.defineProperty(accessor, "version", { enumerable: true, get: () => "0.4.1" });
    expect(telemetryEvent(accessor)).toBeNull();
  });

  test("whatever a run does, every body the receiver is sent is a schema message with only its fields", async () => {
    // a state file an older build (or anything else) wrote: ids, settings, visit days, usage and error text in it
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.0",
      settings: { theme: "dark" }, active: [{ day: "2026-10-07", harnesses: ["claude"], usage: { prompt_answers: 3 } }],
      pending_error: { kind: "uncaught_exception", version: "0.4.0", message: "boom at /home/someone/secret.ts", stack: "x", os: "linux" },
    }));
    const run = setup({ stateDir, version: "0.4.1" });
    await run.telemetry.report();
    run.telemetry.recordError("uncaught_exception");
    const next = setup({ stateDir, version: "0.4.2" });
    await next.telemetry.report();
    const bodies = [...run.bodies, ...next.bodies];
    expect(bodies.length).toBe(4);
    for (const body of bodies) {
      const message = JSON.parse(body) as Record<string, unknown>;
      expect(telemetryEvent(message)).toEqual(message as unknown as TelemetryEvent);
      const allowed: readonly string[] = TELEMETRY_FIELDS[message["event"] as "version" | "error"];
      expect(Object.keys(message).sort()).toEqual([...allowed].sort());
      expect(body).not.toMatch(/install_id|settings|usage|harness|0b5f3c2e|secret|someone|stack|linux|boom/);
    }
    expect(bodies.map((body) => JSON.parse(body))).toEqual([
      { event: "error", version: "0.4.0", error: "uncaught_exception" },
      { event: "version", version: "0.4.1" },
      { event: "error", version: "0.4.1", error: "uncaught_exception" },
      { event: "version", version: "0.4.2" },
    ]);
  });

  test("a version that is not a version is not sent, and is logged rather than retried", async () => {
    const { telemetry, bodies } = setup({ version: "1.0.0 /home/me/secret" });
    seen(telemetry);
    await telemetry.report();
    expect(bodies).toEqual([]);
    expect(telemetry.status().next).toEqual([]);
  });

  test("the module names no address of its own: the endpoint is the operator's", () => {
    for (const file of ["telemetry.ts", "../shared/telemetry.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source.match(/https?:\/\/[^\s"'`)]+/g) ?? []).toEqual([]);
    }
  });

  test("the receiver is sent a POST of JSON to the configured address and nothing else", async () => {
    const calls: { url: string; method: string | undefined; headers: unknown }[] = [];
    const { telemetry } = setup({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), method: init?.method, headers: init?.headers }); return new Response(null, { status: 204 }); }) as typeof fetch,
    });
    seen(telemetry);
    await telemetry.report();
    expect(calls).toEqual([{ url: TEST_URL, method: "POST", headers: { "content-type": "application/json" } }]);
  });
});

describe("the endpoint", () => {
  test("is the operator's WIDAL_TELEMETRY_URL, https, or http on this PC; with none, nothing is configured", () => {
    expect(telemetryUrl({})).toBeNull();
    expect(telemetryUrl({ WIDAL_TELEMETRY_URL: "  " })).toBeNull();
    expect(telemetryUrl({ WIDAL_TELEMETRY_URL: "https://collector.example/v1/events" })).toBe("https://collector.example/v1/events");
    expect(telemetryUrl({ WIDAL_TELEMETRY_URL: "http://127.0.0.1:9000/events" })).toBe("http://127.0.0.1:9000/events");
    expect(telemetryUrl({ WIDAL_TELEMETRY_URL: "http://localhost:9000/events" })).toBe("http://localhost:9000/events");
    for (const bad of ["http://collector.example/events", "ftp://collector.example/", "collector.example/events", "https://user:pass@collector.example/", "https://collector.example/#frag", "not a url"]) {
      expect(telemetryUrl({ WIDAL_TELEMETRY_URL: bad })).toBeNull();
    }
  });

  test("the inherited upstream variable names no endpoint", () => {
    expect(telemetryUrl({ OVIS_TELEMETRY: "https://collector.example/" })).toBeNull();
  });
});

describe("version messages", () => {
  test("nothing is sent before the current notice was shown", async () => {
    const { telemetry, bodies } = setup();
    await telemetry.report();
    expect(bodies).toEqual([]);
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: false, blocked_by_env: false, next: [{ event: "version", version: "0.4.1" }], error_kinds: ["uncaught_exception"] });
  });

  test("the notice sends the version once, and a restart on the same version sends nothing", async () => {
    const first = setup();
    seen(first.telemetry);
    await first.telemetry.report();
    expect(first.sent()).toEqual([{ event: "version", version: "0.4.1" }]);
    expect(first.telemetry.status().next).toEqual([]);
    await first.telemetry.report();
    expect(first.bodies).toHaveLength(1);
    const restart = setup({ stateDir: first.stateDir });
    await restart.telemetry.report();
    expect(restart.bodies).toEqual([]);
  });

  test("a new version sends its own message", async () => {
    const first = setup();
    seen(first.telemetry);
    await first.telemetry.report();
    const update = setup({ stateDir: first.stateDir, version: "0.4.2" });
    await update.telemetry.report();
    expect(update.sent()).toEqual([{ event: "version", version: "0.4.2" }]);
    expect(savedFile(first.stateDir).reported_version).toBe("0.4.2");
  });

  test("the switch off sends nothing, and on again sends what is owed", async () => {
    const { telemetry, sent, bodies } = setup();
    telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(bodies).toEqual([]);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent()).toEqual([{ event: "version", version: "0.4.1" }]);
  });

  test("the environment can forbid sending whatever the switch says", async () => {
    const environments: Record<string, string>[] = [{ OVIS_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { HERDR_TEST_MODE: "unit" }];
    for (const env of environments) {
      const { telemetry, bodies } = setup({ env });
      telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
      await telemetry.report();
      expect(bodies).toEqual([]);
      expect(telemetry.status().blocked_by_env).toBe(true);
    }
    expect(telemetryBlocked({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  test("a message the receiver refused is sent again later", async () => {
    const failing = setup({ status: 503 });
    seen(failing.telemetry);
    await failing.telemetry.report();
    expect(failing.bodies).toHaveLength(1);
    expect(savedFile(failing.stateDir).reported_version).toBeNull();
    const retry = setup({ stateDir: failing.stateDir });
    await retry.telemetry.report();
    expect(retry.bodies).toHaveLength(1);
  });

  test("the first message waits after the notice, so Turn off on the notice sends nothing", async () => {
    const off = setup({ grace: 600_000 });
    seen(off.telemetry);
    await off.telemetry.report();
    expect(off.bodies).toEqual([]);
    off.telemetry.change({ enabled: false });
    off.clock.now += 600_000;
    await off.telemetry.report();
    expect(off.bodies).toEqual([]);

    const kept = setup({ grace: 600_000 });
    seen(kept.telemetry);
    kept.clock.now += 599_999;
    await kept.telemetry.report();
    expect(kept.bodies).toEqual([]);
    kept.clock.now += 1;
    await kept.telemetry.report();
    expect(kept.sent()).toEqual([{ event: "version", version: "0.4.1" }]);
    kept.telemetry.stop();
  });

  test("turning the switch off stops a message already on its way", async () => {
    let signal: AbortSignal | undefined;
    const pending = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
    }) as typeof fetch;
    const { telemetry, stateDir } = setup({ fetch: pending });
    seen(telemetry);
    const sending = telemetry.report();
    expect(signal?.aborted).toBe(false);
    telemetry.change({ enabled: false });
    expect(signal?.aborted).toBe(true);
    await sending;
    expect(savedFile(stateDir)).toMatchObject({ enabled: false, reported_version: null });
  });

  test("a state directory that cannot be written leaves the app running and sends nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(parent);
    writeFileSync(join(parent, "file"), "");
    const { telemetry, bodies } = setup({ stateDir: join(parent, "file", "state") });
    await telemetry.report();
    expect(bodies).toEqual([]);
    // no state directory to tell whether the reports were turned off reads as off (offMarked fails closed)
    expect(telemetry.status().enabled).toBe(false);
  });

  test("what an older build kept in the state file (an id, settings, visit days, usage) is gone after a start", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: 5, reported_version: "0.4.0",
      settings: { theme: "dark" }, active: [{ day: "2026-10-07", harnesses: ["claude"] }], usage_after_notice: true,
    }));
    const { telemetry } = setup({ stateDir });
    // the notice of an older wording does not count: it is shown again first
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: false });
    expect(savedFile(stateDir)).toEqual({ enabled: true, notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: "0.4.0", pending_error: null });
  });
});

describe("error reports", () => {
  test("a run that ended on an uncaught error is reported at the next start, with that run's version and the fixed kind", async () => {
    const run = setup({ version: "0.4.1" });
    seen(run.telemetry);
    await run.telemetry.report();
    run.telemetry.recordError("uncaught_exception");
    // recording sends nothing: the process is about to exit
    expect(run.bodies).toHaveLength(1);
    expect(savedFile(run.stateDir).pending_error).toEqual({ kind: "uncaught_exception", version: "0.4.1" });
    const next = setup({ stateDir: run.stateDir, version: "0.4.2" });
    expect(next.telemetry.status().next).toEqual([{ event: "error", version: "0.4.1", error: "uncaught_exception" }, { event: "version", version: "0.4.2" }]);
    await next.telemetry.report();
    expect(next.sent()).toEqual([{ event: "error", version: "0.4.1", error: "uncaught_exception" }, { event: "version", version: "0.4.2" }]);
    expect(savedFile(run.stateDir).pending_error).toBeNull();
    const again = setup({ stateDir: run.stateDir, version: "0.4.2" });
    await again.telemetry.report();
    expect(again.bodies).toEqual([]);
  });

  test("a crash loop leaves one report for the next start, not one for each crash", async () => {
    const run = setup();
    seen(run.telemetry);
    for (let crash = 0; crash < 5; crash += 1) run.telemetry.recordError("uncaught_exception");
    const next = setup({ stateDir: run.stateDir });
    await next.telemetry.report();
    expect(next.sent().filter((event) => event.event === "error")).toHaveLength(1);
  });

  test("nothing is kept before the notice, while off or where the environment forbids it", async () => {
    const before = setup();
    before.telemetry.recordError("uncaught_exception");
    expect(savedFile(before.stateDir).pending_error).toBeNull();

    const off = setup();
    off.telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    off.telemetry.recordError("uncaught_exception");
    expect(savedFile(off.stateDir).pending_error).toBeNull();

    const blocked = setup({ env: { DO_NOT_TRACK: "1" } });
    seen(blocked.telemetry);
    blocked.telemetry.recordError("uncaught_exception");
    expect(savedFile(blocked.stateDir).pending_error).toBeNull();
  });

  test("an error waiting when the switch is turned off is dropped, and not sent when it is turned on again", async () => {
    const run = setup();
    seen(run.telemetry);
    await run.telemetry.report();
    run.telemetry.recordError("uncaught_exception");
    run.telemetry.change({ enabled: false });
    expect(savedFile(run.stateDir).pending_error).toBeNull();
    run.telemetry.change({ enabled: true });
    const next = setup({ stateDir: run.stateDir });
    await next.telemetry.report();
    expect(next.bodies).toEqual([]);
  });

  test("an error report follows the same notice grace as a version message", async () => {
    const run = setup({ grace: 600_000 });
    seen(run.telemetry);
    run.clock.now += 600_000;
    await run.telemetry.report();
    run.telemetry.recordError("uncaught_exception");
    const next = setup({ stateDir: run.stateDir, grace: 600_000, now: new Date(run.clock.now + 1000).toISOString() });
    await next.telemetry.report();
    expect(next.sent().map((event) => event.event)).toEqual(["error"]);
  });

  test("a kind or version in the state file that is not one is read as no error", () => {
    for (const pending of [{ kind: "TypeError", version: "0.4.1" }, { kind: "uncaught_exception", version: "x y" }, "uncaught_exception", 3, []]) {
      const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
      dirs.push(stateDir);
      writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", pending_error: pending }));
      expect(setup({ stateDir }).telemetry.status().next).toEqual([]);
    }
  });
});

describe("another server on the same state directory", () => {
  /**
   * A second server process that has read the state and is about to write it back: its clock (`now`, read between the
   * two) stops it there until this test writes a line to its stdin. Its lines are written synchronously: a buffered write
   * might never leave before the blocking read.
   */
  async function pausedWriter(stateDir: string, call: string) {
    const script = `
      const { readSync, writeSync } = require("node:fs");
      const { Telemetry } = await import(${JSON.stringify(join(import.meta.dir, "telemetry.ts"))});
      let armed = false;
      const telemetry = new Telemetry({
        stateDir: ${JSON.stringify(stateDir)}, version: "0.4.1", env: {}, url: "https://telemetry.test/v1/events",
        fetch: async () => { writeSync(1, "SENT\\n"); return new Response(null, { status: 204 }); },
        now: () => {
          if (armed) { armed = false; writeSync(1, "PAUSED\\n"); readSync(0, Buffer.alloc(1)); }
          return Date.parse("2026-10-08T12:00:00Z");
        },
      });
      armed = true;
      ${call}
      writeSync(1, "DONE\\n");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, HERDR_TEST_MODE: "unit" } });
    const lines: string[] = [];
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    /** the child's next output line, bounded so a child that never gets there fails rather than hangs */
    const next = () => Promise.race([
      (async () => {
        while (!buffered.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`the writer ended early: ${lines.join(" ")}`);
          buffered += decoder.decode(value);
        }
        const line = buffered.slice(0, buffered.indexOf("\n"));
        buffered = buffered.slice(line.length + 1);
        lines.push(line);
        return line;
      })(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the writer did not answer")), 10_000).unref?.()),
    ]);
    return { child, next, resume: () => { child.stdin.write("\n"); child.stdin.flush(); } };
  }

  test("a switch turned off by another server holds", async () => {
    const first = setup();
    seen(first.telemetry);
    await first.telemetry.report();
    const plugin = setup({ stateDir: first.stateDir, version: "0.4.2" });
    const source = setup({ stateDir: first.stateDir, version: "0.4.2" });
    plugin.telemetry.change({ enabled: false });
    await source.telemetry.report();
    expect(source.bodies).toEqual([]);
    expect(source.telemetry.status().enabled).toBe(false);
    expect(savedFile(first.stateDir).enabled).toBe(false);
  });

  test("turning the reports off while another server is midway through a change keeps them off, and nothing is sent", async () => {
    // the notice is not seen yet: the other server's acknowledgement reads the clock, which is where it stops
    const { telemetry, bodies, stateDir } = setup();
    const writer = await pausedWriter(stateDir, `telemetry.change({ notice_seen: true, notice_version: ${NOTICE_VERSION} });`);
    try {
      expect(await writer.next()).toBe("PAUSED");
      expect(telemetry.change({ enabled: false }).enabled).toBe(false);
      writer.resume();
      const after: string[] = [];
      for (let line = await writer.next(); line !== "DONE"; line = await writer.next()) after.push(line);
      expect(await writer.child.exited).toBe(0);
      // the other server's write lands after the opt-out: it must not turn the reports back on
      expect(after).toEqual([]);
      expect(telemetry.status().enabled).toBe(false);
      expect(setup({ stateDir }).telemetry.status().enabled).toBe(false);
      await telemetry.report();
      expect(bodies).toEqual([]);
    } finally { writer.child.kill(); }
  });

  test("an off that overlaps an on from another server and ends last keeps the reports off against a late write", async () => {
    const { telemetry, stateDir } = setup();
    // its off pauses after it is marked and before the state file is written (the notice it also takes reads the clock)
    const writer = await pausedWriter(stateDir, `telemetry.change({ enabled: false, notice_seen: true, notice_version: ${NOTICE_VERSION} });`);
    try {
      expect(await writer.next()).toBe("PAUSED");
      expect(telemetry.change({ enabled: true }).enabled).toBe(true);
      writer.resume();
      expect(await writer.next()).toBe("DONE");
      expect(await writer.child.exited).toBe(0);
      expect(telemetry.status().enabled).toBe(false);
      // a server that read the switch on before all this writes the state file back
      writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ ...savedFile(stateDir), enabled: true }));
      expect(telemetry.status().enabled).toBe(false);
    } finally { writer.child.kill(); }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an older build's off that could not be marked at start is marked at the next read", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const file = join(stateDir, "telemetry.json");
    const older = { install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: false, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [] };
    writeFileSync(file, JSON.stringify(older));
    chmodSync(stateDir, 0o500);
    const telemetry = (() => { try { return setup({ stateDir }).telemetry; } finally { chmodSync(stateDir, 0o700); } })();
    expect(telemetry.status().enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ ...older, enabled: true }));
    expect(telemetry.status().enabled).toBe(false);
  });

  test("a switch an older build turned off stays off when a late write of the state file says on", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const file = join(stateDir, "telemetry.json");
    const older = { install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: false, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [] };
    writeFileSync(file, JSON.stringify(older));
    const { telemetry } = setup({ stateDir });
    expect(telemetry.status().enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ ...older, enabled: true }));
    expect(telemetry.status().enabled).toBe(false);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a state directory that cannot be read sends nothing, even with the reports on in memory", async () => {
    const { telemetry, bodies, clock, stateDir } = setup({ grace: 60_000 });
    seen(telemetry);
    clock.now += 60_000;
    chmodSync(stateDir, 0o000);
    try {
      // the version message is owed and finds no answer to whether the reports were turned off
      await telemetry.report();
      expect(bodies).toEqual([]);
      expect(telemetry.status().enabled).toBe(false);
    } finally {
      chmodSync(stateDir, 0o700);
      telemetry.stop();
    }
  });

  test.skipIf(process.platform === "win32")("an off mark that is a dangling link still reads off", async () => {
    const { telemetry, bodies, stateDir } = setup();
    symlinkSync(join(stateDir, "gone"), join(stateDir, "telemetry-off"));
    expect(telemetry.status().enabled).toBe(false);
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(bodies).toEqual([]);
  });

  test("a message held back by an off marked just before it goes is sent once the reports are on again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: null, pending_error: null }));
    const sent: TelemetryEvent[] = [];
    let markAtClock = false;
    const telemetry = new Telemetry({
      stateDir, version: "0.4.1", env: {}, url: TEST_URL, noticeGraceMs: 0,
      fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push(JSON.parse(String(init?.body)) as TelemetryEvent);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      // another server turns the reports off between this one's read of the state and its send (the clock is read between)
      now: () => {
        if (markAtClock) { markAtClock = false; writeFileSync(join(stateDir, "telemetry-off"), ""); }
        return Date.parse("2026-10-08T12:00:00Z");
      },
    });
    markAtClock = true;
    await telemetry.report();
    expect(sent).toEqual([]);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent).toEqual([{ event: "version", version: "0.4.1" }]);
  });

  test("turning the reports on again from either server turns them on", async () => {
    const first = setup();
    seen(first.telemetry);
    first.telemetry.change({ enabled: false });
    const second = setup({ stateDir: first.stateDir });
    expect(second.telemetry.status().enabled).toBe(false);
    second.telemetry.change({ enabled: true });
    expect(first.telemetry.status().enabled).toBe(true);
    await first.telemetry.report();
    expect(first.sent()).toEqual([{ event: "version", version: "0.4.1" }]);
  });
});

describe("/api/telemetry", () => {
  const post = (body: unknown, headers: Record<string, string> = { "x-herdr-update": "1" }) =>
    new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("a server without telemetry answers 404", async () => {
    for (const request of [new Request("http://localhost/api/telemetry"), post({ enabled: false })]) {
      const response = await handleTelemetryRequest(request);
      expect(response.status).toBe(404);
    }
  });

  test("GET tells the status and previews the messages exactly as they would be sent", async () => {
    const { telemetry } = setup();
    const response = await handleTelemetryRequest(new Request("http://localhost/api/telemetry"), telemetry);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ enabled: true, blocked_by_env: false, notice_seen: false, next: [{ event: "version", version: "0.4.1" }], error_kinds: ["uncaught_exception"] });
  });

  test("POST takes only the switch and the current notice acknowledgement", async () => {
    const { telemetry, bodies } = setup();
    expect((await handleTelemetryRequest(post({ enabled: false }), telemetry)).status).toBe(200);
    expect(telemetry.status().enabled).toBe(false);
    for (const body of [
      { enabled: "no" }, { notice_seen: false, notice_version: NOTICE_VERSION }, { notice_seen: true }, { notice_seen: true, notice_version: NOTICE_VERSION - 1 },
      { settings: { theme: "dark" } }, { alert_opened: true }, { install_id: "x" }, { usage: {} }, { enabled: true, extra: 1 }, [], "enabled",
    ]) {
      const response = await handleTelemetryRequest(post(body), telemetry);
      expect(response.status).toBe(400);
    }
    expect(telemetry.status().enabled).toBe(false);
    expect(bodies).toEqual([]);
  });

  test("POST needs the app's own header, and refuses a body over the limit, announced or measured", async () => {
    const { telemetry } = setup();
    expect((await handleTelemetryRequest(post({ enabled: false }, {}), telemetry)).status).toBe(403);
    expect(telemetry.status().enabled).toBe(true);
    const big = JSON.stringify({ enabled: false, pad: "x".repeat(8 * 1024) });
    const announced = new Request("http://localhost/api/telemetry", { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json", "content-length": String(big.length) }, body: big });
    expect((await handleTelemetryRequest(announced, telemetry)).status).toBe(413);
    const measured = new Request("http://localhost/api/telemetry", { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json" }, body: big });
    expect((await handleTelemetryRequest(measured, telemetry)).status).toBe(413);
    expect(telemetry.status().enabled).toBe(true);
    expect((await handleTelemetryRequest(new Request("http://localhost/api/telemetry", { method: "PUT", headers: { "x-herdr-update": "1" } }), telemetry)).status).toBe(405);
  });

  test("change() requires the exact current notice version before acknowledging", () => {
    const { telemetry } = setup();
    expect(() => telemetry.change({ notice_seen: true })).toThrow(TypeError);
    expect(() => telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION - 1 })).toThrow(TypeError);
    expect(telemetry.status().notice_seen).toBe(false);
    expect(telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION }).notice_seen).toBe(true);
  });
});
