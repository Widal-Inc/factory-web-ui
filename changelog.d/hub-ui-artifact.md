### Added
- `bun run build:hub` builds the factory hub pages (My Factory, Team, Quality and Admin) into
  `dist-hub/` as a separate artifact of public files only, with a `widal-ui.json` release manifest in
  the factory hub's own format (full commit id, hub API range, size and sha256 of each file, source
  and build time). The legal notices travel with it as HTML pages, and the build needs a Git checkout.
  The My Factory page opens the signed-in person's own factory through the direct transport, and
  gives that transport back when the page refreshes, so the factory can be opened again.
