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
reloading the page. The Setup and Admin onboarding slots hold the screens described in
[Admin onboarding and Setup](#admin-onboarding-and-setup).

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
installs it, once at a time per page, when the person opens their factory, and the protected server
(`docs/factory-auth.md`) enforces current ownership for every request. Real ALB and CORS behaviour
is not yet accepted.

The Setup and Admin onboarding slots receive the current identity and are filled by the screens in
[Admin onboarding and Setup](#admin-onboarding-and-setup). They create no backend and no storage of their
own: the hub's onboarding API (the factory repository's `docs/hub-onboarding-api.md`) and the owner
factory's Setup routes below are the only places they read or write.

PR140's intermediate hub HTML pages do not replace the fork artifact or direct owner transport.
Its removal/setup authorization fix and merge belong to its author. Do not compose that implementation
as accepted until its security review is resolved.

## Admin onboarding and Setup

We decided that a person's own GitHub, Linear and Claude credentials never reach the hub, because the
hub is shared and an administrator must not be able to act as another person. The browser therefore
sends them straight to the person's registered owner factory, and the hub only carries the
organization's non-secret app registration and the progress of invites.

**Admin onboarding** (`AdminOnboarding.tsx`, shown on `/admin` only when the hub reports
`capabilities.onboarding` ready) reads and writes the hub's onboarding API as it is documented
there. In order: create the organization's GitHub App (the browser posts the hub's manifest to
GitHub's own organization page and nowhere else, and GitHub sends the administrator back to the hub);
check the app is installed, with a reminder to turn on Device Flow, which GitHub's manifest cannot do;
enter the Linear app's client ID (never a secret) and see the callback address to register, or say the
team does not use Linear; invite people with a role, or create the administrator's own factory. Only an
engineer invite deploys a factory. The invite list follows a deployment while any invite is creating,
shows a failure with the hub's reason, and for an invite whose email was not sent shows the one-time
link to copy and a button to send a fresh one. Inviting stays disabled, with the reason, until GitHub
and Linear (or "no Linear") are done, and the hub still refuses it if they are not. An unavailable or
failing hub is shown as that, never as an empty setup.

**Setup** (`SetupPage.tsx`, on `/setup`) works on the person's own registered factory, found from
`GET /api/app/my/overview` and `ownerOrigin` like the live view. Without a ready factory it shows the
hub's invitation progress or failure and asks for nothing. With one, it calls the owner server
directly (`ownerSetupApi.ts`, over the same verified direct transport) and walks through:

1. **GitHub**, through the organization's app with the device flow: the factory asks GitHub for a code,
   the page shows the code and GitHub's own device page, and the factory polls GitHub at the interval
   GitHub gives. The page never sees the token.
2. **Linear**, as the person, with PKCE: the factory makes a single-use state and keeps the verifier; the
   page sends the person to Linear's own authorize page, which returns to `<hub origin>/linear/callback`.
   That page (`LinearCallback`) removes the one-time code from the address at once and posts it only to
   the person's own factory, which exchanges it. A team that does not use Linear gets no Linear step.
3. **Choices**: the repositories the person's own GitHub connection reaches through the app, the Linear
   team, and the git name and email the agents commit with, proposed from the GitHub account. The factory
   checks every choice against what the connections reach at the moment of saving.
4. **Claude**, with the factory's existing followed sign-in (`/api/usage/login`): the page shows a link
   on Claude's or Anthropic's own host and takes the one-time code, which it sends to the factory only.

Each step shows what the factory reports: connected, expired (with a reconnect), unavailable, or not
connected, and the page says "ready" only when the factory's status says GitHub, Linear (unless not
used), the saved choices and Claude are all in place. Nothing in Setup starts an agent: Claude's sign-in
runs the CLI's login and nothing else. When the factory host does not answer with the person's sign-in
(its own sign-in cookie is missing), the page offers a top-level visit to
`<factory origin>/api/factory/setup/prime?next=setup`, which returns to a fixed hub path; no other
return address is accepted.

The owner server side, `server/factory-setup.ts` and `server/factory-setup-routes.ts`, is documented in
[factory ingress and ownership](factory-auth.md#owner-setup). Both client modules parse every answer at
the boundary, so a factory or hub that has drifted is shown as unsupported instead of as an empty or
finished Setup.

Not yet accepted: the real ALB and CORS path for these calls, the hub serving this artifact at
`/linear/callback` (requested of the factory repository's integration), the Claude sign-in cookie
(`SameSite=Strict`) across a hub and factory that must share a registrable domain, real GitHub, Linear
and Claude accounts, and the end-to-end invite-to-first-ticket acceptance with fakecloud.

## Verification and remaining acceptance

The synthetic fixtures and focused tests cover schema drift, malformed success bodies, unsafe links,
owner-only rendering, unavailable/partial data, role refusals, loading, abort and refresh cleanup.
`tsconfig.hub.json` checks only these independent modules. These checks use no real sessions or AWS.

```sh
bun test src/hub server/factory-setup.test.ts
bun --bun tsc --noEmit -p tsconfig.hub.json
```

The onboarding and Setup tests use stand-ins for the hub, the owner factory, GitHub, Linear and Claude
with made-up canary values; they check that a canary token, device code, verifier or Claude code never
appears in a response, a URL or the hub's requests, that a callback is used once, and that a stale or
other person's callback is refused.

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
