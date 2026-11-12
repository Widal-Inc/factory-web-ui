import type { FactoryAuth } from "./factory-auth.ts";

/** Protect long lived SSE, media and file bodies too: no unchecked bytes after removal. */
export function protectFactoryResponse(request: Request, response: Response, auth: FactoryAuth, check: () => Promise<void>): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  const origin = request.headers.get("origin");
  if (auth.allowsOrigin(origin)) {
    headers.set("access-control-allow-origin", origin!);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-expose-headers", "x-request-id, x-server-time, content-range");
    headers.append("vary", "Origin");
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set("access-control-allow-headers", "content-type, x-herdr-machine, x-herdr-update, x-request-id");
    }
  }
  if (!response.body) return new Response(null, { status: response.status, statusText: response.statusText, headers });
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await check();
        const chunk = await reader.read();
        await check();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch {
        await reader.cancel().catch(() => {});
        controller.error(new Error("Factory access refused"));
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
