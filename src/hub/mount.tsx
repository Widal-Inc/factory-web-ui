import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../fonts/fonts.css";
import "../styles.css";
import { HubApp, type HubSlots } from "./HubApp.tsx";

/** Artifact integration supplies the shared brand and reviewed direct-owner/onboarding adapters. */
export function mountHub(container: HTMLElement, slots: HubSlots): Root {
  const root = createRoot(container);
  root.render(<StrictMode><HubApp {...slots} /></StrictMode>);
  return root;
}
