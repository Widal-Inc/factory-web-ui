### Fixed
- Chat follows a Copilot started with `--ui-server` in about half the time on a host whose TCP table
  is slow to read (a container, a busy PC): each check of the pane's process now reads that table
  once instead of three times. The process, its listener and the accepted connection are still
  proved again at the end of every read, and any difference still fails closed.
