### Added
- `bun run build:hub` builds the factory hub pages (My Factory, Team, Quality and Admin) into
  `dist-hub/` as a separate artifact of public files only, with a `hub-manifest.json` that lists
  each file's sha256 and the hub API version it was built for. The My Factory page opens the
  signed-in person's own factory through the direct transport.
