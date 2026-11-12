/**
 * The hub UI artifact: what `bun run build:hub` writes to dist-hub/ for the factory hub to serve
 * with `--ui-dir`. Only trusted public files may be in it (no sources, maps, settings or secrets),
 * and `widal-ui.json` lists every file with its size and sha256 so the hub can check a release at
 * start, before it serves a byte. The format is the factory hub's release manifest
 * (docs/hub-app-contract.md in the factory repository, read by `hub/src/ui.ts` there), checked
 * against the factory's merged revision `eab41c491dcb9d45d081b8822432f0f41e5b2dea`. This module holds the
 * pure parts; vite.hub.config.ts wires them in.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { BrandConfig } from "../shared/brand.ts";

/** The hub reads this file name and this schema, and refuses any other. */
export const HUB_MANIFEST_FILE = "widal-ui.json";
export const HUB_MANIFEST_SCHEMA = "widal.ui/1";
/** The hub app API the pages are built against (`GET /api/app/*`, docs/hub-pages.md). The hub's own version must be inside. */
export const HUB_API_RANGE = { min: 1, max: 1 } as const;
export const HUB_ENTRY = "index.html";
/** The file the page reads to compare its own revision with the one the hub serves. */
export const BUILD_FILE = "build.json";
/** The notices ship as HTML because the hub serves a fixed list of file types and Markdown is not one. */
export const NOTICE_FILES = ["THIRD_PARTY_NOTICES.html", "LICENSE.html"] as const;

export interface ArtifactFile { path: string; bytes: Uint8Array }
export interface HubManifest {
  schema: typeof HUB_MANIFEST_SCHEMA;
  /** The full commit id of the source this build was made from; the hub reports it as `ui.revision`. */
  revision: string;
  hubApi: { min: number; max: number };
  entry: typeof HUB_ENTRY;
  /** Every public file but the manifest itself, sorted by path. */
  files: { path: string; bytes: number; sha256: string }[];
  provenance: { source: string; commit: string; builtAt: string };
}

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** The file types the hub serves from a release; a path of any other type is refused by the hub at start. */
const SERVED_TYPES = new Set([".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2", ".wasm"]);

/** The BRAND files a page asks for by address, as paths under the artifact root (the ?v= query stripped). */
export function brandAssetPaths(brand: Pick<BrandConfig, "logo" | "icon" | "largeIcon" | "maskableIcon" | "badge" | "favicon" | "appleTouchIcon">): string[] {
  const addresses = [brand.logo, brand.icon, brand.largeIcon, brand.maskableIcon, brand.badge, brand.favicon, brand.appleTouchIcon];
  return [...new Set(addresses.map((address) => {
    const path = address.split("?")[0]!;
    if (!path.startsWith("/") || path.includes("..") || path.includes("//")) throw new Error(`A brand asset must be a root-relative path: ${address}`);
    return path.slice(1);
  }))].sort();
}

/** The path form the hub accepts: plain, relative, no empty or dot segment, no backslash. */
function isPlainPath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every((segment) => segment !== "" && !segment.startsWith("."));
}

/** The names a hub artifact may hold: the entry, its hashed bundle, the brand files, the notices and its own provenance. */
export function isPublicArtifactPath(path: string, brandAssets: readonly string[]): boolean {
  if (!isPlainPath(path) || !SERVED_TYPES.has(extname(path)) || path.endsWith(".map")) return false;
  if (path === HUB_ENTRY || path === BUILD_FILE || path === HUB_MANIFEST_FILE || (NOTICE_FILES as readonly string[]).includes(path)) return true;
  if (/^assets\/[A-Za-z0-9._-]+$/.test(path)) return true;
  return brandAssets.includes(path);
}

export function assertPublicArtifact(paths: readonly string[], brandAssets: readonly string[]): void {
  const refused = paths.filter((path) => !isPublicArtifactPath(path, brandAssets));
  if (refused.length > 0) throw new Error(`The hub artifact holds files that are not public: ${refused.join(", ")}`);
  if (!paths.includes(HUB_ENTRY)) throw new Error(`The hub artifact has no ${HUB_ENTRY}`);
}

/**
 * The hub serves woff2 and woff but not TrueType, so a release may not carry a `.ttf`. Every browser that
 * runs this app reads the woff2 face first, so a TrueType face that only trails a `src` list is dropped
 * from the stylesheet, and its file is dropped from the artifact (KaTeX lists one last in each face).
 */
export function dropTruetypeFallbacks(css: string): string {
  return css.replace(/,\s*url\([^)]*\.ttf\)\s*format\(["']truetype["']\)/g, "");
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A notice text as a plain page: the hub serves HTML, not Markdown, and a page needs no script to show a license. */
export function noticePage(title: string, text: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>`
    + `<style>body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:60rem;padding:1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>`
    + `<body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(text)}</pre></body></html>\n`;
}

/** `owner/repo` from a package.json repository url such as `git+https://github.com/owner/repo.git`. */
export function sourceRepository(url: string): string {
  const match = /github\.com[/:]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`The source repository is not a GitHub url: ${url}`);
  return match[1]!;
}

export interface ManifestMeta {
  /** The commit the build was made from. A build outside Git has none, and the hub refuses a release without one. */
  revision: string | null;
  source: string;
  builtAt: Date;
}

export function buildManifest(files: readonly ArtifactFile[], meta: ManifestMeta): HubManifest {
  if (meta.revision === null || !COMMIT.test(meta.revision)) throw new Error("A hub UI release needs the full commit id it was built from: build inside a Git checkout.");
  if (Number.isNaN(meta.builtAt.getTime())) throw new Error("The build time is not a date.");
  const listed = files
    .filter((file) => file.path !== HUB_MANIFEST_FILE)
    .map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schema: HUB_MANIFEST_SCHEMA,
    revision: meta.revision,
    hubApi: { ...HUB_API_RANGE },
    entry: HUB_ENTRY,
    files: listed,
    provenance: { source: meta.source, commit: meta.revision, builtAt: meta.builtAt.toISOString() },
  };
}

/**
 * Why a manifest is not one the factory hub accepts, in words; undefined when it is. This is the shape check
 * of the hub's `releaseProblem` (hub/src/ui.ts) kept here so the producer cannot drift from it unseen; the
 * test that runs the hub's own reader on the built artifact is the proof (scripts/hub-artifact.test.ts).
 */
export function manifestProblem(value: unknown, hubApiVersion: number = HUB_API_RANGE.min): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(value)) return "it is not a JSON object";
  if (value.schema !== HUB_MANIFEST_SCHEMA) return `its schema is not ${HUB_MANIFEST_SCHEMA}`;
  if (typeof value.revision !== "string" || !COMMIT.test(value.revision)) return "its revision is not a full commit id";
  const api = value.hubApi;
  if (!isObject(api) || !Number.isInteger(api.min) || !Number.isInteger(api.max) || (api.min as number) > (api.max as number)) return "its hubApi is not {min, max} whole numbers";
  if ((api.min as number) > hubApiVersion || (api.max as number) < hubApiVersion) return `it speaks hub API ${String(api.min)} to ${String(api.max)}, and this hub speaks ${hubApiVersion}`;
  if (value.entry !== HUB_ENTRY) return `its entry is not "${HUB_ENTRY}"`;
  if (!Array.isArray(value.files) || value.files.length === 0) return "it lists no files";
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!isObject(file) || typeof file.path !== "string" || !Number.isInteger(file.bytes) || (file.bytes as number) < 0 || typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)) return "a file entry is not {path, bytes, sha256}";
    if (!isPlainPath(file.path)) return `the file path ${JSON.stringify(file.path)} is not a plain relative path`;
    if (!SERVED_TYPES.has(extname(file.path))) return `the file ${JSON.stringify(file.path)} is of a type the hub does not serve`;
    if (file.path === HUB_MANIFEST_FILE) return "it lists itself";
    if (seen.has(file.path)) return `the file ${JSON.stringify(file.path)} is listed twice`;
    seen.add(file.path);
  }
  if (!seen.has(HUB_ENTRY)) return `it does not list ${HUB_ENTRY}`;
  const provenance = value.provenance;
  if (!isObject(provenance) || typeof provenance.source !== "string" || provenance.source === "" || typeof provenance.commit !== "string" || !COMMIT.test(provenance.commit) || typeof provenance.builtAt !== "string" || Number.isNaN(Date.parse(provenance.builtAt))) return "its provenance is not {source, commit, builtAt}";
  return undefined;
}

/** What a consumer runs before it serves a release: the manifest fits, every listed file is present, whole and unchanged, and nothing else is. */
export function verifyManifest(manifest: unknown, files: readonly ArtifactFile[], brandAssets: readonly string[]): string[] {
  const shape = manifestProblem(manifest);
  if (shape) return [`the manifest is refused: ${shape}`];
  const release = manifest as HubManifest;
  const problems: string[] = [];
  const present = new Map(files.filter((file) => file.path !== HUB_MANIFEST_FILE).map((file) => [file.path, file]));
  for (const listed of release.files) {
    const file = present.get(listed.path);
    if (!file) problems.push(`${listed.path} is listed but missing`);
    else if (sha256(file.bytes) !== listed.sha256 || file.bytes.byteLength !== listed.bytes) problems.push(`${listed.path} differs from the manifest`);
    present.delete(listed.path);
  }
  for (const path of present.keys()) problems.push(`${path} is not in the manifest`);
  for (const listed of release.files) if (!isPublicArtifactPath(listed.path, brandAssets)) problems.push(`${listed.path} is not a public artifact path`);
  return problems;
}
