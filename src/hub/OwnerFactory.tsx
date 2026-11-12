import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getTransport, nativeTransport, setTransport, type Transport } from "../lib/transport.ts";
import type { ReaderTarget } from "../lib/fileReader.ts";
import { directTransport } from "./directTransport.ts";

// The fork's own App (chat, terminal, answer cards, state grouping) is the live view; it is loaded
// only when an owner opens it, so the pages that never need it do not download it.
const FactoryApp = lazy(() => import("./FactoryApp.tsx"));

/**
 * The live view of the signed-in person's own factory. HubApp renders this slot only for a ready,
 * registered factory they own, whose live origin matches its registered HTTPS address; the factory
 * server still decides, per request, whether the signed identity owns it. A page holds one live
 * view at a time, because the App reaches its server through one process-wide transport. The view
 * gives that transport back when it unmounts (a page refresh unmounts it), so the person can open
 * their factory again without reloading the document.
 */
export function OwnerFactory({ factory, origin, reader }: { factory: string; origin: string; reader?: ReaderTarget }) {
  const [open, setOpen] = useState(reader !== undefined);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installed = useRef<Transport | null>(null);
  // React runs a parent's unmount cleanup before its children's, and the App's own cleanup may still
  // make a request through the transport. So the transport is given back one microtask later, and only
  // if it is still this view's: a view opened since keeps its own.
  useEffect(() => {
    if (!open) return;
    // StrictMode may replay this effect before its deferred release. Reacquire only our own
    // previous transport; another view's transport still refuses the connection.
    if (getTransport() !== nativeTransport && getTransport() !== installed.current) { setError("Another factory view is already open on this page."); return; }
    try {
      const transport = directTransport(origin, window.location.origin);
      setTransport(transport);
      installed.current = transport;
      setConnected(true);
      return () => { queueMicrotask(() => { if (getTransport() === transport) setTransport(nativeTransport); }); };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The factory could not be reached.");
    }
  }, [open, origin]);
  if (error) return <p role="alert" className="hub-muted">{error}</p>;
  if (!open) return <p><button type="button" className="btn" onClick={() => setOpen(true)}>{`Open ${factory}`}</button></p>;
  const loading = <p className="hub-muted" role="status">Loading the live view…</p>;
  return <div className={reader ? "hub-owner-reader" : "hub-owner-live"}>{connected ? <Suspense fallback={loading}><FactoryApp factory={factory} reader={reader} /></Suspense> : loading}</div>;
}
