import { FactoryAuthError, type FactoryAuth } from "../factory-auth.ts";
import { withFactoryAuthority, withoutFactoryAuthority } from "../factory-context.ts";
import { LARGE_REPLY_BYTES } from "../herdr/client.ts";
import { OUTPUT_HARD_BYTES } from "../output-window.ts";
import type { Client, SocketData } from "./connections.ts";
import type { SocketHandler } from "./socket.ts";

/** Every frame gets a live check. The bounded output queue preserves order while the registry answers. */
export function factorySocket(handlers: SocketHandler, auth: FactoryAuth): SocketHandler {
  const connections = new WeakMap<SocketData, { client: Client; check: () => Promise<void>; close: () => void; end: (code: number, reason: string) => void; incoming: number; admission: Promise<void> }>();
  return {
    ...handlers,
    async open(raw) {
      const identity = raw.data.factoryIdentity;
      if (!identity) { raw.close(1008, "Factory access refused"); return; }
      let closed = false;
      let queued = 0;
      let frames = 0;
      let output = Promise.resolve();
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (code: number, reason: string, denied: boolean, transport = true) => {
        if (closed) return;
        closed = true;
        raw.data.factoryRevoked = denied;
        clearInterval(timer);
        // Invalidate leases and hold pending input immediately, before the transport's close callback.
        withoutFactoryAuthority(() => handlers.close(client, code, reason));
        if (transport) raw.close(code, reason);
        auth.audit(identity, "websocket.close", denied ? "denied" : "allowed");
      };
      const close = () => finish(1008, "Factory access refused", true);
      const check = async () => {
        if (closed) throw new FactoryAuthError(403);
        try { await auth.checkOwner(identity); }
        catch (error) { close(); throw error; }
        if (closed) throw new FactoryAuthError(403);
      };
      const client: Client = {
        data: raw.data,
        get readyState() { return raw.readyState; },
        getBufferedAmount: () => raw.getBufferedAmount() + queued,
        close: (code = 1000, reason = "") => finish(code, reason, false),
        send(encoded) {
          if (closed) return 0;
          const bytes = Buffer.byteLength(encoded);
          if (++frames > 256 || queued + bytes + raw.getBufferedAmount() > OUTPUT_HARD_BYTES + LARGE_REPLY_BYTES) { close(); return 0; }
          queued += bytes;
          output = output.then(async () => {
            try {
              await check();
              if (raw.send(encoded) === 0) close();
            } catch { /* check closes and invalidates the connection */ }
            finally { queued -= bytes; frames--; }
          });
          return -1;
        },
      };
      raw.data.factoryAuthorize = check;
      connections.set(raw.data, { client, check, close, end: (code, reason) => finish(code, reason, false, false), incoming: 0, admission: Promise.resolve() });
      try {
        await check();
        // Idle connections also lose their attachment; activity always checks independently of this beat.
        let checking = false;
        timer = setInterval(() => {
          if (checking || closed) return;
          checking = true;
          void check().catch(close).finally(() => { checking = false; });
        }, 1000);
        timer.unref?.();
        await withFactoryAuthority(check, () => handlers.open(client));
      } catch { close(); }
    },
    async message(raw, message) {
      const connection = connections.get(raw.data);
      if (!connection) { raw.close(1008, "Factory access refused"); return; }
      // No unbounded waiters, and never a replay of received input after a failed check.
      if (++connection.incoming > 64) { connection.close(); connection.incoming--; return; }
      let handling: void | Promise<void>;
      // Admission order must not reorder terminal keys when registry replies have different latency.
      // The handlers themselves retain their existing concurrency (Stop and ACK cannot wait for a submit).
      const admission = connection.admission.then(async () => {
        await connection.check();
        auth.audit(raw.data.factoryIdentity!, "websocket.message");
        handling = withFactoryAuthority(connection.check, () => handlers.message(connection.client, message));
      });
      connection.admission = admission.catch(connection.close);
      try {
        await admission;
        await handling!;
      } catch { connection.close(); }
      finally { connection.incoming--; }
    },
    drain(raw) {
      const connection = connections.get(raw.data);
      if (!connection) return;
      void connection.check().then(() => withFactoryAuthority(connection.check, () => handlers.drain(connection.client))).catch(connection.close);
    },
    close(raw, code, reason) {
      const connection = connections.get(raw.data);
      if (connection) connection.end(code, reason);
      connections.delete(raw.data);
    },
  };
}
