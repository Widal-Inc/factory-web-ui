### Fixed
- A failed installer download over SSH is reported under the app's name even when the name holds
  quotes, `$` or backticks: the name is now quoted for the remote shell, so the failure is still
  recognised and a stopped server started by hand is started again.
- The reason a remote server gives for not updating, and the developer-console warnings, use the
  app's name instead of the upstream one.
