import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Old PC identities are notification keys only. Never create an identity or use its private key. */
export function savedAlertIdentity(stateDir: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(stateDir, "relay", "identity.json"), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    return alertIdentity((value as Record<string, unknown>)["server_id"]);
  } catch { return undefined; }
}

export function alertIdentity(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}
