# MCP surface

Friday exposes its services to agents through MCP servers reconstructed inside each forked worker. Servers are gated by **caller type** at the worker boundary — the model only sees tools its agent type is authorized to use.

Server registration: `services/daemon/src/mcp/builder.ts`. Each server is built by a sibling file (`mail.ts`, `agents.ts`, `memory.ts`, `tickets.ts`, `schedule.ts`, `evolve.ts`, `integrations.ts`, `echo.ts`). The old `chat.ts` (`chat_reply` tool) was removed by FIX_FORWARD 8.5 — mail is the universal delivery primitive (ADR-017).

Tool names appear to the model as `mcp__<server-name>__<tool-name>` (e.g. `mcp__friday-mail__mail_send`).

## Built-in Claude tools (per agent type)

The Claude `claude_code` preset provides Read, Write, Edit, Bash, Glob, Grep. Friday disables the SDK's built-in `Memory` tool (`autoMemoryEnabled: false`) and the model is instructed not to use the SDK's `Task` sub-agent primitive. Friday's own MCP servers replace both.

## Friday MCP servers

| Server                | Tools                                                                                                                                                                                                                                                                                                                                      | Orchestrator | Builder | Helper | Scheduled | Bare  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------: | :-----: | :----: | :-------: | :---: |
| `friday-mail`         | `mail_send` (with `priority: 'normal' \| 'critical'`), `mail_inbox`, `mail_read`, `mail_close`                                                                                                                                                                                                                                             |      ✓       |    ✓    |   ✓    |     ✓     |   ✓   |
| `friday-agents`       | `agent_create`, `agent_list`, `agent_status`, `agent_archive`, `agent_inspect`                                                                                                                                                                                                                                                             |      ✓       |    —    |   —    |     —     |   —   |
| `friday-memory`       | `memory_search`, `memory_get` (read-only); `memory_save`, `memory_update`, `memory_forget` (write)                                                                                                                                                                                                                                         |    ✓ R/W     |   ✓ R   | ✓ R/W  |   ✓ R/W   | ✓ R/W |
| `friday-tickets`      | `ticket_create`, `ticket_list`, `ticket_get`, `ticket_update`, `ticket_comment`, `ticket_link_external`                                                                                                                                                                                                                                    |      ✓       |    ✓    |   ✓    |     —     |   —   |
| `friday-schedule`     | `schedule_upsert`, `schedule_list`, `schedule_show`, `schedule_pause`, `schedule_resume`, `schedule_delete`, `schedule_trigger`                                                                                                                                                                                                            |      ✓       |    —    |   —    |     —     |   —   |
| `friday-reminder`     | `reminder_create` (accepts `runAt`/`cron`/`dueDate` + optional `idempotencyKey` for app-namespaced re-emission), `reminder_list`, `reminder_cancel`, `reminder_snooze` (user-facing chat nudges that fire without waking any agent; reachable by every agent type, incl. app sub-agents)                                                   |      ✓       |    ✓    |   ✓    |     ✓     |   ✓   |
| `friday-habit`        | `habit_add`, `habit_checkin`, `habit_list`, `habit_status`, `habit_update`, `habit_archive`, `habit_checkin_undo` (core habit/streak tracking; streak computed on read; reachable by every agent type, with soft "only check in habits you own" guidance)                                                                                  |      ✓       |    ✓    |   ✓    |     ✓     |   ✓   |
| `friday-evolve`       | `evolve_list`, `evolve_get`, `evolve_save`, `evolve_update`, `evolve_apply`, `evolve_dismiss`, `evolve_scan`, `evolve_enrich`, `evolve_cluster`                                                                                                                                                                                            |      ✓       |    —    |   —    |     —     |   —   |
| `friday-github`       | `pr_create`, `pr_checks` (repo + head branch come from the caller's row; no merge tool)                                                                                                                                                                                                                                                    |      —       |    ✓    |   —    |     —     |   —   |
| `friday-integrations` | `linear_import`, `linear_create_issue`, `linear_update_issue`, `linear_reconcile`                                                                                                                                                                                                                                                          |      ✓       |    ✓    |   ✓    |     ✓     |   ✓   |
| `friday-apps`         | `app_install`, `app_uninstall`, `app_list`, `app_inspect`, `app_reload`                                                                                                                                                                                                                                                                    |      ✓       |    —    |   —    |     —     |   —   |
| `friday-inbox`        | `inbox_list` (open stateless-intake Captures awaiting triage), `inbox_act` (`approve` runs the staged executor + resolves / `reject` resolves without executing / `dismiss` resolves without acting / `triage` routes an Unsorted item to an `agent:<name>` by mail / `undo` reverses a Done artifact — all idempotent) (FRI-171, ADR-047) |      ✓       |    —    |   —    |     —     |   —   |
| `friday-echo`         | `echo` (sanity check)                                                                                                                                                                                                                                                                                                                      |      ✓       |    ✓    |   ✓    |     ✓     |   ✓   |
| `friday-secrets`      | `secrets_fetch`, `secrets_list` (on-demand secrets only; audited, rate-limited)                                                                                                                                                                                                                                                            |      ✓       |    ✓    |   ✓    |     —     |   ✓   |
| `playwright`          | `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_evaluate`, `browser_console_messages`, `browser_network_requests`, … (full `@playwright/mcp` surface)                                                                                                                         |      —       |    ✓    |   ✓    |     ✓     |   ✓   |

### Gating notes

- **No more `chat_reply` / `friday-chat`** (ADR-017). All user-visible deliveries go through `mail_send` with recipient `friday`; the orchestrator's mail-bridge surfaces them as `mail`-kind block rows in the chat. Builders and helpers address the user the same way.
- **`mail_send.priority`** (ADR-014 amendment). `'normal'` (default) queues for the next turn boundary; `'critical'` triggers mid-turn injection via `mail-wakeup-critical` IPC. Use sparingly — interrupting tool loops costs work in flight.
- **`agent_archive`** is the merged form of the prior `agent_kill` + `agent_delete_workspace`: for builders it stops the worker, removes the worktree under `~/.friday/workspaces/<name>/`, and force-deletes the `friday/<name>` branch. The tool description is contractual — the model MUST present the proposed archive to the user and wait for an explicit "yes" before invoking. **Required argument:** `reason: "completed" | "abandoned" | "failed"`. The reason drives the linked-ticket close behavior (`completed`→`done`+Linear `completed`; `abandoned`/`failed`→`closed`+Linear `canceled`). The orchestrator should ask the user which outcome applies before calling. See `docs/architecture.md` § "Archive reason and linked-ticket close".
- Builder gets `memory_search` / `memory_get` only — builders consult memory but mail the orchestrator with anything worth saving as canonical memory.
- Bare and scheduled don't touch tickets directly. Scheduled meta-agents push proposals through evolve, which the orchestrator turns into tickets.
- Schedule, evolve, and apps mutation are orchestrator-only — sub-agents shouldn't be modifying their own schedules, applying proposals, or installing/uninstalling apps.
- **`friday-apps`** (ADR-021, FRI-78). The `app_uninstall` tool's `folderDisposition: "delete"` is irreversible and the tool description leads with that. Default is `archive` (folder renamed to `<id>.uninstalled-<ts>/`); `keep` leaves the folder in place. Agent rows, schedules, and the registry row are always preserved on uninstall per the preserve-over-delete rule; only the folder contents can be destroyed.
- **`friday-inbox`** (ADR-047, FRI-171). Orchestrator-only, like `friday-schedule`/`friday-evolve`/`friday-apps` — sub-agents never see it. It is the **only** way the orchestrator touches the stateless-intake Inbox, and it's a pull surface: Friday lists and acts on open Captures only when Seth tells her to ("work through my inbox"). There is no nightly or out-of-band triage pass — triage is Seth's job. `inbox_act` actions are idempotent (re-acting on a resolved item is a safe no-op); the tool description tells the model to act only at explicit direction and to summarize and ask before acting otherwise.
- **Per-app stdio MCP servers** are appended to the worker's MCP set when the calling agent has an `app_id` set. Names starting with `friday-` are rejected; the orchestrator never has an `app_id`, so it never sees per-app servers. Args resolve relative to the app folder; `${VAR}` env values substitute from the age vault (app-scoped `env` secrets) with legacy `apps/<id>/.env` fallback during migration. See `docs/architecture.md` §Apps and ADR-038.
- **`friday-elicitation`** (FRI-2074). **The one server that is not hosted, and that is a decision rather than a gap.** Measured: hosted, every `ask_user` fails with `ask_user invoked without a tool_use_id`. The elicitation id _is_ `extra.toolUseId` — what the dashboard SSE event, the submit POST and the canonical `tool_use` block all key on. `createSdkMcpServer` injects it because it runs in-process; the standard MCP transport's `extra` carries `requestId` and `signal` and no `toolUseId`, because tool_use_id is an Anthropic-API concept, not an MCP one.

  Hosting it would buy none of what hosting is for. The other thirteen moved to get a privileged tool surface out of the process running untrusted repository code; `ask_user` holds no credential, reads no state and does nothing privileged — it blocks on a human. Container reachability, the other objection, is already handled: `POST /api/elicitation/wait` is in `WORKER_FACING_ROUTES` (FRI-2072). A test in `hosted-portability.test.ts` pins both halves, so finishing the migration would mean deleting a decision rather than discovering the reason by breaking it.

- **`friday-github`** (FRI-2078). Builder-only, and **always hosted** — there is no in-process fallback, because the whole point is that Friday's GitHub credential stays out of the process running untrusted repository code. Replaces the `gh pr create` / `gh pr checks` the builder persona used to prescribe: before this, a Builder's PRs went through whatever `gh` login existed on the daemon's machine, which Friday could not scope, revoke or attribute, and which does not exist at all in a per-task container (FRI-2038).

  The repository and the head branch are resolved daemon-side from the caller's own registry row and are **absent from the tool schemas** — a Builder opens a PR from its own branch on its own repo, or not at all. `base` is gated to the main branch or another `friday/*` branch (stacked PRs). **There is no merge tool**: "halt at a green PR — never merge" stops being a prompt rule and becomes an operation that does not exist. `pr_checks` returns a snapshot with `complete`/`passing` rather than blocking like `gh pr checks --watch`, which would hold an MCP request open for a whole CI run.

  Needs `GITHUB_TOKEN` in the vault (`friday secrets set GITHUB_TOKEN --daemon`), and `POST /api/secrets/reload` or a restart for it to take effect — `loadFridayConfig` caches. Without it `pr_create` returns 503 naming that command.

- **`friday-secrets`** (ADR-038). In-process MCP — caller identity comes from worker spawn options, not HTTP headers. `secrets_fetch` returns on-demand secrets only (`mode: on-demand` in `secrets/meta.yaml`); env-mode and daemon secrets are never disclosed. Fetches are audited to `secrets_fetch_log` (10/caller/hour rate limit). Scheduled agents are excluded.
- **`playwright`** is the only other stdio (out-of-process) built-in. It launches Microsoft's `@playwright/mcp` via `npx -y @playwright/mcp@latest --headless --isolated` per worker — one fresh Chromium per agent, no shared profile (`SingletonLock` prevents that anyway). Orchestrator is excluded so long-running browser calls never block user responsiveness; browser work belongs in a spawned sub-agent.

## Tool handlers — HTTP loopback

All Friday MCP tool handlers HTTP-call the daemon at `127.0.0.1:<daemonPort>`. They never call shared services directly. Two reasons:

1. **Architecture intent.** The daemon is the sole writer of SQLite. Routing through HTTP keeps that contract.
2. **Auditability.** Every agent action goes through the same code path the dashboard uses. Logging, request tracing, future rate-limiting all hook in one place.

Cost: ~1ms per call on localhost — negligible at LLM-tier latency.

The handlers send `x-friday-caller-name` and `x-friday-caller-type` headers so the API can use them for `createdBy` / `author` / audit fields.

## User-configured MCP servers

In `~/.friday/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "gcal",
      "command": "npx",
      "args": ["-y", "@some-org/mcp-gcal"],
      "env": { "GCAL_TOKEN": "..." },
      "scope": ["orchestrator", "helper", "bare"]
    }
  ]
}
```

- Stdio transport only (the `command` / `args` / `env` shape). HTTP/SSE
  transports aren't wired yet.
- `scope` restricts by agent type. Empty or missing = all agent types.
- Names starting with `friday-` are reserved for in-process built-ins. The
  name `playwright` is also reserved (built-in browser MCP). Reserved names
  in user config are rejected with a warning in the daemon log.
- Malformed entries (e.g. missing `command`) are skipped, not fatal — a typo
  in config never blocks a worker from starting.
- The daemon reloads `~/.friday/config.json` on every spawn, so edits take
  effect on the next agent fork without a restart.

## Skill-driven tool restriction

When a skill declares `allowed_tools`, the daemon assembles the SDK call with the **intersection** of the agent's normal tool set and the skill's declared tools. Per-turn restriction only — never expansion. See `docs/chat-ux.md` §Skills.

## Pending tools (`docs/roadmap.md`)

- Linear `linear_import` — once `reconcile()` is wired.
