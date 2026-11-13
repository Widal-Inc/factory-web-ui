import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BUILD_FILE, HUB_MANIFEST_FILE, buildManifest } from "./hub-artifact.ts";
import { HUB_UI_DIR, OWNER_SERVER, RELEASE_INFO_FILE, RELEASE_INFO_SCHEMA, archiveName, buildPin, bunProblem, checkoutProblem, packDeterministic, pinProblem, releaseEnv, releaseVersion, verifyRelease, type ReleasePin } from "./release-bundle.ts";
import { NAME as PTY_HOST } from "./pty-sidecar.ts";

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

function release(stage: string, options: { ptyHostSha256?: string | null } = {}): { archive: string; pin: ReleasePin } {
  const ptyHostSha256 = options.ptyHostSha256 ?? null;
  const archive = join(temp, `${stage.split("/").pop()}.tgz`);
  packDeterministic(stage, archive, epoch);
  // a case that removed the hub UI still gets a pin (of an empty manifest), so the verifier is what refuses it
  const manifestPath = join(stage, HUB_UI_DIR, HUB_MANIFEST_FILE);
  const manifest = existsSync(manifestPath) ? new Uint8Array(readFileSync(manifestPath)) : new Uint8Array([123, 125]);
  const pin = buildPin({
    version: "43", repository: "Example-Org/example-ui", commit, builtAt: new Date(epoch * 1000),
    archive: { file: archiveName("43", commit), bytes: new Uint8Array(readFileSync(archive)) },
    hubUi: { manifest, files: 3 }, bun: "1.4.2", rustPtyHost: ptyHostSha256 !== null, ptyHostSha256,
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
      [{ ...pin, schema: "widal.web-release/1" }, "widal.web-release/2"],
      [{ ...pin, version: "v43" }, "version"],
      [{ ...pin, platform: "darwin-arm64" }, "platform"],
      [{ ...pin, source: { ...pin.source, commit: "abc" } }, "source"],
      [{ ...pin, archive: { ...pin.archive, sha256: "zz" } }, "archive"],
      [{ ...pin, archive: { ...pin.archive, file: "other.tgz" } }, "archive"],
      [{ ...pin, hubUi: { ...pin.hubUi, revision: other } }, "hubUi"],
      [{ ...pin, ownerServer: { ...pin.ownerServer, entry: "x.ts" } }, "ownerServer"],
      [{ ...pin, ownerServer: { ...pin.ownerServer, ptyHostSha256: "zz" } }, "ptyHostSha256"],
      [{ ...pin, ownerServer: { ...pin.ownerServer, ptyHostSha256: "c".repeat(64) } }, "ptyHostSha256"],
      [{ ...pin, ownerServer: { ...pin.ownerServer, rustPtyHost: true } }, "ptyHostSha256"],
      [null, "object"],
    ] as const) expect(pinProblem(bad), text).toContain(text);
    expect(() => archiveName("43", "abc")).toThrow();
    expect(() => archiveName("v43", commit)).toThrow();
  });

  test("a release with a Rust PTY host records its sha256, and only then", () => {
    const digest = "c".repeat(64);
    const withHost = release(stageRelease("a"), { ptyHostSha256: digest });
    expect(withHost.pin.ownerServer).toMatchObject({ rustPtyHost: true, ptyHostSha256: digest });
    expect(pinProblem(withHost.pin)).toBeUndefined();
    expect(release(stageRelease("b")).pin.ownerServer).toMatchObject({ rustPtyHost: false, ptyHostSha256: null });
    const input = { version: "43", repository: "Example-Org/example-ui", commit, builtAt: new Date(epoch * 1000), archive: { file: archiveName("43", commit), bytes: new Uint8Array([1]) }, hubUi: { manifest: new Uint8Array([1]), files: 1 }, bun: "1.4.2" };
    expect(() => buildPin({ ...input, rustPtyHost: true, ptyHostSha256: null })).toThrow("Rust PTY host");
    expect(() => buildPin({ ...input, rustPtyHost: false, ptyHostSha256: digest })).toThrow("Rust PTY host");
    expect(() => buildPin({ ...input, rustPtyHost: true, ptyHostSha256: "zz" })).toThrow("Rust PTY host");
  });
});

describe("what the build runs with", () => {
  const parent = { PATH: "/usr/bin:/bin", HOME: "/home/example", TMPDIR: "/tmp/x", HTTPS_PROXY: "http://proxy.example.test:3128", NODE_ENV: "development", HERDR_TEST_HOOKS: "1", VITE_EXAMPLE: "1", OVIS_BUILD_CACHE_DIR: "/cache", HERDR_BUNDLE_PTY_SIDECAR: "/elsewhere/host", HERDR_BUNDLE_OUTPUT: "/elsewhere", WIDAL_AUTH_MODE: "example", GIT_DIR: "/elsewhere/.git", BUN_CONFIG_REGISTRY: "http://registry.example.test" };

  test("an allowlisted environment: nothing of the builder's own steers the build", () => {
    const env = releaseEnv(parent, epoch, { toolsDir: "/work/tools" });
    expect(env).toEqual({ PATH: "/work/tools:/usr/bin:/bin", HOME: "/home/example", TMPDIR: "/tmp/x", HTTPS_PROXY: "http://proxy.example.test:3128", SOURCE_DATE_EPOCH: String(epoch), OVIS_TELEMETRY: "0" });
  });

  test("the PTY host is passed on only when the release names one", () => {
    expect(releaseEnv(parent, epoch, { toolsDir: "/work/tools", ptyHost: "/builder/host" })["HERDR_BUNDLE_PTY_SIDECAR"]).toBe("/builder/host");
    expect(releaseEnv(parent, epoch, { toolsDir: "/work/tools" })).not.toHaveProperty("HERDR_BUNDLE_PTY_SIDECAR");
  });

  test("a Bun that is not the pinned one is refused, whether bundle.json or the binary says so", () => {
    expect(bunProblem("1.4.2", "1.4.2", "1.4.2")).toBeNull();
    expect(bunProblem("1.4.2", "1.4.4", "1.4.2")).toContain("records Bun 1.4.4");
    expect(bunProblem("1.4.2", "1.4.2", "1.4.4")).toContain("bin/bun in the bundle is Bun 1.4.4");
    expect(bunProblem("1.4.2", undefined, "1.4.2")).toContain("records Bun undefined");
  });
});

describe("deterministic archive", () => {
  test("the same files make the same bytes, whatever their times, modes order or owner", () => {
    const first = stageRelease("one", { extra: (stage) => chmodSync(stage, 0o700) });
    const second = stageRelease("two", { extra: (stage) => {
      chmodSync(stage, 0o775);
      for (const file of ["server/index.ts", "dist/index.html", "node_modules/pkg/index.js"]) utimesSync(join(stage, file), 1_000_000, 1_000_000);
      chmodSync(join(stage, "server/index.ts"), 0o664);
      chmodSync(join(stage, "bin/bun"), 0o775);
    } });
    const a = release(first);
    const b = release(second);
    expect(sha256(readFileSync(a.archive))).toBe(sha256(readFileSync(b.archive)));
    expect(a.pin.archive.sha256).toBe(b.pin.archive.sha256);
  });

  test("the archive's own ./ entry is 755 whatever the builder's umask made the stage", () => {
    const stage = stageRelease("one", { extra: (dir) => chmodSync(dir, 0o775) });
    const archive = join(temp, "one.tgz");
    packDeterministic(stage, archive, epoch);
    const listing = Bun.spawnSync(["tar", "-tvzf", archive], { stderr: "pipe" }).stdout.toString().split("\n");
    expect(listing[0]).toMatch(/^drwxr-xr-x .* \.\/$/);
  });

  test("the builder's TAR_OPTIONS and locale neither change the archive nor drop files from it", () => {
    const stage = stageRelease("one");
    const plain = join(temp, "plain.tgz");
    packDeterministic(stage, plain, epoch);
    const before = { options: process.env["TAR_OPTIONS"], locale: process.env["LC_ALL"] };
    process.env["TAR_OPTIONS"] = "--exclude=*.ts";
    process.env["LC_ALL"] = "de_DE.UTF-8";
    try {
      const polluted = join(temp, "polluted.tgz");
      packDeterministic(stage, polluted, epoch);
      expect(sha256(readFileSync(polluted))).toBe(sha256(readFileSync(plain)));
      const names = Bun.spawnSync(["tar", "-tzf", polluted], { env: { PATH: process.env["PATH"] ?? "" }, stderr: "pipe" }).stdout.toString();
      expect(names).toContain("server/index.ts");
    } finally {
      for (const [name, value] of [["TAR_OPTIONS", before.options], ["LC_ALL", before.locale]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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

describe("checkoutProblem", () => {
  function checkout(): string {
    const root = join(temp, "checkout");
    put(root, ".gitignore", "dist/\n.env*\nnode_modules\n");
    put(root, "server/index.ts", "export {};\n");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "user.name=Example", "-c", "user.email=example@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    return root;
  }

  test("a clean checkout builds: its node_modules and build output are not inputs", () => {
    const root = checkout();
    put(root, "node_modules/pkg/index.js", "");
    put(root, "dist/index.html", "");
    expect(checkoutProblem(root)).toBeNull();
  });

  test("no exception for generated declarations: an ignored file under shared is refused like any other", () => {
    const root = checkout();
    put(root, "shared/vendor/example/dist/index.d.ts", "");
    expect(checkoutProblem(root)).toContain("shared/vendor/example/dist/index.d.ts");
  });

  test("the root's .env files and the hub app's ignored files reach the build, so they are refused", () => {
    for (const path of [".env", ".env.local", ".env.production.local", "hub-app/dist/leftover.js"]) {
      const root = checkout();
      put(root, path, "VITE_EXAMPLE=1\n");
      expect(checkoutProblem(root), path).toContain(path);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nothing outside the commit reaches a release: no change, no untracked file, no ignored file where the build reads", () => {
    const changed = checkout();
    put(changed, "server/index.ts", "export const changed = true;\n");
    expect(checkoutProblem(changed)).toContain("server/index.ts");
    rmSync(changed, { recursive: true, force: true });

    const untracked = checkout();
    put(untracked, "server/extra.ts", "");
    expect(checkoutProblem(untracked)).toContain("server/extra.ts");
    rmSync(untracked, { recursive: true, force: true });

    const ignored = checkout();
    put(ignored, "server/.env", "SECRET=example\n");
    expect(checkoutProblem(ignored)).toContain("server/.env");
  });
});

describe("releaseVersion", () => {
  const git = (cwd: string, ...args: string[]): string => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Example", "-c", "user.email=example@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commitFile = (root: string, name: string): string => {
    put(root, name, `${name}\n`);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", name);
    return git(root, "rev-parse", "HEAD");
  };

  test("two releases from main never share a number, and a later one is higher, merges included", () => {
    const root = join(temp, "history");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    const releases: { commit: string; version: string }[] = [];
    const release = (commit: string) => releases.push({ commit, version: releaseVersion(root) });
    release(commitFile(root, "one.txt"));
    release(commitFile(root, "two.txt"));
    git(root, "checkout", "-q", "-b", "polecat/example");
    commitFile(root, "branch-a.txt");
    commitFile(root, "branch-b.txt");
    git(root, "checkout", "-q", "main");
    release(commitFile(root, "three.txt"));
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "polecat/example");
    release(git(root, "rev-parse", "HEAD"));
    release(commitFile(root, "four.txt"));
    expect(new Set(releases.map((r) => r.commit)).size).toBe(releases.length);
    expect(new Set(releases.map((r) => r.version)).size).toBe(releases.length);
    const numbers = releases.map((r) => Number(r.version));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    // the number is the commit's own, whatever the builder does afterwards in its checkout
    git(root, "checkout", "-q", "--detach", releases[1]!.commit);
    expect(releaseVersion(root)).toBe(releases[1]!.version);
    // and so is the archive's name
    expect(archiveName(releases[0]!.version, releases[0]!.commit)).not.toBe(archiveName(releases[1]!.version, releases[1]!.commit));
  });

  test("a shallow clone, which holds part of the history, is refused instead of numbered", () => {
    const root = join(temp, "origin");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main");
    commitFile(root, "one.txt");
    commitFile(root, "two.txt");
    commitFile(root, "three.txt");
    const shallow = join(temp, "shallow");
    git(temp, "clone", "-q", "--depth", "1", `file://${root}`, shallow);
    expect(() => releaseVersion(shallow)).toThrow("shallow");
    expect(releaseVersion(root)).toBe("3");
    const whole = join(temp, "whole");
    git(temp, "clone", "-q", `file://${root}`, whole);
    expect(releaseVersion(whole)).toBe("3");
  });

  test("a number is a plain count: no zero, no sign, no letters", () => {
    expect(archiveName("2524", commit)).toBe(`widal-web-2524-${"a".repeat(12)}-linux-x64.tgz`);
    for (const bad of ["0", "043", "-1", "1.5", "v1", ""]) expect(() => archiveName(bad, commit), bad).toThrow();
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
      ["build cache left in", (stage) => put(stage, "node_modules/.cache/vite/x.json", "{}"), "node_modules/.cache is build cache or tooling"],
      ["vite's other caches left in", (stage) => put(stage, "node_modules/.vite/deps/x.json", "{}"), "node_modules/.vite is build cache or tooling"],
      ["an empty vite temp folder left in", (stage) => mkdirSync(join(stage, "node_modules/.vite-temp"), { recursive: true }), "node_modules/.vite-temp is build cache or tooling"],
      ["the package manager's links left in", (stage) => put(stage, "node_modules/.bin/vite", "x"), "node_modules/.bin is build cache or tooling"],
      ["a link out of the release", (stage) => symlinkSync("../../../etc/passwd", join(stage, "node_modules/pkg/escape")), "node_modules/pkg/escape is a link that leaves the release"],
      ["an absolute link", (stage) => symlinkSync("/etc/passwd", join(stage, "node_modules/pkg/abs")), "node_modules/pkg/abs is a link that leaves the release"],
      ["a chain of links that ends outside", (stage) => {
        // each link alone stays inside by its text: q is dist, and q/../.. is above the release
        symlinkSync("../dist", join(stage, "node_modules/q"));
        symlinkSync("q/../../outside", join(stage, "node_modules/p"));
      }, "node_modules/p is a link that leaves the release"],
      ["a link to nothing", (stage) => symlinkSync("missing", join(stage, "node_modules/pkg/dangling")), "node_modules/pkg/dangling is a link that leaves the release"],
      ["a Rust PTY host the pin does not name", (stage) => put(stage, `bin/${PTY_HOST}`, "host", 0o755), `bin/${PTY_HOST} is in the archive, but the pin says there is no Rust PTY host`],
      ["bundle.json for another Bun", (stage) => put(stage, "bundle.json", JSON.stringify({ version: "43", platform: "linux-x64", bun: "1.4.4" })), "bundle.json names Bun 1.4.4, not the pinned 1.4.2"],
      ["a hub file changed after the manifest", (stage) => put(stage, "hub-ui/assets/app.js", "tampered"), "hub-ui: assets/app.js differs from the manifest"],
      ["a hub file the manifest does not list", (stage) => put(stage, "hub-ui/assets/extra.js", "x"), "hub-ui: assets/extra.js is not in the manifest"],
      ["a source map in the hub UI", (stage) => put(stage, "hub-ui/assets/app.js.map", "{}"), "hub-ui:"],
      ["no hub UI", (stage) => rmSync(join(stage, "hub-ui"), { recursive: true }), "hub-ui/ is missing"],
      ["a hub build record that is not JSON", (stage) => put(stage, `hub-ui/${BUILD_FILE}`, "not json"), "hub-ui/build.json does not name the pinned commit"],
    ];
    for (const [name, damage, expected] of cases) {
      const stage = stageRelease(`case-${name.replace(/\W+/g, "-")}`);
      damage(stage);
      const { archive, pin } = release(stage);
      const problems = verifyRelease(archive, pin).join("\n");
      expect(problems, name).toContain(expected);
    }
  }, 60_000);

  test("a pinned Rust PTY host is the one the archive holds", () => {
    const withHost = (name: string, content: string | null) => stageRelease(name, { extra: (stage) => { if (content !== null) put(stage, `bin/${PTY_HOST}`, content, 0o755); } });
    const digest = sha256(new TextEncoder().encode("host"));
    const good = release(withHost("host-good", "host"), { ptyHostSha256: digest });
    expect(verifyRelease(good.archive, good.pin)).toEqual([]);
    const swapped = release(withHost("host-swapped", "other"), { ptyHostSha256: digest });
    expect(verifyRelease(swapped.archive, swapped.pin).join("\n")).toContain(`bin/${PTY_HOST} is not the pinned PTY host`);
    const missing = release(withHost("host-missing", null), { ptyHostSha256: digest });
    expect(verifyRelease(missing.archive, missing.pin).join("\n")).toContain(`bin/${PTY_HOST} is missing`);
  });

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
