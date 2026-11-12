# Web app branding

The web client and bridge read their product identity from [`shared/brand.json`](../shared/brand.json).
It selects the product name, home-screen name, description, logo, browser and notification icons,
and default theme. The theme is an existing theme-block id from `src/styles.css`; colour values
are authored only in those blocks. A browser's saved appearance continues to take precedence.

After editing the configuration, regenerate the static metadata and theme copies:

```sh
bun scripts/brand-metadata.ts
bun run generate:themes
```

The build refuses stale brand metadata. `bun scripts/brand-metadata.ts --check` verifies it without
writing. Web manifest identity, start URL and scope stay stable when the display name changes.
The legacy `OVIS_APP_NAME` environment override still changes an individual installation's
home-screen label for compatibility; it does not rename the product itself.

The default logo is the vector in `public/brand/mark.svg`. To replace the artwork, set `logo` and
`iconSource`, then run `bun scripts/generate-brand.ts` with ffmpeg built with SVG support. This
exports the standard web PNG/ICO files. Keep the mark inside the central safe circle for maskable
icons. Configured icon URLs can also point to supplied same-origin public assets. Change their
version query when replacing their bytes so existing installations fetch the new art. The
notification badge must be a monochrome mark on transparency.

`shared/brand.ts` exports `BRAND` for other web entry points. The current web app uses it for
its headers, title, install metadata, notifications and authored bridge messages. Legacy
translation keys remain lookup keys; their product name is substituted before user variables
are filled, so user text is preserved. Storage keys, environment variables, protocol markers,
native plugin names and other compatibility identifiers retain their existing spelling.

The configuration also reserves an email sender name and address. The address defaults to null
and `emailSender()` returns null until it is configured. This bridge sends no invitations or
email; connecting the hub's mail delivery to this configuration is unfinished integration.

The legacy account, relay and native-shell paths are being removed separately. This brand change
does not claim to complete sign-in, telemetry, distribution, hub pages or the factory outcome.
Legal notices, upstream credits and historical release records retain their original attribution.
