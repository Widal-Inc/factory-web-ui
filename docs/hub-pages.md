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
| Freshness | `build.json` holds the commit the build came from; it is absent in a build outside Git |
| Integrity | `hub-manifest.json` |

The artifact holds public files only: the entry, its hashed bundle, the brand images,
`THIRD_PARTY_NOTICES.md`, `build.json` and the manifest. The build fails if anything else is in it,
and it writes no source maps, service worker, web manifest or offline cache. The hub must not serve
`/api`, `/healthz`, `/join`, `/factories` or a missing asset from it, and it checks the signed
identity for the page and its assets on every request.

`hub-manifest.json` has `schema` (1), `kind` (`factory-hub-ui`), `hubApiVersion` (1, the
`/api/app/*` version in the table below), `revision` (the commit, or null), `appVersion`, `entry`,
`brand`, `files` (path, sha256 and size of each file, sorted) and `digest`, the sha256 of the sorted
`path`, NUL, `sha256` lines. A consumer should call `verifyManifest` (`scripts/hub-artifact.ts`)
or do the same: refuse a release whose manifest has another schema or API version, lists a file
that is missing or changed, or leaves a file unlisted, and swap a release in as a whole directory.

The owner view (`OwnerFactory`) is the fork's own App, loaded on demand when the person opens their
factory, behind `directTransport` for the registered owner origin. A page holds one such view,
because the App reaches its server through one process-wide transport. The Setup and Admin
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

The optional `ownerView({factory, origin})` is called only for a ready, registered factory owned by
the signed-in person, whose live origin matches its registered HTTPS address. The slot must reuse
the existing fork chat, terminal, answer cards and state grouping with the protected direct factory
transport. This local check only limits rendering; the factory server must enforce current ownership
for every HTTP/WebSocket operation. No socket path is invented here. Missing adapters show unavailable.

`directTransport.ts` prepares the custom transport using the protected server contract in
`docs/factory-auth.md` at web UI checkpoint `bcf280a8d9e27148b1fcf17a9a8a5e2a12cb74fc`.
It maps the existing App's supplied HTTP, WebSocket, EventSource and resource paths to the verified
owner origin. HTTP uses credentialed, uncached requests without redirects; EventSource also includes
cookies. It rejects third-party origins and hub page requests and never retries a write. `OwnerFactory`
installs it, once per page, when the person opens their factory, and the protected server
(`docs/factory-auth.md`) enforces current ownership for every request. Real ALB and CORS behaviour
is not yet accepted.

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
(`bun test scripts/hub-artifact.test.ts`). They do not establish serving of the artifact by the
hub, the direct owner HTTP/WebSocket path against a real ALB, subscription limits, the real
Admin/setup services or second-engineer onboarding. Real served contracts, sign-in/revocation for
each role, and phone/laptop browser acceptance remain.
Required Fast checks and browser gates need their separate shared-capacity admission before push.
