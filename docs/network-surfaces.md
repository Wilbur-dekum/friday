# Network surfaces — the credential-and-route register

Every call across a process boundary in Friday has to answer two questions:
**what route does it take**, and **whose credential does it carry**. This
document is the register of those answers, and ADR-055 is the decision that
makes them a lookup rather than a discovery.

It exists because they were discovered. Three times in a row, a builder
container turned out to need something external that nothing supplied: git
(closed by FRI-2076/2077), the GitHub API (FRI-2078), and the model API —
found only when someone asked whether work could actually move into Friday, and
closed by FRI-2084. Each was handled as its own surprise. The pattern was
available the whole time, which is what this register is for.

FRI-2084 is also the worked example of rule 2 paying off rather than costing:
brokering the model API **removed** `api.anthropic.com` from the egress
allowlist, so closing a credential gap shrank the builder's permitted
destinations instead of growing them.

## The four patterns

| Pattern         | Route                      | Credential lives       | Caller presents       |
| --------------- | -------------------------- | ---------------------- | --------------------- |
| **denied**      | none — no path exists      | —                      | nothing               |
| **caller-held** | direct                     | in the calling process | the credential itself |
| **brokered**    | through the daemon         | trusted tier           | a per-worker token    |
| **relayed**     | through the daemon's proxy | caller's own, or none  | a per-worker token    |

**Rule 1 (ADR-055), the invariant that holds now: a process running untrusted
code may only use `denied`, `brokered` or `relayed` — never `caller-held`.**
The trusted tier may use `caller-held`; that is what being the trusted tier
means.

The axis is **caller trust, not destination locality.** "Internal" is not a
property that makes a connection safe — a builder reaching Postgres is an
internal call that ADR-054 denies outright, and even a builder's access to the
daemon is mediated rather than direct (a separate listener, seven routes, a
per-worker token). Locality is also not stable enough to build on: on ADR-051's
shared cluster, Postgres sits outside the Deployment container but inside the
cluster.

**Rule 2 (ADR-055), a destination rather than a present state: all external
egress, from any tier, goes through a single chokepoint.** Rule 1 permits the
trusted tier `caller-held` and that stays true — but permitting it is not
endorsing four processes each holding their own external credentials forever.
The trusted-tier table below is therefore a list of what rule 2 has yet to
consolidate, not a list of things that are finished.

**Choosing between `brokered` and `relayed`: whose credential is it?**

- Friday's or the Organization's → **brokered**. The credential must not enter
  the container, which is the whole point of the boundary.
- Nobody's, or a public endpoint → **relayed**. Nothing to protect.
- A User's own third-party credential → **brokered**. It is still a credential
  in an untrusted process otherwise. This is the case with no implementation
  yet; see FRI-2086.

**`relayed` has a coverage limit that `brokered` does not.** It works by
`HTTPS_PROXY` in the container's environment, so it only reaches clients that
honour that convention. `npm`, `git` and `curl` do. **Node's global `fetch`
does not** — measured on the pinned runtime:

```
$ docker run -e HTTPS_PROXY=http://127.0.0.1:1 friday-worker node -e 'fetch("https://example.com")'
fetch SUCCEEDED (status 200) -> proxy env IGNORED
node v22.21.1
```

So `relayed` is only a valid answer for a client known to honour proxy
environment variables. Anything else is `brokered` or `denied` — and silently
`denied`, because on an internal network an ignored proxy means `ENETUNREACH`
rather than an error that names the cause. The general fix is an intercepting
proxy rather than an advertised one; that is the declared destination in
ADR-055, not built.

## Ingress

| Surface                                                | Int/Ext | Auth                                                                                                                  | Pattern | State                               |
| ------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------- |
| Internet → dashboard (`:7615` via cloudflared)         | **Ext** | BetterAuth session                                                                                                    | n/a     | **used**                            |
| Browser → zero-cache (WS, proxied by the dashboard)    | **Ext** | Zero JWT                                                                                                              | n/a     | **used**                            |
| Anything → daemon API (`127.0.0.1:7610`)               | Int     | daemon secret **plus the loopback bind** — 62 of 84 routes carry no `auth` flag and rely on the bind alone (FRI-2072) | n/a     | **used**                            |
| Builder → daemon worker listener (`:7611`)             | Int     | per-worker bearer token; never the daemon secret                                                                      | n/a     | **used**                            |
| Builder → `git-upload-pack` / `git-receive-pack`       | Int     | per-worker bearer token                                                                                               | n/a     | **used**                            |
| Builder → hosted MCP (`/api/mcp/<server>`, 14 servers) | Int     | per-worker bearer token                                                                                               | n/a     | **used**                            |
| Builder → model route (`/api/model/*`)                 | Int     | per-worker bearer token, sent as the SDK's `ANTHROPIC_AUTH_TOKEN`                                                     | n/a     | **used** (FRI-2084)                 |
| Daemon → broker (`:7612`)                              | Int     | `BROKER_TOKEN`                                                                                                        | n/a     | **used**                            |
| Webhooks in (Linear / GitHub / Slack)                  | **Ext** | —                                                                                                                     | —       | **unknown** — E3/E5, no surface yet |

The worker listener is the only daemon surface a builder can see, and it is
deliberately a _second_ listener rather than a wider bind: a route added
tomorrow is loopback-only by default, which is the safe direction to fail.

## Egress from a builder container

| Destination                             | Int/Ext | Credential                                                      | Pattern         | State                                                                     |
| --------------------------------------- | ------- | --------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Everything, by default                  | —       | —                                                               | **denied**      | **used** — `internal: true`, measured `ENETUNREACH`                       |
| Daemon (API, MCP, git, command channel) | Int     | worker token                                                    | **brokered**    | **used**                                                                  |
| git → the real origin                   | **Ext** | GitHub token, never in the container                            | **brokered**    | **used** (FRI-2077)                                                       |
| GitHub API (PR create, checks)          | **Ext** | GitHub token, never in the container                            | **brokered**    | **used** (FRI-2078)                                                       |
| `api.anthropic.com`                     | **Ext** | injected by the daemon; the builder holds only its worker token | **brokered**    | **used** (FRI-2084) — and the host is NO LONGER on the egress allowlist   |
| npm / yarn registries (public)          | **Ext** | none                                                            | **relayed**     | **used** (FRI-2039)                                                       |
| Private package registries              | **Ext** | registry token                                                  | —               | **unknown** — would be `caller-held`; FRI-2086                            |
| `WebFetch` (the tool is enabled)        | **Ext** | none                                                            | relayed (fails) | ⚠️ **BROKEN** — Node `fetch` ignores the proxy; FRI-2085                  |
| `WebSearch`                             | ?       | none                                                            | —               | **unknown** — server-side at Anthropic, or client-side? FRI-2085          |
| User-configured MCP servers             | **Ext** | **each brings its own API key**                                 | —               | ⚠️ **unbounded** — stdio-only, so they run _inside_ the builder; FRI-2086 |

`McpServerConfig` is `{ name, command, args?, env?, scope? }` — stdio only.
There is no remote-MCP shape, so a user-configured server is arbitrary code
running in the builder with its own credential in its own `env`, calling a host
nobody enumerated. It is the one row here that cannot be closed by adding
entries to an allowlist.

## Egress from the trusted tier

`caller-held` throughout, which rule 1 permits. Listed because blast radius is
a separate question from pattern, because this is where the launch gates live,
and because **every external row here is something rule 2 has yet to
consolidate.**

| Source → destination                        | Int/Ext | Credential                             | Notes                                                                            |
| ------------------------------------------- | ------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Daemon → Postgres                           | Int     | `DATABASE_URL`                         | superuser URL deliberately absent from the service (FRI-2062)                    |
| Daemon → `api.anthropic.com` (orchestrator) | **Ext** | `ANTHROPIC_API_KEY`                    | the orchestrator is a forked worker, not a container                             |
| Daemon → GitHub (git forward + API)         | **Ext** | one broad `githubToken` from the vault | per-task single-repo scoping is FRI-2041, a **launch gate**, blocked on FRI-2056 |
| Daemon → `api.linear.app`                   | **Ext** | `LINEAR_API_KEY`                       | hosted `friday-integrations` MCP, so the call leaves the daemon                  |
| `@friday/memory` → `huggingface.co`         | **Ext** | none                                   | embedding-model download, setup/update only                                      |
| cloudflared → Cloudflare edge               | **Ext** | tunnel connector token                 | outbound-only; no inbound port is opened                                         |
| Dashboard / browser → PostHog               | **Ext** | project key                            | client-side, outside our containers entirely                                     |

## Named exposures

Not classified by pattern, because neither rule addresses them.

**The dashboard is internet-facing and holds a database credential.** It is the
public surface behind the Cloudflare tunnel, `getDb()` resolves a Postgres pool
for BetterAuth, it executes mutators, and it runs in the **same container** as
the daemon. Rule 1 puts it in the trusted tier, which is defensible and is the
weakest such call in the system: it is the one process where an unauthenticated
external request reaches code holding a database pool. Rule 1 does not help —
its risky direction is ingress, not egress — and neither does rule 2.
Candidates for narrowing, both out of ADR-055's scope: a scoped role for the
mutator path instead of the auth pool's credential, and a process boundary
between the public surface and the credential holder.

**The daemon holds one broad GitHub token.** Bounded by the repo allowlist on
both the git and PR routes, and never present in the container — but blast
radius on compromise is every allowlisted repository. ADR-054's launch gate
under control (5); FRI-2041, blocked on FRI-2056.

## Open items

| Ticket   | Surface                                      | Needs deciding                                                    |
| -------- | -------------------------------------------- | ----------------------------------------------------------------- |
| FRI-2085 | non-proxy-aware clients; the SDK's web tools | whether `relayed` becomes intercepting, and what `WebSearch` does |
| FRI-2086 | user-configured MCP servers                  | a credential-injecting broker, versus keys in the untrusted tier  |
| FRI-2040 | per-Organization isolation                   | mostly delivered by FRI-2039's internal network; wants re-scoping |

## Adding a surface

Classify it here **before** building it. A new external call from a container
is `brokered` or `relayed` and the register says which; if neither fits, that is
an ADR-055 amendment, not an implementation detail. The three breakages above
all looked like implementation details at the time.
