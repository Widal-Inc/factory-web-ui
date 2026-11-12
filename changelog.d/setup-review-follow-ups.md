### Fixed
- Owner Setup retries a failed Linear renewal before the token runs out, and stops asking once Linear
  refuses the refresh token for good. A GitHub token that GitHub rejects now shows as expired, and a
  repository is no longer reported lost from a listing that stopped at a limit or from a GitHub outage.
- Owner Setup lists every page of a large GitHub installation, reuses a fresh list for the choices page,
  and does not repeat a failed listing at once. A change of owner takes the previous owner's `ready` back
  first and clears their credentials on any first request, a disconnect or a Linear start included.
- The factory's secrets file is read and written as raw bytes, so a line that is not UTF-8 is kept, and
  Setup refuses a token that holds a character a shell would not take literally. Stopping the server waits
  for the Setup turn in flight.
