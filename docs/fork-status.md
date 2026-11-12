# Fork documentation scope and integration status

Widal Factory is the current product name. The repository is [Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui). This documentation correction is based on source at `bb0d0f9b234e1c59b98e3ad01060b8d3dc4bd0e9`; it is independent of the implementation branch removing upstream authentication. Planned acceptance criteria are not treated as implemented behavior.

## Available now

The source checkout provides the React client, Bun bridge, herdr/herdr-core adapters and agent/transcript/terminal functionality. The supported workflow is [local source development](../INSTALL.md) with inherited telemetry disabled. Root package metadata identifies this fork; its inherited version is not a newly published Widal release.

No shared Widal brand configuration exists on this base. The docs use the requested display name, and preserve inherited artwork with its provenance. They do not supply a new logo or implement UI, manifest, email-sender or native packaging branding.

## Pending integration

| Area | Actual boundary |
| --- | --- |
| Factory pages and Setup | Not delivered by the current browser bridge or these docs |
| Shared sign-in and authorization | Still pending; arbitrary proxy headers are not authenticated Factory identity |
| Upstream account, relay, pairing, Portal and Tailscale-owner login | Removed from this fork's browser/server integration and retired as setup guidance. Inherited native-app source (`app/`) and store notes remain; they are not a supported Widal distribution path |
| Telemetry | Done: the server sends only its version and a crash's kind, to the address in `WIDAL_TELEMETRY_URL` and to nothing when that is unset. The upstream collector, its Worker and its report scripts are removed ([what is sent](guide.md#version-and-crash-reports)). Any further field waits for the owners' decision on what may be collected |
| Installers and updates | No supported Widal install URL or release channel is established; inherited launchers and feeds must be adapted |
| Remote-PC runtimes | The bundle resolver no longer falls back to an upstream manifest: it needs a local bundle or `OVIS_BUNDLE_MANIFEST`. The remote-PC installer (`server/pc-install.ts`) still runs the upstream installer; do not use automatic setup/update as Widal onboarding |
| Native apps and public demo | Source, workflows and legacy assets do not prove published Widal artifacts, signing or hosting |

## Audit coverage

The correction covers the main and Japanese, Korean and Simplified Chinese READMEs; source setup; contribution and security reporting; current agent guidance; active user, development, remote-PC, update, account, relay, native-app and artwork docs; technical references that used the former product name; and root `package.json`/lockfile metadata.

Retired guides link to immutable source history rather than offering executable upstream setup instructions. Native/service/store READMEs carry an explicit historical-reference banner. Prior audits, measurements and platform test results are labeled historical; they are not this fork's validation evidence. Runtime code, website pages, native package metadata and release workflows remain implementation follow-ups, with the current gaps listed above.

## Preserved-name allowlist

These references are intentional; they are not current product branding to replace globally.

| Location / form | Why it remains |
| --- | --- |
| `LICENSE`, `CLA.md`, `THIRD_PARTY_NOTICES.md`, vendor notices | Exact legal text, copyright and upstream authorship |
| README attribution sections, contribution/agent fork declaration | Truthful identification of Ovis as the upstream project; original contributor credits and copyright |
| Account/relay/native retirement notices and artwork provenance | Identify the retired product and inherited assets explicitly |
| `CHANGELOG.md`, released summaries, earlier changelog fragments | Historical release records; they must not be rewritten as Widal releases |
| Dated audits under `docs/`, `docs/reviews/`, and dated native findings in `docs/terminal-input.md` | Original upstream issue links, test evidence, source paths and literal UI strings |
| Existing `DESIGN.md` design entries | Historical implementation rationale and names such as the inherited `Ovis Hangul Mono` font; generated theme tables stay unchanged |
| Bannered native/service/store READMEs and `docs/relay-mux-limits.md` | Retained upstream build/protocol/deployment history; explicitly not Widal deployment instructions |
| `OVIS_*`, state paths, `.ovis`, `ovis:*`, cookies, protocol labels, binary paths and test-session names | Existing compatibility identifiers; renaming can break state or security-fix porting |
| Literal legacy error quoted in `docs/runtime-move.md` | Accurately reports the current implementation, not a release instruction |

The active technical prose uses Widal Factory. Repository links for clone, contributions and reports target this fork. External research/source-credit links remain attached to their original projects. The security advisory link is conditional on private reporting being enabled; no service availability is assumed.

## Verification method

Review the scoped diff and scan current docs with `rg -n 'Ovis|ovis\.sh|devswha/(ovis|herdr-web-ui)' README* INSTALL.md CONTRIBUTING.md SECURITY.md AGENTS.md docs`. Classify each remaining hit against the allowlist above. Inspect root metadata separately; do not expand the scan into mass identifier replacements in source.

Validate relative Markdown/HTML paths and heading fragments in changed current docs. Historical-only outbound references retain their original meaning; if a retired heading no longer exists, point its historical reference at the immutable original document. Check `bun run` names against `package.json`, the Vite proxy against `vite.config.ts`, and setup/runtime/telemetry claims against source. No link check should invoke installers or contact live user sessions.

Run the repo's required Fast checks before push within the witness's validation allocation. Record exact commands, head, results and skipped lanes in the bead/PR handoff. This documentation change adds no shared UI behavior, so it does not require new browser screenshots or production deployment.
