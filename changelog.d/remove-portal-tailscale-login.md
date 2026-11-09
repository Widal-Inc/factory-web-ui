### Removed
- Portal, the optional public HTTPS address through a relay with its own sign-in (a private link, an
  Ethereum wallet or an OIDC account), is gone: its panel, its routes (`/api/portal`), its visitors
  and the `X-Portal-*` headers.
- The Tailscale login is no longer a way in. The server does not read `Tailscale-User-Login`, so
  `OVIS_TAILSCALE_OWNER` and `OVIS_TAILSCALE_SERVE_ONLY` are gone, and so are PCs on your Tailscale
  under Add a connection (they relied on that login). A request that came through a proxy or Tailscale
  Funnel is refused without the access token, `tailscale serve` included.
  `OVIS_TAILSCALE_HTTPS_PORT` and the `tailscale serve` address Settings suggests stay.
