### Added
- `bun run build:release` builds the Widal web release: the owner server and the hub UI in one reproducible
  Linux x64 archive, with a pin naming its commit, digest and hub UI manifest, and a `verify` command that
  checks them. See docs/release-bundle.md.
