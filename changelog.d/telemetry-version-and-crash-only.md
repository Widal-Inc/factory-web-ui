### Changed
- Telemetry sends only the version this install runs and, after a run that ended on an uncaught
  error, a fixed kind of error. It goes to the address in `WIDAL_TELEMETRY_URL` and to nowhere
  when that is unset: no collector address is built in. The notice and the switch in Settings say
  so, and the notice is shown again once.

### Removed
- The upstream telemetry collector, its Worker, its report scripts and the Worker release guard.
  Settings snapshots, install and update counts, daily activity, usage counts, install ids and
  the tapped-alert count are no longer collected, and an older state file loses them at the
  first start.
