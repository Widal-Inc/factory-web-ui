/**
 * Where the owner's Setup keeps what it learned on this factory host.
 *
 * Credentials go into the factory's own secrets file (`$WIDAL_SECRETS`, else
 * `$XDG_CONFIG_HOME/widal/secrets.env`, else `~/.config/widal/secrets.env`): one NAME=value per line,
 * mode 0600, the file the factory itself reads. They never go into the state folder's JSON, a
 * response, a log line or an environment an agent inherits. Everything that is not a secret (whose
 * account, the repositories chosen, the git identity, the expiry times) goes into
 * `factory-setup.json` in the state folder, which the factory may read to see what the person chose
 * and whether Setup is complete.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SetupSettings } from "../shared/factory-setup.ts";
import { writePrivateState } from "./private-state.ts";

export const SECRET_GITHUB = "GH_TOKEN";
export const SECRET_LINEAR = "LINEAR_ACCESS_TOKEN";
export const SECRET_LINEAR_REFRESH = "LINEAR_REFRESH_TOKEN";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultSecretsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env["WIDAL_SECRETS"]) return env["WIDAL_SECRETS"];
  return join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "widal", "secrets.env");
}

export function readSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

/** Merges values into the secrets file; a name in `remove` goes. Written atomically, readable by its owner only. */
export function saveSecrets(path: string, values: Record<string, string>, remove: readonly string[] = []): void {
  const all = { ...readSecrets(path), ...values };
  for (const name of remove) if (!(name in values)) delete all[name];
  for (const [name, value] of Object.entries(all)) {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a valid variable name`);
    if (/[\r\n\0]/.test(value)) throw new Error(`the value of ${name} must be one line`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const body = Object.entries(all).filter(([, value]) => value !== "").map(([name, value]) => `${name}=${value}\n`).join("");
  writeFileSync(temporary, `# the factory's secrets, written by its web Setup. Keep this file private.\n${body}`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export interface StoredGithub {
  readonly login: string;
  readonly id: number;
  readonly name: string | null;
  readonly email: string | null;
  readonly connectedAt: string;
  /** milliseconds since the epoch; absent when GitHub gave the token no lifetime */
  readonly expiresAt?: number;
}

export interface StoredLinear {
  readonly name: string;
  readonly connectedAt: string;
  readonly expiresAt?: number;
}

/** factory-setup.json: no secret. */
export interface StoredSetup {
  readonly version: 1;
  /** the person who made the connections */
  readonly owner: string;
  readonly github?: StoredGithub;
  readonly linear?: StoredLinear;
  readonly settings?: SetupSettings;
  readonly claude?: boolean;
  /** every required connection exists and the choices are saved */
  readonly ready: boolean;
  readonly updatedAt: string;
}

export class SetupStore {
  readonly file: string;
  constructor(stateDir: string, readonly secretsPath: string) { this.file = join(stateDir, "factory-setup.json"); }

  read(): StoredSetup | null {
    if (!existsSync(this.file)) return null;
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (value !== null && typeof value === "object" && (value as { version?: unknown }).version === 1) return value as StoredSetup;
    } catch { /* an unreadable record is no record: Setup starts again, it never guesses */ }
    return null;
  }

  write(value: StoredSetup): void { writePrivateState(this.file, value); }
  secrets(): Record<string, string> { return readSecrets(this.secretsPath); }
  saveSecrets(values: Record<string, string>, remove: readonly string[] = []): void { saveSecrets(this.secretsPath, values, remove); }
}
