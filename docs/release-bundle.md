# The Widal web release

The web UI is never deployed on its own. The factory install ships it together with the hub and the
factory hosts, as one release archive that is built here and pinned to a commit of this repository.
Nothing is fetched from GitHub or built on the customer's account, and nothing is built on the hub. A
later marketplace image bakes in the same archive.

We decided on one archive, not two, because the owner server and the hub pages are one version of one
product: a hub page speaks to the owner server of the same commit, and a single pin and a single digest
say which one an install runs.

## What the archive holds

The archive is the fork's Linux x64 remote bundle, the format `widal install --factory-release` already
installs at `/opt/widal`, plus the hub UI and a small record of what it was built from.

| Path | What it is | Who uses it |
| --- | --- |
| `bundle.json` | `version` (the remote bundle version, `REMOTE_BUNDLE_VERSION`), `platform: linux-x64`, the Bun version | the factory install checks version and platform against its pin |
| `bin/bun`, `bin/node`, `bin/herdr` | the runtimes, pinned by checksum in `scripts/build-remote-bundle.ts` | every factory host |
| `server/index.ts`, `shared/`, `integrations/`, `dist/`, `node_modules/` | the owner server and the personal client it serves | every factory host runs `bin/bun server/index.ts` behind the load balancer |
| `hub-ui/` | the hub UI artifact: `index.html`, hashed `assets/`, brand images, notices, `build.json` and `widal-ui.json` ([format](hub-pages.md#the-hub-ui-artifact)) | the hub, started with `--ui-dir <where hub-ui/ is unpacked>` |
| `widal-release.json` | the commit and build time, and the two paths above | people and tools reading an unpacked release |

The factory host's service environment (`WIDAL_AUTH_MODE` and the rest) is not in the archive: it
belongs to the host and is described in [factory ingress and ownership](factory-auth.md#runtime-configuration).
Health is `GET /api/health`. The archive holds no secret and no build cache (`node_modules/.cache` is removed).

## The pin

`widal-web-release.json` is written next to the archive and is the one thing the install trusts:

```json
{
  "schema": "widal.web-release/1",
  "version": "43",
  "platform": "linux-x64",
  "source": { "repository": "Widal-Inc/factory-web-ui", "commit": "<40 hex>", "builtAt": "<commit time>" },
  "archive": { "file": "widal-web-43-<commit12>-linux-x64.tgz", "bytes": 0, "sha256": "<64 hex>" },
  "hubUi": { "path": "hub-ui", "manifest": "hub-ui/widal-ui.json", "revision": "<the same commit>", "manifestSha256": "<64 hex>", "files": 0 },
  "ownerServer": { "entry": "server/index.ts", "runtime": "bin/bun", "healthPath": "/api/health", "bun": "1.4.2", "rustPtyHost": false }
}
```

The install passes `version` as `--factory-release-version` and `archive.sha256` as
`--factory-release-sha256`, and reads the archive named by `archive.file`. `version` is the bundle protocol version the
factory checks against `bundle.json`; the commit and the digest are what tell two releases of the same version apart.
The hub UI's own revision (`GET /api/app/bootstrap` reports it as `ui.revision`) is always the pinned commit.

## Building it

```sh
bun run build:release          # in a clean checkout of the commit to release
bun scripts/release-bundle.ts verify release-bundles/widal-web-<...>.tgz release-bundles/widal-web-release.json
```

The build refuses to run unless the checkout is clean (the pin names a commit, and edits are not in it), the
machine is Linux x64, and the Bun is the one `package.json` pins in `packageManager`, because the archive
carries the builder's own Bun binary. It sets `SOURCE_DATE_EPOCH` to the commit time, builds `dist/` and
`dist-hub/`, builds the remote bundle, adds `hub-ui/`, and packs the result with sorted names, one fixed time,
no owner, plain modes and an unnamed, untimed gzip stream. The same commit built in the same runner image
therefore makes the same bytes. The build ends by running the verification on what it made.

`HERDR_BUNDLE_PTY_SIDECAR` may name the Rust PTY host to include, as for any remote bundle; without it the
archive relies on the bundled Node fallback and the pin says `rustPtyHost: false`. The remote bundle builder
downloads the runtimes it bundles and checks each against the checksum it pins, so the build needs network
access to those hosts. `WIDAL_RELEASE_OUTPUT` changes the output folder (`release-bundles/`, not committed).

## Verifying it

`verify` is what an installer should run before it trusts an archive: the archive is the pinned bytes; no
entry or link leaves its folder; the files a factory host needs are there and the programs are executable;
`bundle.json` has the pinned version and platform; there is no build cache; `hub-ui/` is exactly the release its own
`widal-ui.json` lists, the manifest is the pinned one, and `hub-ui/` and `widal-release.json` name the pinned commit.
The manifest checks are the same ones the factory hub's own reader applies
(`scripts/hub-artifact.ts`, [hub pages](hub-pages.md#the-hub-ui-artifact)).

## What this does not do

It builds and checks an archive. It publishes nothing, pushes no tag and creates no release; publication is its own
authorized step ([distribution status](development.md#releasing)). It does not install anything: placing `hub-ui/` on the hub, running the
owner server on every factory host behind the load balancer, and the fake cloud proof on what the install ships belong to the factory
repository. Bumping `REMOTE_BUNDLE_VERSION` is a separate release change.
