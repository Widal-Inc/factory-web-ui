import type { PairingCode } from "../../shared/protocol.ts";

/**
 * The server keeps one pending pairing code. A panel that started a new one says so on `window`,
 * with the code as `detail`, and the other panel shows that code instead of the one it had.
 */
export const PAIRING_CODE_EVENT = "ovis:pairing-code";

export function announcePairingCode(code: PairingCode): void {
  window.dispatchEvent(new CustomEvent<PairingCode>(PAIRING_CODE_EVENT, { detail: code }));
}
