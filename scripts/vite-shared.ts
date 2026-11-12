/** What the client build (vite.config.ts) and the hub artifact build (vite.hub.config.ts) must agree on. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePath } from "vite";
import { buildXtermSource } from "./build-xterm.ts";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Vite 6's syntax targets, kept when changing the bundler, including installed mobile clients. */
export const buildTarget = ["es2020", "edge88", "firefox78", "chrome87", "safari14"];

export function gitRevision(): string | null {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; /* non-Git build */ }
}

export function appVersion(): string {
  return (JSON.parse(readFileSync(`${repoRoot}package.json`, "utf8")) as { version: string }).version;
}

/** The Bun patch targets xterm's readable source, not its minified distribution: every client builds that source. */
export function clientAliases() {
  const xtermSource = normalizePath(buildXtermSource(repoRoot));
  return [
    { find: /^@xterm\/xterm$/, replacement: `${xtermSource}/browser/public/Terminal.js` },
    { find: /^browser\//, replacement: `${xtermSource}/browser/` },
    { find: /^common\//, replacement: `${xtermSource}/common/` },
    { find: /^vs\/nls$/, replacement: `${xtermSource}/vs/patches/nls.js` },
    { find: /^vs\//, replacement: `${xtermSource}/vs/` },
    { find: "@shared", replacement: `${repoRoot}shared` },
  ];
}

export function clientDefines(revision: string | null) {
  return {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify(appVersion()),
    // test hooks (src/lib/crashProbe.ts): on only in the browser lane's demo build (scripts/demo-build.ts)
    __HERDR_TEST_HOOKS__: JSON.stringify(process.env["HERDR_TEST_HOOKS"] === "1"),
  };
}
