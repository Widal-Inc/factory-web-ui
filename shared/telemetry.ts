/**
 * What this app may tell the endpoint its operator configures (server/telemetry.ts), and nothing else.
 * Two messages exist: the version this install runs, once for each version, and a report that the
 * previous run ended on an uncaught error, with a fixed kind. Nothing identifies an install or a
 * person: no install id, no settings, no counts of use, no paths, no error text. A third kind of
 * message is added here, to TELEMETRY_FIELDS and to telemetryEvent, or it is never sent: the server
 * refuses to send a body that telemetryEvent does not return whole.
 *
 * Nothing is sent before the app has shown its notice once (and a grace period after it,
 * server/telemetry.ts NOTICE_GRACE_MS), while the switch in Settings is off, where the environment
 * says not to (OVIS_TELEMETRY=0, DO_NOT_TRACK, CI), or when no endpoint is configured
 * (WIDAL_TELEMETRY_URL).
 *
 *  GET  /api/telemetry  -> TelemetryStatus, no-store
 *  POST /api/telemetry  { enabled?: boolean, notice_seen?: true, notice_version?: number } -> TelemetryStatus
 *       (same-origin, `x-herdr-update: 1`)
 *       The server accepts notice_seen only with notice_version === NOTICE_VERSION.
 *
 * A server that sends nothing (tests, a remote PC's bridge, no endpoint configured) answers 404 to
 * both, and the app shows neither the notice nor the switch.
 */

/**
 * The notice's wording as a number: an install that saw an older one sees the notice again, and
 * sends nothing until it has (6: only the version and a crash's kind are sent, to the endpoint
 * the operator configures).
 */
export const NOTICE_VERSION = 6;

/** The kinds of error a report may name. A fixed list: never an error's message, stack or path. */
export const TELEMETRY_ERROR_KINDS = ["uncaught_exception"] as const;
export type TelemetryErrorKind = typeof TELEMETRY_ERROR_KINDS[number];

/** The version this install runs, as it was started, without the v. Sent once for each version. */
export interface TelemetryVersionEvent {
  event: "version";
  version: string;
}

/** The previous run ended on an error of this kind; sent with the version that run was. */
export interface TelemetryErrorEvent {
  event: "error";
  version: string;
  error: TelemetryErrorKind;
}

export type TelemetryEvent = TelemetryVersionEvent | TelemetryErrorEvent;

/** Every field a message may carry, by message. A body with a key outside its list is never sent. */
export const TELEMETRY_FIELDS = {
  version: ["event", "version"],
  error: ["event", "version", "error"],
} as const satisfies Record<TelemetryEvent["event"], readonly string[]>;

/** The browser's changes to the switch and the notice; nothing else is taken from it. */
export interface TelemetryChange {
  enabled?: boolean;
  notice_seen?: true;
  notice_version?: number;
}

const VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

/** A version as this app reports one (package.json's: digits, dots, a prerelease or build tag). */
export function telemetryVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}

/** The message exactly as TELEMETRY_FIELDS allows it, as a fresh object, or null for anything else. */
export function telemetryEvent(value: unknown): TelemetryEvent | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const record = value as Record<string, unknown>;
    const name = record["event"];
    if (name !== "version" && name !== "error") return null;
    const allowed: readonly string[] = TELEMETRY_FIELDS[name];
    if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key as string))) return null;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    const version = telemetryVersion(record["version"]);
    if (version === null) return null;
    if (name === "version") return { event: "version", version };
    const error = record["error"];
    if (typeof error !== "string" || !(TELEMETRY_ERROR_KINDS as readonly string[]).includes(error)) return null;
    return { event: "error", version, error: error as TelemetryErrorKind };
  } catch {
    return null;
  }
}

export interface TelemetryStatus {
  /** the switch in Settings */
  enabled: boolean;
  /** OVIS_TELEMETRY=0, DO_NOT_TRACK or a CI/test environment: nothing is sent whatever the switch says */
  blocked_by_env: boolean;
  /** the app has shown its current notice (NOTICE_VERSION) once; no message goes out before that */
  notice_seen: boolean;
  /** the messages owed now, in the order they would be sent, exactly as they would be sent; empty when none is */
  next: TelemetryEvent[];
  /** every kind of error a report may name */
  error_kinds: readonly TelemetryErrorKind[];
}
