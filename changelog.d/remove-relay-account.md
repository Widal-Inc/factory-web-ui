### Removed
- The Ovis account and sign-in are gone, with everything built on them: Settings' Account group, the
  approval prompts for a device joining through the account, the account routes (`/api/account/*`) and
  `OVIS_ACCOUNT_SERVICE_URL`.
- The Ovis relay is gone: Settings' relay switch and its pairing QR code and typed code, the hosted app
  at `app.ovis.sh` (`bun run build:shell`, `dist-shell/`) and its release deploy, the relay service
  (`relay/`), the relay routes (`/api/relay/*`), `OVIS_RELAY_URL` and `OVIS_RELAY_APP_URL`. A PC can no
  longer be added through the relay (`POST /api/machines/relay*`); PCs over SSH are unchanged, and a PC
  saved through the relay before (`relay-pcs.json`) is no longer loaded. The plugin's `link` command,
  `pair --approve` and `POST /api/devices/pair/cancel` went with it, and `pair` prints only the
  address and pairing code.
- Devices lost what only the relay used: a device's key and how it is connected, and the `Check now`
  button. A PC no longer has a relay ID; alerts turned off for a PC are kept by its name.
