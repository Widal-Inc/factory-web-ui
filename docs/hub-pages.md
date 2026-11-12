# Hub page components and integration boundary

The new components in `src/hub/` prepare the fork's My Factory, Team and Admin pages. They are
independent of the personal factory app entry (`src/main.tsx`), which is unchanged. `src/hub/main.tsx`
is their production entry: it calls `mountHub(container, slots)` with the name and logo from the shared
`BRAND` config and the owner view below. See [the artifact](#the-hub-ui-artifact).

We decided to keep dashboard requests separate from the personal factory transport. The hub owns
work-item and registration data. The personal factory owns sessions, chat, terminal, prompts and
subscription limits. Selecting a Team item cannot create a personal connection. Admin registration
visibility gives no right to open another person's sessions.

The navigation and work summaries follow the status-and-context approach in
[Warp's vertical tabs](https://docs.warp.dev/terminal/windows/vertical-tabs/) and
[agent management](https://docs.warp.dev/platform/managing-cloud-agents/). Here Team deliberately
shows work-item context only, because personal sessions are private. These components use the fork's
existing colour and typography tokens; no third-party code or pixels were copied.

## The hub UI artifact

`bun run build:hub` runs `vite build --config vite.hub.config.ts` and writes `dist-hub/`, which the
factory hub serves from its origin root with `--ui-dir`. It is separate from `bun run build`
(`dist/`), so the personal factory client and its service worker are untouched.

| Part | Where |
| --- | --- |
| Source page | `hub-app/index.html`; name, description and icon addresses are stamped from `shared/brand.json` |
| Entry | `src/hub/main.tsx`; output `dist-hub/index.html`, base `/`, absolute `/assets/` paths |
| Theme | the classic blocking boot script, emitted as `assets/theme-bootstrap-<hash>.js` |
| Brand images | the files `BRAND` names, copied by name from `public/` (the whole folder is never copied) |
| Freshness | `build.json` holds the commit the build came from |
| Legal | `THIRD_PARTY_NOTICES.html` and `LICENSE.html`: the full texts of `THIRD_PARTY_NOTICES.md` and `LICENSE` as plain pages |
| Release manifest | `widal-ui.json`, the factory hub's own format (below) |

The artifact holds public files only: the entry, its hashed bundle, the brand images, the two legal
pages, `build.json` and the manifest. The build fails if anything else is in it, and it writes no
source maps, service worker, web manifest or offline cache. Every file is of a type the hub serves
(HTML, JavaScript, CSS, JSON, images, woff and woff2 fonts, Wasm). The hub does not serve Markdown or
TrueType, so the notices are written as HTML, and the TrueType fallback that KaTeX lists last in each
font face is dropped from the stylesheet and from the artifact: the woff2 face is read first anyway.
The build needs a Git checkout, because the hub refuses a release that does not name the full commit
it was built from. `SOURCE_DATE_EPOCH` fixes the one time-dependent field (`provenance.builtAt`). The hub must not serve
`/api`, `/healthz`, `/join`, `/factories` or a missing asset from it, and it checks the signed
identity for the page and its assets on every request.

`widal-ui.json` is the release manifest the factory hub reads at start (`hub/src/ui.ts` and
`docs/hub-app-contract.md` in the factory repository, checked against its merged revision
`eab41c491dcb9d45d081b8822432f0f41e5b2dea`): `schema` (`"widal.ui/1"`), `revision` (the full commit id),
`hubApi` (`{min: 1, max: 1}`, the `/api/app/*` version in the table below), `entry` (`index.html`),
`files` (path, size and sha256 of every public file but the manifest, sorted by path) and `provenance`
(`source`, `commit`, `builtAt`). With it the hub reads and checks every file once, keeps those bytes in
memory, serves only them, and reports `revision` as `ui.revision` at `GET /api/app/bootstrap`. Without
it the hub serves the directory as a plain development folder, with no integrity check and no revision,
so a build for an install always has it. Install each release in a directory of its own and restart the
hub; never change a served directory in place.

`scripts/hub-artifact.ts` builds the manifest, and `manifestProblem` and `verifyManifest` apply the
hub's own shape and bytes checks, so a change here that the hub would refuse fails a test here.
`scripts/hub-artifact-consumer.test.ts` goes further: with `FACTORY_HUB_UI` set to `hub/src/ui.ts` in a
factory checkout, it runs the hub's own reader on a release made here and on the real `dist-hub/`.

The owner view (`OwnerFactory`) is the fork's own App, loaded on demand when the person opens their
factory, behind `directTransport` for the registered owner origin. A page holds one such view,
because the App reaches its server through one process-wide transport. The view gives that
transport back when it unmounts (a page refresh unmounts it), one microtask after the App's own
teardown, and only if it is still the view's own, so the person can open their factory again without
reloading the page. The Setup and Admin
onboarding slots stay empty until the reviewed onboarding services are composed.

## Published producer contract

The browser projection in `contract.ts` follows the factory repository's immutable checkpoint
`02c64480524283a116360aeeb81c3ef0e9ba168c`, specifically `hub/src/app-contract.ts`,
`hub/src/dashboard.ts`, `hub/src/access.ts`, `hub/src/registry.ts` and
`docs/hub-app-contract.md`. This checkpoint is not a claim that the backend is merged or deployed.

| Page | Hub requests |
| --- | --- |
| Every page | `GET /api/app/bootstrap` before its page request |
| My Factory | `GET /api/app/my/overview` |
| Team | `GET /api/app/team/today` |
| Quality | `GET /api/app/team/quality` |
| Work item | `GET /api/app/team/items/<factory>/<id>` |
| Admin | `GET /api/app/admin`, only after an admin bootstrap |

Requests use same-origin cookies, no-store and no redirects. They never use the factory transport
singleton or send a browser bearer token. Unsupported schemas fail visibly. Errors do not reveal
arbitrary backend response bodies. Refresh clears personal page data, rechecks identity, and aborts
the previous read. Unmount also aborts and ignores late responses. Full navigation checks the hub's
signed-identity page boundary again; these components register no service worker or offline cache.

Queue read failures are shown as unavailable, not as empty queues. Null recorded cost means not
reported; it is not zero or separate cloud/model billing. Review, CI, live agents, subscription usage
and resets retain the producer's unavailable state. A missing producer cannot look like a successful
connection. Team exposes no factory-address links. Work-item and PR links allow HTTPS only.

## Integration slots

`HubSlots` requires `{brand: {name, logo}}`. The artifact entry passes these from the shared
`BRAND` export; there is no second product-name constant here. Colours stay in `src/styles.css`.
The hub pages are not an installable app, so they ship no web manifest.

The optional `ownerView({factory, origin, reader?})` is called only for a ready, registered factory owned by
the signed-in person, whose live origin matches its registered HTTPS address. The slot must reuse
the existing fork chat, terminal, answer cards and state grouping with the protected direct factory
transport. This local check only limits rendering; the factory server must enforce current ownership
for every HTTP/WebSocket operation. No socket path is invented here. Missing adapters show unavailable.

A Markdown tab keeps the selected factory ID in its `factory` query parameter alongside `read`
and `machine`. The hub entry rereads bootstrap and My Factory registration before rendering the
existing FileReader through the owner's transport. It never accepts an origin from the link,
guesses a factory for an old link without an ID, or grants an admin access to someone else's files.
Relative document navigation, reload and Back retain the factory ID. Standalone reader links keep
their existing format. This follows [T3 Code's environment-specific file previews](https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md#files-outside-the-workspace),
with fresh hub registration required because this artifact can connect to several factories.

Raw-file links use the same resource transport as downloads on desktop and in the phone's More
menu. Followed Claude/Codex sign-in cancellation also uses the selected HTTP transport, retaining
`keepalive` for page exit and reporting refusals before a terminal handoff can start.

`directTransport.ts` prepares the custom transport using the protected server contract in
`docs/factory-auth.md` at web UI checkpoint `bcf280a8d9e27148b1fcf17a9a8a5e2a12cb74fc`.
It maps the existing App's supplied HTTP, WebSocket, EventSource and resource paths to the verified
owner origin. HTTP uses credentialed, uncached requests without redirects; EventSource also includes
cookies. It rejects third-party origins and hub page requests and never retries a write. `OwnerFactory`
installs it, once at a time per page, when the person opens their factory, and the protected server
(`docs/factory-auth.md`) enforces current ownership for every request. Real ALB and CORS behaviour
is not yet accepted.

File previews use that same transport for video, audio and PDF element URLs as for images,
HTML and downloads. After the signed identity and current ownership checks, the file read guard
accepts CORS requests from the configured hub origin. Browser media elements that omit `Origin`
must send a `Referer` from that exact hub origin; an absent or unrelated referrer is refused.
The hub's referrer policy must therefore retain its origin for these media requests. This exception
does not apply outside authenticated factory HTTP context, to an opaque `Origin: null`, or to a
referrer from a rendered factory preview. Rendered HTML permits only itself and the configured hub
as frame ancestors and keeps its script sandbox without same-origin access or network access.
Unsigned preflights accept API query strings too (file paths are parameters); they return only
CORS metadata for the configured browser origin, trusted proxy and permitted methods/headers.
The following data request still requires signed identity and current ownership.
Credentialed CORS exposes `content-range`, which text previews need to validate a partial response.

`bun scripts/factory-file-view.ts` exercises the actual FileViewer and direct transport against two
local HTTPS fixture origins, with synthetic ALB identity and registry answers. It checks image,
video, audio, PDF, sandboxed HTML and desktop/mobile raw-file navigation with Chromium's real Fetch
Metadata, and rejects a revoked admin. Synthetic CLI operations behind the signed/current-owner
dispatch exercise Close, terminal handoff and page-exit cancellation for Claude and Codex without
starting a real CLI. With `FACTORY_HUB_UI_DIR` set to a freshly built `dist-hub`, it also opens the
production hub entry as a Markdown tab and checks relative links, reload, Back and denied identity.
The file viewer mobile regression also runs the checks that need no hub artifact. This is local integration evidence;
it does not establish deployment sign-in, real ALB cookies, proxy configuration or cross-site cookie
availability.

The Setup and Admin onboarding slots receive the current identity. They must consume the reviewed
onboarding services, including the browser-to-factory secret/OAuth flow. They do not create a second
backend or new storage. `POST /api/app/my/factory` remains reserved for provisioning; the summary uses
`GET /api/app/my/overview`. Admin currently lists people/factories and explicit unavailable capabilities.
It performs no mutation. The separate setup flow supplies the actual controls after contract review.

PR140's intermediate hub HTML pages do not replace the fork artifact or direct owner transport.
Its removal/setup authorization fix and merge belong to its author. Do not compose that implementation
as accepted until its security review is resolved.

## Verification and remaining acceptance

The synthetic fixtures and focused tests cover schema drift, malformed success bodies, unsafe links,
owner-only rendering, unavailable/partial data, role refusals, loading, abort and refresh cleanup.
`tsconfig.hub.json` checks only these independent modules. These checks use no real sessions or AWS.

```sh
bun test src/hub
bun --bun tsc --noEmit -p tsconfig.hub.json
```

`bun scripts/hub-pages-qa.ts` prepares a temporary in-memory artifact and synthetic same-origin APIs,
then checks 1280×900 and 390×844 layouts with one browser. It exercises navigation, unavailable data,
Team's request boundary, revocation and non-admin deep links. It is fixture QA, not a deployed hub
or personal factory. Run it only within the applicable browser-capacity policy.

These are component checks plus a successful `bun run build:hub` and the artifact manifest tests
(`bun test scripts/hub-artifact.test.ts scripts/hub-artifact-consumer.test.ts`). They do not establish
serving of the artifact by a running hub with its sign-in, the direct owner HTTP/WebSocket path against a real ALB, subscription limits, the real
Admin/setup services or second-engineer onboarding. Real served contracts, sign-in/revocation for
each role, and phone/laptop browser acceptance remain.
Required Fast checks and browser gates need their separate shared-capacity admission before push.
