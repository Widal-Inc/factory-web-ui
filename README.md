# Widal Factory

The web app for managing software factories, built in [Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui).

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

This fork currently provides a React browser client and a Bun bridge to [herdr](https://github.com/herdrdev/herdr): workspaces, agent conversations, prompt cards, files and live terminals. herdr owns the terminals and agent state. Factory-specific pages, shared sign-in and Setup are pending integration; this checkout does not provide a finished hosted Factory service.

## Run from source

Use Git, Bun 1.4+ (CI pins 1.4.2), and a running herdr 0.9.0+. Attached terminals on Linux and macOS need the Rust PTY host or Node 18+ as a fallback; without either, panes are mirrored. Windows uses the mirror. See [setup](INSTALL.md) for details.

```bash
git clone https://github.com/Widal-Inc/factory-web-ui.git
cd factory-web-ui
bun install --frozen-lockfile
```

In one terminal:

```bash
OVIS_TELEMETRY=0 OVIS_RUNTIME=herdr HOST=127.0.0.1 bun run server
```

In another:

```bash
bun run dev
```

Open `http://localhost:5173`; Vite proxies API and WebSocket requests to port 7317. Use a separate test herdr session for QA. For a built client, run `bun run build`, then the same server command and open `http://127.0.0.1:7317`.

## Current scope

- Read supported agents' transcripts, answer verified prompt cards and use the terminal view.
- Browse the selected workspace's files and changes. Operations run on the selected PC.
- Keep unsent drafts through reconnects; sending remains an explicit action.
- Develop and validate the fork locally. [Remote-PC setup](docs/remote-pcs.md) needs separate runtime-distribution work.

The inherited UI, icons, installers and service code are still being adapted. No Widal install URL, public demo, native download or release channel is established here. Do not use upstream installers or update controls for this fork. See [distribution status](docs/app-updates.md).

Local commands disable inherited upstream telemetry with `OVIS_TELEMETRY=0`. This documentation change does not remove that implementation or establish a Widal endpoint. Do not assume that the app is account-free, that nothing leaves the PC, or that shared Factory sign-in is enforced. See [access and telemetry](docs/guide.md#access-and-safety).

## Docs and contributions

- [Setup from source](INSTALL.md) and [user guide](docs/guide.md)
- [Development and checks](docs/development.md), [contributing](CONTRIBUTING.md) and [agent instructions](AGENTS.md)
- [Fork audit and compatibility names](docs/fork-status.md)
- [Report a bug](https://github.com/Widal-Inc/factory-web-ui/issues) or [report a security issue privately](SECURITY.md)
- [Design conventions](DESIGN.md) and [historical changelog](CHANGELOG.md)

## Upstream attribution

Widal Factory is a fork of [Ovis](https://github.com/devswha/ovis). Upstream copyright, legal notices and historical authorship are preserved. Existing artwork is inherited; this documentation does not supply a new Widal logo.

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

[MIT](LICENSE). Copyright © 2026 devswha. See [third-party notices](THIRD_PARTY_NOTICES.md).
