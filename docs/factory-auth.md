# Factory ingress and ownership

Each factory deployment uses signed ALB identity and current hub registration data for both
viewing and control. An administrator has no access to another person's factory. A shared
token, bridge token, cookie, forwarded address or direct loopback connection grants no factory
access. Standalone development servers without any factory configuration retain their local
development gate; deployment must explicitly select the factory mode below.

The verifier follows the hub's `hub/src/signin.ts` ES256 contract and
[AWS's ALB authentication contract](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html): the signed
`x-amzn-oidc-data` header identifies the signer ALB ARN, key ID, expiry and verified email claim.
The factory also pins the signed issuer and OIDC client. Public keys are fetched only from the
AWS regional ALB key service derived from the configured ARN, with redirects refused, a bounded
key cache and failure budget. No identity or ownership answer is cached.

## Runtime configuration

Run the built server with `bun run server/index.ts`. The default port is 7317 and the default
bind is `127.0.0.1`. The factory deployment selects `PORT=7421` and its private interface with
`HOST`; it must not publish a public listener or route around the ALB. Startup refuses partial
factory authentication configuration before opening a listener.

| Environment variable | Required value |
| --- | --- |
| `WIDAL_AUTH_MODE` | `alb` |
| `WIDAL_FACTORY_ID` | This factory's immutable registry ID |
| `WIDAL_FACTORY_OWNER` | The provisioned owner's identity email; compared without case |
| `WIDAL_FACTORY_ORIGIN` | Public HTTPS factory origin, without a path or trailing slash |
| `WIDAL_ALB_ARN` | Expected application load balancer ARN |
| `WIDAL_OIDC_ISSUER` | Exact signed HTTPS issuer URL, including its user pool path |
| `WIDAL_OIDC_CLIENT_ID` | Exact signed OIDC client ID |
| `WIDAL_HUB_ORIGIN` | Public HTTPS hub origin used by the browser |
| `WIDAL_REGISTRY_ORIGIN` | Protected direct hub HTTP(S) origin for live registration lookups |
| `WIDAL_ALB_SUBNETS` | Comma separated CIDRs of actual ALB peers; no `/0` |

Security groups must allow the factory port only from the ALB security group. CIDR checks use
the connection's actual peer, never `X-Forwarded-For`. ALB must preserve the original public
Host, set `X-Forwarded-Proto: https`, replace identity headers, and enforce the same Cognito
sign-in on every factory host. Do not add loopback or an arbitrary proxy to the trusted ALB
subnets. Neither a VPC-wide bind nor a CIDR alone is proof of identity.

## Current registration lookup

The existing hub `GET /api/app/me` API is the authority. The factory sends the original, locally
verified `x-amzn-oidc-data` token to `WIDAL_REGISTRY_ORIGIN/api/app/me` for every authorization
check, without redirects or cached responses and with a five second timeout. This origin must
reach the hub's signed-identity listener directly. Routing this lookup through an ALB browser
sign-in action can redirect or replace the identity and is not a valid integration.

The direct listener is private: restrict it to the factory hosts, use authenticated HTTPS when
it crosses a trust boundary, and keep any plain HTTP hop entirely inside the protected VPC.
The hub still verifies the ALB signature itself. The lookup needs no personal service secret
and adds no new hub endpoint. Never accept caller supplied registry URLs or factory metadata.

The response must name the same verified person, an active role (`engineer`, `admin` or
`viewer`), and a factory whose ID, owner and address exactly match the configured factory and
whose state is `ready`. The person must also match the provisioned owner. An admin's membership
in `GET /api/app/factories` is not ownership evidence; that endpoint is never used here.
Missing, malformed, removed, reassigned or unavailable registration data fails closed.

## HTTP and WebSocket contract

All data and control routes, including static assets, files, media, health details and WebSocket upgrades, pass
the factory gate. The public host must match `WIDAL_FACTORY_ORIGIN`. Mutation requests and
WebSocket upgrades must carry either the public hub or factory Origin. Credentialed CORS is
limited to those configured origins. Factory mode provides no `/api/auth` token sign-in.

The unsigned health exception is `GET /api/health`, with no query and no identity header, from
a trusted ALB peer. It returns only `{"ok":true}`, with `Cache-Control: no-store`; it reveals no
runtime, identity, session or registry facts. A signed health request uses the normal gate;
`?scope=bridge` supplies authenticated bridge health without depending on herdr. Its auth via
is `alb`. Direct loopback probes are refused.

Cross-origin browser preflights do not carry a sign-in cookie. An ALB rule must therefore
forward `OPTIONS /api/*` to the protected server before the Cognito authentication action.
The server answers an unsigned preflight only for a trusted ALB peer, the pinned public
host and HTTPS forwarding, an exact configured Origin, an allowlisted request method and
only `content-type`, `x-herdr-machine`, `x-herdr-update` or `x-request-id` request headers.
The empty 204 response exposes only fixed CORS metadata, without running a route or checking
the registry. The actual GET or mutation still needs signed identity and current ownership.
API query strings are allowed on this metadata-only request, so correlation headers can be
preflighted for file paths and other parameterized reads without authorizing their contents.
Arbitrary OPTIONS requests and any other unsigned traffic are refused. The browser must use
`credentials: "include"` for cross-origin factory HTTP calls. CORS exposes only the request
correlator, server clock and file `content-range` headers in addition to standard response headers.
The range header lets text previews verify their bounded read and detect empty files.

Repository changes, history and pull-request controls also accept cross-site requests from an
explicit configured hub or factory Origin after signed identity and current ownership checks.
An absent, opaque or unrelated Origin does not bypass their cross-site guard. Standalone
servers retain that guard without trusting any hub origin supplied by the request.

HTTP bodies, including SSE and media, recheck ownership before delivering chunks. WebSockets
recheck before every incoming frame and outgoing frame. Admission preserves incoming order;
output waits in a bounded queue. Removal, expiry or lookup failure closes the socket with code
1008, invalidates its leases, detaches it and holds its pending input. A one second idle check
also closes inactive connections; it never supplies cached authorization to active traffic.
Delayed terminal input rechecks at its turn, and the identity context follows queued sends to
their RPC writes. A reconnect starts from a new signed upgrade and cannot revive old input.
If disconnect or revocation finishes while terminal creation is pending, the completed attachment
is released when no client still claims it. A concurrent client keeps its shared attachment.

Audit records contain only time, factory, verified actor (or `unknown` for an unverified
refusal), action category and outcome. They contain no request bodies, query strings, prompts,
transcripts, identity tokens or credentials.

## Owner Setup

Behind the same gate, `/api/factory/setup/*` lets the registered owner connect their own accounts on this
factory. It answers 404 on a server without the factory gate, so a standalone server never collects a
person's GitHub or Linear connection. The browser calls it directly (the hub never relays it) and no
response carries a token, a refresh token, a PKCE verifier, a device code or a Claude code.

| Request | Purpose |
| --- | --- |
| `GET /api/factory/setup` | status: GitHub, Linear, saved choices, Claude, `ready`, the next step |
| `POST /github/start`, `/github/poll`, `/github/disconnect` | GitHub device flow with the organization's app |
| `POST /linear/start`, `/linear/callback`, `/linear/disconnect` | Linear with PKCE; the callback takes `{code,state}` |
| `GET /choices`, `PUT /settings` | reachable repositories and teams; the saved repositories, team, git name and email, with `accounts: {github, linear}`, the account ids the page showed |
| `GET /prime?next=setup` or `my-factory` | a top-level visit that sets the factory host's sign-in, then returns to a fixed hub path |

The client IDs of the organization's GitHub App and Linear app come from the hub's `GET /api/app/setup`,
read with the person's own verified identity (the same lookup origin as ownership); the browser never
supplies a client ID, a redirect address or an upstream host, and every upstream address is fixed in the
server. A device code or PKCE verifier lives in memory only, belongs to one person, is single use and
expires after ten minutes. A GitHub user token cannot be refreshed here, because refreshing needs the app's
client secret, which stays on the hub: when its lifetime ends the status says expired, Setup is not ready,
the page says when the connection ends and, once it has, that agents wait until the person connects GitHub
again. GitHub Apps expire user tokens after eight hours by default, so an administrator chooses one of two:
opt the organization's GitHub App out of expiring user tokens (the app's settings, Optional features,
"User-to-server token expiration"; the token then lasts until it is revoked, which weighs a longer-lived
credential on the factory against reconnecting every eight hours), or keep expiry and have the hub refresh
the token, which is not built yet. A hub-side refresh needs a hub endpoint that takes the factory's refresh
token (`ghr_…`, which GitHub returns with an expiring user token and Setup would then keep as a secret) and
answers with GitHub's new access and refresh tokens, after calling GitHub's token endpoint with the app's
client ID and client secret, authorized by the factory's own identity rather than a person's browser sign-in,
since the renewal runs with nobody on the page. A Linear token is renewed with its refresh token, by the app
it was issued to, and says expired when that fails.

The server renews on its own: every minute (and when it starts) it renews a Linear token that expires within
five minutes and takes `ready` back in `factory-setup.json` when a credential it rests on has expired or is
gone from the secrets file, whether or not anyone opens Setup. It never sets `ready` itself; only a status
read, with the hub's answer, does. The timer and a status read renew through the same path in the same serial
lane, so `LINEAR_REFRESH_TOKEN` is spent by one request at a time: Linear rotates it, and a second refresh with
the old one fails. Nothing else may refresh it, the factory's runtime included, and one Setup server serves a
state folder. After a renewal Linear did not answer, the next attempt waits five minutes, or half of what the
token has left when that is less (never under ten seconds), so a single failure cannot let the token run out
before the next try. When Linear answers that it will never accept the refresh token again (`invalid_grant`,
`invalid_client`, `unauthorized_client`), renewal stops: the token expires, the status says so, and connecting
Linear again brings a refresh token of its own. On a shutdown the server waits (up to eight seconds) for the
turn the Setup timer is in, so a renewal in flight is written before the process ends, and no turn starts
after the stop.

Saved choices belong to the accounts they were made with: the record keeps the GitHub account id and the
Linear account id they were saved for, and a different account (or a Linear connection that is gone) has no
choices until the person saves them again; reconnecting the same account keeps them. A save names the GitHub
and Linear account ids the page showed and is refused (409 `account_changed`) when either is no longer the
connected one, so a second tab with stale choices cannot save them under a newly connected account. That
field is required: a hub page that does not send it yet gets 400 `invalid_accounts` on every save, so a
deployment updates the hub first and the factories after it.

A status read rechecks the saved repositories against what the GitHub connection reaches. The list is read at
most every minute, and the choices page reuses a list that fresh; it follows every page GitHub has, up to 200
requests or 30 seconds, and a list that stopped at that limit says nothing about the repositories it did not
get to, so none is reported lost from it. When GitHub does not answer, the last answer stands and the failure
is remembered for fifteen seconds, so a GitHub outage is not asked about on every poll. When GitHub answers
401 the connection is treated as expired (the token is revoked, and it is not asked about again).
`unreachableRepositories` lists the saved repositories GitHub no longer reaches, and while any is listed
Setup is not ready and the next step is `settings`. The Setup timer does not make this recheck: it renews and
takes `ready` back for an expired or missing credential, but a repository the app has lost, or a team Linear no
longer has, shows on the next status read by the person.

When the hub names a different owner than the record's, the previous person's record and every one of their
credentials (`GH_TOKEN`, `LINEAR_ACCESS_TOKEN`, `LINEAR_REFRESH_TOKEN`) are removed before anything of the new
owner's is read or written. This happens on the first request of any kind from the new owner (a connection, a
disconnect or a start), and `ready` is taken back in the previous record first, so a removal that fails
leaves no record claiming the previous owner is ready, and the next request tries again. The hub's Linear callback page removes the code from its address as it reads it and hands it
to the factory once; refreshing the page's data never sends it again. Every status read,
renewal and write runs in one serial lane, so a status never records over a renewal or a settings write and
the `ready` it reports is the `ready` it persists. The hub's Setup answer must name each app explicitly: a
`null` means no such app (for Linear, that the organization does not use it), while a missing or malformed
registration is reported as unavailable and never as "not used".

Credentials are written to the factory's own secrets file (`$WIDAL_SECRETS`, else
`$XDG_CONFIG_HOME/widal/secrets.env`, else `~/.config/widal/secrets.env`; mode 0600) as `GH_TOKEN`,
`LINEAR_ACCESS_TOKEN` and `LINEAR_REFRESH_TOKEN`. Setup changes only those names' lines (`NAME=value` or
`export NAME=value`); every other line of whoever provisioned the file (comments, other `export` lines, empty
values, CRLF endings, a line that is not UTF-8) is kept byte for byte: the file is read and written as raw
bytes. A token is written without quotes, because the file may be sourced by a shell, so Setup accepts one
only if it is made of letters, digits and `. _ - + / = :` (every token GitHub and Linear issue is) and
treats any other as a refused sign-in. Each write goes to a temporary file of its own beside it, is
flushed, and is renamed over the file (a link there is replaced, never written through).

What is not secret goes to `factory-setup.json` in the state folder: who connected, the repositories, the
Linear team, the git name and email, expiry times (`github.expiresAt`, `linear.expiresAt`: milliseconds since
the epoch, absent when the token has no lifetime) and `ready`. `ready` is true only when GitHub, Linear (unless
the organization does not use it), the saved choices and Claude's sign-in all exist, none has expired and,
as of the last status read, every saved repository is reachable; the factory starts no agent before it is
true. The status
(`GET /api/factory/setup`) carries the same `github.expiresAt` and `linear.expiresAt`. Claude uses the
existing followed sign-in, `/api/usage/login`.

Applying these choices is not done by this server. The factory's runtime must read the secrets file and
`factory-setup.json` (repositories, Linear team, git identity, `ready`, the expiry times), apply them to its
own settings and hold agent start until `ready` is true and neither `github.expiresAt` nor (when the choices
use Linear) `linear.expiresAt` has passed: Setup takes `ready` back within a minute of an expiry, and the
consumer does not wait for that. It reads `LINEAR_ACCESS_TOKEN` again before use, since Setup renews it, and
never refreshes it itself. That consumer is separate factory work (the factory repository's
runtime adapter); until it exists, a complete Setup means the choices are saved on the factory, not that its
agents use them or can start.

## External notifications

Factory mode disables browser push and alert webhook delivery, including test sends and
webhook retries. Persisted destinations do not carry a signed owner identity, so the independent
status collector cannot prove current ownership or identity expiry before delivering private
pane titles, prompt summaries or actions. A valid browser request does not authorize later
background delivery. This restriction applies even while the owner is signed in and survives
server restarts; stored subscriptions and webhook settings are preserved without sending to
them. Standalone development keeps its existing notification behavior. Enabling Factory
notifications requires identity-bound destinations and current-owner checks at every send and
retry; it is not part of this implementation.

## Deployment acceptance

Synthetic tests establish the server boundary and revocation behavior without AWS. They do not
establish ALB-only networking, sign-in cookie routing, or real role-account acceptance. Keep
the deployment's existing fail-closed 503 until the groundwork and protected server are merged,
the private lookup and ALB rules are wired, and each role's account has passed the full install
acceptance test. This server change alone does not complete that acceptance.
