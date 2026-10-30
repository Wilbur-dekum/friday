# Protocol: Linear

When the user has Linear configured (via `LINEAR_API_KEY` and the linear integration package), tickets in Friday's `tickets` table can be linked to Linear tickets via `ticket_external_links`.

## When to link

- The user assigns a Linear ticket → create a Friday ticket and link it.
- The user creates a ticket in Friday for non-trivial work → optionally also create it in Linear.

## Lifecycle workflow

Linear's state types are `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. Friday's convention:

| Trigger                                                                 | Linear state                                              | Owner                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------- |
| `linear_create_issue` files a new ticket                                | `backlog` (Linear default)                                | n/a                         |
| Orchestrator dispatches a builder/helper against a Linear-linked ticket | `started`                                                 | orchestrator                |
| Builder opens a PR that closes the ticket                               | (still `started`) — include `Closes FRI-N` in the PR body | builder                     |
| PR with `Closes FRI-N` is merged                                        | `completed`                                               | Linear's GitHub integration |
| Ticket dropped or superseded                                            | `canceled`                                                | orchestrator                |
| `agent_archive` with `reason=completed` / `abandoned` / `failed`        | `completed` / `canceled` / `canceled`                     | daemon (automatic)          |

Don't leave Linear tickets stuck in `backlog` once work has started. The orchestrator owns the `backlog → started` transition; the GitHub integration owns the `started → completed` transition; `agent_archive` is the safety net.

## `Closes FRI-N` — PR-body convention

When a PR closes a Linear ticket, include `Closes FRI-N` (or the equivalent for another team prefix) on its own line in the **PR body** — Linear's GitHub integration scans PR descriptions for close keywords and moves the linked issue to `completed` on merge. Builders are responsible for putting this in the `body` they pass to `pr_create`; the orchestrator should not have to chase merges to manually transition.

Conventions:

- One Linear identifier per close line: `Closes FRI-86`, not `Closes FRI-86, FRI-87`. (Linear's parser accepts a comma list, but per-line is more legible in PR review.)
- Use `Closes` (not `Fixes`, `Resolves`, etc.) for consistency across Friday's PRs.
- Always in the PR **body**, not the title — Linear scans bodies and commit messages, not titles.
- Multiple tickets closed by one PR → multiple `Closes` lines.
- If a PR is partial work on a ticket that should _not_ auto-close, reference the ticket without the keyword: `Part of FRI-86` or `Refs FRI-86`.

## Ticket state on archive

Friday ticket state — and any linked Linear state — propagates **automatically** when you archive a builder via `agent_archive`. The daemon's archive path reads the agent's linked `ticketId`, maps the archive `reason` to a ticket status, and pushes the corresponding workflow state to every external system on the ticket's links.

| `reason`    | local ticket               | Linear state              |
| ----------- | -------------------------- | ------------------------- |
| `completed` | `done`                     | `completed` (e.g. "Done") |
| `abandoned` | `closed`                   | `canceled`                |
| `failed`    | `closed` + failure comment | `canceled`                |

Before proposing `agent_archive` to the user, **ask which outcome applies**: "Archive `<name>` as done, abandoned, or failed?" Don't pick a default — the user's choice drives both the Friday and Linear sides.

Manual `linear_update_issue` calls remain available for transitions outside the dispatch / archive flow (e.g. moving a ticket to `canceled` when the user decides not to pursue the work). Don't double-write from a builder turn — builders should rely on the `Closes FRI-N` keyword in the PR body and let the integration close the ticket on merge.

## Reconciliation

The daemon runs a reconcile pass on boot: cross-references Linear tickets in "In Progress" with live Friday agents and surfaces orphans. Treat the resulting orphan list as ambient state, not as commands.

## Communication

The Linear ticket itself is the primary record for Linear-aware stakeholders. Add brief comments when state changes if you have additional context worth leaving on the issue. Don't dump full transcripts; link to Friday's `/tickets/<id>` page when relevant.
