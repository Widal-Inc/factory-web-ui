### Fixed
- A web release is numbered by the commits in its history, so a release built from a newer commit
  no longer reuses an older release's number (two different releases were both 43). The build
  refuses a shallow clone, and `bundle.json` keeps the bridge protocol as `remote_bundle_version`.
