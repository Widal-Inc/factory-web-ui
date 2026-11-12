import { lazy, Suspense, useState } from "react";
import { getTransport, nativeTransport, setTransport } from "../lib/transport.ts";
import { directTransport } from "./directTransport.ts";

// The fork's own App (chat, terminal, answer cards, state grouping) is the live view; it is loaded
// only when an owner opens it, so the pages that never need it do not download it.
const FactoryApp = lazy(() => import("./FactoryApp.tsx"));

/**
 * The live view of the signed-in person's own factory. HubApp renders this slot only for a ready,
 * registered factory they own, whose live origin matches its registered HTTPS address; the factory
 * server still decides, per request, whether the signed identity owns it. A page holds one live
 * view at a time, because the App reaches its server through one process-wide transport.
 */
export function OwnerFactory({ factory, origin }: { factory: string; origin: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function start() {
    if (getTransport() !== nativeTransport) { setError("Another factory view is already open on this page."); return; }
    try {
      setTransport(directTransport(origin, window.location.origin));
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The factory could not be reached.");
    }
  }
  if (error) return <p role="alert" className="hub-muted">{error}</p>;
  if (!open) return <p><button type="button" className="btn" onClick={start}>{`Open ${factory}`}</button></p>;
  return <div className="hub-owner-live"><Suspense fallback={<p className="hub-muted">Loading the live view…</p>}><FactoryApp /></Suspense></div>;
}
