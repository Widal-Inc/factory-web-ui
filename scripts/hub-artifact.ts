/**
 * The hub UI artifact: what `bun run build:hub` writes to dist-hub/ for the factory hub to serve
 * with `--ui-dir`. Only trusted public files may be in it (no sources, maps, settings or secrets),
 * and `hub-manifest.json` lists every file with its sha256 so the consumer can verify a release
 * before it swaps it in. This module holds the pure parts; vite.hub.config.ts wires them in.
 */
import { createHash } from "node:crypto";
import type { BrandConfig } from "../shared/brand.ts";

/** Bumped when a consumer must change how it reads the manifest. */
export const HUB_MANIFEST_SCHEMA = 1;
/** The hub app API the pages are built against (`GET /api/app/*`, docs/hub-pages.md). */
export const HUB_API_VERSION = 1;
export const HUB_MANIFEST_FILE = "hub-manifest.json";
export const HUB_ENTRY = "index.html";

export interface ArtifactFile { path: string; bytes: Uint8Array }
export interface HubManifest {
  schema: typeof HUB_MANIFEST_SCHEMA;
  kind: "factory-hub-ui";
  hubApiVersion: typeof HUB_API_VERSION;
  /** The commit the build was made from; null in a build outside Git. A consumer must not guess one. */
  revision: string | null;
  appVersion: string;
  entry: typeof HUB_ENTRY;
  brand: { name: string; shortName: string; theme: string };
  /** sha256 over the sorted `path\0sha256\n` lines: one value that names the whole release. */
  digest: string;
  files: { path: string; sha256: string; bytes: number }[];
}

/** The BRAND files a page asks for by address, as paths under the artifact root (the ?v= query stripped). */
export function brandAssetPaths(brand: Pick<BrandConfig, "logo" | "icon" | "largeIcon" | "maskableIcon" | "badge" | "favicon" | "appleTouchIcon">): string[] {
  const addresses = [brand.logo, brand.icon, brand.largeIcon, brand.maskableIcon, brand.badge, brand.favicon, brand.appleTouchIcon];
  return [...new Set(addresses.map((address) => {
    const path = address.split("?")[0]!;
    if (!path.startsWith("/") || path.includes("..") || path.includes("//")) throw new Error(`A brand asset must be a root-relative path: ${address}`);
    return path.slice(1);
  }))].sort();
}

/** The names a hub artifact may hold: the entry, its hashed bundle, the brand files and its own provenance. */
export function isPublicArtifactPath(path: string, brandAssets: readonly string[]): boolean {
  if (path.includes("..") || path.startsWith("/") || path.endsWith(".map")) return false;
  if (path === HUB_ENTRY || path === "build.json" || path === "THIRD_PARTY_NOTICES.md" || path === HUB_MANIFEST_FILE) return true;
  if (/^assets\/[A-Za-z0-9._-]+$/.test(path)) return true;
  return brandAssets.includes(path);
}

export function assertPublicArtifact(paths: readonly string[], brandAssets: readonly string[]): void {
  const refused = paths.filter((path) => !isPublicArtifactPath(path, brandAssets));
  if (refused.length > 0) throw new Error(`The hub artifact holds files that are not public: ${refused.join(", ")}`);
  if (!paths.includes(HUB_ENTRY)) throw new Error(`The hub artifact has no ${HUB_ENTRY}`);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function buildManifest(files: readonly ArtifactFile[], meta: { revision: string | null; appVersion: string; brand: Pick<BrandConfig, "name" | "shortName" | "theme"> }): HubManifest {
  const listed = files
    .filter((file) => file.path !== HUB_MANIFEST_FILE)
    .map((file) => ({ path: file.path, sha256: sha256(file.bytes), bytes: file.bytes.byteLength }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash("sha256");
  for (const file of listed) digest.update(`${file.path}\0${file.sha256}\n`);
  return {
    schema: HUB_MANIFEST_SCHEMA,
    kind: "factory-hub-ui",
    hubApiVersion: HUB_API_VERSION,
    revision: meta.revision,
    appVersion: meta.appVersion,
    entry: HUB_ENTRY,
    brand: { name: meta.brand.name, shortName: meta.brand.shortName, theme: meta.brand.theme },
    digest: digest.digest("hex"),
    files: listed,
  };
}

/** What a consumer runs before it serves a release: every listed file is present, whole and unchanged, and nothing else is. */
export function verifyManifest(manifest: HubManifest, files: readonly ArtifactFile[], brandAssets: readonly string[]): string[] {
  const problems: string[] = [];
  if (manifest.schema !== HUB_MANIFEST_SCHEMA || manifest.kind !== "factory-hub-ui") problems.push("not a hub UI manifest this reader knows");
  if (manifest.hubApiVersion !== HUB_API_VERSION) problems.push(`built for hub API ${String(manifest.hubApiVersion)}, not ${HUB_API_VERSION}`);
  const present = new Map(files.filter((file) => file.path !== HUB_MANIFEST_FILE).map((file) => [file.path, file]));
  for (const listed of manifest.files) {
    const file = present.get(listed.path);
    if (!file) problems.push(`${listed.path} is listed but missing`);
    else if (sha256(file.bytes) !== listed.sha256 || file.bytes.byteLength !== listed.bytes) problems.push(`${listed.path} differs from the manifest`);
    present.delete(listed.path);
  }
  for (const path of present.keys()) problems.push(`${path} is not in the manifest`);
  for (const listed of manifest.files) if (!isPublicArtifactPath(listed.path, brandAssets)) problems.push(`${listed.path} is not a public artifact path`);
  return problems;
}
