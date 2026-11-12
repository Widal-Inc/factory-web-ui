# Widal Factory

This is Widal-Inc/factory-web-ui, a fork of Ovis. Follow [INSTALL.md](INSTALL.md) for the supported source workflow and [docs/fork-status.md](docs/fork-status.md) for pending integration. Shared sign-in, Setup, brand configuration and Widal distribution are not implemented by the documentation correction. Disable inherited upstream telemetry with `OVIS_TELEMETRY=0` for local runs. Do not invoke upstream installers, publish/deploy workflows, account/relay pairing or managed update paths as Widal onboarding.

City workers use their assigned isolated `polecat/<bead-id>` branch and hand it to the refinery; they do not open/merge the refinery's PR or push to main. Coordinate heavy checks with the witness and record actual commands, head and skipped coverage. Preserve legal/history attribution and runtime compatibility identifiers. No shared Widal brand configuration exists on this documentation base; do not invent a logo or claim UI branding has shipped.

Browser UI for the herdr terminal multiplexer: a React 19 + xterm.js client (`src/`), a Bun
backend (`server/`) that bridges herdr's unix-socket API, and the wire contract both import
(`shared/`). herdr owns every pty, scrollback and agent state; this app is only a bridge.

These files hold only the traps the code and tests do not show. Commands, layout, checks and
release steps are in [docs/development.md](docs/development.md); contributors follow
[CONTRIBUTING.md](CONTRIBUTING.md). Code conventions (imports, CSS tokens, i18n entries, fixed
sleeps, wording, icons) are enforced by the `conventions.test.ts` files, whose failures say what
to change. Also read [server/AGENTS.md](server/AGENTS.md) and [src/AGENTS.md](src/AGENTS.md).

## Bridge traps
- Never load node-pty inside Bun: it panics the runtime. PTY work goes through the Rust PTY host
  (`crates/pty-sidecar`), or the Node sidecar as its fallback, never in-process.
- Never pass `--takeover` to `herdr terminal attach` on the server's own initiative; it cuts off
  whoever holds the pane. Only a user's explicit take-over request may.
- One herdr RPC connection per call: herdr closes the socket after each answer. Only
  `events.subscribe` stays open, and a second subscribe on it is ignored, so reopen with the full
  set. Caching answers is fine.
- `pane.process_info` takes `pane_id`, not `target` (with `target` herdr answers for the focused
  pane).
- Keep xterm `scrollback: 0` and never rebuild an attached terminal from `pane.read`: the attach
  stream is the truth. Except on a herdr-core server (`terminal-history`): nothing there scrolls,
  so xterm keeps the history its attach replays. Only a mirrored pane (Windows, or no PTY host:
  neither the Rust host nor Node) is drawn from `pane.read`, so never assume a pty exists.
- Nothing the user typed is sent automatically after a disconnect: it waits in a draft until the
  user sends or discards it.
- Prompt answers go through `POST /api/pane/prompt/answer`, never guessed digit keys.
- Selecting a pane or tab in the browser never moves herdr's own focus; only an explicit action
  that needs it calls `pane.focus`.
- Never edit `shared/herdr-api.generated.ts` or `server/herdr-core/hc-api.generated.ts`; run
  `bun run generate:types`.
- Theme colors are edited only in the theme blocks of `src/styles.css`. Never edit
  `src/lib/themes.generated.ts` or the generated copies in DESIGN.md, index.html and
  `public/manifest.webmanifest`; run `bun run generate:themes`.

## Tests and QA
- Tests never touch the user's herdr session or real state: they use the isolated test session,
  a `mkdtempSync` `stateDir` and `port: 0` for every `createServer`. Never run the real
  `herdr update` in a test.
- Screenshots and recordings come from the demo or a test session, never the user's live one.
- A Widal Factory server an agent starts for someone to open (manual QA, a preview) binds to this PC's
  Tailscale address, not loopback: `HOST=$(tailscale ip -4) PORT=<free port> bun run server`,
  then hand over `http://<that address>:<port>`. A Tailscale-only bind stays inside the tailnet
  (`lanExposed` in `server/access.ts`); never bind `0.0.0.0` for it. Tests keep `port: 0` on
  loopback.
- That bind is for a throwaway preview only. A server someone installs as an app from another
  device needs HTTPS (only `localhost` installs over plain http): bind it to `127.0.0.1` and let
  `tailscale serve` add the address. Moving a port that `tailscale serve` already fronts to the
  Tailscale address breaks that HTTPS address.
- Upstream maintainer services, tailnet addresses, Macs and Windows VMs are not this fork's QA infrastructure. Use this city's authorized isolated test environments; do not drive someone else's machine or stop a live app. Native platform checks require their own coordinated environment.
- On this PC `/tmp` is a small tmpfs that runs out of inodes: run `bun run check fast`, tests
  and review checkouts with `TMPDIR=$HOME/.cache/ovis-tmp/<name>` (create it first, delete it
  when done).
- A UI change touching a shared component (FilesDialog, RepoChanges, the sidebar, selection or
  focus, the terminal view) runs the browser regressions that cover it (the
  `scripts/*-regression.ts` and `scripts/*-qa.ts` that name it) in the CI runner image before it
  is ready for review, even when the new behaviour is opt-in.

## Maintainer workflow
- A session that changes code, in any harness, stops at an open PR: only the maintainer's merge
  pass merges, unless the maintainer asks that session to merge. One session that edits files per
  worktree; read-only sessions may share it.
- A worktree an agent adds with `git worktree add` that outlives its session (an open PR) goes
  under `~/.herdr/worktrees/herdr-web-ui-wt/`, named after its branch with `/` as `-`
  (`fix/pin-order` in `herdr-web-ui-wt/fix-pin-order`); a short-lived one may stay in the run's
  temp root, and skills that name their own path keep it. Once its PR merges, remove the
  worktree and its branch.
- After a merge, the merge pass also closes the herdr worktree workspace the PR came from (the
  one checked out on the PR's branch, under `~/.herdr/worktrees/herdr-web-ui/`), only when all
  hold: no pane in it has an agent `working`, `git status` there is clean, and the branch's tip
  is the PR's head commit (`gh pr view --json headRefOid`), so nothing was added after it. Close
  it with `herdr worktree remove --workspace <id>`, never `git worktree remove`, so the
  workspace leaves with its checkout. herdr keeps the branch: then `git branch -D` it (a squash
  merge leaves it unmerged to git; GitHub already deletes the remote one). A workspace that
  fails a check stays, and the merge report names it and why. A session never removes the
  worktree it runs in.
- Everything written to git and GitHub (commits, branches, PRs, reviews, issues, changelog
  fragments) is in English.
- Never push a `v*` tag by hand: installed updaters act on tags alone.
- Widal release integration is pending ([status](docs/development.md#releasing)); no session publishes inherited artifacts or tags as Widal releases. A release needs its own authorized workflow. If an authorized release PR raises `REMOTE_BUNDLE_VERSION`, the merge
  pass merges nothing touching `server/`, `shared/`, `bun.lock` or `patches/` from its merge until
  the Release run is done.
- Required checks: Fast checks, Integration and browser, Native Windows install. Resolve review
  threads before merging (branch protection does not enforce it).
- The merge pass may merge on a local merge gate instead of waiting for GitHub's runs. On a
  freshly fetched `origin/main` with the PR head merged in (nothing pushed), it runs CI's release
  guards, then four groups side by side, each in a checkout and container of its own of the
  self-hosted CI runner image, as the image's own user: Fast checks, the integration suite and
  CI's two browser jobs (the second with 16 workers). The containers get CPUs 64-127, the CI
  runner containers move to 0-63 while it runs, and herdr's panes stay on 0-95. CI's change
  filter picks the groups: a docs-only PR runs Fast checks alone, a PR changing only `src/` runs
  only the integration files that import `src/`. The suites see none of the host's environment
  or credentials, but the release guards and `bun install` run on the host, so an external PR is
  gated only after its diff has been reviewed.
- The gate posts its result and the `main` commit it ran on as a "Local merge gate" PR comment;
  the merge pass then squash-merges with `--admin --match-head-commit` at the gated head (branch
  protection lets admins bypass the required checks), with a clear review at that head and no
  unresolved threads. As with a merge on GitHub's checks (branches need not be up to date),
  `main` may have moved meanwhile, and main's own CI run checks the result. An integration file
  whose every failed test ran 2 s or more, or failed on a timeout or a start that never came, is
  rerun once and listed in the comment; any other failure is red. A PR still waits for GitHub's
  checks when it touches what only GitHub's runners check: `app/`, `crates/`, a `.ps1`,
  `install.*`, `.github/`, `package.json`, `bun.lock`, `patches/`, `scripts/plugin*`, or the
  files of a test that the Windows or macOS jobs of `ci.yml` run (`server/grok.test.ts` covers
  `server/grok*`).
- Run `bun run check fast` before every push, and push a PR's commits together: each push to a
  PR cancels its CI run in progress and starts every job again.
- A handoff or a PR's Validation says which checks ran (`bun run check fast`, `full`, or which
  single commands and files) and which were skipped. No pre-push hook stands in for this line.
- CodeRabbit's reviews are rationed per PR author, and agents open their PRs as one account:
  opening a PR, a push and each `@coderabbitai review` spend one, and past about 80 in a week
  one comes back per hour. Open verified work ready for review, not as a draft: the merge pass
  reviews every PR itself and stops at a draft. A draft is only for work still unfinished; push
  it once when it is ready. Do not open a stack of PRs at once, and ask for another review
  only after a commit that changes behaviour in `server/`, `src/` or `shared/`, an HTTP/WS
  contract or a workflow. A rebase, changelog fragment, docs, comment or test-only commit gets
  none.
- A rate-limited or skipped review still shows a passing CodeRabbit check; its "Review limit
  reached" or "Review skipped" comment means no review ran. CodeRabbit skips a PR of more than
  150 files, so a PR that needs a review stays under that.
- A PR touching `--takeover`, observe permissions, queued input, authentication, an HTTP/WS
  contract or a workflow waits for a real review. When CodeRabbit skips it, a code-review agent's
  review stands in: its findings and how each was resolved go in a PR comment before the merge.
- A move-only PR (files moved or split, imports updated, no behaviour change) does not wait for
  CodeRabbit: it merges on its checks once its diff shows only moved code and import paths
  (`git diff --color-moved origin/main...HEAD`). Every PR merged without a CodeRabbit review
  says so in a comment, and any other PR merges on its checks and the maintainer.
- Changelog entries go in `changelog.d/` fragments ([format](changelog.d/README.md)), not
  CHANGELOG.md; only a release folds them in.
