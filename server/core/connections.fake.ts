import { type Client, createConnections } from "./connections.ts";

/** The client as a connection that asked to observe only (`role {mode: "observe"}`), for tests of what an observer may not do. */
export function observing<T extends Client>(client: T): T {
  createConnections({ clients: new Set(), present: new Set(), pending: { close: () => {} }, detachClaimed: () => {}, dropClaims: () => {} }).setRole(client, "observe");
  return client;
}
