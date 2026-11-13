import { getTransport, nativeTransport } from "./transport.ts";

/**
 * Whether this page shows a factory through the hub's direct transport (src/hub/OwnerFactory.tsx), as
 * opposed to a server the person runs themselves. In a factory the owner cannot start herdr, set an
 * environment variable or restart anything: every message there says what they can do (wait, reload,
 * try again) and otherwise that the factory reports it, and names no socket, variable or host.
 */
export function inFactory(): boolean {
  return getTransport() !== nativeTransport;
}
