### Fixed
- A factory's Setup renews its Linear token and takes back "ready" on its own, every minute, so
  `factory-setup.json` never says ready once the GitHub or Linear token has expired; the status and the
  record carry when each token expires, and the Setup page says when the GitHub connection ends.
- Setup keeps the lines of the factory's secrets file it does not own (comments, `export` lines, empty
  values, CRLF endings) and writes the file durably through a private temporary file.
- Setup reports saved repositories the organization's GitHub App no longer reaches and is not ready until
  the choices are saved again; a saved Linear team that is gone is no longer kept selected.
- A second Setup tab cannot save its choices under a GitHub or Linear account connected since it loaded,
  a new factory owner's Setup removes the previous owner's credentials, and the Linear callback code is
  never sent again when the hub page's data is refreshed.
- The Admin onboarding view no longer stays busy after the first invite in development builds.
