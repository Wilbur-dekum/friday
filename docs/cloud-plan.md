# Cloud Project Plan

Friday becomes a SaaS product: one **Deployment** (container stack + Postgres) per
customer **Organization**, several **User**s collaborating through one shared Friday,
reachable over multiple **Transport**s. Vocabulary lives in [CONTEXT.md](../CONTEXT.md);
rationale in [ADR-050 — ADR-054](decisions.md); the work itself, with the constraint each
ticket must respect, in [cloud-tickets.md](cloud-tickets.md).

**Three docs, three jobs** — keep them from drifting: ADRs own _why_ and what was
rejected. [cloud-tickets.md](cloud-tickets.md) owns _the work_ — all 51 tickets
(`FRI-2001`–`FRI-2051`), each carrying the constraint it has to respect, and it is the
canonical record of the plan. This doc owns _epics, order, and what can run in parallel_.
Nothing here restates a decision; it links to one.

## Strategy: dogfood first

E1 exists so the daily driver runs the cloud image. That makes [ADR-050](decisions.md)'s
one-image invariant self-enforcing instead of aspirational, and it means the dogfood
install **is** the first self-hosted Deployment — so the standalone-mode seams
[ADR-054](decisions.md) needs for the enterprise tier get exercised continuously rather
than built blind at the end.

Everything is testable only after E1: `checkDeps()` hard-parks the stack on a box without
Homebrew, so there is no Linux target to verify against until it lands.

## Epics

### E1 — Dev–cloud parity: the container

FRI-2001 · tasks FRI-2002–2014

**Goal.** The stack runs as one container (supervisor as PID 1) against external Postgres,
from the same image the cloud will use.
**Done when** the daily driver runs that image, not a `launchctl`-managed local install.
**ADRs:** 050, 051 (Postgres, secrets, ingress).

Prerequisites, roughly in boot order: Linux container build (no Linux leg exists in CI and
`pack.mjs` refuses non-darwin; native addons are per-arch with no cross-compile) ·
container-appropriate preflight to replace the Homebrew gating in `checkDeps` · `FRIDAY_DB`
and the connection string become configuration · `CREATE EXTENSION vector` moves to
provisioning, off the boot path · persistent volumes for the data dir and
`~/.claude/projects` · drop the `$SHELL -ilc` env capture · verify `.daemon-secret`'s
`0600` fatal-exit against the real mount · age identity injected at runtime, not on the
volume · a local reverse proxy with a real hostname so BetterAuth's `trustedOrigins`
behaves as it will in the cloud.

**Pulled forward into E1:** scrub the worker environment ([ADR-054](decisions.md) control 1).
It belongs to the isolation epic, but it is cheap and the worker env has to be constructed
explicitly for a container anyway — there is no login shell to capture. It forwards
`SSH_AUTH_SOCK` (delegating the operator's SSH agent to every worker) and makes the worker
env a function of their dotfiles, which cannot stand once the worker runs untrusted code.

**Ordering within E1:** get the stack booting in a container early, even imperfectly, then
harden. Doing all of the above before the first boot attempt front-loads every unknown.

### E2 — Multi-user in one Deployment

FRI-2015 · tasks FRI-2016–2028

**Goal.** Several Users share one Friday: identity, **Role**, **Scope**, per-User
**Conversation**s.
**Done when** a second account can be added, holds its own Conversation, and cannot read
the first's personal-Scope rows.
**ADRs:** 051 (identity), 052 (Conversations), 053 (Role, Scope, lifecycle).
**Depends on:** E1 · **Does not depend on:** E5 — the standalone auth mode is what ships
today, so multi-user lands without a Control plane.

First slice is deliberately one task: **thread the acting User through the turn.** It is
[ADR-052](decisions.md)'s prompt identity, [ADR-053](decisions.md)'s role gate, and the
audit/erasure stamp at once — one change serving three obligations, and the shared
prerequisite that unblocks E2 and E3 together.

### E3 — Transports

FRI-2029 · tasks FRI-2030–2035

**Goal.** **Transport** as a first-class concept with per-Transport **Transport style**;
Slack first.
**Done when** a Slack thread drives a turn and Friday replies into it, as the right User.
**ADRs:** 052.
**Depends on:** E1, and E2's acting-User task · **Does not depend on:** E5.

A webhook receiver does not exist anywhere in the repo. For dogfooding, point one Slack app
at the Deployment directly; the central verify-and-route shim is an E5 refactor, not a
prerequisite — which is what keeps E3 off the Control plane's critical path.

### E4 — Agent isolation

FRI-2036 · tasks FRI-2037–2043

**Goal.** Agent execution moves into containers; the container is the sandbox.
**Done when** builders run in per-task containers with egress deny-by-default, and the
remaining four [ADR-054](decisions.md) controls are in place.
**ADRs:** 054.
**Depends on:** E1 (control 1 already landed there).

Builders first, per-turn worker containers as the declared destination. The worker boundary
is built as a protocol seam from the start — `wakeAgent` is IPC and `killDescendantTree`
walks `pgrep -P`, so both become a network protocol and a container lifecycle.

### E5 — Control plane

FRI-2044 · tasks FRI-2045–2051

**Goal.** The second application: marketing, registration, billing, legal, support,
provisioning, fleet upgrade, the central webhook shim, **Usage cap** ceilings and the kill
switch.
**Done when** a company can sign up and get a working Deployment unattended.
**ADRs:** 051, 052 (webhook shim), 053 (suspension and retention window).
**Depends on:** E1 (there must be an image to provision).

Separate codebase, no consumers until customer #2 — so it blocks nothing above it and can
start whenever there is a second pair of hands. Its hard parts are operational rather than
architectural: canary cohorts, per-Deployment migration telemetry, synthetic health probes
(process liveness is insufficient — the worst failure leaves the page looking fine while
live sync is dead), and expand/contract migration discipline becoming permanent.

## Order and parallelism

```
E1 ──┬── acting-User task ──┬── E2 ──┐
     │                      └── E3 ──┤
     ├── E4 ─────────────────────────┤
     └── E5 (independent, any time) ─┘
```

- **E1 is the only hard gate.** Nothing is verifiable on the supported target before it.
- **The acting-User task is the only cross-epic chokepoint.** Sequence it first inside E2;
  E2 and E3 then run in parallel.
- **E4 parallelizes with E2/E3** — it shares only E1.
- **E5 parallelizes with everything** and is the natural second-person workstream.

## Sequencing risks

- **E1 is large, unglamorous, and mandatory.** Mitigation is the ordering note above: boot
  first, harden second.
- **Fleet upgrade cost is accepted, not solved** ([ADR-051](decisions.md) consequences).
  E5's telemetry and canary work is what makes it survivable; until then the fleet is one
  Deployment and the risk is latent.
- **The orchestrator stays unsandboxed until E4's later slices**, while being driven by any
  User over any Transport once E3 lands. E3 before E4 is a deliberate, time-boxed exposure
  — not an oversight.
