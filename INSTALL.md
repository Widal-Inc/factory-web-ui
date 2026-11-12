# Widal Factory setup from source

This is the supported development setup for this fork. Shared Factory sign-in, Setup and Widal release/update integration are pending. Inherited installer scripts, marketplace entries and upstream native downloads are not a Widal distribution path.

## Prerequisites

Use Git, Bun 1.4+ and a running herdr 0.9.0+. CI pins Bun 1.4.2 and herdr 0.9.3 in [setup-ci](.github/actions/setup-ci/action.yml).

```bash
git --version
bun --version
herdr --version
```

Start herdr yourself in a terminal if needed. The app is a bridge and does not replace it. Do not stop the user's herdr session during setup or QA.

## Clone and run

```bash
git clone https://github.com/Widal-Inc/factory-web-ui.git
cd factory-web-ui
bun install --frozen-lockfile
```

On Linux and macOS, build the Rust PTY host if a Rust toolchain is available:

```bash
cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
```

Node 18+ is the fallback PTY host. With neither host, panes are mirrored; Windows uses the mirror. Never load node-pty inside Bun. Do not download upstream release binaries as a substitute for building this fork.

Run the API server with inherited telemetry disabled:

```bash
OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1 bun run server
```

In another terminal in the same checkout:

```bash
bun run dev
```

Open `http://localhost:5173`. Vite proxies `/api` and `/ws` to `localhost:7317`. The default herdr socket on Linux/macOS is `~/.config/herdr/herdr.sock` (on Windows, `%APPDATA%\herdr\herdr.sock`); set `HERDR_SOCKET` for another session. The examples pin `OVIS_RUNTIME=herdr` so a saved herdr-core choice cannot redirect them. Use a separate session for QA. If changing the backend's `PORT`, configure Vite's proxy consistently.

For a built client, stop Vite, run `bun run build`, then run the same server command and open `http://127.0.0.1:7317`. Stop the process you started when finished. These commands do not use the update supervisor. Avoid `bun run start`, plugin installation and native wrappers until [fork distribution](docs/app-updates.md) is integrated.

Examples use POSIX syntax. In PowerShell, set `$env:OVIS_TELEMETRY='0'`, `$env:OVIS_RUNTIME='herdr'` and `$env:HOST='127.0.0.1'` before `bun run server`.

## Access and data

Keep development on loopback. Current inherited authentication does not supply Widal's future shared sign-in. A proxy header alone does not establish a Factory identity. Do not publish a development port as a production Factory service.

This build sends nothing unless `WIDAL_TELEMETRY_URL` names an endpoint, and `OVIS_TELEMETRY=0` blocks it even then, regardless of the UI switch. Keep `OVIS_TELEMETRY=0` on every local run so a stray endpoint variable never sends anything ([what is sent](docs/guide.md#version-and-crash-reports)). The state directory is still `~/.config/ovis`; set `OVIS_STATE_DIR` to a dedicated directory when isolation is needed. Do not rename or delete existing state, cookies or keys as part of branding.

Agent previews follow [AGENTS.md](AGENTS.md): bind a throwaway preview to the chosen Tailscale address; keep tests on loopback with `port: 0`. An app installed from another device requires HTTPS; a `tailscale serve` backend stays on loopback. Neither preview path completes Factory sign-in or deployment integration.

## Verify

```bash
bun run check fast
```

Follow [development checks](docs/development.md#checks) for isolated integration/browser tests, temporary directories and platform checks.

If the page cannot reach herdr, verify the socket and runtime. If terminal attachment is unavailable, check the Rust or Node host; never take over a live pane automatically. Report fork bugs in [this repository](https://github.com/Widal-Inc/factory-web-ui/issues), and security problems [privately](SECURITY.md).
