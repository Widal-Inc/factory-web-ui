/** Real browser shortcut checks in one owned pane, with a watchdog separate from the core UI. */
import type { Browser } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromePath } from "./chrome-path.ts";
import { checkCommandBackspace } from "./terminal-command-backspace-regression.ts";
import { checkCtrlEnter } from "./terminal-ctrl-enter-regression.ts";
import { checkCommandArrows } from "./terminal-command-arrows-regression.ts";

async function checkTerminalShortcuts(browser: Browser, origin: string, pane: string): Promise<void> {
  await checkCommandBackspace(browser, origin, pane);
  await checkCtrlEnter(browser, origin, pane);
  await checkCommandArrows(browser, origin, pane);
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { UsageService } = await import("../server/usage.ts");
  const { chromium } = await import("playwright-core");
  const root = mkdtempSync(join(tmpdir(), "herdr-shortcuts-qa-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", usage: new UsageService(undefined, []) });
  let browser: Browser | undefined;
  let workspace: string | undefined;
  try {
    const made = await workspaceCreate({ cwd: root, label: "ovis-test-terminal-shortcuts" });
    workspace = made.workspace.workspace_id;
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTerminalShortcuts(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id);
  } finally {
    try { await browser?.close(); } finally {
      server.stop();
      try { if (workspace) await workspaceClose(workspace); } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
}
