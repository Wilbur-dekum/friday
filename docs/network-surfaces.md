# Network surfaces — the credential-and-route register

Every call across a process boundary in Friday has to answer two questions:
**what route does it take**, and **whose credential does it carry**. This
document is the register of those answers, and ADR-055 is the decision that
makes them a lookup rather than a discovery.

It exists because they were discovered. Three times in a row, a builder
container turned out to need something external that nothing supplied: git
(closed by FRI-2076/2077), the GitHub API (FRI-2078), and the model API — which
is **still broken**, found only when someone asked whether work could actually
move into Friday. Each was handled as its own surprise. The pattern was
available the whole time.

## The four patterns

| Pattern         | Route                      | Credential lives       | Caller presents       |
| --------------- | -------------------------- | ---------------------- | --------------------- |
| **denied**      | none — no path exists      | —                      | nothing               |
| **caller-held** | direct                     | in the calling process | the credential itself |
| **brokered**    | through the daemon         | trusted tier           | a per-worker token    |
| **relayed**     | through the daemon's proxy | caller's own, or none  | a per-worker token    |

**The rule (ADR-055): a process running untrusted code may only use `denied`,
`brokered` or `relayed` — never `caller-held`.** The trusted tier may use
`caller-held` freely; that is what being the trusted tier means.

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
| Daemon → broker (`:7612`)                              | Int     | `BROKER_TOKEN`                                                                                                        | n/a     | **used**                            |
| Webhooks in (Linear / GitHub / Slack)                  | **Ext** | —                                                                                                                     | —       | **unknown** — E3/E5, no surface yet |

The worker listener is the only daemon surface a builder can see, and it is
deliberately a _second_ listener rather than a wider bind: a route added
tomorrow is loopback-only by default, which is the safe direction to fail.

## Egress from a builder container

| Destination                             | Int/Ext | Credential                               | Pattern         | State                                                                     |
| --------------------------------------- | ------- | ---------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| Everything, by default                  | —       | —                                        | **denied**      | **used** — `internal: true`, measured `ENETUNREACH`                       |
| Daemon (API, MCP, git, command channel) | Int     | worker token                             | **brokered**    | **used**                                                                  |
| git → the real origin                   | **Ext** | GitHub token, never in the container     | **brokered**    | **used** (FRI-2077)                                                       |
| GitHub API (PR create, checks)          | **Ext** | GitHub token, never in the container     | **brokered**    | **used** (FRI-2078)                                                       |
| `api.anthropic.com`                     | **Ext** | Anthropic key — **nothing supplies one** | relayed (wrong) | ⚠️ **BROKEN** — FRI-2084                                                  |
| npm / yarn registries (public)          | **Ext** | none                                     | **relayed**     | **used** (FRI-2039)                                                       |
| Private package registries              | **Ext** | registry token                           | —               | **unknown** — would be `caller-held`; FRI-2086                            |
| `WebFetch` (the tool is enabled)        | **Ext** | none                                     | relayed (fails) | ⚠️ **BROKEN** — Node `fetch` ignores the proxy; FRI-2085                  |
| `WebSearch`                             | ?       | none                                     | —               | **unknown** — server-side at Anthropic, or client-side? FRI-2085          |
| User-configured MCP servers             | **Ext** | **each brings its own API key**          | —               | ⚠️ **unbounded** — stdio-only, so they run _inside_ the builder; FRI-2086 |

`McpServerConfig` is `{ name, command, args?, env?, scope? }` — stdio only.
There is no remote-MCP shape, so a user-configured server is arbitrary code
running in the builder with its own credential in its own `env`, calling a host
nobody enumerated. It is the one row here that cannot be closed by adding
entries to an allowlist.

## Egress from the trusted tier

`caller-held` throughout, which the rule permits. Listed because blast radius is
a separate question from pattern, and because this is where the launch gates
live.

| Source → destination                        | Int/Ext | Credential                             | Notes                                                                            |
| ------------------------------------------- | ------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Daemon → Postgres                           | Int     | `DATABASE_URL`                         | superuser URL deliberately absent from the service (FRI-2062)                    |
| Daemon → `api.anthropic.com` (orchestrator) | **Ext** | `ANTHROPIC_API_KEY`                    | the orchestrator is a forked worker, not a container                             |
| Daemon → GitHub (git forward + API)         | **Ext** | one broad `githubToken` from the vault | per-task single-repo scoping is FRI-2041, a **launch gate**, blocked on FRI-2056 |
| Daemon → `api.linear.app`                   | **Ext** | `LINEAR_API_KEY`                       | hosted `friday-integrations` MCP, so the call leaves the daemon                  |
| `@friday/memory` → `huggingface.co`         | **Ext** | none                                   | embedding-model download, setup/update only                                      |
| cloudflared → Cloudflare edge               | **Ext** | tunnel connector token                 | outbound-only; no inbound port is opened                                         |
| Dashboard / browser → PostHog               | **Ext** | project key                            | client-side, outside our containers entirely                                     |

## Open items

| Ticket   | Surface                                      | Needs deciding                                                    |
| -------- | -------------------------------------------- | ----------------------------------------------------------------- |
| FRI-2084 | builder → model API                          | `brokered`, or a named time-boxed `caller-held` exception         |
| FRI-2085 | non-proxy-aware clients; the SDK's web tools | whether `relayed` becomes intercepting, and what `WebSearch` does |
| FRI-2086 | user-configured MCP servers                  | a credential-injecting broker, versus keys in the untrusted tier  |
| FRI-2041 | daemon → GitHub blast radius                 | per-task single-repo tokens; **launch gate**, blocked on FRI-2056 |
| FRI-2040 | per-Organization isolation                   | mostly delivered by FRI-2039's internal network; wants re-scoping |

## Adding a surface

Classify it here **before** building it. A new external call from a container
is `brokered` or `relayed` and the register says which; if neither fits, that is
an ADR-055 amendment, not an implementation detail. The three breakages above
all looked like implementation details at the time.
