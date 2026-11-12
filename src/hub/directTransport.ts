import type { EventSourceLike, WebSocketLike } from "../lib/transport.ts";

// The structural custom-transport contract published by groundwork. It is deliberately not
// installed globally here: production composition waits for the protected factory App stack.
export interface DirectTransport {
  readonly kind: "custom";
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openSocket(url: string): WebSocketLike;
  openEventSource(url: string): EventSourceLike;
  resourceUrl(path: string): string;
}
interface BrowserConnections {
  fetch: typeof fetch;
  socket(url: string): WebSocketLike;
  events(url: string): EventSourceLike;
}

/**
 * Rebase the existing App's paths onto the verified owner origin. The App supplies its HTTP/WS
 * paths; this adapter invents none. B2e's signed ALB/current-owner gate is still the authority.
 */
export function directTransport(ownerOrigin: string, hubOrigin: string, browser?: BrowserConnections): DirectTransport {
  const owner = new URL(ownerOrigin);
  const hub = new URL(hubOrigin);
  for (const url of [owner, hub]) {
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("A direct connection requires a registered HTTPS origin.");
  }
  const connections = browser ?? {
    fetch: globalThis.fetch.bind(globalThis),
    socket: (url: string) => new WebSocket(url),
    events: (url: string) => new EventSource(url, { withCredentials: true }),
  };
  function target(input: string, socket = false): string {
    const url = new URL(input, hub);
    if (socket) {
      if (url.protocol !== "wss:") throw new Error("A direct socket requires secure WebSocket transport.");
      url.protocol = "https:";
    }
    if (url.username || url.password || (url.origin !== hub.origin && url.origin !== owner.origin)) throw new Error("The app requested a different factory origin.");
    if (url.pathname === "/api/app" || url.pathname.startsWith("/api/app/")) throw new Error("Hub page requests cannot use the personal factory transport.");
    url.protocol = socket ? "wss:" : owner.protocol;
    url.hostname = owner.hostname;
    url.port = owner.port;
    return url.href;
  }
  return {
    kind: "custom",
    fetch: (input, init) => {
      const source = input instanceof Request ? input : null;
      const url = target(source ? source.url : String(input));
      const options: RequestInit = { ...init, credentials: "include", redirect: "error", cache: "no-store" };
      return connections.fetch(source ? new Request(url, source) : url, options);
    },
    openSocket: (url) => connections.socket(target(url, true)),
    openEventSource: (url) => connections.events(target(url)),
    resourceUrl: (path) => target(path),
  };
}
