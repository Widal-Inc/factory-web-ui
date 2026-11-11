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
Arbitrary OPTIONS requests and any other unsigned traffic are refused. The browser must use
`credentials: "include"` for cross-origin factory HTTP calls. CORS exposes only the request
correlator and server clock headers in addition to the standard response headers.

HTTP bodies, including SSE and media, recheck ownership before delivering chunks. WebSockets
recheck before every incoming frame and outgoing frame. Admission preserves incoming order;
output waits in a bounded queue. Removal, expiry or lookup failure closes the socket with code
1008, invalidates its leases, detaches it and holds its pending input. A one second idle check
also closes inactive connections; it never supplies cached authorization to active traffic.
Delayed terminal input rechecks at its turn, and the identity context follows queued sends to
their RPC writes. A reconnect starts from a new signed upgrade and cannot revive old input.

Audit records contain only time, factory, verified actor (or `unknown` for an unverified
refusal), action category and outcome. They contain no request bodies, query strings, prompts,
transcripts, identity tokens or credentials.

## Deployment acceptance

Synthetic tests establish the server boundary and revocation behavior without AWS. They do not
establish ALB-only networking, sign-in cookie routing, or real role-account acceptance. Keep
the deployment's existing fail-closed 503 until the groundwork and protected server are merged,
the private lookup and ALB rules are wired, and each role's account has passed the full install
acceptance test. This server change alone does not complete that acceptance.
