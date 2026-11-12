/**
 * Where the owner's Setup keeps what it learned on this factory host.
 *
 * Credentials go into the factory's own secrets file (`$WIDAL_SECRETS`, else
 * `$XDG_CONFIG_HOME/widal/secrets.env`, else `~/.config/widal/secrets.env`): NAME=value lines, mode 0600,
 * the file the factory itself reads. Setup changes only the lines of the names it owns and keeps every other
 * line of whoever provisioned the file exactly as it is. They never go into the state folder's JSON, a
 * response, a log line or an environment an agent inherits. Everything that is not a secret (whose
 * account, the repositories chosen, the git identity, the expiry times) goes into
 * `factory-setup.json` in the state folder, which the factory may read to see what the person chose
 * and whether Setup is complete.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SetupSettings } from "../shared/factory-setup.ts";
import { writePrivateBytes, writePrivateState } from "./private-state.ts";

export const SECRET_GITHUB = "GH_TOKEN";
export const SECRET_LINEAR = "LINEAR_ACCESS_TOKEN";
export const SECRET_LINEAR_REFRESH = "LINEAR_REFRESH_TOKEN";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * What a value Setup writes may hold. The file is NAME=value lines that the factory (or a shell, or a service
 * manager) may source, and a value is written unquoted: only characters that mean nothing to a shell are
 * allowed, which covers every token GitHub and Linear issue (letters, digits, `_`, `-`, `.`, base64's `+/=`).
 */
const SAFE_VALUE = /^[A-Za-z0-9._+/=:-]+$/;
export const isSecretValue = (value: string): boolean => SAFE_VALUE.test(value);

export function defaultSecretsPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env["WIDAL_SECRETS"]) return env["WIDAL_SECRETS"];
  return join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "widal", "secrets.env");
}

/** A definition Setup understands: `NAME=value` or `export NAME=value`, with an optional CR before the newline. */
const DEFINITION = /^(\s*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*?)(\r?)$/;
interface Definition { readonly prefix: string; readonly name: string; readonly value: string; readonly cr: string }

/**
 * The file is read and written as latin1, one character per byte, so a line that is not UTF-8 (whoever
 * provisioned the file may have used another encoding) goes back byte for byte. Everything Setup itself writes
 * is ASCII.
 */
const ENCODING = "latin1";

/** The file's lines, each with its own line ending, exactly as they are. */
const splitLines = (content: string): string[] => content.match(/[^\n]*\n|[^\n]+$/g) ?? [];

function definition(line: string): Definition | null {
  const match = line.replace(/\n$/, "").match(DEFINITION);
  if (!match) return null;
  const raw = match[3]!;
  // a value the provisioner quoted is read without its quotes, as a shell would
  const value = raw.length >= 2 && (raw[0] === "\"" || raw[0] === "'") && raw.at(-1) === raw[0] ? raw.slice(1, -1) : raw;
  return { prefix: match[1]!, name: match[2]!, value, cr: match[4]! };
}

/** Every definition in the file; a later one of the same name wins, as when the file is sourced. */
export function readSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of splitLines(readFileSync(path, ENCODING))) {
    const found = definition(line);
    if (found) out[found.name] = found.value;
  }
  return out;
}

/**
 * Sets the names in `values` (an empty value removes the name) and removes the names in `remove`. Only those
 * names' lines change: every other line (comments, `export` lines, empty values, CRLF endings, lines Setup does
 * not understand) is kept byte for byte. A name defined more than once keeps its first line, rewritten, and
 * loses the rest, which would otherwise win when the file is sourced. A value is refused unless it is made only
 * of characters a shell takes literally. Written with writePrivateBytes: a
 * temporary file of its own beside it, flushed, renamed over the file (never written through a link), the
 * folder flushed, readable by its owner only.
 */
export function saveSecrets(path: string, values: Record<string, string>, remove: readonly string[] = []): void {
  for (const [name, value] of Object.entries(values)) {
    if (!NAME.test(name)) throw new Error(`"${name}" is not a valid variable name`);
    if (value !== "" && !SAFE_VALUE.test(value)) throw new Error(`the value of ${name} has a character that is not safe in a file a shell may source`);
  }
  const touched = new Set([...Object.keys(values), ...remove]);
  const pending = new Map(Object.entries(values).filter(([, value]) => value !== ""));
  const existing = existsSync(path) ? readFileSync(path, ENCODING) : null;
  const eol = existing?.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = existing === null ? ["# the factory's secrets, written by its web Setup. Keep this file private.\n"] : [];
  for (const line of existing === null ? [] : splitLines(existing)) {
    const found = definition(line);
    if (!found || !touched.has(found.name)) { out.push(line); continue; }
    const value = pending.get(found.name);
    if (value === undefined) continue; // removed, or already written on its first line
    pending.delete(found.name);
    out.push(`${found.prefix}${found.name}=${value}${found.cr}${line.endsWith("\n") ? "\n" : ""}`);
  }
  if (pending.size > 0 && out.length > 0 && !out.at(-1)!.endsWith("\n")) out.push(eol);
  for (const [name, value] of pending) out.push(`${name}=${value}${eol}`);
  writePrivateBytes(path, Buffer.from(out.join(""), ENCODING));
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
  /** Linear's own id of the account: choices made with another one do not carry over */
  readonly id: string;
  readonly name: string;
  /** the Linear app's public client id the token was issued to, which renews it; absent in records saved before it was kept */
  readonly clientId?: string;
  readonly connectedAt: string;
  /** milliseconds since the epoch; renewed by Setup before it passes */
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
  /** the GitHub account id and Linear account id (null: Linear not used) the settings were made with */
  readonly settingsAccounts?: { readonly github: number; readonly linear: string | null };
  readonly claude?: boolean;
  /**
   * every required connection exists and the choices are saved; set only by a status read, taken back within
   * MAINTAIN_MS once a credential it rests on expires. A reader also checks `github.expiresAt` and `linear.expiresAt`.
   */
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
