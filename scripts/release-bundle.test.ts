import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BUILD_FILE, HUB_MANIFEST_FILE, buildManifest } from "./hub-artifact.ts";
import { HUB_UI_DIR, OWNER_SERVER, RELEASE_INFO_FILE, RELEASE_INFO_SCHEMA, archiveName, buildPin, packDeterministic, pinProblem, verifyRelease, type ReleasePin } from "./release-bundle.ts";

const commit = "a".repeat(40);
const other = "b".repeat(40);
const epoch = 1_794_505_069;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let temp: string;
beforeEach(() => { temp = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "release-bundle-test-")); });
afterEach(() => { rmSync(temp, { recursive: true, force: true }); });

function put(stage: string, path: string, content: string, mode = 0o644): void {
  const full = join(stage, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  chmodSync(full, mode);
}

/** A small stand-in for a release: the same layout the builder makes, without its size. */
function stageRelease(name: string, options: { revision?: string; extra?: (stage: string) => void } = {}): string {
  const stage = join(temp, name);
  const revision = options.revision ?? commit;
  put(stage, "bundle.json", JSON.stringify({ version: "43", platform: "linux-x64", bun: "1.4.2", pty_sidecar: false }));
  put(stage, "package.json", "{}");
  put(stage, "server/index.ts", "export {};");
  put(stage, "dist/index.html", "<html>");
  for (const program of ["bun", "node", "herdr"]) put(stage, `bin/${program}`, program, 0o755);
  put(stage, "node_modules/pkg/index.js", "x");
  put(stage, RELEASE_INFO_FILE, JSON.stringify({ schema: RELEASE_INFO_SCHEMA, commit: revision }));
  const hub = [
    { path: "index.html", bytes: new TextEncoder().encode("<html>hub") },
    { path: "assets/app.js", bytes: new TextEncoder().encode("app") },
    { path: BUILD_FILE, bytes: new TextEncoder().encode(`${JSON.stringify({ revision })}\n`) },
  ];
  for (const file of hub) put(stage, `${HUB_UI_DIR}/${file.path}`, new TextDecoder().decode(file.bytes));
  put(stage, `${HUB_UI_DIR}/${HUB_MANIFEST_FILE}`, JSON.stringify(buildManifest(hub, { revision, source: "Example-Org/example-ui", builtAt: new Date(epoch * 1000) })));
  options.extra?.(stage);
  return stage;
}

function release(stage: string): { archive: string; pin: ReleasePin } {
  const archive = join(temp, `${stage.split("/").pop()}.tgz`);
  packDeterministic(stage, archive, epoch);
  // a case that removed the hub UI still gets a pin (of an empty manifest), so the verifier is what refuses it
  const manifestPath = join(stage, HUB_UI_DIR, HUB_MANIFEST_FILE);
  const manifest = existsSync(manifestPath) ? new Uint8Array(readFileSync(manifestPath)) : new Uint8Array([123, 125]);
  const pin = buildPin({
    version: "43", repository: "Example-Org/example-ui", commit, builtAt: new Date(epoch * 1000),
    archive: { file: archiveName("43", commit), bytes: new Uint8Array(readFileSync(archive)) },
    hubUi: { manifest, files: 3 }, bun: "1.4.2", rustPtyHost: false,
  });
  return { archive, pin };
}

describe("release pin", () => {
  test("names the archive, the commit and the hub UI the factory install needs", () => {
    const { pin } = release(stageRelease("a"));
    expect(pin.archive.file).toBe(`widal-web-43-${"a".repeat(12)}-linux-x64.tgz`);
    expect(pin.source.commit).toBe(commit);
    expect(pin.hubUi).toMatchObject({ path: "hub-ui", manifest: "hub-ui/widal-ui.json", revision: commit });
    expect(pin.ownerServer).toMatchObject({ entry: "server/index.ts", runtime: "bin/bun", healthPath: "/api/health" });
    expect(pinProblem(pin)).toBeUndefined();
    expect(OWNER_SERVER.entry).toBe("server/index.ts");
  });

  test("a pin that drifted from the format is refused in words", () => {
    const { pin } = release(stageRelease("a"));
    for (const [bad, text] of [
      [{ ...pin, schema: "x" }, "schema"],
      [{ ...pin, version: "v43" }, "version"],
      [{ ...pin, platform: "darwin-arm64" }, "platform"],
      [{ ...pin, source: { ...pin.source, commit: "abc" } }, "source"],
      [{ ...pin, archive: { ...pin.archive, sha256: "zz" } }, "archive"],
      [{ ...pin, archive: { ...pin.archive, file: "other.tgz" } }, "archive"],
      [{ ...pin, hubUi: { ...pin.hubUi, revision: other } }, "hubUi"],
      [{ ...pin, ownerServer: { ...pin.ownerServer, entry: "x.ts" } }, "ownerServer"],
      [null, "object"],
    ] as const) expect(pinProblem(bad), text).toContain(text);
    expect(() => archiveName("43", "abc")).toThrow();
    expect(() => archiveName("v43", commit)).toThrow();
  });
});

describe("deterministic archive", () => {
  test("the same files make the same bytes, whatever their times, modes order or owner", () => {
    const first = stageRelease("one");
    const second = stageRelease("two", { extra: (stage) => {
      for (const file of ["server/index.ts", "dist/index.html", "node_modules/pkg/index.js"]) utimesSync(join(stage, file), 1_000_000, 1_000_000);
      chmodSync(join(stage, "server/index.ts"), 0o664);
      chmodSync(join(stage, "bin/bun"), 0o775);
    } });
    const a = release(first);
    const b = release(second);
    expect(sha256(readFileSync(a.archive))).toBe(sha256(readFileSync(b.archive)));
    expect(a.pin.archive.sha256).toBe(b.pin.archive.sha256);
  });

  test("another file or another time makes other bytes", () => {
    const base = release(stageRelease("one"));
    const changed = release(stageRelease("two", { extra: (stage) => put(stage, "server/index.ts", "export const x = 1;") }));
    expect(changed.pin.archive.sha256).not.toBe(base.pin.archive.sha256);
    const later = join(temp, "later.tgz");
    packDeterministic(join(temp, "one"), later, epoch + 1);
    expect(sha256(readFileSync(later))).not.toBe(base.pin.archive.sha256);
    expect(() => packDeterministic(join(temp, "one"), later, -1)).toThrow();
  });
});

describe("verifyRelease", () => {
  test("a whole release verifies", () => {
    const { archive, pin } = release(stageRelease("good"));
    expect(verifyRelease(archive, pin)).toEqual([]);
  });

  test("an archive that is not the pinned bytes is refused before anything is read from it", () => {
    const { archive, pin } = release(stageRelease("good"));
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from("x")]));
    expect(verifyRelease(archive, pin)).toEqual(["the archive is not the pinned bytes (size or sha256 differs)"]);
  });

  test("a pin that is refused is reported, not trusted", () => {
    const { archive, pin } = release(stageRelease("good"));
    expect(verifyRelease(archive, { ...pin, version: "x" })[0]).toContain("the pin is refused");
  });

  test("it finds what a factory host or the hub could not use", () => {
    const cases: [string, (stage: string) => void, string][] = [
      ["no owner server entry", (stage) => rmSync(join(stage, "server/index.ts")), "server/index.ts is missing"],
      ["no client", (stage) => rmSync(join(stage, "dist/index.html")), "dist/index.html is missing"],
      ["bun not executable", (stage) => chmodSync(join(stage, "bin/bun"), 0o644), "bin/bun is not executable"],
      ["no herdr", (stage) => rmSync(join(stage, "bin/herdr")), "bin/herdr is missing"],
      ["wrong bundle version", (stage) => put(stage, "bundle.json", JSON.stringify({ version: "42", platform: "linux-x64" })), "bundle.json is not version 43"],
      ["wrong platform", (stage) => put(stage, "bundle.json", JSON.stringify({ version: "43", platform: "darwin-arm64" })), "bundle.json is not version 43"],
      ["release info for another commit", (stage) => put(stage, RELEASE_INFO_FILE, JSON.stringify({ schema: RELEASE_INFO_SCHEMA, commit: other })), "does not name the pinned commit"],
      ["build cache left in", (stage) => put(stage, "node_modules/.cache/vite/x.json", "{}"), "node_modules/.cache/vite/x.json is build cache"],
      ["a link out of the release", (stage) => symlinkSync("../../../etc/passwd", join(stage, "node_modules/pkg/escape")), "node_modules/pkg/escape is a link that leaves the release"],
      ["an absolute link", (stage) => symlinkSync("/etc/passwd", join(stage, "node_modules/pkg/abs")), "node_modules/pkg/abs is a link that leaves the release"],
      ["a hub file changed after the manifest", (stage) => put(stage, "hub-ui/assets/app.js", "tampered"), "hub-ui: assets/app.js differs from the manifest"],
      ["a hub file the manifest does not list", (stage) => put(stage, "hub-ui/assets/extra.js", "x"), "hub-ui: assets/extra.js is not in the manifest"],
      ["a source map in the hub UI", (stage) => put(stage, "hub-ui/assets/app.js.map", "{}"), "hub-ui:"],
      ["no hub UI", (stage) => rmSync(join(stage, "hub-ui"), { recursive: true }), "hub-ui/ is missing"],
    ];
    for (const [name, damage, expected] of cases) {
      const stage = stageRelease(`case-${name.replace(/\W+/g, "-")}`);
      damage(stage);
      const { archive, pin } = release(stage);
      const problems = verifyRelease(archive, pin).join("\n");
      expect(problems, name).toContain(expected);
    }
  }, 60_000);

  test("a hub UI built from another commit than the pin is refused", () => {
    const stage = stageRelease("stale", { revision: other });
    put(stage, RELEASE_INFO_FILE, JSON.stringify({ schema: RELEASE_INFO_SCHEMA, commit }));
    const { archive, pin } = release(stage);
    const problems = verifyRelease(archive, pin).join("\n");
    expect(problems).toContain("hub-ui was not built from the pinned commit");
    expect(problems).toContain("hub-ui/build.json does not name the pinned commit");
  });

  test("a pinned manifest digest that differs is refused", () => {
    const { archive, pin } = release(stageRelease("good"));
    expect(verifyRelease(archive, { ...pin, hubUi: { ...pin.hubUi, manifestSha256: "0".repeat(64) } }).join("\n")).toContain("is not the pinned manifest");
    expect(verifyRelease(archive, { ...pin, hubUi: { ...pin.hubUi, files: 9 } }).join("\n")).toContain("another number of files");
  });
});
