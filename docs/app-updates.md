# Fork updates and distribution

Widal Factory's release and update integration is pending. The repository still contains inherited installers, a managed supervisor, native feeds, bundle fallback URLs and publishing workflows. Do not use them as Widal installation/update routes or infer release availability from their presence.

## Source workflow

Use [setup from source](../INSTALL.md). `bun run server` and `bun run dev` do not update themselves. For a built client, use `bun run build` and the unmanaged server. To change versions, select a reviewed fork revision, run `bun install --frozen-lockfile`, rebuild and restart the server you own. Browser reload alone does not restart the backend.

Avoid `bun run start`, plugin installers, automatic update controls, beta channels and inherited native wrappers. Do not push `v*` tags to test distribution: installed upstream-compatible updaters may act on tags.

## Boundaries

The desktop update status keeps its inherited literal wording because older peers compare it exactly to avoid offering a replacement install. Product branding does not change this compatibility value.

- Fork-owned installers, publication, manifests, signing and update discovery need implementation and validation before releases are advertised.
- Remote-PC setup can fall back to an upstream manifest in `server/remote-bundle.ts`. Building a local bundle does not establish a remote distribution service.
- Telemetry has no built-in endpoint. The server sends its version and a crash's kind only to the address in `WIDAL_TELEMETRY_URL`, and nothing when that is unset ([what is sent](guide.md#version-and-crash-reports)). The inherited collector and its Worker are removed.
- Shared sign-in, Setup and factory pages are pending. A package name or README does not implement them.

## Historical provenance

The previous supervisor/rollback design, behavior references and verification notes remain in [Git history](https://github.com/Widal-Inc/factory-web-ui/blob/bb0d0f9b234e1c59b98e3ad01060b8d3dc4bd0e9/docs/app-updates.md). Those results are not validation of a Widal release. The chatmux references remain upstream attribution; no copied code is claimed.

See [development](development.md#releasing) and [fork status](fork-status.md).
