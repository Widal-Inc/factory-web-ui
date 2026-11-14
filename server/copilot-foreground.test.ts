import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetCopilotForeground, readCopilotForeground } from "./copilot-foreground.ts";
import * as processOwner from "./process-owner.ts";

const session = "12aa83d8-48bc-41f2-a498-7055c5c44b01";
const root = mkdtempSync(join(tmpdir(), "herdr-copilot-foreground-"));
const script = join(root, "api.js");
let child: ReturnType<typeof Bun.spawn> | undefined;

/** Copilot's `--ui-server` as far as Chat asks of it: a loopback listener answering `connect` and `session.getForeground`. */
const stand = `import { createServer } from "node:net";
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]);
};
createServer((socket) => {
  socket.on("error", () => {});
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    for (;;) {
      const boundary = bytes.indexOf("\\r\\n\\r\\n");
      if (boundary < 0) return;
      const length = Number(bytes.subarray(0, boundary).toString().split(":")[1]);
      if (bytes.length < boundary + 4 + length) return;
      const message = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + length));
      bytes = bytes.subarray(boundary + 4 + length);
      socket.write(frame({ jsonrpc: "2.0", id: message.id,
        result: message.method === "connect" ? { protocolVersion: 3 } : { sessionId: process.argv[2] } }));
    }
  });
}).listen(0, "127.0.0.1");
setInterval(() => {}, 1000);`;

/**
 * A new connection must be seen accepted within 2 s, which fails closed (`rpc_timeout`, or `rpc_failed` when
 * the connection is cut meanwhile) on a host whose TCP table takes this long to read or that is starved:
 * asking again is what Chat does, and what proves the same thing here.
 */
async function answered(pid: number): ReturnType<typeof readCopilotForeground> {
  for (let attempt = 0;; attempt++) {
    const answer = await readCopilotForeground(pid);
    if (answer.state === "selected" || !["rpc_timeout", "rpc_failed"].includes(answer.diagnostic) || attempt >= 4) return answer;
  }
}

/** Reads of the kernel's TCP tables (`/proc/<pid>/net/tcp`): each costs tens to hundreds of ms in a container. */
function countTableReads<T>(run: () => Promise<T>): Promise<{ result: T; reads: number }> {
  const real = fs.openSync;
  let reads = 0;
  const open = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (typeof path === "string" && /\/net\/tcp$/.test(path)) reads++;
    return (real as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);
  return run().then((result) => ({ result, reads }), (error) => { throw error; }).finally(() => open.mockRestore());
}

beforeAll(async () => {
  if (process.platform !== "linux") return;
  writeFileSync(script, stand);
  child = Bun.spawn([process.execPath, script, session, "--ui-server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  // the listener is not up for a moment: an unproved endpoint is what Chat sees until it is
  for (const deadline = Date.now() + 10_000;;) {
    if ((await answered(child.pid)).state === "selected") break;
    if (Date.now() > deadline) throw new Error("the --ui-server stand-in never answered");
    await Bun.sleep(50);
  }
  forgetCopilotForeground();
});

afterAll(() => {
  forgetCopilotForeground();
  child?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("proves ownership from one TCP table read once its connection is held", async () => {
  const pid = child!.pid;
  const first = await answered(pid);
  expect(first).toMatchObject({ state: "selected", sessionId: session });
  const { result: second, reads } = await countTableReads(() => readCopilotForeground(pid));
  expect(second).toMatchObject({ state: "selected", sessionId: session });
  // The end of the read proves the process, its listener and the accepted connection from one snapshot
  expect(reads).toBe(1);
  // and the same client answered: nothing was proved again from scratch
  expect(second.state === "selected" && first.state === "selected" && second.binding === first.binding).toBe(true);
});

it.skipIf(process.platform !== "linux")("starts over with a new connection when the process's start differs from the one proved", async () => {
  const pid = child!.pid;
  const first = await answered(pid);
  if (first.state !== "selected") throw new Error("the stand-in does not answer");
  const real = processOwner.readProcessBirth;
  const other = spyOn(processOwner, "readProcessBirth").mockImplementation((who) => {
    const reading = real(who);
    return who === pid && reading.state === "identified" ? { state: "identified", birth: { ...reading.birth, value: `${reading.birth.value}0` } } : reading;
  });
  try {
    // every read now names another start than the connection was proved with: a fresh proof of the
    // new one is what answers (the kept connection is not trusted), and it holds from then on
    const again = await answered(pid);
    expect(again).toMatchObject({ state: "selected", sessionId: session });
    if (again.state === "selected") expect(again.binding.split(":")[0]).not.toBe(first.binding.split(":")[0]);
  } finally { other.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("fails closed when the process's start changes during a read", async () => {
  const pid = child!.pid;
  forgetCopilotForeground();
  expect((await answered(pid)).state).toBe("selected");
  const real = processOwner.readProcessBirth;
  let reads = 0;
  // the first look (which keeps the connection) sees the proved start; the proof at the end of the read sees another
  const swapped = spyOn(processOwner, "readProcessBirth").mockImplementation((who) => {
    const reading = real(who);
    if (who !== pid || reading.state !== "identified" || ++reads === 1) return reading;
    return { state: "identified", birth: { ...reading.birth, value: `${reading.birth.value}0` } };
  });
  try {
    expect(await readCopilotForeground(pid)).toEqual({ state: "unavailable", diagnostic: "process_changed" });
  } finally { swapped.mockRestore(); }
  expect(await answered(pid)).toMatchObject({ state: "selected" });
});

it.skipIf(process.platform !== "linux")("is unavailable for a process that was not started with --ui-server or has ended", async () => {
  expect(await readCopilotForeground(process.pid)).toEqual({ state: "unavailable", diagnostic: "not_opted_in" });
  const gone = Bun.spawn([process.execPath, "-e", "0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await gone.exited;
  expect((await readCopilotForeground(gone.pid)).state).toBe("unavailable");
});
