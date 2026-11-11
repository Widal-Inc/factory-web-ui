# Remote PCs over SSH

Widal Factory inherits SSH discovery, setup and routing from its upstream browser bridge. These are implementation capabilities, not a completed Factory onboarding or remote-distribution service. Shared sign-in and Setup remain pending.

## Current development boundary

Use the [local source workflow](../INSTALL.md) first. The remote bundle resolver in [server/remote-bundle.ts](../server/remote-bundle.ts) still has an upstream release-manifest fallback. Do not use automatic installation, **Install and connect**, **Install app**, or update-all controls as Widal setup instructions. Fork-owned runtime distribution and update integration need implementation and verification.

Developers working on remote support can inspect [scripts/build-remote-bundle.ts](../scripts/build-remote-bundle.ts), `bun run build:remote`, and the `OVIS_BUNDLE_MANIFEST` override. A locally built manifest is not a published or supported Widal runtime release. Review its paths and artifacts before any remote mutation.

## SSH behavior

The connection server uses its operating-system account's OpenSSH configuration and ssh-agent; the browser does not open SSH. Each registration selects a target herdr socket. The inherited setup reads saved herdr machine profiles and local SSH candidates; discovery alone does not grant setup permission.

Verify a new host fingerprint against the target PC. A changed host key must fail closed. Setup approval, remote installation, key registration and bridge startup are separate operations. Do not stop or replace an existing herdr daemon to make setup succeed.

Remote operations execute as the target SSH account. App-specific private keys stay on the connection server; only public keys belong in remote `authorized_keys`. Never commit real keys, hosts, credentials or transcripts as fixtures.

### Windows PCs

The inherited Windows transport uses OpenSSH and terminal mirroring. Native Windows validation needs its own authorized test environment; source presence is not a supported Widal native release. See [native-app status](native-app.md).

## Runtime and endpoints

```text
Browser → connection server → OpenSSH local forward → remote loopback bridge → herdr socket
```

The bridge reuses this backend. Conversation reads, file operations and input are scoped to the selected PC. The browser's selected pane does not change another PC's herdr focus. The HTTP/WebSocket contract lives in [shared/protocol.ts](../shared/protocol.ts) and [server/machine-api.ts](../server/machine-api.ts).

Legacy local paths and a WebSocket without a machine destination mean the local PC. A terminal connection keeps its destination for its lifetime. Do not reconnect an input stream to a different PC or use `--takeover` automatically.

## Disconnects and updates

Connection state is separate from pane identity. During a disconnect, unsent input stays in the destination's draft until the user sends or discards it. Do not retarget it when another machine becomes selected.

The inherited remote update and bridge-restart code is not a Widal release channel. Never offer an upstream runtime as a fork update. Follow [distribution status](app-updates.md) before enabling remote installation or update controls.

## Verification

Use isolated SSH targets, private test state and the commands in [development checks](development.md#checks), including `bun run test:ssh` when changing remote transport. Never point integration tests at a user's PCs or session.

The full upstream design, consent model, API table and prior test results remain in [Git history](https://github.com/Widal-Inc/factory-web-ui/blob/bb0d0f9b234e1c59b98e3ad01060b8d3dc4bd0e9/docs/remote-pcs.md). They are historical evidence, not validation of a Widal deployment. [Retired relay guidance](relay.md) does not provide an alternate supported onboarding path.
