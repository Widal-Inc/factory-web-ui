import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getTransport, nativeTransport, setTransport, type Transport } from "../lib/transport.ts";
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
export function OwnerFactory({ factory, origin }: { factory: string; origin: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installed = useRef<Transport | null>(null);
  // React runs a parent's unmount cleanup before its children's, and the App's own cleanup may still
  // make a request through the transport. So the transport is given back one microtask later, and only
  // if it is still this view's: a view opened since keeps its own.
  useEffect(() => () => {
    const mine = installed.current;
    installed.current = null;
    if (mine) queueMicrotask(() => { if (getTransport() === mine) setTransport(nativeTransport); });
  }, []);
  function start() {
    if (getTransport() !== nativeTransport) { setError("Another factory view is already open on this page."); return; }
    try {
      const transport = directTransport(origin, window.location.origin);
      setTransport(transport);
      installed.current = transport;
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The factory could not be reached.");
    }
  }
  if (error) return <p role="alert" className="hub-muted">{error}</p>;
  if (!open) return <p><button type="button" className="btn" onClick={start}>{`Open ${factory}`}</button></p>;
  return <div className="hub-owner-live"><Suspense fallback={<p className="hub-muted">Loading the live view…</p>}><FactoryApp /></Suspense></div>;
}
