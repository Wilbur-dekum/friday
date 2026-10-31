/**
 * Worker entrypoint. Forked by `lifecycle.ts`. Speaks the protocol defined in
 * `worker-protocol.ts`. Hosts a long-lived agent loop:
 *
 *   while (!stopped) {
 *     if pendingPrompt → run query() with that prompt
 *     else drain mail inbox; if mail → build mail prompt → run query()
 *     else emit idle, await mail-wakeup / new prompt / stop / 60s timeout
 *   }
 *
 * `mode === "one-shot"` short-circuits the loop after the first query() —
 * scheduled agents fire, run, and exit.
 *
 * MCP servers are reconstructed inside the worker (their config carries a
 * live McpServer instance that can't cross the IPC boundary).
 *
 * "IPC" throughout this file means the command/event transport, not
 * specifically node IPC: a containerised worker (FRI-2038) carries the same
 * protocol over a WebSocket it dials to the daemon. See `worker-transport.ts`.
 */

import { randomUUID } from "node:crypto";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AGE_KEY_PATH,
  DATA_DIR,
  META_PATH,
  VAULT_ENC_PATH,
  autoCompactWindowFor,
  loadConfig,
  renderLocalDatetime,
  renderLocalDatetimeLine,
  stringifyToolResult,
  unlockVault,
} from "@friday/shared";
import { runMemoryFlush } from "./compact-flush.js";
import { resolveWorkerTransport } from "./worker-transport.js";
import { readAttachmentBytes, type MailRow } from "@friday/shared/services";
import type {
  WorkerAttachment,
  WorkerCommand,
  WorkerEvent,
  WorkerPromptCommand,
  WorkerSpawnOptions,
} from "./worker-protocol.js";
import {
  extractRequestUsage,
  extractUsageFromResult,
  type FinalUsage,
  type RequestUsage,
} from "./usage-capture.js";
import { classifySdkError } from "./sdk-error.js";
import { healDanglingToolUseInJsonl } from "./sdk-jsonl-heal.js";
import { buildMcpServers } from "../mcp/builder.js";
import { workspacesRoot } from "./workspace.js";
import { buildMailPrompt } from "../comms/mail-prompt.js";
import { daemonFetch } from "../mcp/http.js";
import { runHooks } from "@friday/shared";
import "../hooks/register.js";
import { denyBuiltinAskUserQuestion } from "../hooks/block-builtin-ask-user-question.js";
import { captureShellEnv, claudeCodeChildEnv, getResolvedShellEnv } from "../shell-env.js";
import { ensureContainerWorkspace } from "./workspace-clone.js";
import { logger } from "../log.js";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

// FRI-150 (pivot, ADR-037): per-agent shell capture. Each forked worker
// runs `$SHELL -ilc` at startup to learn what the user's interactive
// shell sees — PATH + toolchain hints + locale. The captured env is
// stored on a per-worker-process module singleton in shell-env.ts; the
// MCP builder reads from it via `getResolvedShellEnv()` and threads a
// RESTRICTED allowlist subset into each per-server stdio `env`.
//
// Latency: typically 50-300ms; capped at 5s by the in-module timeout
// (override via `FRIDAY_SHELL_ENV_TIMEOUT_MS`). On capture failure
// (timeout, missing shell, marker parse error) the fallback is a
// sanitized `process.env` snapshot — the worker keeps going. See
// `services/daemon/src/shell-env.ts` for the full failure matrix.
//
// Capture runs ONCE per worker process and is reused across every turn
// that worker handles. Long-lived agents (orchestrator, builders,
// helpers, kitchen) amortize the cost easily; one-shot scheduled
// agents pay it once and exit.
//
// Start the capture eagerly at module load, parallel with the worker's
// `ready` IPC and the parent's first `start` message round-trip. The
// promise resolves into a module-internal singleton; we `await` it at
// the top of `mainLoop` (below) so the singleton is seeded BEFORE the
// SDK's first `query()` builds any MCP child env.
const shellEnvCapturePromise: Promise<unknown> = captureShellEnv();

let abortController: AbortController | null = null;
let stopped = false;
let mainLoopRunning = false;
let pendingPrompt: WorkerPromptCommand | null = null;
/**
 * Set when a `mail-wakeup-critical` IPC arrives. Read at the next SDK
 * iteration boundary inside `runQuery`; on set, the worker breaks the
 * iterator and lets `mainLoop` drain the inbox (FIX_FORWARD 2.4).
 */
let pendingCriticalMail = false;
/**
 * Set when the parent has queued user prompts and signalled
 * `prompts-pending`. Read at the next SDK iteration boundary; on set, the
 * worker breaks the iterator and emits `turn-complete`. The parent's
 * existing turn-complete handler then pops `nextPrompts` and sends a
 * fresh `prompt` IPC (FIX_FORWARD 2.4).
 */
let promptsPending = false;
let idleResolve: (() => void) | null = null;
let workerOpts: WorkerSpawnOptions | null = null;
let lastSessionId: string | undefined;

/**
 * FRI-27 §4: in-flight memory-flush guard. The SDK can fire PreCompact more
 * than once for a session (a retry, or multiple compact_boundary frames in one
 * long turn — both legitimate), and two overlapping flushes would each
 * fork-resume the full context and race two memory_save streams against the
 * same store. Module-scope so it spans the worker's lifetime; the PreCompact
 * hook short-circuits when the session is already flushing and clears the
 * entry in a finally.
 */
const inFlightFlushes = new Set<string>();

/**
 * FRI-156 §A: the autoCompactWindow "takes-effect" probe fires ONCE per worker
 * process. The configured window is a function of agent type + config, both
 * constant for the worker's lifetime, so the SDK verdict can't change
 * turn-to-turn — re-probing every runQuery only re-issued a getContextUsage()
 * control round-trip to re-log an invariant.
 */
let probeFired = false;

/**
 * FRI-2038: node IPC when there is a parent process, a WebSocket to the
 * daemon's worker-facing listener when there is not (a containerised worker).
 * Resolved at module load, deliberately: a worker with neither should fail
 * before it runs a turn whose every event would go nowhere.
 */
const transport = resolveWorkerTransport();

function emit(e: WorkerEvent): void {
  transport.send(e);
}

function wakeIdle(): void {
  if (idleResolve) {
    const r = idleResolve;
    idleResolve = null;
    r();
  }
}

transport.onCommand((msg: WorkerCommand) => {
  try {
    if (msg.type === "start") {
      if (!workerOpts) {
        workerOpts = msg.options;
        lastSessionId = msg.options.resumeSessionId;
        pendingPrompt = {
          prompt: msg.options.prompt,
          attachments: msg.options.attachments,
          turnId: msg.options.turnId,
          resumeSessionId: msg.options.resumeSessionId,
          allowedToolsOverride: msg.options.allowedToolsOverride,
        };
        if (!mainLoopRunning) {
          mainLoopRunning = true;
          void mainLoop();
        }
      }
    } else if (msg.type === "prompt") {
      // Replace any unprocessed pending prompt — the latest user input wins.
      pendingPrompt = msg.options;
      wakeIdle();
    } else if (msg.type === "abort") {
      abortController?.abort();
    } else if (msg.type === "stop") {
      stopped = true;
      abortController?.abort();
      wakeIdle();
    } else if (msg.type === "mail-wakeup") {
      wakeIdle();
    } else if (msg.type === "mail-wakeup-critical") {
      pendingCriticalMail = true;
      wakeIdle();
    } else if (msg.type === "prompts-pending") {
      promptsPending = true;
      wakeIdle();
    }
  } catch (err: unknown) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  }
});

emit({ type: "ready" });

async function mainLoop(): Promise<void> {
  if (!workerOpts) return;
  // FRI-150 (ADR-037): await the in-flight shell capture before the SDK
  // can build any MCP child env. Capture was kicked off at module load
  // so it ran in parallel with `ready` + the first `start` round-trip;
  // by here it's usually already settled. The 5s in-module timeout
  // bounds this. On any failure mode `captureShellEnv` resolves with a
  // sanitized process.env snapshot — mainLoop never throws because of
  // shell-env issues.
  await shellEnvCapturePromise;
  await unlockVault();
  // FRI-2076: fill `/workspace` before the first turn. A containerised Builder
  // gets an empty volume from the broker, and the repo it needs is served by
  // the daemon — this is the client of that route. A no-op for a forked worker,
  // which has a real worktree, and for a reattached volume that already holds a
  // clone. Reported rather than thrown: the turn should fail with a visible
  // reason, not die before it starts.
  const cloned = await ensureContainerWorkspace(process.env, workerOpts.workingDirectory);
  if (cloned.state === "failed") {
    emit({
      type: "error",
      message: `workspace could not be provisioned: ${cloned.reason ?? "unknown"}`,
      recoverable: false,
    });
    process.exit(1);
  }
  try {
    while (!stopped) {
      if (pendingPrompt) {
        const p = pendingPrompt;
        pendingPrompt = null;
        await runQuery(p);
        if (workerOpts.mode === "one-shot") break;
        continue;
      }

      // Long-lived path: poll the inbox before idling. A `prompt` IPC can land
      // during the poll (the daemon drains its queue immediately on
      // turn-complete and sends the next prompt ~25ms later); `wakeIdle()` is a
      // no-op while we're awaiting here, so the post-poll read inside
      // `resolveBetweenTurnsStep` is what catches it. See that function's
      // doc-comment for the failure mode (a dropped queued message, surfacing
      // as "Agent didn't respond").
      const { agentName, daemonPort } = workerOpts;
      const { action, inbox } = await resolveBetweenTurnsStep({
        isPromptPending: () => pendingPrompt !== null,
        isStopped: () => stopped,
        fetchInbox: () => fetchInboxQuiet(agentName, daemonPort),
      });
      if (action === "loop") continue;
      if (action === "mail") {
        pendingPrompt = {
          prompt: buildMailPrompt(workerOpts.agentName, inbox),
          turnId: `t_${randomUUID()}`,
          resumeSessionId: lastSessionId,
        };
        continue;
      }

      // Idle. Resolved by mail-wakeup, prompt, stop, or 60s timeout (which
      // re-checks the inbox as a backstop in case the IPC was missed).
      emit({ type: "status-change", status: "idle" });
      await new Promise<void>((resolve) => {
        // Lost-wakeup guard: if a `prompt`/`stop` landed since the checks
        // above (no await sits between them and here today, but keep the
        // invariant local so a future refactor that adds one can't reopen the
        // race), resolve immediately rather than parking for 60s.
        if (pendingPrompt !== null || stopped) {
          resolve();
          return;
        }
        idleResolve = resolve;
        setTimeout(() => {
          if (idleResolve === resolve) {
            idleResolve = null;
            resolve();
          }
        }, 60_000).unref();
      });
    }
  } catch (err: unknown) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  } finally {
    process.exit(0);
  }
}

async function fetchInboxQuiet(agentName: string, port: number): Promise<MailRow[]> {
  try {
    return await daemonFetch<MailRow[]>({
      port,
      path: `/api/mail/inbox/${encodeURIComponent(agentName)}`,
      callerName: agentName,
    });
  } catch {
    return [];
  }
}

/**
 * Per-turn block tracking. The SDK gives us `index` for content blocks inside
 * `content_block_start/delta/stop` events. We mint a `clientBlockId` that's
 * unique within this worker process (so duplicate indices across messages
 * stay separate) and the daemon correlates start/delta/stop by that id.
 */
interface BlockState {
  clientBlockId: string;
  kind: "text" | "tool_use" | "thinking";
  blockIndex: number;
  messageId?: string;
  /** Stable tool id from the SDK content block; only set when kind === 'tool_use'. */
  toolId?: string;
  toolName?: string;
  /** Accumulated text for text/thinking; assembled for the final block-stop. */
  text: string;
  /** Accumulated `input_json_delta.partial_json` for tool_use blocks. */
  inputJson?: string;
}

function nextClientBlockId(): string {
  return `b_${randomUUID()}`;
}

/**
 * Whether an SDK `assistant`-typed message carries any `tool_use` content
 * blocks. Used by the for-await loop to decide whether a pending-injection
 * break should fire immediately at the assistant boundary (pure-text reply,
 * no follow-up `user` tool_results message coming) or defer to the next
 * `user` boundary (model invoked tools; breaking now would leave the SDK
 * session JSONL with a dangling `assistant→tool_use` and trigger
 * "Stream closed" on the subsequent resume). Exported for testability.
 */
export function assistantMessageHasToolUses(assistantMsg: unknown): boolean {
  const content = (assistantMsg as { content?: unknown })?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as { type?: string })?.type === "tool_use");
}

/**
 * Whether an SDK `assistant`-typed message has produced its REPLY yet — a
 * `text` content block (tool_use is handled separately by the breakAtNextUser
 * deferral above). Extended-thinking turns surface an assistant-message
 * boundary for the THINKING block *before* the reply text streams: the SDK
 * emits a partial assistant message whose `content` is `['thinking']`, then a
 * later boundary once the text arrives. A mid-turn prompts-pending /
 * critical-mail break that fires at the thinking-only boundary cancels the
 * (empty) thinking block via flushBoundaryBlocks and ends the turn with ZERO
 * captured blocks; the model's real reply then streams out-of-band into the
 * session JSONL after the worker has moved on to the queued turn, and post-turn
 * recovery orphans it under a synthetic `recover_<session>` turn with a late
 * timestamp — the "Agent didn't respond" + reordered-conversation bug. Gating
 * the break on reply-content-present keeps the break at a boundary where the
 * reply has been streamed and captured under THIS turn. Verified against the
 * live SDK frame ordering (the thinking-only boundary reports
 * `m.message.content === ['thinking']`). Exported for testing.
 */
export function assistantMessageHasText(assistantMsg: unknown): boolean {
  const content = (assistantMsg as { content?: unknown })?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as { type?: string })?.type === "text");
}

/**
 * FRI-156 §C: classify the SDK `system/status` frame into a `compacting-status`
 * WorkerEvent (or `null` to ignore it).
 *
 * The SDK shape (verified sdk.d.ts@0.2.132 SDKStatusMessage):
 *   `{ type:'system'; subtype:'status'; status:'compacting'|'requesting'|null;
 *      compact_result?:'success'|'failed'; compact_error?:string }`
 *
 * Mapping:
 *   - `status:'compacting'`            → phase:'start' (live spinner on)
 *   - `compact_result` present         → phase:'done' + result (+ error)
 *   - everything else (incl.
 *     `status:'requesting'`, which is
 *     UNRELATED to compaction)         → null (ignored)
 *
 * IMPORTANT: the field is `compact_result` with values 'success'|'failed' —
 * NOT any other shape — and `status:'requesting'` must be ignored. If a future
 * SDK bump renames either field this branch silently stops emitting; the test
 * pins all three live frame shapes so a regression surfaces there. Exported
 * for testability (pure — no IPC, no I/O).
 */
export function classifyStatusFrame(
  m: Record<string, unknown>,
  sessionId: string | undefined,
): {
  type: "compacting-status";
  sessionId: string;
  phase: "start" | "done";
  result?: "success" | "failed";
  error?: string;
} | null {
  if (m.type !== "system" || m.subtype !== "status") return null;
  if (m.status === "compacting") {
    return { type: "compacting-status", sessionId: sessionId ?? "", phase: "start" };
  }
  const result = m.compact_result;
  if (result === "success" || result === "failed") {
    const error = typeof m.compact_error === "string" ? m.compact_error : undefined;
    return {
      type: "compacting-status",
      sessionId: sessionId ?? "",
      phase: "done",
      result,
      ...(error ? { error } : {}),
    };
  }
  // status:'requesting' or any other status frame — unrelated to compaction.
  return null;
}

/**
 * Resolve which session id a drained prompt should resume (FRI-127 §6/§9).
 *
 * The worker's own `lastSessionId` — the most recent session id it observed
 * from the SDK's `session_id` field — is the freshest signal. A queued
 * prompt's `p.resumeSessionId` was captured at POST/NOTIFY time and may be
 * stale by the time the prompt drains (the just-finished turn moved the
 * session on). Prefer the live value; only fall back to the parent-provided
 * value when the worker has no observed session yet — i.e. the first turn
 * after a fresh spawn, where `lastSessionId` is `undefined` and the SDK
 * should start a brand-new session from `p.resumeSessionId` (typically also
 * `undefined`). Exported for testability.
 */
export function resolveSessionId(
  p: { resumeSessionId?: string },
  lastSessionId: string | undefined,
): string | undefined {
  return lastSessionId ?? p.resumeSessionId;
}

/**
 * What the between-turns loop should do after polling the mail inbox.
 *
 *  - "loop": re-enter the loop immediately — either a `prompt` IPC landed
 *    while we were polling (service it at the loop top) or `stop` arrived
 *    (let the `while (!stopped)` guard exit). Never park in this case.
 *  - "mail": no user prompt pending but the inbox has mail; build a
 *    mail-driven turn.
 *  - "park": genuinely idle — emit `status-change: idle` and await the next
 *    wakeup (mail-wakeup / prompt / stop / 60s timeout).
 *
 * Extracted as a pure function (mirroring {@link resolveSessionId}) so the
 * lost-wakeup invariant can be asserted without forking a worker or stubbing
 * the SDK. THE INVARIANT: a `prompt` IPC that arrives during the inbox poll
 * MUST win over both parking and draining mail. `wakeIdle()` is a no-op while
 * we're inside `await fetchInboxQuiet()` (idleResolve isn't set yet), so the
 * wakeup is lost; if the loop then parks (or clobbers `pendingPrompt` with a
 * mail prompt) the queued message is never serviced. In practice the user
 * re-sends, the re-send overwrites `pendingPrompt`, and the original turn ends
 * with zero assistant blocks — the dashboard's "Agent didn't respond" with the
 * queued message missing from context. Re-checking `pendingPrompt` after the
 * poll closes the window. (Follow-up to the FRI-127 queue-drain work; that fix
 * addressed stale `resumeSessionId`, not this scheduler race.)
 */
export type BetweenTurnsAction = "loop" | "mail" | "park";

export function nextBetweenTurnsAction(state: {
  hasPendingPrompt: boolean;
  stopped: boolean;
  inboxCount: number;
}): BetweenTurnsAction {
  if (state.hasPendingPrompt || state.stopped) return "loop";
  if (state.inboxCount > 0) return "mail";
  return "park";
}

/**
 * Poll the inbox, then decide what the between-turns loop should do — reading
 * the pending/stopped flags AFTER the poll resolves.
 *
 * The post-await read is the entire fix, not an incidental detail: a `prompt`
 * (or `stop`) IPC that lands *during* `fetchInbox()` has already lost its
 * `wakeIdle()` (idleResolve is unset while we're awaiting here), so this read
 * is the only thing that observes it. Snapshotting `isPromptPending()` /
 * `isStopped()` *before* the await reopens the dropped-queued-message race.
 * Keeping the fetch and the read together in one awaitable unit lets a test
 * flip the pending flag from inside the injected `fetchInbox` and assert the
 * loop services the prompt rather than parking — coverage the pure
 * {@link nextBetweenTurnsAction} table cannot give (it never sees the ordering).
 */
export async function resolveBetweenTurnsStep<T extends { length: number }>(deps: {
  isPromptPending: () => boolean;
  isStopped: () => boolean;
  fetchInbox: () => Promise<T>;
}): Promise<{ action: BetweenTurnsAction; inbox: T }> {
  const inbox = await deps.fetchInbox();
  const action = nextBetweenTurnsAction({
    hasPendingPrompt: deps.isPromptPending(),
    stopped: deps.isStopped(),
    inboxCount: inbox.length,
  });
  return { action, inbox };
}

type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;

/**
 * Build the SDK `query()` options object for a turn. Extracted as a pure
 * function (FRI-127 §2/AC#3) so the `disallowedTools: ["Task"]` invariant —
 * and the rest of the options assembly — can be asserted without forking a
 * worker.
 *
 * `disallowedTools: ["Task"]` removes Anthropic's built-in `Task` sub-agent
 * tool from the model's context for EVERY agent type. All five Friday agent
 * types already carry a textual "do not use the built-in Task tool"
 * instruction; hardening at the SDK layer makes the rule structural. Per the
 * SDK docs `disallowedTools` "removes [tools] from the model's context …
 * even if they would otherwise be allowed", so it cannot conflict with the
 * `allowedTools` auto-approval list threaded from a skill's `allowed_tools`.
 */
export function buildQueryOptions(
  opts: WorkerSpawnOptions,
  _p: WorkerPromptCommand,
  sessionId: string | undefined,
  allowedTools: string[] | undefined,
  hooks: QueryOptions["hooks"] | undefined,
  thinking: QueryOptions["thinking"] | undefined,
  mcpServers: QueryOptions["mcpServers"],
  abortController: AbortController | undefined,
  shellEnv?: Record<string, string>,
): QueryOptions {
  return {
    cwd: opts.workingDirectory,
    model: opts.model,
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    mcpServers,
    // FRI-150 / ADR-037: hand the agent's Claude Code process the user's
    // captured interactive shell env — the missing half of the documented
    // trust gradient (shell-env.ts: "agent sees the captured user shell env
    // (full)"). The SDK's `env` REPLACES its `process.env` default, so we spread
    // process.env first (Friday's operational vars + creds) and overlay the
    // captured shell env so the user's PATH/toolchain wins. Without this the
    // agent's Bash tool inherits the daemon's launchd-minimal PATH on a fresh
    // (launchd-started) box and can't find `gh`, brew tools, etc. — even though
    // the MCP children (which already read this capture) can. Secret-shaped keys
    // are stripped from the capture (sanitizeEnv), so a user-shell export can't
    // clobber the CLI's creds in process.env (ANTHROPIC_API_KEY/_TOKEN/OAuth all
    // match the strip regex). Non-secret user vars (e.g. ANTHROPIC_BASE_URL) DO
    // overlay — intended: it's the user's box and their interactive shell wins,
    // same as if they ran `claude` in their terminal. `shellEnv` omitted (tests)
    // → no `env` override, identical to prior behavior.
    // FRI-2059: `claudeCodeChildEnv()`, NOT raw `process.env`. The worker
    // deliberately carries the full daemon environment (FRI-2012) — it is
    // Friday's own code and reaches the database — but the Claude Code child
    // is the boundary, because its Bash tool runs untrusted repository code.
    // DATABASE_URL, the age identity, SSH_AUTH_SOCK and the superuser
    // connection all stop here; the CLI's own Anthropic credentials do not,
    // because it cannot authenticate without them.
    ...(shellEnv ? { env: { ...claudeCodeChildEnv(), ...shellEnv } } : {}),
    // Drop Anthropic's built-in `Task` sub-agent tool from the catalog for
    // every agent type. Friday farms work out via `agent_create` + mail, not
    // SDK Task. See the doc-comment above.
    disallowedTools: ["Task"],
    // Friday owns memory via friday-memory MCP. Disabling the SDK's
    // project-scoped auto-memory prevents the model from silently
    // falling back to writes under ~/.claude/projects/<cwd>/memory/.
    // `autoMemoryEnabled` lives on Settings, passed through the
    // top-level `settings` Options field.
    //
    // FRI-156 §A: `autoCompactWindow` is the per-agent-type SDK auto-compact
    // ceiling (200K default for every type, config-overridable). When live
    // context crosses it, the SDK compacts in place — the backstop above the
    // 100K nightly sweep. Resolved field-by-field via `autoCompactWindowFor`
    // so a partial `compaction.autoCompactWindow` config override doesn't drop
    // the other types' defaults (the shallow-merge hazard).
    settings: {
      autoMemoryEnabled: false,
      autoCompactWindow: autoCompactWindowFor(loadConfig(), opts.agentType),
    },
    // FRI-78: thread the worker's abortController through the SDK so
    // `stop`/`abort` IPCs propagate cleanly to the CLI subprocess
    // (tool-execution streams shut down deterministically instead of
    // closing on iterator return). Without this, the SDK only learns
    // the consumer is gone when the for-await iterator returns.
    ...(abortController ? { abortController } : {}),
    ...(hooks ? { hooks } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(thinking ? { thinking } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: (opts.systemPrompt ? opts.systemPrompt + "\n\n" : "") + renderLocalDatetime(),
    },
    ...(sessionId ? { resume: sessionId } : {}),
  };
}

/**
 * FRI-16: is this cwd inside the builders' workspaces root
 * (`~/.friday/workspaces/`)? Drives the planner middle-path gate below — a
 * planner only gets the workspace-guard chain (in "middle" mode) when it
 * actually inherited a builder worktree; a planner running elsewhere (e.g.
 * under the orchestrator's home) is unguarded, exactly like a helper.
 */
export function isInsideBuilderWorkspace(p: string): boolean {
  const root = workspacesRoot();
  return p === root || p.startsWith(root + "/");
}

/**
 * Defense-in-depth PreToolUse adapter. The SDK fires PreToolUse for every
 * tool call regardless of permissionMode (bypassPermissions skips canUseTool
 * but not hooks); we use it for two things:
 *   1. Deny the built-in `AskUserQuestion` for every agent type that ships
 *      `friday-elicitation/ask_user` (FRI-152). The deny message redirects
 *      the model to the MCP variant. This fires unconditionally.
 *   2. The workspace-guard registry's `before_tool_call` chain — builders
 *      always; planners only when running inside a builder worktree, in
 *      "middle" mode (FRI-16). Composed below.
 *
 * Extracted as a pure function of `opts` so the gate (which agent types the
 * guard chain runs for, and with which mode) can be asserted without forking
 * a worker — see `worker-guard-gate.test.ts`.
 */
const SECRET_FS_PATHS = new Set([
  resolvePath(AGE_KEY_PATH),
  resolvePath(VAULT_ENC_PATH),
  resolvePath(META_PATH),
  resolvePath(DATA_DIR, ".daemon-secret"),
]);

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolvePath(homedir(), p.slice(2)) : p;
}

function denySecretsFilesystemAccess(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  const fsTools = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);
  if (!fsTools.has(toolName)) return undefined;
  const candidates = [
    toolInput.file_path,
    toolInput.path,
    toolInput.pattern,
    toolInput.notebook_path,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw) continue;
    const abs = resolvePath(expandHome(raw));
    for (const denied of SECRET_FS_PATHS) {
      if (abs === denied || abs.startsWith(`${denied}/`)) {
        return "Access to Friday secrets files is denied (ADR-038). Use mcp__friday-secrets__secrets_fetch for on-demand secrets.";
      }
    }
  }
  return undefined;
}

export function buildPreToolUseHooks(opts: WorkerSpawnOptions) {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: unknown) => {
            const i = input as {
              hook_event_name?: string;
              tool_name?: string;
              tool_input?: Record<string, unknown>;
            };
            if (i.hook_event_name !== "PreToolUse") return {};
            const secretsDeny = denySecretsFilesystemAccess(i.tool_name ?? "", i.tool_input ?? {});
            if (secretsDeny) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: secretsDeny,
                },
              };
            }
            // FRI-152: built-in AskUserQuestion deny. Pure check, runs
            // for all agent types.
            const builtinDeny = denyBuiltinAskUserQuestion(i.tool_name ?? "");
            if (builtinDeny) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: builtinDeny,
                },
              };
            }
            // Workspace-guard: builders always; planners only when running
            // inside a builder worktree (FRI-16 middle path). Skip for
            // everything else so the hook-registry round-trip stays out of
            // the hot path.
            const guardable =
              opts.agentType === "builder" ||
              (opts.agentType === "planner" && isInsideBuilderWorkspace(opts.workingDirectory));
            if (!guardable) return {};
            const results = await runHooks("before_tool_call", {
              workspacePath: opts.workingDirectory,
              toolName: i.tool_name,
              toolInput: (i.tool_input ?? {}) as Record<string, unknown>,
              mode: opts.agentType === "planner" ? "middle" : "strict",
            });
            const denied = results.find((r) => r?.deny);
            if (denied?.deny) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: denied.deny.reason,
                },
              };
            }
            return {};
          },
        ],
      },
    ],
  };
}

/**
 * FRI-156 §A — runtime "takes-effect" probe for `settings.autoCompactWindow`.
 *
 * Setting `autoCompactWindow` in {@link buildQueryOptions} is necessary but not
 * sufficient: the SDK has to actually honor it. The §A design mandates we
 * confirm at runtime via `Query.getContextUsage()` that the SDK's
 * `autoCompactThreshold` reflects the configured window — and, if the setting
 * does NOT flow through (older SDK, field renamed, threshold absent), log the
 * documented SDK gap. The probe verdict drives nothing directly; the documented
 * fallback is the INDEPENDENT nightly sweep (FRI-156 §B), which dispatches
 * `/compact` on its own timer at the 100K budget regardless of whether the SDK
 * ceiling takes effect — so context is bounded even when this probe reports
 * `takes_effect:false`.
 *
 * Best-effort and FULLY isolated: the probe is one `getContextUsage()` control
 * round-trip that never throws into the turn (any failure is swallowed and
 * logged as `takes_effect:false`). `getContextUsage` is absent on the mocked
 * iterator in some unit tests, so the method-presence guard is load-bearing.
 *
 * "Takes effect" means the SDK reports auto-compaction ENABLED and a numeric
 * `autoCompactThreshold` at or below the configured window — i.e. the window
 * (or something tighter) is the live ceiling. A missing threshold, disabled
 * auto-compaction, or a threshold larger than the window all mean the setting
 * did not flow through and the fallback is documented.
 *
 * Returns the probe verdict (also logged) so the call site / tests can assert.
 * Exported for the worker-layer runtime test.
 */
export async function probeAutoCompactWindow(
  q: Pick<Query, "getContextUsage"> | { getContextUsage?: never },
  configuredWindow: number,
  agentName: string,
): Promise<{ takesEffect: boolean; autoCompactThreshold?: number }> {
  const getUsage = (q as Partial<Query>).getContextUsage;
  if (typeof getUsage !== "function") {
    // SDK gap: no getContextUsage on the Query (older SDK). Document the
    // fallback to the post-turn-usage `/compact` dispatch path.
    logger.log("info", "worker.compact.window.probe", {
      agent: agentName,
      configured_window: configuredWindow,
      takes_effect: false,
      fallback: "independent nightly sweep bounds context (getContextUsage unavailable)",
    });
    return { takesEffect: false };
  }
  try {
    const usage = await getUsage.call(q);
    const threshold =
      typeof usage.autoCompactThreshold === "number" ? usage.autoCompactThreshold : undefined;
    const takesEffect =
      usage.isAutoCompactEnabled === true &&
      threshold !== undefined &&
      threshold <= configuredWindow;
    logger.log("info", "worker.compact.window.probe", {
      agent: agentName,
      configured_window: configuredWindow,
      auto_compact_threshold: threshold,
      auto_compact_enabled: usage.isAutoCompactEnabled,
      max_tokens: usage.maxTokens,
      takes_effect: takesEffect,
      ...(takesEffect
        ? {}
        : {
            fallback:
              "independent nightly sweep bounds context (SDK autoCompactThreshold did not reflect the window)",
          }),
    });
    return { takesEffect, autoCompactThreshold: threshold };
  } catch (e) {
    // A failed control round-trip must never affect the turn — log the gap and
    // document the same fallback.
    logger.log("warn", "worker.compact.window.probe", {
      agent: agentName,
      configured_window: configuredWindow,
      takes_effect: false,
      fallback: "independent nightly sweep bounds context (getContextUsage threw)",
      error: e instanceof Error ? e.message : String(e),
    });
    return { takesEffect: false };
  }
}

/** MIME types Anthropic's vision API will accept as `image` content
 *  blocks. `image/jpg` is folded into `image/jpeg`. Anything outside this
 *  set (and outside `application/pdf`, handled as a document block) is
 *  dropped with a warning so the model never sees an unsupported mime. */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function normalizeMediaType(mime: string): string {
  const m = mime.toLowerCase();
  return m === "image/jpg" ? "image/jpeg" : m;
}

/**
 * FRI-167: prefix a per-turn user body with a freshly-rendered local datetime
 * line so every turn (including resumed ones) sees the current time rather than
 * the session-frozen value baked into the systemPrompt append. Slash-command
 * bodies are passed through untouched — they are routed/parsed verbatim and a
 * prefix would corrupt the command.
 */
export function applyTurnDatetime(prompt: string): string {
  if (prompt.startsWith("/")) return prompt;
  return `${renderLocalDatetimeLine()}\n\n${prompt}`;
}

/**
 * Build the SDK's async-iterable prompt form when a turn carries
 * attachments. Yields a single `SDKUserMessage` whose `content` is the
 * text followed by one image/document block per attachment. The iterator
 * resolves immediately — the SDK collects the message synchronously and
 * runs the turn as if the caller had streamed it in.
 *
 * Resolution failures are non-fatal: a missing sha (e.g. the file rotted
 * out of `~/.friday/uploads`) drops that single attachment with a
 * `[image unavailable: <filename>]` text fragment so the model has some
 * signal that the user intended an attachment.
 */
async function buildAttachmentPromptStream(
  text: string,
  attachments: WorkerAttachment[],
): Promise<AsyncIterable<SDKUserMessage>> {
  const content: Array<Record<string, unknown>> = [];
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  for (const a of attachments) {
    const bytes = await readAttachmentBytes(a.sha256);
    if (!bytes) {
      content.push({
        type: "text",
        text: `[attachment unavailable: ${a.filename}]`,
      });
      continue;
    }
    const data = bytes.toString("base64");
    const mediaType = normalizeMediaType(a.mime);
    if (mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: mediaType, data },
        title: a.filename,
      });
    } else if (IMAGE_MEDIA_TYPES.has(mediaType)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      });
    } else {
      content.push({
        type: "text",
        text: `[attachment ${a.filename} has unsupported mime ${a.mime}]`,
      });
    }
  }
  // The SDK won't accept an empty content array — fall back to a single
  // empty-text block to keep the message valid. The dashboard's submit
  // gates already block empty-text-and-no-ready-attachments sends, so
  // this branch is purely defensive.
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      let yielded = false;
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (yielded) return Promise.resolve({ value: undefined, done: true });
          yielded = true;
          const msg: SDKUserMessage = {
            type: "user",
            message: { role: "user", content: content as never },
            parent_tool_use_id: null,
          };
          return Promise.resolve({ value: msg, done: false });
        },
      };
    },
  };
}

function finalizeBlockContent(b: BlockState): string {
  if (b.kind === "text") {
    return JSON.stringify({ text: b.text });
  }
  if (b.kind === "thinking") {
    return JSON.stringify({ text: b.text });
  }
  // tool_use
  let input: unknown = {};
  if (b.inputJson && b.inputJson.length > 0) {
    try {
      input = JSON.parse(b.inputJson);
    } catch {
      input = { _raw: b.inputJson };
    }
  }
  return JSON.stringify({
    tool_use_id: b.toolId ?? "",
    name: b.toolName ?? "",
    input,
  });
}

async function runQuery(p: WorkerPromptCommand): Promise<void> {
  if (!workerOpts) return;
  const opts = workerOpts;

  abortController = new AbortController();
  // FRI-151: carry the prompt's turnId so the daemon can refresh `w.turnId`
  // on the idle→working edge. Critical for the worker-internal mail-fetch
  // path (FRI-127) where the worker mints its own `t_${randomUUID()}` at
  // `worker.ts` mainLoop time — without this, the daemon's view of the turn
  // id stays pinned to the previous turn for the entire mail-driven turn.
  emit({ type: "status-change", status: "working", turnId: p.turnId });

  // Periodic heartbeat so the parent's stall watchdog can distinguish a
  // mid-tool wait from a frozen worker. Every event already updates the
  // parent's lastHeartbeat — this just covers gaps when the SDK is between
  // tool turns and not streaming text.
  const hbInterval = setInterval(() => {
    emit({ type: "heartbeat" });
  }, 10_000);
  hbInterval.unref();

  let sessionId = resolveSessionId(p, lastSessionId);
  let sessionAnnounced = false;
  let currentMessageId = "";
  let finalUsage: FinalUsage | undefined;
  // FRI nightly-compaction runaway: per-API-request usage, one per `assistant`
  // message, in arrival order. The cumulative `finalUsage` (result.usage)
  // re-counts cache_read on every round-trip and so inflates the live-context
  // estimate; the LAST request row's prompt size is the true window. Reset per
  // turn (this whole function body is one turn). Emitted on turn-complete.
  const requestUsages: RequestUsage[] = [];
  // Keyed by SDK content-block index *within the current assistant message*.
  // We mint a fresh `clientBlockId` per block-start so the daemon can
  // correlate without relying on the SDK index (which resets each message).
  const blocks = new Map<number, BlockState>();

  // Flush any in-flight blocks with a terminal status. Called from two places
  // that need to honestly close out partial streams instead of leaving them
  // stuck at `status='streaming'` in DB + spinning forever in the dashboard:
  //   - `api_retry` system message (the SDK is about to retry; the prior
  //     attempt's blocks won't get their own block-stop because the SDK
  //     starts a fresh message_start with new ids)
  //   - the iterator's catch handler (hard error; we owe a terminal status
  //     to every block we already announced)
  const flushInflightBlocks = (status: "aborted" | "error"): void => {
    for (const block of blocks.values()) {
      emit({
        type: "block-stop",
        clientBlockId: block.clientBlockId,
        contentJson: finalizeBlockContent(block),
        status,
      });
    }
    blocks.clear();
  };

  // Mid-message break (prompts-pending / critical-mail). Each block decides
  // its own terminal status based on whether content actually accumulated.
  // See the FRI-22 comment at the `m.type === "assistant"` boundary for why.
  const blockHasContent = (b: BlockState): boolean => {
    if (b.kind === "text" || b.kind === "thinking") return b.text.length > 0;
    if (b.kind === "tool_use") return (b.inputJson?.length ?? 0) > 0;
    return false;
  };
  // FRI-78 follow-up: a block that started but accumulated zero content
  // (e.g. SDK opened a `thinking` block, emitted no deltas, and the worker
  // exited the for-await before content landed) shouldn't leak into the DB
  // or paint a misleading "Thinking STOPPED" footer in the dashboard. Emit
  // a `block-cancel` instead of `block-stop`; the daemon DELETEs the row
  // and publishes `block_canceled` SSE so live clients drop the bubble.
  const flushBoundaryBlocks = (): void => {
    for (const block of blocks.values()) {
      if (!blockHasContent(block)) {
        emit({ type: "block-cancel", clientBlockId: block.clientBlockId });
        continue;
      }
      emit({
        type: "block-stop",
        clientBlockId: block.clientBlockId,
        contentJson: finalizeBlockContent(block),
        status: "complete",
      });
    }
    blocks.clear();
  };

  const DEFAULT_THINKING_BUDGET = 8192;
  const thinking =
    opts.thinking?.type === "enabled"
      ? {
          type: "enabled" as const,
          budgetTokens: opts.thinking.budgetTokens ?? DEFAULT_THINKING_BUDGET,
        }
      : opts.thinking;

  const mcpServers = buildMcpServers({
    callerType: opts.agentType,
    callerName: opts.agentName,
    daemonPort: opts.daemonPort,
    parentName: opts.parentName,
    userMcpServers: opts.userMcpServers,
    appContext: opts.appContext,
  });

  const allowedTools = p.allowedToolsOverride ?? opts.allowedToolsOverride;

  const preToolUseHooks = buildPreToolUseHooks(opts);

  // FRI-27 + FRI-156 §C: compaction-time hooks, on the SDK's own hook channel
  // (separate from Friday's @friday/shared registry). Two hooks:
  //
  //   PreCompact  — fire the isolated memory flush (runMemoryFlush). The flush
  //     resume+forkSessions the about-to-be-compacted session so the model
  //     sees the full conversation, saves 0..n memories, and NEVER pollutes
  //     the user transcript or recurses (the flush query registers no hooks).
  //     30s matcher timeout (SECONDS) bounds it; a stall is aborted by the SDK
  //     and compaction proceeds. GATED off `builder` — builders get read-only
  //     memory, so memory_save would error (mirrors the workspace-guard gate
  //     on the PreToolUse hook above). Prefer the hook input's `session_id`
  //     (the authoritative about-to-compact session) over the captured one.
  //
  //   PostCompact — logging only (OVERRIDES.md #2 / FRI-27 AC30): record
  //     `worker.compact.post` with the trigger + compact_summary LENGTH. The
  //     summary CONTENT is never persisted. Runs for ALL agent types (builders
  //     compact too — the autoCompactWindow ceiling applies — and logging-only
  //     PostCompact carries none of the read-only-memory risk that gates
  //     PreCompact off builders). Only PreCompact is builder-gated.
  //
  // The closures capture `opts`, `mcpServers`, `emit`, `sessionId` — all in
  // runQuery scope. Top-level hook keys (PreToolUse vs PreCompact vs
  // PostCompact) don't collide, so we merge by spread below.
  const preCompactHooks =
    opts.agentType === "builder"
      ? {}
      : {
          PreCompact: [
            {
              hooks: [
                async (
                  input: unknown,
                  _toolUseId: string | undefined,
                  { signal }: { signal: AbortSignal },
                ) => {
                  const i = input as { session_id?: string } | undefined;
                  const flushSession = i?.session_id ?? sessionId ?? "";
                  // No resolvable session → the flush can't fork-resume the
                  // conversation (resume:'' would start a fresh, empty
                  // session). Skip rather than silently degrade. Compaction
                  // proceeds regardless (we always return {}).
                  if (!flushSession) {
                    emit({
                      type: "memory-flush",
                      phase: "error",
                      sessionId: "",
                      message: "flush skipped: no resolvable session id",
                    });
                    return {};
                  }
                  // FRI-27 §4: no two flushes per session in parallel.
                  if (inFlightFlushes.has(flushSession)) return {};
                  inFlightFlushes.add(flushSession);
                  // runMemoryFlush owns the full start/complete lifecycle (the
                  // 'start' emit lives there, not here — emitting in both would
                  // double the worker.compact.flush.started log line).
                  try {
                    await runMemoryFlush(
                      opts,
                      flushSession,
                      mcpServers,
                      opts.daemonPort,
                      emit,
                      signal,
                    );
                  } catch (e) {
                    emit({
                      type: "memory-flush",
                      phase: "error",
                      sessionId: flushSession,
                      message: e instanceof Error ? e.message : String(e),
                    });
                  } finally {
                    inFlightFlushes.delete(flushSession);
                  }
                  return {};
                },
              ],
              // SECONDS, not ms — HookCallbackMatcher.timeout is seconds.
              timeout: 30,
            },
          ],
        };

  // PostCompact runs for ALL agent types (builders included). Logging-only,
  // so there is no read-only-memory hazard; gating it off builders dropped the
  // worker.compact.post forensic log for every builder compaction, violating
  // OVERRIDES.md #2 / FRI-27 AC30.
  const postCompactHooks = {
    PostCompact: [
      {
        hooks: [
          async (input: unknown) => {
            const i = input as {
              session_id?: string;
              trigger?: "manual" | "auto";
              compact_summary?: string;
            };
            logger.log("info", "worker.compact.post", {
              agent: opts.agentName,
              session_id: i.session_id ?? sessionId ?? "",
              trigger: i.trigger,
              summary_length: typeof i.compact_summary === "string" ? i.compact_summary.length : 0,
            });
            return {};
          },
        ],
      },
    ],
  };

  // Single hooks surface for the turn's query: the PreToolUse defense-in-depth
  // hook + PreCompact (non-builder only) + PostCompact (all types). Disjoint
  // top-level keys, merged by spread.
  const mergedHooks = { ...preToolUseHooks, ...preCompactHooks, ...postCompactHooks };

  // When the dispatch carries attachments, the SDK's plain `prompt: string`
  // form can't represent them — image/document content blocks have to ride
  // on a `MessageParam` whose `content` is an array. Switch to the
  // async-iterable form for that case and build the user message inline
  // from bytes on disk. The fallback (no attachments) stays on the simpler
  // string form so the mail / scheduled / queue-injected paths are
  // unchanged.
  const guardedPrompt = applyTurnDatetime(p.prompt);
  const promptInput =
    p.attachments && p.attachments.length > 0
      ? await buildAttachmentPromptStream(guardedPrompt, p.attachments)
      : guardedPrompt;

  // FRI-78: when a pending-injection break would land on an assistant
  // message that carried tool_use blocks, defer it to the next
  // user(tool_results) message so the SDK's session transcript stays
  // consistent for the subsequent resume. See the assistant-boundary
  // comment block below for the failure mode this avoids.
  let breakAtNextUser = false;
  // FRI-60: set when the SDK emits a compact_boundary system frame this turn.
  // Reset to false at the top of each runQuery call (function scope).
  let compactionSeenThisTurn = false;

  const configuredWindow = autoCompactWindowFor(loadConfig(), opts.agentType);
  try {
    const q = query({
      prompt: promptInput,
      options: buildQueryOptions(
        opts,
        p,
        sessionId,
        allowedTools,
        mergedHooks,
        thinking,
        mcpServers,
        abortController,
        getResolvedShellEnv().env,
      ),
    });
    // FRI-156 §A: fire-and-forget runtime probe that the SDK actually honors
    // the per-agent autoCompactWindow (or logs the documented fallback). Not
    // awaited in the hot path — a probe failure can never stall or fail the
    // turn (probeAutoCompactWindow swallows everything internally). Fires once
    // per worker process: the window is constant for the session, so the
    // verdict is invariant turn-to-turn (see probeFired).
    if (!probeFired) {
      probeFired = true;
      void probeAutoCompactWindow(q, configuredWindow, opts.agentName);
    }
    for await (const msg of q) {
      const m = msg as Record<string, unknown>;

      const maybeSession = m.session_id as string | undefined;
      if (maybeSession) {
        sessionId = maybeSession;
        if (!sessionAnnounced) {
          emit({ type: "session-update", sessionId: maybeSession });
          sessionAnnounced = true;
        }
      }

      // Drop SDK Task sub-agent traffic. Their stream/assistant/user messages
      // carry `parent_tool_use_id` set to the spawning Task's tool_use id;
      // emitting them would tag sub-agent tool blocks with the orchestrator's
      // agent + turn_id and bleed them into the parent's chat.
      if (typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id) {
        continue;
      }

      // The SDK emits `{ type: 'system', subtype: 'api_retry' }` immediately
      // before retrying a failed request (default 2 retries on 408/409/429/
      // 5xx — including Cloudflare 522s from the upstream API). The retry
      // starts a fresh `message_start` with new ids, so the prior attempt's
      // blocks never receive their own `block-stop`. Close them out as
      // aborted here; otherwise the dashboard renders both the failed
      // attempt's stuck-running bubbles and the retry's fresh ones (the
      // duplicate-messages report on FRI-4). The retry trail stays visible
      // — preserve over delete — but each attempt's status is honest.
      if (m.type === "system" && m.subtype === "api_retry") {
        flushInflightBlocks("aborted");
        continue;
      }

      // FRI-60: compact_boundary signals the SDK trimmed the context window
      // mid-turn. Flag it for the turn-complete IPC so lifecycle.ts can tag
      // the zero_block_reason and the dashboard can show "Context compacted".
      if (m.type === "system" && m.subtype === "compact_boundary") {
        compactionSeenThisTurn = true;
        const meta = m.compact_metadata as
          | {
              pre_tokens?: number;
              post_tokens?: number;
              duration_ms?: number;
              trigger?: "manual" | "auto";
            }
          | undefined;
        emit({
          type: "compaction-boundary",
          sessionId: sessionId ?? "",
          preTokens: meta?.pre_tokens ?? 0,
          postTokens: meta?.post_tokens,
          durationMs: meta?.duration_ms,
          // FRI-156 §C: forward 'manual'|'auto' so a consumer can distinguish a
          // user/sweep /compact from the autoCompactWindow ceiling.
          ...(meta?.trigger ? { trigger: meta.trigger } : {}),
        });
        continue;
      }

      // FRI-156 §C: the SDK `system/status` frame carries the live
      // compaction-in-progress signal ('compacting' → start; compact_result →
      // done). classifyStatusFrame filters out unrelated status frames
      // (status:'requesting'). Surfacing it lets the dashboard show a
      // "Compacting context…" spinner while the durable marker block (written
      // from the compaction-boundary frame above) is the settled artifact.
      if (m.type === "system" && m.subtype === "status") {
        const ev = classifyStatusFrame(m, sessionId);
        if (ev) emit(ev);
        continue;
      }

      const captured = extractUsageFromResult(m);
      if (captured) {
        finalUsage = captured;
        // FRI-127 §7: the SDK delivered `result` while we were still
        // deferring a pending-injection break for an outstanding
        // `tool_use` (breakAtNextUser was set at the assistant boundary
        // but the matching synthetic `user(tool_result)` never arrived
        // before `result`). A tool that interrupts/errors/completes after
        // the assistant boundary can produce this ordering, leaving the
        // SDK session JSONL with a dangling `tool_use`. The next resume
        // would reject with "Stream closed". Heal mid-session by appending
        // a synthetic tool_result for each unresolved tool_use BEFORE
        // flushBoundaryBlocks() clears the map. The heal is idempotent
        // (hasMatchingToolResult skips the write if a result already
        // exists) and best-effort — boot-time recoverDanglingToolUses is
        // still the backstop on any path that throws here.
        if (breakAtNextUser && blocks.size > 0 && sessionId) {
          for (const block of blocks.values()) {
            if (block.kind === "tool_use" && block.toolId) {
              try {
                healDanglingToolUseInJsonl({
                  cwd: opts.workingDirectory,
                  sessionId,
                  toolUseId: block.toolId,
                  healMarker: "[Tool call interrupted by mid-turn break; session continues.]",
                });
              } catch {
                // Best-effort; boot-time recovery still heals on restart.
              }
            }
          }
          breakAtNextUser = false;
        }
        // The SDK protocol says `result` is the FINAL message of a
        // turn. Continuing the for-await past it and waiting for the
        // iterator to close on its own is a latent stall: if the CLI
        // subprocess hangs or the underlying transport drops without
        // emitting iterator-end, the worker sits in this loop forever
        // — exactly what produced the 4h stale-turn ceiling kill on
        // 2026-05-19 (turn t_92e2862e). Break immediately so
        // turn-complete fires on the strong signal we already have,
        // not on iterator closure that may never come. Any in-flight
        // blocks that didn't receive their own content_block_stop
        // before the result fired get the boundary-flush treatment
        // (complete with content / cancel without) — mirroring the
        // prompts-pending and critical-mail break paths.
        flushBoundaryBlocks();
        break;
      }

      if (m.type === "stream_event") {
        const e = (m.event ?? {}) as {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
          };
          message?: { id?: string };
        };

        if (e.type === "message_start" && e.message?.id) {
          currentMessageId = e.message.id;
        }

        if (e.type === "content_block_start" && typeof e.index === "number") {
          const cb = e.content_block ?? {};
          if (cb.type === "tool_use") {
            const toolId = cb.id ?? `tool_${e.index}`;
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "tool_use",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              toolId,
              toolName: cb.name ?? "",
              text: "",
              inputJson: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "tool_use",
              blockIndex: e.index,
              messageId: state.messageId,
              tool: { id: toolId, name: state.toolName ?? "" },
            });
          } else if (cb.type === "thinking") {
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "thinking",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              text: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "thinking",
              blockIndex: e.index,
              messageId: state.messageId,
            });
          } else if (cb.type === "redacted_thinking") {
            // Emit start + stop immediately — no delta events follow.
            // Do NOT add to `blocks`; when content_block_stop arrives
            // blocks.get(e.index) returns undefined and the guard skips it.
            const clientBlockId = nextClientBlockId();
            const data =
              typeof (cb as Record<string, unknown>).data === "string"
                ? ((cb as Record<string, unknown>).data as string)
                : "";
            emit({
              type: "block-start",
              clientBlockId,
              kind: "thinking",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
            });
            emit({
              type: "block-stop",
              clientBlockId,
              contentJson: JSON.stringify({ isRedacted: true, data }),
              status: "complete",
            });
          } else {
            const state: BlockState = {
              clientBlockId: nextClientBlockId(),
              kind: "text",
              blockIndex: e.index,
              messageId: currentMessageId || undefined,
              text: "",
            };
            blocks.set(e.index, state);
            emit({
              type: "block-start",
              clientBlockId: state.clientBlockId,
              kind: "text",
              blockIndex: e.index,
              messageId: state.messageId,
            });
          }
          continue;
        }

        if (e.type === "content_block_delta" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          if (!block) continue;
          const d = e.delta ?? {};
          if (d.type === "text_delta" && typeof d.text === "string" && block.kind === "text") {
            block.text += d.text;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { text: d.text },
            });
          } else if (
            d.type === "thinking_delta" &&
            typeof d.thinking === "string" &&
            block.kind === "thinking"
          ) {
            block.text += d.thinking;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { text: d.thinking },
            });
          } else if (
            d.type === "input_json_delta" &&
            typeof d.partial_json === "string" &&
            block.kind === "tool_use"
          ) {
            block.inputJson = (block.inputJson ?? "") + d.partial_json;
            emit({
              type: "block-delta",
              clientBlockId: block.clientBlockId,
              delta: { partial_json: d.partial_json },
            });
          }
          continue;
        }

        if (e.type === "content_block_stop" && typeof e.index === "number") {
          const block = blocks.get(e.index);
          if (!block) continue;
          emit({
            type: "block-stop",
            clientBlockId: block.clientBlockId,
            contentJson: finalizeBlockContent(block),
            status: "complete",
          });
          // Remove from the in-flight map so `flushInflightBlocks` (the
          // error-catch and prompts-pending paths) doesn't double-emit
          // `block-stop` for blocks that closed cleanly.
          blocks.delete(e.index);
          continue;
        }

        continue;
      }

      if (m.type === "assistant") {
        // Capture this API request's usage BEFORE any break path below. Each
        // `assistant` message carries the SDK's per-request `usage` (an
        // Anthropic BetaUsage). The LAST request's prompt size is the true
        // live context window — see the per-turn `requestUsages` note above and
        // getLatestContextForAgent. Captured here (not gated behind the break
        // branches) so a turn that breaks for a queued prompt still records its
        // final request.
        const reqUsage = extractRequestUsage(m);
        if (reqUsage) requestUsages.push(reqUsage);

        // FIX_FORWARD 2.4: SDK iteration boundary. Each assistant message
        // marks the end of one model step (tool calls land in the
        // subsequent `user` message). Check whether we have queued user
        // prompts or critical mail to inject — if so, break the iterator
        // gracefully. The parent's turn-complete handler will drain the
        // next prompt; `mainLoop` drains the inbox for critical mail.
        if (promptsPending || pendingCriticalMail) {
          // FRI-78: break timing matters for SDK-session integrity.
          // Breaking immediately after an assistant message with tool_use
          // blocks leaves the SDK's session JSONL with a dangling
          // assistant→tool_use that never gets its matching user→
          // tool_result. The next `runQuery` resumes that broken
          // transcript and the CLI subprocess returns "Stream closed" /
          // "Tool permission stream closed before response received" on
          // the first tool dispatch (model retries with the same payload
          // and the second call succeeds — the dashboard pattern Seth saw
          // with fri-75-design-review). Defer the break to the next
          // user(tool_results) boundary so the SDK can complete its tool
          // dispatch first. If the assistant emitted no tool_use blocks
          // (pure text), there's no follow-up user message and breaking
          // immediately is safe.
          if (assistantMessageHasToolUses(m.message)) {
            breakAtNextUser = true;
            continue;
          }
          // FRI-4 #2 + FRI-22: at the assistant-message yield the model's
          // reply is conceptually finished. The SDK *usually* emits
          // `content_block_stop` for every block before yielding the
          // assembled message, but in practice we've seen two cases land
          // here with the `blocks` map non-empty:
          //   - the SDK abandoned a partial block (no deltas, no stop) —
          //     content_json comes out empty; this is the original FRI-4 #2.
          //   - the SDK yielded the assistant message before emitting
          //     `content_block_stop` for the last block — content is fully
          //     populated; the stop was just dropped on the floor.
          // Marking everything `aborted` collapses both cases and leaves
          // visually-complete blocks rendering with the "Stopped" footer.
          // Discriminate on whether content actually accumulated: present
          // content ⇒ `complete` (the model's intent is whole); empty ⇒
          // `aborted` (the SDK truly cut it short).
          //
          // But first: with extended thinking, the SDK surfaces this
          // assistant boundary for the THINKING block before the reply text
          // streams (`m.message.content === ['thinking']`). Breaking here
          // would cancel the empty thinking block and end the turn with zero
          // captured blocks, orphaning the reply that streams afterward (see
          // assistantMessageHasText). Keep consuming until the reply's text
          // boundary so it is captured under THIS turn; only then honor the
          // pending-injection break. tool_use turns already deferred above.
          if (!assistantMessageHasText(m.message)) {
            continue;
          }
          flushBoundaryBlocks();
          promptsPending = false;
          pendingCriticalMail = false;
          break;
        }
        continue;
      }

      if (m.type === "user") {
        const userMsg = m.message as { id?: string; content?: unknown[] } | undefined;
        const content = userMsg?.content;
        if (Array.isArray(content)) {
          content.forEach((rawBlock, idx) => {
            const block = rawBlock as {
              type?: string;
              tool_use_id?: string;
              content?: unknown;
              is_error?: boolean;
            };
            if (block.type === "tool_result" && block.tool_use_id) {
              const clientBlockId = nextClientBlockId();
              const status: "complete" | "error" = block.is_error ? "error" : "complete";
              const text = stringifyToolResult(block.content);
              emit({
                type: "block-start",
                clientBlockId,
                kind: "tool_result",
                blockIndex: idx,
                messageId: userMsg?.id,
                tool: { id: block.tool_use_id, name: "" },
              });
              emit({
                type: "block-stop",
                clientBlockId,
                contentJson: JSON.stringify({
                  tool_use_id: block.tool_use_id,
                  text,
                  is_error: block.is_error === true,
                }),
                status,
              });
            }
          });
        }
        // FRI-78: if the prior assistant message had tool_uses and we
        // deferred a pending-injection break, fire it now. The SDK has
        // delivered the tool_results, so the session transcript is
        // complete and the next resume won't trip the "Stream closed"
        // race.
        if (breakAtNextUser) {
          flushBoundaryBlocks();
          promptsPending = false;
          pendingCriticalMail = false;
          breakAtNextUser = false;
          break;
        }
        continue;
      }

      // Compaction is now USER-FACING (FRI-60 + FRI-156). Friday's SSE wire
      // no longer carries the legacy token-level `compaction_*` stream events,
      // but the SDK still emits the `compact_boundary` system frame (→ durable
      // kind:'compaction' marker block) and `system/status` frames (→ the live
      // `compacting` SSE signal). Both are intercepted above; nothing falls
      // through to here.
    }

    lastSessionId = sessionId ?? lastSessionId;
    emit({
      type: "turn-complete",
      sessionId: sessionId ?? "",
      compactionThisTurn: compactionSeenThisTurn || undefined,
      usage: finalUsage,
      requestUsages: requestUsages.length > 0 ? requestUsages : undefined,
    });
    emit({ type: "status-change", status: "idle" });
  } catch (err: unknown) {
    const aborted = abortController.signal.aborted;
    // Close out any in-flight blocks so the daemon can flip their DB rows
    // off `status='streaming'` (the dashboard's `tool` / `thinking` bubbles
    // otherwise stay 'running' forever — `finishTurn` only walks assistant
    // text bubbles).
    flushInflightBlocks(aborted ? "aborted" : "error");
    if (aborted) {
      emit({ type: "error", message: "aborted", recoverable: true });
    } else {
      const classified = classifySdkError(err);
      emit({
        type: "error",
        message: classified.headline,
        recoverable: false,
        code: classified.code,
        headline: classified.headline,
        httpStatus: classified.httpStatus,
        retryAfterSeconds: classified.retryAfterSeconds,
        requestId: classified.requestId,
        rawMessage: classified.rawMessage,
      });
    }
    emit({ type: "status-change", status: "idle" });
  } finally {
    clearInterval(hbInterval);
    abortController = null;
  }
}
