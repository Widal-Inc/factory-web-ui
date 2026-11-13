/**
 * The Widal web release: ONE archive the factory install ships, and the pin that names it.
 *
 * The archive is the fork's Linux x64 remote bundle (the format `widal install --factory-release`
 * already installs at `/opt/widal`: `bundle.json`, `bin/bun`, `bin/node`, `bin/herdr`, `server/index.ts`,
 * `dist/`, `node_modules/`, ...) plus `hub-ui/`, the hub UI artifact (`bun run build:hub`, with its
 * `widal-ui.json`) the factory hub serves with `--ui-dir`. Nothing is fetched or built on the customer's
 * account: every factory host runs the owner server from this archive, and the hub serves `hub-ui/`.
 *
 * `bun run build:release` builds it from a clean checkout and writes, in `release-bundles/`:
 *   - `widal-web-<version>-<commit12>-linux-x64.tgz`  the archive, byte-for-byte reproducible
 *   - `widal-web-release.json`                         the pin: commit, archive sha256, hub UI manifest digest
 * `bun scripts/release-bundle.ts verify ARCHIVE PIN` is the check an installer (or a person) runs before it
 * trusts a release; the factory install passes the pin's archive sha256 as its trusted digest.
 * This script builds and checks. It publishes nothing and pushes no tag.
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BRAND } from "../shared/brand.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { BUILD_FILE, HUB_MANIFEST_FILE, brandAssetPaths, sourceRepository, verifyManifest, type ArtifactFile } from "./hub-artifact.ts";
import { NAME as PTY_HOST } from "./pty-sidecar.ts";

export const RELEASE_PIN_SCHEMA = "widal.web-release/2";
/**
 * Every `tar` runs with this environment and nothing else: the builder's own (`TAR_OPTIONS`, `TAR_*` and the
 * locale) can change the archive's bytes or drop files from it.
 */
const TAR_ENV: Record<string, string> = { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" };
export const RELEASE_PIN_FILE = "widal-web-release.json";
export const RELEASE_INFO_FILE = "widal-release.json";
export const RELEASE_INFO_SCHEMA = "widal.web-release-info/1";
export const RELEASE_PLATFORM = "linux-x64";
/** Where the hub UI artifact sits in the archive: the directory the hub is started with (`--ui-dir`). */
export const HUB_UI_DIR = "hub-ui";
/** The owner server's entry and runtime, as the factory host's service runs them from `/opt/widal`. */
export const OWNER_SERVER = { entry: "server/index.ts", runtime: "bin/bun", healthPath: "/api/health" } as const;
/** What a factory host needs on disk before it can start the owner server; the factory install checks the same names. */
const REQUIRED_FILES = ["bundle.json", "package.json", OWNER_SERVER.entry, "dist/index.html"] as const;
const REQUIRED_PROGRAMS = ["bin/bun", "bin/node", "bin/herdr"] as const;

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ReleasePin {
  schema: typeof RELEASE_PIN_SCHEMA;
  /**
   * The release number the factory install passes as `--factory-release-version`; `bundle.json` carries the same.
   * It is the number of commits in the history of the released commit (`releaseVersion`), so every release has its own.
   */
  version: string;
  platform: typeof RELEASE_PLATFORM;
  source: { repository: string; commit: string; builtAt: string };
  archive: { file: string; bytes: number; sha256: string };
  hubUi: { path: typeof HUB_UI_DIR; manifest: string; revision: string; manifestSha256: string; files: number };
  /** `ptyHostSha256` is the digest of `bin/ovis-pty-sidecar`, the Rust PTY host, and is null exactly when `rustPtyHost` is false. */
  ownerServer: typeof OWNER_SERVER & { bun: string; rustPtyHost: boolean; ptyHostSha256: string | null };
}

export function archiveName(version: string, commit: string): string {
  if (!/^[1-9][0-9]*$/.test(version) || !COMMIT.test(commit)) throw new Error("A release archive is named by its numeric bundle version and its full commit id.");
  return `widal-web-${version}-${commit.slice(0, 12)}-${RELEASE_PLATFORM}.tgz`;
}

export function buildPin(input: { version: string; repository: string; commit: string; builtAt: Date; archive: { file: string; bytes: Uint8Array }; hubUi: { manifest: Uint8Array; files: number }; bun: string; rustPtyHost: boolean; ptyHostSha256: string | null }): ReleasePin {
  if (!COMMIT.test(input.commit)) throw new Error("The pin needs the full commit id.");
  if (input.rustPtyHost !== (input.ptyHostSha256 !== null) || (input.ptyHostSha256 !== null && !DIGEST.test(input.ptyHostSha256))) throw new Error("The pin records the sha256 of the Rust PTY host when, and only when, the release has one.");
  if (Number.isNaN(input.builtAt.getTime())) throw new Error("The build time is not a date.");
  return {
    schema: RELEASE_PIN_SCHEMA,
    version: input.version,
    platform: RELEASE_PLATFORM,
    source: { repository: input.repository, commit: input.commit, builtAt: input.builtAt.toISOString() },
    archive: { file: input.archive.file, bytes: input.archive.bytes.byteLength, sha256: sha256(input.archive.bytes) },
    hubUi: { path: HUB_UI_DIR, manifest: `${HUB_UI_DIR}/${HUB_MANIFEST_FILE}`, revision: input.commit, manifestSha256: sha256(input.hubUi.manifest), files: input.hubUi.files },
    ownerServer: { ...OWNER_SERVER, bun: input.bun, rustPtyHost: input.rustPtyHost, ptyHostSha256: input.ptyHostSha256 },
  };
}

/** Why a pin is not one this module wrote, in words; undefined when it is. */
export function pinProblem(value: unknown): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(value)) return "it is not a JSON object";
  if (value.schema !== RELEASE_PIN_SCHEMA) return `its schema is not ${RELEASE_PIN_SCHEMA}`;
  if (typeof value.version !== "string" || !/^[1-9][0-9]*$/.test(value.version)) return "its version is not a release number";
  if (value.platform !== RELEASE_PLATFORM) return `its platform is not ${RELEASE_PLATFORM}`;
  const source = value.source;
  if (!isObject(source) || typeof source.repository !== "string" || source.repository === "" || typeof source.commit !== "string" || !COMMIT.test(source.commit) || typeof source.builtAt !== "string" || Number.isNaN(Date.parse(source.builtAt))) return "its source is not {repository, commit, builtAt}";
  const archive = value.archive;
  if (!isObject(archive) || typeof archive.file !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/.test(archive.file) || !Number.isInteger(archive.bytes) || (archive.bytes as number) <= 0 || typeof archive.sha256 !== "string" || !DIGEST.test(archive.sha256)) return "its archive is not {file, bytes, sha256}";
  if (archive.file !== archiveName(value.version, source.commit)) return "its archive name does not follow from its version and commit";
  const hubUi = value.hubUi;
  if (!isObject(hubUi) || hubUi.path !== HUB_UI_DIR || hubUi.manifest !== `${HUB_UI_DIR}/${HUB_MANIFEST_FILE}` || hubUi.revision !== source.commit || typeof hubUi.manifestSha256 !== "string" || !DIGEST.test(hubUi.manifestSha256) || !Number.isInteger(hubUi.files) || (hubUi.files as number) <= 0) return "its hubUi is not {path, manifest, revision (the source commit), manifestSha256, files}";
  const owner = value.ownerServer;
  if (!isObject(owner) || owner.entry !== OWNER_SERVER.entry || owner.runtime !== OWNER_SERVER.runtime || owner.healthPath !== OWNER_SERVER.healthPath || typeof owner.bun !== "string" || typeof owner.rustPtyHost !== "boolean") return "its ownerServer is not {entry, runtime, healthPath, bun, rustPtyHost, ptyHostSha256}";
  if (owner.ptyHostSha256 !== null && (typeof owner.ptyHostSha256 !== "string" || !DIGEST.test(owner.ptyHostSha256))) return "its ownerServer.ptyHostSha256 is neither null nor a sha256";
  if (owner.rustPtyHost !== (owner.ptyHostSha256 !== null)) return "its ownerServer.ptyHostSha256 is set when there is no Rust PTY host, or missing when there is one";
  return undefined;
}

// ---- deterministic archive -------------------------------------------------------------------------------

/** Plain modes, so the archive does not depend on the builder's umask: directories (the root, the archive's `./` entry, included) 755, programs 755, other files 644. */
export function normalizeModes(root: string, dir = root): void {
  if (dir === root) chmodSync(root, 0o755);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      chmodSync(path, 0o755);
      normalizeModes(root, path);
    } else chmodSync(path, info.mode & 0o111 ? 0o755 : 0o644);
  }
}

/**
 * `tar` of the stage with sorted names, one fixed time, no owner and no gzip name or time: the same files
 * always make the same bytes. Needs GNU tar (the release builder is Linux x64 and has it).
 */
export function packDeterministic(stage: string, archive: string, epoch: number): void {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error("The archive time is a whole number of seconds.");
  const version = Bun.spawnSync(["tar", "--version"], { env: TAR_ENV });
  if (!version.stdout.toString().includes("GNU tar")) throw new Error("A reproducible archive needs GNU tar.");
  normalizeModes(stage);
  const result = Bun.spawnSync(["tar", "--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "--use-compress-program=gzip -n -9", "-cf", archive, "-C", stage, "."], { env: TAR_ENV, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
}

// ---- verification ----------------------------------------------------------------------------------------

function listTree(root: string, dir = root): { path: string; link: string | null }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const info = lstatSync(path);
    const rel = relative(root, path).split(sep).join("/");
    if (info.isSymbolicLink()) return [{ path: rel, link: readlinkSync(path) }];
    if (info.isDirectory()) return listTree(root, path);
    return [{ path: rel, link: null }];
  });
}

/**
 * Whether the link at `path` (in the unpacked release at `stage`, whose resolved folder is `inside`) leaves the
 * release. Judged three ways, because the text of a link is not where it points once links chain
 * (`node_modules/q -> ../dist`, `node_modules/p -> q/../../outside`): the target is not absolute, no `..` follows a
 * name (only leading `..` steps keep the text and the real place the same), and the place the link really resolves to
 * exists and is inside. A link to nothing is refused too: it cannot be shown to stay inside.
 */
export function linkProblem(inside: string, stage: string, path: string, link: string): boolean {
  if (link.startsWith("/") || !resolve(stage, dirname(path), link).startsWith(stage + sep)) return true;
  const parts = link.split("/");
  if (parts.some((part, index) => part === ".." && parts.slice(0, index).some((before) => before !== ".." && before !== "." && before !== ""))) return true;
  try {
    const real = realpathSync(join(stage, path));
    return !real.startsWith(inside + sep);
  } catch {
    return true;
  }
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/**
 * Everything an installer should know before it trusts a release, as a list of problems (empty when whole):
 * the archive is the pinned bytes, holds nothing that leaves its folder, has what a factory host and the hub
 * need, and its hub UI is the very release its own manifest lists, built from the pinned commit.
 */
export function verifyRelease(archive: string, pin: unknown): string[] {
  const shape = pinProblem(pin);
  if (shape) return [`the pin is refused: ${shape}`];
  const release = pin as ReleasePin;
  const bytes = readFileSync(archive);
  if (bytes.byteLength !== release.archive.bytes || sha256(bytes) !== release.archive.sha256) return ["the archive is not the pinned bytes (size or sha256 differs)"];

  const names = Bun.spawnSync(["tar", "-tzf", archive], { env: TAR_ENV, stderr: "pipe" });
  if (names.exitCode !== 0) return [`the archive cannot be read: ${names.stderr.toString().trim()}`];
  const problems: string[] = [];
  for (const entry of names.stdout.toString().split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) problems.push(`the archive entry ${JSON.stringify(entry)} leaves its folder`);
  }
  if (problems.length > 0) return problems;

  const stage = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "widal-release-verify-"));
  try {
    const unpacked = Bun.spawnSync(["tar", "-xzf", archive, "-C", stage, "--no-same-owner"], { env: TAR_ENV, stderr: "pipe" });
    if (unpacked.exitCode !== 0) return [`the archive cannot be unpacked: ${unpacked.stderr.toString().trim()}`];
    const tree = listTree(stage);
    const inside = realpathSync(stage);
    for (const entry of tree) {
      if (entry.link === null) continue;
      if (linkProblem(inside, stage, entry.path, entry.link)) problems.push(`${entry.path} is a link that leaves the release`);
    }
    // the builder's package manager and tools leave dot-entries (.bin, .cache, .vite, .vite-temp): none is run at runtime
    const modules = join(stage, "node_modules");
    if (existsSync(modules)) {
      for (const name of readdirSync(modules)) if (name.startsWith(".")) problems.push(`node_modules/${name} is build cache or tooling, not part of a release`);
    }
    for (const file of REQUIRED_FILES) if (!existsSync(join(stage, file))) problems.push(`${file} is missing`);
    for (const program of [...REQUIRED_PROGRAMS]) {
      const path = join(stage, program);
      if (!existsSync(path)) problems.push(`${program} is missing`);
      else if ((statSync(path).mode & 0o111) === 0) problems.push(`${program} is not executable`);
    }
    const bundle = readJson(join(stage, "bundle.json")) as { version?: unknown; platform?: unknown; bun?: unknown; pty_sidecar?: unknown } | undefined;
    if (!bundle || bundle.version !== release.version || bundle.platform !== release.platform) problems.push(`bundle.json is not version ${release.version} for ${release.platform}`);
    else if (bundle.bun !== release.ownerServer.bun) problems.push(`bundle.json names Bun ${String(bundle.bun)}, not the pinned ${release.ownerServer.bun}`);
    const host = join(stage, "bin", PTY_HOST);
    if (release.ownerServer.rustPtyHost) {
      if (!existsSync(host)) problems.push(`bin/${PTY_HOST} is missing, and the pin says this release has the Rust PTY host`);
      else if (sha256(readFileSync(host)) !== release.ownerServer.ptyHostSha256) problems.push(`bin/${PTY_HOST} is not the pinned PTY host (sha256 differs)`);
    } else if (existsSync(host)) problems.push(`bin/${PTY_HOST} is in the archive, but the pin says there is no Rust PTY host`);

    const info = readJson(join(stage, RELEASE_INFO_FILE)) as { schema?: unknown; commit?: unknown } | undefined;
    if (!info || info.schema !== RELEASE_INFO_SCHEMA || info.commit !== release.source.commit) problems.push(`${RELEASE_INFO_FILE} does not name the pinned commit`);

    const hubRoot = join(stage, HUB_UI_DIR);
    if (!existsSync(hubRoot)) problems.push(`${HUB_UI_DIR}/ is missing`);
    else {
      const files: ArtifactFile[] = listTree(hubRoot).map((entry) => ({ path: entry.path, bytes: new Uint8Array(readFileSync(join(hubRoot, entry.path))) }));
      const manifestBytes = files.find((file) => file.path === HUB_MANIFEST_FILE)?.bytes;
      if (!manifestBytes) problems.push(`${HUB_UI_DIR}/${HUB_MANIFEST_FILE} is missing`);
      else {
        let manifest: unknown;
        try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { manifest = undefined; }
        problems.push(...verifyManifest(manifest, files, brandAssetPaths(BRAND)).map((problem) => `${HUB_UI_DIR}: ${problem}`));
        if ((manifest as { revision?: unknown } | undefined)?.revision !== release.source.commit) problems.push(`${HUB_UI_DIR} was not built from the pinned commit`);
        if (sha256(manifestBytes) !== release.hubUi.manifestSha256) problems.push(`${HUB_UI_DIR}/${HUB_MANIFEST_FILE} is not the pinned manifest`);
        if ((manifest as { files?: unknown[] } | undefined)?.files?.length !== release.hubUi.files) problems.push(`${HUB_UI_DIR} lists another number of files than the pin`);
      }
      const build = files.find((file) => file.path === BUILD_FILE);
      let buildInfo: unknown;
      try { buildInfo = build ? JSON.parse(new TextDecoder().decode(build.bytes)) : undefined; } catch { buildInfo = undefined; }
      if ((buildInfo as { revision?: unknown } | undefined)?.revision !== release.source.commit) problems.push(`${HUB_UI_DIR}/${BUILD_FILE} does not name the pinned commit`);
    }
    return problems;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// ---- build -----------------------------------------------------------------------------------------------

/**
 * The number of this release: how many commits the history of HEAD holds. A commit has more ancestors than any of
 * its own ancestors, and main's commits form one chain (each merge descends from the one before), so two releases
 * built from main never share a number and a later one is always higher. The count is of the whole history, so a
 * shallow clone, which holds only part of it, is refused rather than given a number that is not this commit's.
 */
export function releaseVersion(root: string): string {
  const gitIn = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  };
  if (gitIn("rev-parse", "--is-shallow-repository") !== "false") throw new Error("A release is numbered by the commits in its history, and this checkout is shallow: fetch the whole history first (git fetch --unshallow).");
  const count = gitIn("rev-list", "--count", "HEAD");
  if (!/^[1-9][0-9]*$/.test(count)) throw new Error(`The commit count ${JSON.stringify(count)} is not a release number.`);
  return count;
}

/** What the build copies or bundles from the checkout: the remote bundle copies these folders whole, and Vite copies public/. */
const BUILD_READS = ["server", "shared", "integrations", "public", "src", "scripts", "hub-app", "index.html", "vite.config.ts", "vite.hub.config.ts"] as const;
/** Vite reads `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local` from the root, so the root's are inputs too. */
const ROOT_ENV_FILES = ".env*";

/**
 * Why `root` cannot be built into a release, or null. The pin names a commit, so nothing outside it may reach the
 * archive: no change, no untracked file, and no ignored file (an `.env`, say) where the build reads, the root's
 * `.env*` files included.
 */
export function checkoutProblem(root: string): string | null {
  const gitIn = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString();
  };
  const changed = gitIn("status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean);
  if (changed.length > 0) return `A release is built from a clean checkout: the pin names a commit, and these are not in it:\n  ${changed.join("\n  ")}`;
  const ignored = gitIn("ls-files", "--others", "--ignored", "--exclude-standard", "--", ...BUILD_READS, ROOT_ENV_FILES).split("\n").filter(Boolean);
  if (ignored.length > 0) return `A release takes nothing git ignores from where the build reads; remove these first:\n  ${ignored.join("\n  ")}`;
  return null;
}

/** Variables a build child may inherit: where to find tools, the account's package cache and proxy and certificate settings. */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR"] as const;

/**
 * The environment every build step runs with: an allowlist, not the builder's own. HERDR_TEST_HOOKS, NODE_ENV and VITE_*
 * change what Vite writes, OVIS_BUILD_CACHE_DIR can restore a `dist/` somebody else built, and HERDR_BUNDLE_* and
 * WIDAL_* steer the bundle: none of them may reach a release by accident. The PTY host is the one deliberate input
 * (`ptyHost`), recorded in the pin by its sha256, and goes to the remote bundle step alone.
 */
export function releaseEnv(parent: Record<string, string | undefined>, epoch: number, options: { toolsDir: string; ptyHost?: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  // the Bun that runs the build comes first, so a `bun` named inside a package.json script is this one
  env["PATH"] = [options.toolsDir, env["PATH"]].filter(Boolean).join(":");
  env["SOURCE_DATE_EPOCH"] = String(epoch);
  env["OVIS_TELEMETRY"] = "0";
  if (options.ptyHost !== undefined) env["HERDR_BUNDLE_PTY_SIDECAR"] = options.ptyHost;
  return env;
}

/** Why the Bun in the archive is not the pinned one, or null. `recorded` is what bundle.json says, `binary` what `bin/bun --version` prints. */
export function bunProblem(pinned: string, recorded: unknown, binary: string): string | null {
  if (recorded !== pinned) return `The bundle records Bun ${String(recorded)}, not the pinned ${pinned}.`;
  if (binary !== pinned) return `The bin/bun in the bundle is Bun ${binary}, not the pinned ${pinned}.`;
  return null;
}

const root = resolve(import.meta.dir, "..");

function run(argv: string[], env: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(argv, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed (exit ${result.exitCode})`);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

async function build(): Promise<void> {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string; repository: { url: string } };
  const pinnedBun = /^bun@(.+)$/.exec(packageJson.packageManager)?.[1];
  // the Linux bundle carries the builder's own Bun binary (build-remote-bundle.ts), so the builder's Bun is the release's Bun
  if (!pinnedBun || Bun.version !== pinnedBun) throw new Error(`A release is built with the pinned Bun ${String(pinnedBun)}; this is ${Bun.version}.`);
  if (`${process.platform}-${process.arch}` !== RELEASE_PLATFORM) throw new Error(`A release is built on ${RELEASE_PLATFORM}; this is ${process.platform}-${process.arch}.`);
  const unclean = checkoutProblem(root);
  if (unclean !== null) throw new Error(unclean);
  const commit = git("rev-parse", "HEAD");
  const version = releaseVersion(root);
  const epoch = Number(git("show", "-s", "--format=%ct", "HEAD"));
  const builtAt = new Date(epoch * 1000);
  // the Rust PTY host, when the builder names one: its bytes are recorded in the pin by sha256
  const ptyHostPath = process.env["HERDR_BUNDLE_PTY_SIDECAR"] ? resolve(process.env["HERDR_BUNDLE_PTY_SIDECAR"]) : undefined;
  const ptyHostSha256 = ptyHostPath === undefined ? null : sha256(new Uint8Array(readFileSync(ptyHostPath)));

  const output = resolve(process.env["WIDAL_RELEASE_OUTPUT"] ?? join(root, "release-bundles"));
  const work = join(output, `work-${commit.slice(0, 12)}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    // every child runs THIS Bun (the one checked above), by its path and as `bun` on the children's PATH, and
    // with an allowlisted environment, not the builder's
    const bun = realpathSync(process.execPath);
    const toolsDir = join(work, "tools");
    mkdirSync(toolsDir);
    symlinkSync(bun, join(toolsDir, "bun"));
    const env = releaseEnv(process.env, epoch, { toolsDir });
    rmSync(join(root, "dist"), { recursive: true, force: true });
    rmSync(join(root, "dist-hub"), { recursive: true, force: true });
    // node_modules is what the commit's bun.lock and patches/ make of it, never what the checkout happened to hold
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    run([bun, "install", "--frozen-lockfile"], env);
    run([bun, "run", "build"], env);
    run([bun, "run", "build:hub"], env);
    // nothing the install or the builds did may have changed what the pin names
    const changed = checkoutProblem(root);
    if (changed !== null) throw new Error(`The install or a build changed the checkout:\n${changed}`);
    run([bun, "scripts/build-remote-bundle.ts", RELEASE_PLATFORM], { ...releaseEnv(process.env, epoch, { toolsDir, ...(ptyHostPath === undefined ? {} : { ptyHost: ptyHostPath }) }), HERDR_BUNDLE_OUTPUT: work });

    const stage = join(work, "stage");
    mkdirSync(stage);
    const unpacked = Bun.spawnSync(["tar", "-xzf", join(work, `herdr-web-ui-${RELEASE_PLATFORM}.tgz`), "-C", stage, "--no-same-owner"], { env: TAR_ENV, stderr: "pipe" });
    if (unpacked.exitCode !== 0) throw new Error(`The remote bundle cannot be unpacked: ${unpacked.stderr.toString()}`);
    // the builder copies the whole node_modules; its dot-entries are not part of a release: caches (.cache, .vite,
    // .vite-temp) and the package manager's .bin (relative links into the packages, with this lockfile, but a
    // package manager may write absolute ones, and a link farm of launchers is tooling, not runtime). Nothing at
    // runtime runs them (the Windows bundle drops .bin for the same reason).
    for (const name of readdirSync(join(stage, "node_modules"))) if (name.startsWith(".")) rmSync(join(stage, "node_modules", name), { recursive: true, force: true });
    cpSync(join(root, "dist-hub"), join(stage, HUB_UI_DIR), { recursive: true });
    writeFileSync(join(stage, RELEASE_INFO_FILE), `${JSON.stringify({ schema: RELEASE_INFO_SCHEMA, commit, builtAt: builtAt.toISOString(), hubUi: HUB_UI_DIR, ownerServer: OWNER_SERVER }, null, 2)}\n`);

    const bundle = JSON.parse(readFileSync(join(stage, "bundle.json"), "utf8")) as { version: string; platform: string; bun: string; pty_sidecar?: boolean; remote_bundle_version?: string };
    if (bundle.version !== REMOTE_BUNDLE_VERSION || bundle.platform !== RELEASE_PLATFORM) throw new Error("The remote bundle is not the version and platform this release names.");
    // the remote bundle's own version is the bridge protocol the machines compare and stays what the server was built with
    // (`remote_bundle_version`); the release is numbered by its history, so a newer commit never reuses an older release's number
    bundle.remote_bundle_version = bundle.version;
    bundle.version = version;
    writeFileSync(join(stage, "bundle.json"), JSON.stringify(bundle));
    const bundledBun = Bun.spawnSync([join(stage, "bin", "bun"), "--version"], { env: {}, stderr: "pipe" });
    const wrongBun = bunProblem(pinnedBun, bundle.bun, bundledBun.stdout.toString().trim());
    if (wrongBun !== null) throw new Error(wrongBun);
    const hostInArchive = join(stage, "bin", PTY_HOST);
    const bundledHostSha256 = existsSync(hostInArchive) ? sha256(new Uint8Array(readFileSync(hostInArchive))) : null;
    if (bundledHostSha256 !== ptyHostSha256 || (bundle.pty_sidecar === true) !== (ptyHostSha256 !== null)) throw new Error("The PTY host in the bundle is not the one HERDR_BUNDLE_PTY_SIDECAR names.");

    const file = archiveName(version, commit);
    mkdirSync(output, { recursive: true });
    const temporary = join(output, `${file}.tmp`);
    // nothing is left under the archive's name, or a pin beside it, unless the archive verifies
    rmSync(join(output, RELEASE_PIN_FILE), { force: true });
    try {
      packDeterministic(stage, temporary, epoch);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    renameSync(temporary, join(output, file));

    const pin = buildPin({
      version,
      repository: sourceRepository(packageJson.repository.url),
      commit,
      builtAt,
      archive: { file, bytes: new Uint8Array(readFileSync(join(output, file))) },
      hubUi: { manifest: new Uint8Array(readFileSync(join(stage, HUB_UI_DIR, HUB_MANIFEST_FILE))), files: (JSON.parse(readFileSync(join(stage, HUB_UI_DIR, HUB_MANIFEST_FILE), "utf8")) as { files: unknown[] }).files.length },
      bun: bundle.bun,
      rustPtyHost: bundle.pty_sidecar === true,
      ptyHostSha256,
    });
    const problems = verifyRelease(join(output, file), pin);
    if (problems.length > 0) {
      rmSync(join(output, file), { force: true });
      throw new Error(`The release just built does not verify:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    }
    writeFileSync(join(output, RELEASE_PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`${file} sha256:${pin.archive.sha256} (${pin.archive.bytes} bytes)\ncommit ${commit}\npin ${join(output, RELEASE_PIN_FILE)}`);
    if (!pin.ownerServer.rustPtyHost) console.log("This release has no Rust PTY host (HERDR_BUNDLE_PTY_SIDECAR was not set): terminals use the bundled Node fallback.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (command === "verify" && rest.length === 2) {
    const pin = readJson(resolve(rest[1]!));
    const problems = verifyRelease(resolve(rest[0]!), pin);
    if (problems.length > 0) {
      console.error(problems.map((problem) => `- ${problem}`).join("\n"));
      process.exit(1);
    }
    console.log(`${rest[0]} is the pinned release (commit ${(pin as ReleasePin).source.commit})`);
  } else if (command === undefined || command === "build") {
    await build();
  } else {
    console.error("Usage: bun run build:release | bun scripts/release-bundle.ts verify ARCHIVE PIN");
    process.exit(2);
  }
}
