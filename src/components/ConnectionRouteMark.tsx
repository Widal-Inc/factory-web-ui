import { useRef } from "react";
import { Globe, Monitor, Network, Wifi, type LucideIcon } from "lucide-react";

import type { ObservedIngress } from "../../shared/protocol.ts";
import { connectionRoute } from "../lib/connectionRoute.ts";
import { useT } from "../lib/i18n.ts";

/**
 * How this device reaches the Ovis it shows (lib/connectionRoute.ts), in the header at all times:
 * one glyph and one short word, the route said in its title whatever the connection's state (the
 * chip beside it tells that). It is about the page's own connection, which every PC the sidebar
 * lists shares, so it sits with the chip, not on a PC. Tailscale and LAN are names, the same in
 * every language.
 */
export function ConnectionRouteMark({ ingress }: { ingress: ObservedIngress | null }) {
  const t = useT();
  // the server's word on this page's requests holds through a failed health read, which clears the
  // facts it brought: a missing answer is no evidence of another route
  const known = useRef<ObservedIngress | null>(null);
  if (ingress !== null) known.current = ingress;
  const route = connectionRoute({ ingress: known.current, hostname: window.location.hostname });
  const [Icon, word, title]: [LucideIcon, string, string] =
    route === "tailscale" ? [Network, "Tailscale", t("Via Tailscale")]
    : route === "tailscale-name" ? [Network, "Tailscale", t("Via Tailscale, or Funnel from the internet")]
    : route === "lan" ? [Wifi, "LAN", t("Via the local network")]
    : route === "direct" ? [Globe, t("direct"), t("Straight to this address")]
    : [Monitor, t("local"), t("Via a loopback address: this PC, or a tunnel to it")];
  return (
    <span className="conn-route" data-route={route} title={title}>
      <Icon aria-hidden="true" />
      <span className="conn-route-word" aria-hidden="true">{word}</span>
      <span className="visually-hidden">{title}</span>
    </span>
  );
}
