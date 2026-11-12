/**
 * The owner factory's Setup contract (`/api/factory/setup/*`), served only by a factory server that
 * has the signed ALB identity gate (docs/factory-auth.md). The browser of the registered owner calls
 * it directly; the hub never sees any of these bodies. No response carries a token, a refresh token,
 * a PKCE verifier, a device code or a Claude code: only that a connection exists and whose it is.
 */

export type SetupStep = "github" | "linear" | "settings" | "claude";

/** A connection the person made on this factory, without its credential. */
export interface SetupGithub {
  readonly state: "connected" | "expired" | "not_connected" | "unavailable";
  readonly login?: string;
  /** The `<id>+<login>@users.noreply.github.com` address GitHub gives commits of a person who keeps their email private. */
  readonly noreplyEmail?: string;
  /**
   * When the token stops working, in milliseconds since the epoch; absent when GitHub gave it no lifetime. It
   * cannot be renewed on the factory: after it, the person connects GitHub again.
   */
  readonly expiresAt?: number;
  /** Why it cannot be used, for the page; never an upstream body. */
  readonly reason?: string;
}

export interface SetupLinear {
  /** `not_used`: the organization chose that its team does not use Linear. */
  readonly state: "connected" | "expired" | "not_connected" | "not_used" | "unavailable";
  readonly name?: string;
  /** When the current token stops working (milliseconds since the epoch); the factory renews it before then. */
  readonly expiresAt?: number;
  readonly reason?: string;
}

export interface SetupSettings {
  readonly repositories: readonly string[];
  readonly linearTeam: string | null;
  readonly gitName: string;
  readonly gitEmail: string;
}

export interface SetupStatus {
  readonly version: 1;
  readonly github: SetupGithub;
  readonly linear: SetupLinear;
  /** null until the person saved the choices */
  readonly settings: SetupSettings | null;
  readonly claude: { readonly state: "signed_in" | "not_signed_in" | "unavailable" };
  /**
   * True only when every required connection exists, none has expired, and the choices are saved. The factory
   * starts no agent before this is true; it is also written to `factory-setup.json` in the state folder, and
   * taken back there within a minute when a credential expires.
   */
  readonly ready: boolean;
  /** The first step that still needs the person. */
  readonly next: SetupStep | null;
}

/** POST /github/start */
export interface GithubDeviceStart {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** POST /github/poll */
export type GithubDevicePoll =
  | { readonly state: "pending"; readonly interval: number }
  | { readonly state: "connected"; readonly login: string }
  | { readonly state: "failed"; readonly reason: "expired" | "denied" | "unavailable"; readonly message: string };

/** POST /linear/start: the browser opens `url` as a top-level page. */
export interface LinearStart {
  readonly url: string;
}

export interface SetupChoices {
  readonly repositories: readonly { readonly fullName: string; readonly private: boolean }[];
  readonly teams: readonly { readonly key: string; readonly name: string }[];
  /** the git identity the agents commit with, proposed from the connected GitHub account */
  readonly proposed: { readonly gitName: string; readonly gitEmail: string };
}

/** The error body: `{error:{code,message}}` with a message written for the page. */
export interface SetupFailure {
  readonly error: { readonly code: string; readonly message: string };
}
