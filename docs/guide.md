# Widal Factory user guide

[README](../README.md) · [Setup](../INSTALL.md) · [Development](development.md) · [Fork status](fork-status.md)

Widal Factory is being built from a terminal-and-agent browser client. This guide describes the source workflow available now. Factory pages, shared sign-in and Setup are pending integration; inherited account, relay, pairing and release controls are not supported Widal onboarding.

## Quick start

Follow [setup from source](../INSTALL.md). Run `bun run server` with `OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1`, and `bun run dev` in another terminal. Open `http://localhost:5173`. For a built client, use `bun run build` and the unmanaged server on `http://127.0.0.1:7317`.

The sidebar shows the selected herdr session's workspaces. Each workspace contains tabs and panes. A browser tab is separate from a herdr tab. Pick a pane to read its conversation or use its terminal. Selecting a pane in the browser does not move herdr's own focus.

**New workspace** creates a workspace; **New tab** adds a tab. Pane menus offer rename, split, zoom and close where the runtime supports them. These actions change the underlying session; use an isolated test session for QA.

## Supported agents

Support varies by installed CLI version, runtime and transcript format. The source of truth is [the agent catalog](../shared/agent-catalog.ts); [catalog documentation](agent-catalog.md) describes availability checks. The browser reads supported native transcripts rather than starting another conversation service. A pane without a verified reader remains a terminal.

Agent installation, provider authentication and subscription credentials belong to those tools, separately from pending Factory sign-in. See [agent commands](agent-commands.md) for command and reader contracts.

## Features

- **Chat:** read supported transcripts, open folded tool activity and copy answers. Agent conversation history is separate from the herdr session.
- **Prompt cards:** answer through the verified server endpoint, never with guessed digit keys.
- **Terminal:** attach through a PTY host where available, or use a screen mirror. The attach stream owns terminal output.
- **Files and changes:** inspect the selected pane's working directory and repository with the server account's permissions.
- **Drafts:** unsent text belongs to its PC and pane. A disconnect keeps it as a draft; sending or discarding is explicit.
- **Navigation:** select workspaces, tabs and panes without moving herdr's focus just by browsing.

The inherited UI may show features outside this workflow while the fork is adapted. Their presence does not establish a Widal service, release or security guarantee.

## Subscription usage

Usage panels read supported agents' provider credentials and limits. They are not Factory account or billing status. Agent CLIs own OAuth refresh tokens; the bridge must not refresh them. See [server guidance](../server/AGENTS.md).

## Voice input

The inherited voice implementation can send audio to an OpenAI-compatible service configured by `OVIS_OPENAI_API_KEY` and `OVIS_OPENAI_BASE_URL`. This is separate from telemetry. Review provider configuration before enabling it; no Widal voice service is supplied here.

## On your phone

No Widal phone onboarding or store build is documented as supported here. Do not scan upstream pairing codes or use its hosted relay app as Factory login.

Browser home-screen installation requires a suitable secure origin. A development server or installed shortcut does not provide shared sign-in or Setup.

## Remote PCs over SSH

The code includes discovery, SSH setup and bridge routing. [Remote PCs](remote-pcs.md) describes the limits. Runtime distribution still has upstream fallbacks; do not start automatic remote installation or updates as Widal onboarding.

### One always-on PC for all your PCs

A connection server routes operations to the selected PC. This inherited topology is not a Factory deployment recipe. Multi-user exposure needs the pending shared identity and authorization integration.

## Access and safety

Anyone allowed to control a pane can run commands with its permissions. Keep source development on loopback and use an isolated session for testing. Current development authentication does not supply Factory authorization.

The account service, relay, device pairing, Portal and Tailscale-owner login are removed from this fork. The bridge token remains for source development and for SSH-connected PCs. Shared sign-in, signed proxy identity validation, owner authorization and Setup remain pending. An arbitrary identity header must not be trusted.

### On your LAN over HTTPS

No Widal LAN deployment recipe is supplied yet. HTTPS protects transport; it does not supply Factory authorization. Previews follow [AGENTS.md](../AGENTS.md).

### Behind a reverse proxy

An unmanaged source server is not a production Factory service. Do not configure public access using retired token/pairing instructions. Shared sign-in and deployment need their own implementation and review.

## Herdr app terminals

The inherited backend can select herdr or herdr-core. `OVIS_RUNTIME=herdr-core` and `OVIS_HC_BIN` select an installed core; see [layout](herdr-core-layout.md) and [runtime-move implementation](runtime-move.md). Normal development uses an existing herdr session. Migration can end and restart agents; it is not required for setup.

## Configuration

`OVIS_*`, `.ovis` attachments and `ovis:*` browser storage are compatibility identifiers. Before the upstream rename the variables were `HERDR_WEB_*` (`HERDR_WEB_UI_REF` for `OVIS_REF`); legacy aliases remain. Do not mass-rename variables or stored state while changing documentation.

| Variable | Current default / use |
| --- | --- |
| `HOST` | `127.0.0.1`; keep local development on loopback |
| `PORT` | `7317`; Vite's proxy expects this port |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock`; select another session explicitly for QA |
| `OVIS_STATE_DIR` | `~/.config/ovis`; override for isolated state |
| `OVIS_TELEMETRY` | Set to `0` in the fork workflow; the inherited default is not Widal policy |
| `DO_NOT_TRACK` | `1` also blocks inherited telemetry |
| `OVIS_RUNTIME` | `herdr` or `herdr-core`; unset uses the runtime resolver |
| `OVIS_HERDR_BIN` | `herdr`; executable for terminal attachment |
| `OVIS_HC_BIN` | Optional explicit installed herdr-core executable |
| `OVIS_SSH` | OpenSSH executable override |
| `OVIS_PASTE_DIR` | `<pane cwd>/.ovis`; pasted files |
| `CODEX_HOME` | `~/.codex`; agent conversation store |

More legacy settings remain in source. Inspect the relevant implementation before using one; listing them as Widal onboarding would be misleading. See [fork status](fork-status.md).

## Updates

Select a reviewed fork revision, reinstall dependencies as needed, rebuild and restart your unmanaged server. Browser reload alone does not restart server code. Do not use upstream installers, automatic updates, beta channels or native feeds. See [update status](app-updates.md).

## Anonymous usage counts

Set `OVIS_TELEMETRY=0` before starting the server. The inherited implementation can otherwise contact an upstream collector after notice acknowledgement. Its removal/replacement and a restricted Widal schema are separate pending work, not shipped by these docs.

Transcript reads, SSH, provider usage checks, voice services and agent tools are separate data paths. Disabling telemetry does not stop those operations or make the app offline.

## Keyboard shortcuts

Use the command palette and current platform's UI hints. Terminal keys go to the selected pane. See [terminal input](terminal-input.md) for drafts, composition and readiness. Closing or interrupting a pane affects the underlying process.

## How it works

```text
Browser → React client → Bun HTTP/WebSocket bridge → herdr socket → agent / terminal
```

Both sides import the contract from `shared/`. herdr owns PTYs, scrollback and agent state. The browser keeps view state and drafts. The bridge reads verified transcripts and routes actions to the selected pane. A remote PC adds SSH transport and a remote bridge.

## FAQ

**Is this a hosted Factory service?** Not yet. Shared sign-in, Setup and factory pages are pending.

**Where are installers, a demo and native releases?** No Widal distribution endpoint is established here. Run from source; upstream artifacts install a different product.

**Why are old identifiers and icons present?** They belong to compatibility state and inherited assets. Runtime branding is separate work. Legal and historical attribution remains truthful.

**Does the server need to stay running?** Yes. The browser needs the bridge and the selected terminal runtime to reach a pane.
