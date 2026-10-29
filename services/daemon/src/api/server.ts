import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { handleRequest, matchRoute, type RouteRow, type RouterDeps } from "./router.js";
import { logger } from "../log.js";
import { eventBus, getBootId, getBootTs } from "../events/bus.js";
import {
  cancel as cancelElicitation,
  register as registerElicitation,
  resolve as resolveElicitation,
  type ElicitationAnswer,
} from "../elicitation/registry.js";
import {
  type AgentEntry,
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  isLocalHost,
  loadConfig,
  isSecretsLocked,
  loadFridayConfig,
  resolveDaemonPort,
  resolveModelForRole,
} from "@friday/shared";
import {
  addComment,
  closeMail,
  consumeRateLimit,
  createTicket,
  externalLinks,
  fetchBlocksByAgent,
  getAttachment,
  getMail,
  getTicket,
  inbox,
  linkExternal,
  unlinkExternal,
  listAgentSessions,
  listComments,
  listTickets,
  markRead,
  readAttachmentBytes,
  searchMail,
  sendMail,
  sessionCountsByAgent,
  updateTicket,
  uploadAttachment,
} from "@friday/shared/services";
import {
  forgetEntry,
  getEntry,
  listEntries,
  saveEntry,
  searchMemories,
  touchRecall,
  updateEntry,
  type MemoryEntry,
} from "@friday/memory";
import { runHooks } from "@friday/shared";
import { buildDispatchPrompt } from "../prompts/build-dispatch-prompt.js";
import { buildSystemPrompt } from "../prompts/build-system-prompt.js";
import { resolveRecipient, validateRecipient } from "../comms/recipient.js";
import {
  deleteProposal,
  enrichProposals,
  getProposal,
  listProposals,
  mergeClusters,
  saveProposal,
  sinceHoursAgo,
  appendRun,
  updateProposal,
  runEvolveCycle,
  type Proposal,
  type SaveProposalInput,
  type UpdateProposalInput,
  type EvolveCycleEffects,
} from "@friday/evolve";
import { deleteProposalFromPg, syncProposalToPg } from "../evolve/projector.js";
import { syncProposalsForClosedTickets } from "../services/proposal-sync.js";
import {
  createIssueWithConfiguredTeam as linearCreateIssue,
  getStateIdByType as linearGetStateIdByType,
  importIssue as linearImportIssue,
  LinearApiError,
  reconcile as linearReconcile,
  resolveIssueIdByIdentifier as linearResolveIssueIdByIdentifier,
  updateIssue as linearUpdateIssue,
  type LinearPriority,
  type LinearStateType,
  type UpdateIssueInput,
} from "@friday/integrations-linear";
import {
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  ScheduleNameCollisionError,
  snoozeSchedule,
  triggerSchedule,
  upsertSchedule,
} from "../scheduler/scheduler.js";
import { readScheduleArtifacts } from "../scheduler/state.js";
import {
  archiveHabit,
  createHabit,
  deleteCheckin,
  getHabit,
  insertCheckin,
  listCheckins,
  listHabits,
  updateHabit,
  type CreateHabitInput,
  type HabitFilter,
  type UpdateHabitInput,
} from "../habits/store.js";
import { withStreak } from "../habits/streak.js";
import * as registry from "../agent/registry.js";
import {
  computeSpawnDepth,
  validateSpawnPermissions,
  type CallerType,
} from "../agent/spawn-permissions.js";
import {
  abortTurn,
  archiveAgent,
  dispatchTurn,
  findAgentByTurnId,
  forceWorkerRefork,
  peekLiveWorker,
  removeQueuedPrompt,
  stopWorkersForApp,
} from "../agent/lifecycle.js";
import { recordUserBlock } from "../agent/block-injectors.js";
import { getBlockById } from "@friday/shared/services";
import { generateScratchName } from "../agent/scratch-names.js";
import { archiveWorkspace, createWorkspace, workspacePath } from "../agent/workspace.js";
import { commandsApi } from "./commands.js";
import {
  AppInstallError,
  installApp,
  inspectApp,
  listApps,
  reloadApp,
  uninstallApp,
} from "../apps/installer.js";
import { randomUUID } from "node:crypto";
import { isValidAgentName } from "@friday/shared";
import type { AgentType, IntakeSource } from "@friday/shared";
import {
  runIntake,
  approveInbox,
  undoInbox,
  triageInbox,
  listOpenInbox,
  actInbox,
  type InboxAction,
} from "../intake/intake.js";
import { ensureVapidKeys } from "../notifications/vapid.js";
import {
  upsertSubscription,
  dropSubscriptionsForDevice,
} from "../notifications/push-subscriptions.js";
import { reportPresence } from "../notifications/presence.js";
import { notify } from "../notifications/notify.js";
import type { PushSubscribePayload, PresenceReport, NotifyEventType } from "@friday/shared";
import { NOTIFY_EVENT_TYPES } from "@friday/shared";

export const { version: DAEMON_VERSION } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

export interface StartServerOptions {
  port: number;
}

export function startServer(opts: StartServerOptions) {
  const cfg = loadConfig();
  const server = createServer((req, res) => handle(req, res, cfg));
  server.listen(opts.port, "127.0.0.1");
  logger.log("info", "api.listening", { port: opts.port });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  res.setHeader("X-Friday-Version", DAEMON_VERSION);

  // FRI-router: dispatch through the route table + deep request adapter. The
  // adapter (router.ts) owns the cross-cutting mechanics — auth gate, body
  // parse, schema validation, the error envelope — so each route is one
  // declarative row. A no-match falls through to the terminal 404 below.
  const matched = matchRoute(ROUTES, method, path);
  if (matched) {
    return handleRequest(matched, { req, res, url, path, method, cfg }, routerDeps);
  }

  return json(res, 404, { error: "not found", path });
}

/**
 * Memory upsert payload (POST /api/memory). The one route where the cascade's
 * inline `if (!body.title || !body.content)` check is replaced by a declarative
 * schema run by the adapter — demonstrating the schema path end-to-end. Every
 * field the handler reads is covered, so the validated value the handler
 * receives carries no surprises (zod strips unknown keys).
 */
const MemoryUpsertSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

/** IO the adapter depends on: the real same-host gate + the real body reader. */
const routerDeps: RouterDeps = {
  authorize: authorizeSameHost,
  readBody: (req) => readJson<unknown>(req),
};

/**
 * The daemon HTTP route table. ONE declarative row per endpoint, in DECLARATION
 * ORDER (the only disambiguator for specific-before-broad regex routes — e.g.
 * `/api/memory/search` MUST precede `^/api/memory/[^/]+$`, and the habits
 * `/checkin`,`/<id>/checkin`,`/<id>/archive` paths MUST precede the bare
 * `/<id>`). The adapter (router.ts) runs auth → parse → validate → handler →
 * error-envelope; handlers return `{ status, body }` and the adapter serializes.
 *
 * `auth` is per-route and load-bearing: most routes rely on the daemon binding
 * 127.0.0.1 + the dashboard proxy injecting the daemon secret (auth:false);
 * health/secrets/intake/push/presence/notify/uploads/apps gate inline
 * (auth:true). Streaming/binary/seam routes (`/api/events`, `/api/uploads`,
 * `/api/evolve/scan`, `/api/commands/dispatch`) opt out of the JSON envelope via
 * `raw` and own `req`/`res` themselves.
 *
 * Exported for the route-table contract test (`router-table.test.ts`), which
 * pins the migration invariants: unique (method, match) keys, the full no-drop
 * golden set, the specific-before-broad ordering, the auth-gated set, and the
 * raw routes.
 */
export const ROUTES: RouteRow[] = [
  // --- Health ---
  {
    method: "GET",
    match: "/api/health",
    // FIX_FORWARD 5.8: gate /api/health behind the same-host secret so a local
    // web page (or a DNS-rebind attacker) can't probe daemon status.
    auth: true,
    handler: () => ({
      status: 200,
      body: { ok: true, ts: Date.now(), secretsLocked: isSecretsLocked() },
    }),
  },

  // --- Secrets ---
  {
    method: "POST",
    match: "/api/secrets/reload",
    auth: true,
    handler: async () => {
      const { clearFridayConfigCache, clearSecretsCache, unlockVault } =
        await import("@friday/shared");
      clearSecretsCache();
      clearFridayConfigCache();
      const result = await unlockVault(true);
      return {
        status: 200,
        body: { ok: result.ok, reason: result.ok ? undefined : result.reason },
      };
    },
  },
  {
    method: "POST",
    match: "/api/secrets/audit",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        secretName: string;
        callerName: string;
        callerType: string;
        appId?: string | null;
        reason: string;
        source: "mcp" | "cli";
      };
      const { logSecretsFetch } = await import("../services/secrets-audit.js");
      const logged = await logSecretsFetch(body);
      if (!logged.ok) return { status: 429, body: { error: logged.error } };
      return { status: 200, body: { ok: true } };
    },
  },

  // --- Commands (system + skills, for chat autocomplete) ---
  {
    method: "GET",
    match: "/api/commands",
    handler: () => ({ status: 200, body: commandsApi() }),
  },
  // System command dispatch — handleSystemCommand owns the response.
  {
    method: "POST",
    match: "/api/commands/dispatch",
    raw: async (ctx) => {
      const body = await readJson<{ command: string; args?: string }>(ctx.req);
      return handleSystemCommand(ctx.res, body, ctx.cfg);
    },
  },

  // --- SSE events --- (streaming; owns res for the connection lifetime)
  {
    method: "GET",
    match: "/api/events",
    raw: (ctx) => handleEvents(ctx.req, ctx.res, ctx.cfg),
  },

  // --- FRI-152 elicitation bridge ---
  {
    method: "POST",
    match: "/api/elicitation/wait",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        agentName?: string;
        turnId?: string;
        toolUseId?: string;
      };
      if (
        typeof body.agentName !== "string" ||
        typeof body.turnId !== "string" ||
        typeof body.toolUseId !== "string" ||
        body.toolUseId.length === 0
      ) {
        return { status: 400, body: { error: "missing_fields" } };
      }
      const promise = registerElicitation(body.toolUseId);
      // Fire SSE AFTER registering the waiter so the dashboard's submit can't
      // beat us to the resolver.
      eventBus.publish({
        v: 1,
        type: "elicitation_requested",
        agent: body.agentName,
        turn_id: body.turnId,
        tool_use_id: body.toolUseId,
        ts: Date.now(),
      });
      const onAbort = () => {
        cancelElicitation(body.toolUseId!, new Error("client_aborted"));
      };
      ctx.req.on("close", onAbort);
      try {
        const answer = await promise;
        ctx.req.off("close", onAbort);
        return { status: 200, body: answer };
      } catch (err) {
        ctx.req.off("close", onAbort);
        return { status: 499, body: { error: String((err as Error).message) } };
      }
    },
  },
  {
    method: "POST",
    // Prefix+suffix matcher (the one route that is neither exact nor a single
    // regex): `/api/elicitation/<id>/submit`.
    match: (p) => p.startsWith("/api/elicitation/") && p.endsWith("/submit"),
    body: "json",
    handler: (ctx) => {
      const id = ctx.path.slice("/api/elicitation/".length, -"/submit".length);
      if (id.length === 0) return { status: 400, body: { error: "missing_id" } };
      const body = ctx.body as ElicitationAnswer;
      if (!body || typeof body !== "object" || !body.answers) {
        return { status: 400, body: { error: "missing_answers" } };
      }
      const resolved = resolveElicitation(id, body);
      if (!resolved) return { status: 409, body: { error: "no_waiter", id } };
      return { status: 200, body: { ok: true } };
    },
  },

  // --- Internal fast-paths (cancel-queued / abort-turn) ---
  {
    method: "POST",
    match: "/api/internal/cancel-queued",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { block_id?: string };
      const blockId = body.block_id;
      if (typeof blockId !== "string" || blockId.length === 0) {
        return { status: 400, body: { error: "missing_block_id" } };
      }
      const block = await getBlockById(blockId);
      if (!block) {
        return { status: 200, body: { ok: true, already_canceled: true, text: "" } };
      }
      if (block.status !== "queued" && block.status !== "cancel_requested") {
        return {
          status: 409,
          body: {
            error: "not_queued",
            block_id: blockId,
            status: block.status,
            message: "Block has already dispatched; use abort instead",
          },
        };
      }
      const removed = removeQueuedPrompt(block.agentName, block.turnId);
      let recoveredText = "";
      try {
        const parsed = JSON.parse(block.contentJson) as { text?: unknown };
        if (typeof parsed.text === "string") recoveredText = parsed.text;
      } catch {
        // Malformed content_json — return empty text; the user retypes.
      }
      return {
        status: 200,
        body: {
          ok: true,
          already_canceled: removed === null,
          text: recoveredText,
          turn_id: block.turnId,
          agent: block.agentName,
        },
      };
    },
  },
  {
    method: "POST",
    match: "/api/internal/abort-turn",
    body: "json",
    handler: (ctx) => {
      const body = ctx.body as { turn_id?: string };
      const turnId = body.turn_id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        return { status: 400, body: { error: "missing_turn_id" } };
      }
      const agent = findAgentByTurnId(turnId);
      const aborted = agent ? abortTurn(agent) : false;
      return { status: 200, body: { ok: true, aborted, turn_id: turnId, agent } };
    },
  },

  // --- Agents ---
  {
    method: "GET",
    match: "/api/agents",
    handler: async (ctx) => {
      const all: AgentEntry[] = await registry.listAgents();
      // Prefer the in-memory live worker's status over the DB column whenever
      // an agent has a forked worker — the live map is the real-time truth.
      const merged: AgentEntry[] = all.map((a) => {
        const live = peekLiveWorker(a.name);
        return live ? { ...a, status: live.status } : a;
      });
      const typeFilter = ctx.url.searchParams.get("type");
      const statusFilter = ctx.url.searchParams.get("status");
      const filtered = merged.filter(
        (a) =>
          (!typeFilter || a.type === typeFilter) && (!statusFilter || a.status === statusFilter),
      );
      const counts = await sessionCountsByAgent();
      const augmented = filtered.map((a) => ({
        ...a,
        sessionCount: counts[a.name] ?? 0,
      }));
      return { status: 200, body: augmented };
    },
  },
  {
    method: "GET",
    match: /^\/api\/agents\/[^/]+\/sessions$/,
    handler: async (ctx) => {
      const agentName = ctx.path.split("/")[3];
      return { status: 200, body: await listAgentSessions(agentName) };
    },
  },
  {
    method: "POST",
    match: "/api/agents",
    body: "json",
    handler: async (ctx) => {
      const r = await createAgent(ctx.body as CreateAgentInput, ctx.cfg);
      return { status: r.status, body: r.body };
    },
  },
  {
    method: "GET",
    match: /^\/api\/agents\/[^/]+$/,
    handler: async (ctx) => {
      const name = ctx.path.split("/")[3];
      const a = await registry.getAgent(name);
      if (!a) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: a };
    },
  },
  {
    method: "POST",
    match: /^\/api\/agents\/[^/]+\/archive$/,
    // `reason` is required and may arrive in a missing/empty body — tolerate a
    // malformed body as `{}` (mirrors the cascade's `readJson(...).catch`).
    body: "json-optional",
    handler: async (ctx) => {
      const name = ctx.path.split("/")[3];
      const a = await registry.getAgent(name);
      if (!a) return { status: 404, body: { error: "not found" } };
      // Bare agents registered under an installed app are persistent user-facing
      // interfaces (e.g. the kitchen agent). Block the call.
      if (a.type === "bare") {
        const appId = await registry.getAppId(name);
        if (appId) {
          return {
            status: 409,
            body: {
              error: `cannot archive "${name}": it is a persistent bare agent registered under app "${appId}". Uninstall the app to remove it.`,
              code: "app_agent_protected",
            },
          };
        }
      }
      const body = ctx.body as { reason?: string };
      const validReasons = ["completed", "abandoned", "failed"] as const;
      type ApiReason = (typeof validReasons)[number];
      if (!body.reason || !validReasons.includes(body.reason as ApiReason)) {
        return {
          status: 400,
          body: { error: `reason required, one of: ${validReasons.join(", ")}` },
        };
      }
      const reason = body.reason as ApiReason;
      const branch = a.type === "builder" && "branch" in a ? a.branch : undefined;
      // PR-271 BLOCKER 1: resolve teardown against the ORIGINAL source repo
      // persisted on the agent row, NOT process.cwd().
      const builderRepo =
        a.type === "builder"
          ? ((await registry.getWorkspaceRepo(name)) ?? process.cwd())
          : undefined;
      await archiveAgent(name, { reason });
      let workspacePathRemoved: string | undefined;
      if (a.type === "builder") {
        try {
          workspacePathRemoved = workspacePath(name);
          archiveWorkspace(name, builderRepo ?? process.cwd(), { branch, repo: builderRepo });
        } catch (err) {
          logger.log("warn", "agent.archive.workspace.fail", {
            agent: name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { status: 200, body: { ok: true, workspacePath: workspacePathRemoved } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/agents\/[^/]+\/unarchive$/,
    handler: async (ctx) => {
      const name = ctx.path.split("/")[3];
      const a = await registry.getAgent(name);
      if (!a) return { status: 404, body: { error: "not found" } };
      if (a.status !== "archived") {
        return {
          status: 409,
          body: { error: `"${name}" is not archived (status=${a.status})`, code: "not_archived" },
        };
      }
      try {
        await registry.unarchiveAgent(name);
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/agents\/[^/]+\/abort$/,
    handler: (ctx) => {
      const name = ctx.path.split("/")[3];
      const aborted = abortTurn(name);
      return { status: 200, body: { aborted } };
    },
  },

  // --- Blocks (canonical transcript) ---
  {
    method: "GET",
    match: /^\/api\/agents\/[^/]+\/blocks$/,
    handler: async (ctx) => {
      const agentName = ctx.path.split("/")[3];
      const limit = numericParam(ctx.url, "limit");
      const before = ctx.url.searchParams.get("before") ?? undefined;
      const after = ctx.url.searchParams.get("after") ?? undefined;
      const aroundTs = numericParam(ctx.url, "around_ts");
      const beforeLimit = numericParam(ctx.url, "before_limit");
      const afterLimit = numericParam(ctx.url, "after_limit");
      const matchQ = ctx.url.searchParams.get("match") ?? undefined;
      const sessionId = ctx.url.searchParams.get("session_id") ?? undefined;
      try {
        const result = await fetchBlocksByAgent({
          agentName,
          sessionId,
          limit,
          beforeBlockId: before,
          afterBlockId: after,
          aroundTs,
          beforeLimit,
          afterLimit,
          match: matchQ,
        });
        return { status: 200, body: { blocks: result.blocks } };
      } catch (err) {
        // FTS5 MATCH expressions can throw on syntactically invalid queries.
        return {
          status: 400,
          body: {
            error: "invalid_query",
            detail: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  },

  // --- Tickets ---
  {
    method: "GET",
    match: "/api/tickets",
    handler: async (ctx) => {
      const TICKET_STATUSES = ["open", "in_progress", "done", "blocked", "closed"] as const;
      const rawStatus = ctx.url.searchParams.get("status");
      const status = (TICKET_STATUSES as readonly string[]).includes(rawStatus ?? "")
        ? (rawStatus as (typeof TICKET_STATUSES)[number])
        : undefined;
      const assignee = ctx.url.searchParams.get("assignee") ?? undefined;
      return { status: 200, body: await listTickets({ status, assignee }) };
    },
  },
  {
    method: "POST",
    match: "/api/tickets",
    body: "json",
    handler: async (ctx) => ({
      status: 200,
      body: await createTicket(ctx.body as Parameters<typeof createTicket>[0]),
    }),
  },
  {
    method: "GET",
    match: /^\/api\/tickets\/[^/]+$/,
    handler: async (ctx) => {
      const id = ctx.path.split("/")[3];
      const t = await getTicket(id);
      if (!t) return { status: 404, body: { error: "not found" } };
      const ext = await externalLinks(id);
      const comments = await listComments(id);
      return { status: 200, body: { ...t, externalLinks: ext, comments } };
    },
  },
  {
    method: "PATCH",
    match: /^\/api\/tickets\/[^/]+$/,
    body: "json",
    handler: async (ctx) => {
      const id = ctx.path.split("/")[3];
      const body = ctx.body as Parameters<typeof updateTicket>[1];
      return { status: 200, body: await updateTicket(id, body) };
    },
  },
  {
    method: "POST",
    match: /^\/api\/tickets\/[^/]+\/comments$/,
    body: "json",
    handler: async (ctx) => {
      const id = ctx.path.split("/")[3];
      const body = ctx.body as { author: string; body: string };
      await addComment(id, body.author, body.body);
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/tickets\/[^/]+\/links$/,
    body: "json",
    handler: async (ctx) => {
      const id = ctx.path.split("/")[3];
      if (!(await getTicket(id))) return { status: 404, body: { error: "ticket not found" } };
      const body = ctx.body as {
        system: string;
        externalId: string;
        url?: string;
        meta?: Record<string, unknown>;
      };
      if (!body.system || !body.externalId) {
        return { status: 400, body: { error: "system and externalId required" } };
      }
      await linkExternal({
        ticketId: id,
        system: body.system,
        externalId: body.externalId,
        url: body.url,
        meta: body.meta,
      });
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "DELETE",
    match: /^\/api\/tickets\/[^/]+\/links$/,
    handler: async (ctx) => {
      const id = ctx.path.split("/")[3];
      if (!(await getTicket(id))) return { status: 404, body: { error: "ticket not found" } };
      const system = ctx.url.searchParams.get("system");
      const externalId = ctx.url.searchParams.get("externalId");
      if (!system || !externalId) {
        return { status: 400, body: { error: "system and externalId query params required" } };
      }
      const removed = await unlinkExternal({ ticketId: id, system, externalId });
      if (!removed) return { status: 404, body: { error: "link not found" } };
      return { status: 200, body: { ok: true } };
    },
  },

  // --- Schedules ---
  {
    method: "GET",
    match: "/api/schedules",
    handler: async () => ({ status: 200, body: await listSchedules() }),
  },
  {
    method: "POST",
    match: "/api/schedules",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as Parameters<typeof upsertSchedule>[0];
      try {
        await upsertSchedule(body);
      } catch (err) {
        if (err instanceof ScheduleNameCollisionError) {
          return { status: 409, body: { error: err.message } };
        }
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/schedules\/[^/]+\/trigger$/,
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      const runId = await triggerSchedule(name);
      if (!runId) {
        return { status: 409, body: { error: "schedule not found or already running" } };
      }
      return { status: 200, body: { runId } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/schedules\/[^/]+\/(pause|resume)$/,
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      const action = ctx.path.split("/")[4];
      const ok = action === "pause" ? await pauseSchedule(name) : await resumeSchedule(name);
      if (!ok) return { status: 404, body: { error: "schedule not found" } };
      return { status: 200, body: { ok: true } };
    },
  },
  {
    // FRI-168: re-arm a fired/pending reminder to fire again after a delay.
    method: "POST",
    match: /^\/api\/schedules\/[^/]+\/snooze$/,
    body: "json",
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      const { duration } = ctx.body as { duration: string };
      try {
        const ok = await snoozeSchedule(name, duration);
        if (!ok) return { status: 404, body: { error: "schedule not found" } };
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "GET",
    match: /^\/api\/schedules\/[^/]+$/,
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      const r = await getSchedule(name);
      if (!r) return { status: 404, body: { error: "schedule not found" } };
      return { status: 200, body: r };
    },
  },
  {
    method: "GET",
    match: /^\/api\/schedules\/[^/]+\/state$/,
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      if (!(await getSchedule(name))) return { status: 404, body: { error: "schedule not found" } };
      return { status: 200, body: readScheduleArtifacts(name) };
    },
  },
  {
    method: "DELETE",
    match: /^\/api\/schedules\/[^/]+$/,
    handler: async (ctx) => {
      const name = decodeURIComponent(ctx.path.split("/")[3]);
      const ok = await deleteSchedule(name);
      if (!ok) return { status: 404, body: { error: "schedule not found" } };
      return { status: 200, body: { ok: true } };
    },
  },

  // --- Habits (FRI-169) ---
  // Loopback-bound, secret-header contract (no inline guard). Dynamic <id> /
  // <checkinId> segments are matched by regex + path.split. Order matters: the
  // more-specific /checkin/<id>, /<id>/checkin and /<id>/archive paths are
  // matched BEFORE the bare /<id> rows so the catch-all <id> regex doesn't
  // swallow them.
  {
    method: "POST",
    match: "/api/habits",
    body: "json",
    handler: async (ctx) => {
      // Raw body: window_* arrive as ISO strings over the wire (the store takes
      // Date). Everything else maps straight onto CreateHabitInput.
      const body = ctx.body as Omit<CreateHabitInput, "windowStart" | "windowEnd"> & {
        windowStart?: string | null;
        windowEnd?: string | null;
      };
      if (!body?.name || !body?.mode || !body?.period) {
        return { status: 400, body: { error: "name, mode, and period are required" } };
      }
      try {
        const habit = await createHabit({
          name: body.name,
          mode: body.mode,
          period: body.period,
          target: body.target,
          description: body.description,
          daysOfWeek: body.daysOfWeek,
          bucket: body.bucket,
          colorIndex: body.colorIndex,
          windowStart: body.windowStart != null ? new Date(body.windowStart) : null,
          windowEnd: body.windowEnd != null ? new Date(body.windowEnd) : null,
        });
        return { status: 200, body: habit };
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "GET",
    match: "/api/habits",
    handler: async (ctx) => {
      const filterParam = ctx.url.searchParams.get("filter");
      const filter: HabitFilter = filterParam === "archived" ? "archived" : "active";
      const habits = await listHabits(filter);
      const now = new Date();
      const withStreaks = await Promise.all(
        habits.map(async (h) => withStreak(h, await listCheckins(h.id), now)),
      );
      return { status: 200, body: withStreaks };
    },
  },
  {
    // DELETE one Check-in by id. Matched before /api/habits/<id> so "checkin"
    // isn't read as a habit id.
    method: "DELETE",
    match: /^\/api\/habits\/checkin\/[^/]+$/,
    handler: async (ctx) => {
      const checkinId = decodeURIComponent(ctx.path.split("/")[4]);
      const removed = await deleteCheckin(checkinId);
      if (!removed) return { status: 404, body: { error: "check-in not found" } };
      return { status: 200, body: { ok: true } };
    },
  },
  {
    // POST a Check-in for a habit (append-only insert).
    method: "POST",
    match: /^\/api\/habits\/[^/]+\/checkin$/,
    body: "json",
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      if (!(await getHabit(id))) return { status: 404, body: { error: "habit not found" } };
      const body = ctx.body as { ts?: string; note?: string | null };
      const checkin = await insertCheckin(id, {
        ts: body?.ts != null ? new Date(body.ts) : undefined,
        note: body?.note ?? null,
      });
      return { status: 200, body: checkin };
    },
  },
  {
    // POST archive a habit (status='archived'; preserve data, never delete).
    method: "POST",
    match: /^\/api\/habits\/[^/]+\/archive$/,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      const habit = await archiveHabit(id);
      if (!habit) return { status: 404, body: { error: "habit not found" } };
      return { status: 200, body: habit };
    },
  },
  {
    // GET one habit: live streak/progress + recent Check-ins.
    method: "GET",
    match: /^\/api\/habits\/[^/]+$/,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      const habit = await getHabit(id);
      if (!habit) return { status: 404, body: { error: "habit not found" } };
      const checkins = await listCheckins(id);
      const decorated = withStreak(habit, checkins, new Date());
      return { status: 200, body: { ...decorated, checkins } };
    },
  },
  {
    // PATCH a habit definition (bumps updated_at).
    method: "PATCH",
    match: /^\/api\/habits\/[^/]+$/,
    body: "json",
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      // Raw body: window_* arrive as ISO strings and are parsed to Date here.
      const body = ctx.body as Omit<UpdateHabitInput, "windowStart" | "windowEnd"> & {
        windowStart?: string | null;
        windowEnd?: string | null;
      };
      const { windowStart, windowEnd, ...rest } = body;
      const patch: UpdateHabitInput = { ...rest };
      if (windowStart !== undefined) {
        patch.windowStart = windowStart != null ? new Date(windowStart) : null;
      }
      if (windowEnd !== undefined) {
        patch.windowEnd = windowEnd != null ? new Date(windowEnd) : null;
      }
      try {
        const habit = await updateHabit(id, patch);
        if (!habit) return { status: 404, body: { error: "habit not found" } };
        return { status: 200, body: habit };
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },

  // --- Memory ---
  {
    method: "GET",
    match: "/api/memory",
    handler: async () => ({ status: 200, body: await listEntries() }),
  },
  {
    // Exact /search MUST precede the bare /<id> regex below.
    method: "GET",
    match: "/api/memory/search",
    handler: async (ctx) => {
      const q = ctx.url.searchParams.get("q") ?? "";
      const tagsParam = ctx.url.searchParams.get("tags");
      const limitParam = ctx.url.searchParams.get("limit");
      const tags = tagsParam
        ? tagsParam
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
      const limit = limitParam ? Math.max(1, Number(limitParam) || 10) : undefined;
      if (!q.trim()) return { status: 400, body: { error: "q parameter required" } };
      const results = await searchMemories({ query: q, tags, limit, trackRecall: false });
      return { status: 200, body: results };
    },
  },
  {
    method: "POST",
    match: "/api/memory",
    // The one schema-validated route: the cascade's inline title/content check
    // becomes a declarative schema run by the adapter.
    schema: MemoryUpsertSchema,
    handler: async (ctx) => {
      const body = ctx.body as { id?: string; title: string; content: string; tags?: string[] };
      const id = (body.id?.trim() || slugifyMemoryId(body.title)).slice(0, 64);
      if (!id) return { status: 400, body: { error: "could not derive id from title" } };
      const callerName = String(ctx.req.headers["x-friday-caller-name"] ?? "user");
      const now = new Date().toISOString();
      const existing = await getEntry(id);
      const entry: MemoryEntry = {
        id,
        title: body.title,
        content: body.content,
        tags: body.tags ?? existing?.tags ?? [],
        createdBy: existing?.createdBy ?? callerName,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        recallCount: existing?.recallCount ?? 0,
        lastRecalledAt: existing?.lastRecalledAt ?? null,
      };
      await saveEntry(entry);
      return { status: existing ? 200 : 201, body: entry };
    },
  },
  {
    method: "GET",
    match: /^\/api\/memory\/[^/]+$/,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      const e = await getEntry(id);
      if (!e) return { status: 404, body: { error: "not found" } };
      // Require an explicit `?recall=1` to bump recallCount (page views must not
      // pollute the agent-side recall metric).
      if (ctx.url.searchParams.get("recall") === "1") {
        await touchRecall(id);
      }
      return { status: 200, body: e };
    },
  },
  {
    method: "PATCH",
    match: /^\/api\/memory\/[^/]+$/,
    body: "json",
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      if (!(await getEntry(id))) return { status: 404, body: { error: "not found" } };
      const patch = ctx.body as { title?: string; content?: string; tags?: string[] };
      await updateEntry(id, patch);
      return { status: 200, body: await getEntry(id) };
    },
  },
  {
    method: "DELETE",
    match: /^\/api\/memory\/[^/]+$/,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      if (!(await getEntry(id))) return { status: 404, body: { error: "not found" } };
      await forgetEntry(id);
      return { status: 200, body: { ok: true } };
    },
  },

  // --- Evolve ---
  {
    method: "GET",
    match: "/api/evolve/proposals",
    handler: (ctx) => {
      const all = listProposals();
      const statusFilter = ctx.url.searchParams.get("status");
      const typeFilter = ctx.url.searchParams.get("type");
      const filtered = all.filter(
        (p) =>
          (!statusFilter || p.status === statusFilter) && (!typeFilter || p.type === typeFilter),
      );
      return { status: 200, body: filtered };
    },
  },
  {
    method: "POST",
    match: "/api/evolve/proposals",
    body: "json",
    handler: (ctx) => {
      const body = ctx.body as Omit<SaveProposalInput, "createdBy">;
      if (!body.title || !body.proposedChange || !body.type) {
        return { status: 400, body: { error: "title, type, and proposedChange are required" } };
      }
      const callerName = String(ctx.req.headers["x-friday-caller-name"] ?? "user");
      const p = saveProposal({ ...body, createdBy: callerName });
      // Item #54: project the FS write to Postgres so /evolve's Zero reactive
      // query sees the new row. Fire-and-forget — FS stays canonical.
      void syncProposalToPg(p.id);
      return { status: 201, body: p };
    },
  },
  {
    method: "GET",
    match: /^\/api\/evolve\/proposals\/[^/]+$/,
    handler: (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[4]);
      const p = getProposal(id);
      if (!p) return { status: 404, body: { error: "proposal not found" } };
      return { status: 200, body: p };
    },
  },
  {
    method: "PATCH",
    match: /^\/api\/evolve\/proposals\/[^/]+$/,
    body: "json",
    handler: (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[4]);
      if (!getProposal(id)) return { status: 404, body: { error: "proposal not found" } };
      const patch = ctx.body as UpdateProposalInput;
      const next = updateProposal(id, patch);
      void syncProposalToPg(id);
      return { status: 200, body: next };
    },
  },
  {
    method: "DELETE",
    match: /^\/api\/evolve\/proposals\/[^/]+$/,
    handler: (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[4]);
      if (!deleteProposal(id)) return { status: 404, body: { error: "proposal not found" } };
      void deleteProposalFromPg(id);
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/evolve\/proposals\/[^/]+\/apply$/,
    body: "json",
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[4]);
      const p = getProposal(id);
      if (!p) return { status: 404, body: { error: "proposal not found" } };
      if (p.status === "applied") {
        return {
          status: 409,
          body: { error: `proposal already applied (ticket ${p.appliedTicketId ?? "<unknown>"})` },
        };
      }
      const body = ctx.body as {
        ticketKind?: "task" | "epic" | "bug" | "chore";
        assignee?: string;
      };
      const callerName = String(ctx.req.headers["x-friday-caller-name"] ?? "user");
      const ticket = await createTicket({
        title: p.title,
        body: renderProposalForTicket(p),
        kind: body.ticketKind ?? "task",
        assignee: body.assignee,
        meta: { evolveProposalId: p.id },
      });
      const updated = updateProposal(id, {
        status: "applied",
        appliedAt: new Date().toISOString(),
        appliedBy: callerName,
        appliedTicketId: ticket.id,
      });
      void syncProposalToPg(id);
      return { status: 200, body: { proposal: updated, ticket } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/evolve\/proposals\/[^/]+\/dismiss$/,
    body: "json",
    handler: (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[4]);
      const p = getProposal(id);
      if (!p) return { status: 404, body: { error: "proposal not found" } };
      const body = ctx.body as { reason?: string };
      const newBody = body.reason
        ? `${p.proposedChange}\n\n---\n\n## Dismissed\n\n${body.reason}`
        : p.proposedChange;
      const updated = updateProposal(id, { status: "rejected", proposedChange: newBody });
      void syncProposalToPg(id);
      return { status: 200, body: updated };
    },
  },
  {
    // ADR-036 seam: the inline `daemonEffects` (config-gated triage/builder
    // spawn IO) is the daemon-side side-effect boundary and stays VERBATIM. The
    // handler owns its own body read + response (raw) so the seam is untouched.
    method: "POST",
    match: "/api/evolve/scan",
    raw: async (ctx) => {
      const { req, res, cfg } = ctx;
      const body = await readJson<{
        windowHours?: number;
        includeFriction?: boolean;
        includePreferences?: boolean;
        includeDreaming?: boolean;
        sinceTs?: string;
      }>(req);
      const windowHours = body.windowHours ?? 24;
      const includeFriction = body.includeFriction !== false;
      const includePreferences = body.includePreferences !== false;
      const includeDreaming = body.includeDreaming !== false;
      const callerName = String(req.headers["x-friday-caller-name"] ?? "scan");
      const since = sinceHoursAgo(windowHours);
      // FRI-26 AC6: the dreaming cursor. The meta-agent passes `sinceTs`
      // (lastDreamScannedTs from its state.md) so each night re-scans only turns
      // newer than the last dream pass; absent it, the dreaming sub-pass shares
      // the regular `since` window. Propose-merge dedup is the overlap safety net.
      const dreamSince = body.sinceTs ?? since;
      const windowEnd = new Date().toISOString();
      // FRI-174: the ordered signal→propose→rerank→upgrade→audit→notify→spawn→
      // dream cycle now lives in `runEvolveCycle` (shared with the CLI). The
      // daemon supplies the side-effect boundary: the real `notify`, the
      // config-gated triage/builder spawn loops (the `autoSpawn*` gate + the
      // `createAgent`/`updateProposal`/`sendMail` escalation IO stay HERE — seam
      // i / ADR-036), and the real `listEntries`.
      const daemonEffects: EvolveCycleEffects = {
        notify: (event) => {
          // Fire-and-forget; `evolve_critical` is the always-on critical class
          // (toast always / push always, DND-bypass-eligible).
          void notify(event);
        },
        // FRI-40 Phase 1: when enabled, auto-spawn a read-only triage helper for
        // each planned request. Read with a strict `=== true` so the shallow-merge
        // `{ evolve: {} }` case stays off. Spawn failures must never throw out of
        // the cycle (AC #7); the in-process `createAgent` 409 gives idempotent
        // dedup against an already-spawned triage helper (AC #6).
        spawnTriage: async (triage) => {
          if (cfg.evolve?.autoSpawnTriageHelpers === true) {
            try {
              for (const t of triage) {
                try {
                  const r = await createAgent(
                    {
                      type: "helper",
                      name: t.name,
                      parentName: "scheduled-meta-daily",
                      prompt: t.prompt,
                      reason: t.reason,
                    },
                    cfg,
                  );
                  if (r.status === 201)
                    logger.log("info", "evolve.triage.spawn", { name: t.name, reason: t.reason });
                  else if (r.status === 409)
                    logger.log("info", "evolve.triage.spawn.skip", { name: t.name, status: 409 });
                  else
                    logger.log("warn", "evolve.triage.spawn.error", {
                      name: t.name,
                      status: r.status,
                    });
                } catch (err) {
                  logger.log("warn", "evolve.triage.spawn.error", {
                    name: t.name,
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            } catch (err) {
              logger.log("warn", "evolve.triage.spawn.error", {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        },
        // FRI-149 Phase 2: when enabled, auto-spawn an auto-fixing Builder for each
        // planned request. The Builder iterates in its worktree, drives the fix to
        // a GREEN review-ready PR, mails the orchestrator the PR URL, and STOPS (it
        // never merges; the human approval gate moves to merge — ADR-036). Read
        // with a strict `=== true` so the shallow-merge `{ evolve: {} }` case stays
        // off. The carve-out that lets a `scheduled` caller spawn a builder is
        // gated on the un-forgeable `evolveEscalation` arg passed ONLY here (never
        // reachable from the wire — see validateSpawnPermissions / createAgent).
        // Spawn failures are caught per-request AND for the whole block, so they
        // never throw out of the cycle; the in-process `createAgent` 409 gives
        // idempotent dedup against an already-spawned `builder-<id>`.
        spawnBuilder: async (builders) => {
          if (cfg.evolve?.autoSpawnBuilders === true) {
            try {
              for (const b of builders) {
                try {
                  const proposalId = b.name.slice("builder-".length);
                  const r = await createAgent(
                    {
                      type: "builder",
                      name: b.name,
                      parentName: "scheduled-meta-daily",
                      prompt: b.prompt,
                      reason: b.reason,
                      ticketId: proposalId,
                      worktree: { repo: process.cwd() },
                    },
                    cfg,
                    { evolveEscalation: true },
                  );
                  if (r.status === 201) {
                    logger.log("info", "evolve.builder.spawn", {
                      name: b.name,
                      proposalId,
                      reason: b.reason,
                    });
                    // Two-way linkage: record the in-flight builder on the proposal
                    // so the dashboard can connect a critical proposal to its
                    // builder. Branch is derivable as friday/builder-<id>; the PR
                    // URL arrives via the builder's mail.
                    try {
                      updateProposal(proposalId, { builderAgent: b.name });
                    } catch (err) {
                      logger.log("warn", "evolve.builder.linkage.error", {
                        name: b.name,
                        proposalId,
                        message: err instanceof Error ? err.message : String(err),
                      });
                    }
                    // Notify the orchestrator that an escalation builder is in
                    // flight; it surfaces this to the user, and the builder itself
                    // mails the review-ready PR URL once CI is green.
                    try {
                      await sendMail({
                        fromAgent: "scheduled-meta-daily",
                        toAgent: cfg.orchestratorName,
                        type: "notification",
                        subject: `evolve escalation: ${proposalId}`,
                        body:
                          `Auto-escalated critical+code proposal \`${proposalId}\` to Builder \`${b.name}\`. ` +
                          `It will drive a GREEN, review-ready PR (branch friday/${b.name}) and mail you the PR URL — it will NOT merge. ` +
                          `You review and merge.`,
                      });
                    } catch (err) {
                      logger.log("warn", "evolve.builder.notify.error", {
                        name: b.name,
                        proposalId,
                        message: err instanceof Error ? err.message : String(err),
                      });
                    }
                  } else if (r.status === 409) {
                    logger.log("info", "evolve.builder.spawn.skip", { name: b.name, status: 409 });
                  } else {
                    logger.log("warn", "evolve.builder.spawn.error", {
                      name: b.name,
                      status: r.status,
                    });
                  }
                } catch (err) {
                  logger.log("warn", "evolve.builder.spawn.error", {
                    name: b.name,
                    message: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            } catch (err) {
              logger.log("warn", "evolve.builder.spawn.error", {
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        },
        listEntries: () => listEntries(),
        onUpgradeResolved: ({ definitive, tentative }) => {
          logger.log("info", "evolve.upgrade-resolved", { definitive, tentative });
        },
      };
      try {
        const result = await runEvolveCycle({
          since,
          dreamSince,
          includeFriction,
          includePreferences,
          includeDreaming,
          callerName,
          orchestratorName: cfg.orchestratorName,
          effects: daemonEffects,
        });
        return json(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendRun({
          ts: windowEnd,
          by: callerName,
          windowStart: since,
          windowEnd,
          signalsScanned: 0,
          proposalsCreated: 0,
          proposalsUpdated: 0,
          promotedToCritical: 0,
          note: `error: ${message}`,
        });
        return json(res, 500, { error: message });
      }
    },
  },
  {
    method: "POST",
    match: "/api/evolve/enrich",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        id?: string;
        retryFailed?: boolean;
        force?: boolean;
        limit?: number;
      };
      try {
        const result = await enrichProposals(body);
        return {
          status: 200,
          body: {
            enriched: result.enriched.length,
            skipped: result.skipped,
            failed: result.failed,
          },
        };
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/evolve/cluster",
    body: "json",
    handler: (ctx) => {
      const body = ctx.body as { threshold?: number };
      try {
        const result = mergeClusters({ threshold: body.threshold });
        return {
          status: 200,
          body: {
            clustersCreated: result.clustersCreated.length,
            clustersUpdated: result.clustersUpdated.length,
            proposalsAttached: result.proposalsAttached,
          },
        };
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },

  // --- Integrations: Linear ---
  {
    method: "POST",
    match: "/api/integrations/linear/import",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { identifier?: string };
      if (!body.identifier) return { status: 400, body: { error: "identifier required" } };
      try {
        const result = await linearImportIssue({ identifier: body.identifier });
        return { status: 200, body: result };
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/integrations/linear/create-issue",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        title?: string;
        body?: string;
        team?: string;
        priority?: LinearPriority;
      };
      if (!body.title) return { status: 400, body: { error: "title required" } };
      if (!loadFridayConfig().linearApiKey) {
        return { status: 400, body: { error: "LINEAR_API_KEY not set" } };
      }
      const teamOverride = body.team;
      const restore = teamOverride
        ? (() => {
            const prev = process.env.FRIDAY_LINEAR_TEAM;
            process.env.FRIDAY_LINEAR_TEAM = teamOverride;
            return () => {
              if (prev === undefined) delete process.env.FRIDAY_LINEAR_TEAM;
              else process.env.FRIDAY_LINEAR_TEAM = prev;
            };
          })()
        : () => {};
      try {
        const { issue } = await linearCreateIssue({
          title: body.title,
          description: body.body,
          priority: body.priority,
        });
        return {
          status: 200,
          body: { identifier: issue.identifier, url: issue.url, id: issue.id },
        };
      } catch (err) {
        const status = err instanceof LinearApiError ? 502 : 500;
        return { status, body: { error: err instanceof Error ? err.message : String(err) } };
      } finally {
        restore();
      }
    },
  },
  {
    method: "POST",
    match: "/api/integrations/linear/update-issue",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        identifier?: string;
        title?: string;
        body?: string;
        state?: LinearStateType;
        priority?: LinearPriority;
      };
      if (!body.identifier) return { status: 400, body: { error: "identifier required" } };
      const apiKey = loadFridayConfig().linearApiKey;
      if (!apiKey) return { status: 400, body: { error: "LINEAR_API_KEY not set" } };
      if (
        body.title === undefined &&
        body.body === undefined &&
        body.state === undefined &&
        body.priority === undefined
      ) {
        return {
          status: 400,
          body: { error: "at least one of title, body, state, priority must be provided" },
        };
      }
      const teamKeyMatch = body.identifier.match(/^([A-Z][A-Z0-9_]*)-(\d+)$/);
      if (!teamKeyMatch) {
        return { status: 400, body: { error: `invalid Linear identifier: ${body.identifier}` } };
      }
      const teamKey = teamKeyMatch[1];
      try {
        const issueId = await linearResolveIssueIdByIdentifier({
          apiKey,
          identifier: body.identifier,
        });
        if (!issueId) {
          return { status: 404, body: { error: `Linear issue not found: ${body.identifier}` } };
        }
        const input: UpdateIssueInput = {};
        if (body.title !== undefined) input.title = body.title;
        if (body.body !== undefined) input.description = body.body;
        if (body.priority !== undefined) input.priority = body.priority;
        if (body.state !== undefined) {
          const stateId = await linearGetStateIdByType({ apiKey, teamKey, stateType: body.state });
          if (!stateId) {
            return {
              status: 400,
              body: {
                error: `No Linear workflow state of type "${body.state}" on team "${teamKey}"`,
              },
            };
          }
          input.stateId = stateId;
        }
        const updated = await linearUpdateIssue({ apiKey, id: issueId, input });
        return {
          status: 200,
          body: { identifier: updated.identifier, title: updated.title, url: updated.url },
        };
      } catch (err) {
        const status = err instanceof LinearApiError ? 502 : 500;
        return { status, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/integrations/linear/reconcile",
    handler: async () => {
      try {
        const result = await linearReconcile();
        // FRI-66: tickets reconcile just back-propagated to terminal need their
        // originating evolve proposals flipped to `applied`.
        if (result.closedTicketIds.length > 0) {
          await syncProposalsForClosedTickets(result.closedTicketIds);
        }
        return { status: 200, body: result };
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },

  // --- Intake (FRI-171, ADR-047) --- (loopback + daemon-secret gated)
  {
    method: "POST",
    match: "/api/intake",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { text?: unknown; source?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return { status: 400, body: { error: "text is required" } };
      // `source` is an open set (Capture provenance); default to quick_add.
      const source: IntakeSource = body.source === "watch" ? "watch" : "quick_add";
      const result = await runIntake(source, text);
      return {
        status: 200,
        body: {
          cleaned: result.cleaned,
          disposition: result.disposition,
          rationale: result.rationale,
          kind: result.kind,
        },
      };
    },
  },
  {
    method: "POST",
    match: "/api/intake/approve",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return { status: 400, body: { error: "id is required" } };
      try {
        const result = await approveInbox(id);
        return { status: 200, body: result };
      } catch (err) {
        return { status: 409, body: { ok: false, error: (err as Error).message } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/intake/undo",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { id?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      if (!id) return { status: 400, body: { error: "id is required" } };
      try {
        const result = await undoInbox(id);
        return { status: 200, body: result };
      } catch (err) {
        return { status: 409, body: { ok: false, error: (err as Error).message } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/intake/triage",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { id?: unknown; targetId?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      const targetId = typeof body.targetId === "string" ? body.targetId : "";
      if (!id || !targetId) return { status: 400, body: { error: "id and targetId are required" } };
      try {
        const result = await triageInbox(id, targetId);
        return { status: 200, body: result };
      } catch (err) {
        return { status: 409, body: { ok: false, error: (err as Error).message } };
      }
    },
  },
  {
    method: "GET",
    match: "/api/intake/inbox",
    auth: true,
    handler: async () => ({ status: 200, body: { items: await listOpenInbox() } }),
  },
  {
    method: "POST",
    match: "/api/intake/act",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { id?: unknown; action?: unknown; targetId?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      const action = typeof body.action === "string" ? (body.action as InboxAction) : undefined;
      const targetId = typeof body.targetId === "string" ? body.targetId : undefined;
      const allowed: InboxAction[] = ["approve", "reject", "dismiss", "triage", "undo"];
      if (!id || !action || !allowed.includes(action)) {
        return {
          status: 400,
          body: {
            error: "id and a valid action (approve|reject|dismiss|triage|undo) are required",
          },
        };
      }
      try {
        const result = await actInbox(id, action, targetId);
        return { status: 200, body: result };
      } catch (err) {
        return { status: 409, body: { ok: false, error: (err as Error).message } };
      }
    },
  },

  // --- Push (FRI-142, ADR-048) --- (loopback + daemon-secret gated)
  {
    method: "GET",
    match: "/api/push/vapid-public-key",
    auth: true,
    handler: async () => {
      const { publicKey } = await ensureVapidKeys();
      return { status: 200, body: { publicKey } };
    },
  },
  {
    method: "POST",
    match: "/api/push/subscribe",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as {
        endpoint?: unknown;
        keys?: unknown;
        deviceId?: unknown;
        userId?: unknown;
      };
      const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const userId = typeof body.userId === "string" ? body.userId : "";
      const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;
      const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
      const auth = typeof keys?.auth === "string" ? keys.auth : "";
      if (!endpoint || !p256dh || !auth || !deviceId || !userId) {
        return {
          status: 400,
          body: { error: "endpoint, keys.p256dh, keys.auth, deviceId, and userId are required" },
        };
      }
      const payload: PushSubscribePayload = { endpoint, keys: { p256dh, auth }, deviceId };
      try {
        const result = await upsertSubscription(payload, userId);
        return { status: 200, body: { ok: true, endpoint: result.endpoint } };
      } catch (err) {
        return { status: 500, body: { ok: false, error: (err as Error).message } };
      }
    },
  },
  {
    method: "POST",
    match: "/api/push/forget-device",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { deviceId?: unknown; userId?: unknown };
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!deviceId || !userId) {
        return { status: 400, body: { error: "deviceId and userId are required" } };
      }
      try {
        await dropSubscriptionsForDevice(deviceId, userId);
        return { status: 200, body: { ok: true } };
      } catch (err) {
        return { status: 500, body: { ok: false, error: (err as Error).message } };
      }
    },
  },

  // --- Presence (FRI-142, ADR-048) --- (loopback + daemon-secret gated)
  {
    method: "POST",
    match: "/api/presence",
    auth: true,
    body: "json",
    handler: (ctx) => {
      const body = ctx.body as { deviceId?: unknown; visible?: unknown };
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const visible = body.visible === true;
      if (!deviceId) return { status: 400, body: { error: "deviceId is required" } };
      const report: PresenceReport = { deviceId, visible };
      reportPresence(report);
      return { status: 200, body: { ok: true } };
    },
  },
  {
    // Fire a TEST Notification through the full router. Tolerant body.
    method: "POST",
    match: "/api/notify/test",
    auth: true,
    body: "json-optional",
    handler: async (ctx) => {
      const body = ctx.body as { eventType?: unknown };
      const requested = typeof body.eventType === "string" ? body.eventType : "builder_archive";
      const eventType: NotifyEventType = (NOTIFY_EVENT_TYPES as readonly string[]).includes(
        requested,
      )
        ? (requested as NotifyEventType)
        : "builder_archive";
      // Awaited so the response reflects that the router ran.
      await notify({
        type: eventType,
        title: "Friday test notification",
        body: "If you can see this, notifications are working.",
        deepLink: "/",
      });
      return { status: 200, body: { ok: true, eventType } };
    },
  },

  // --- Mail ---
  {
    method: "GET",
    match: /^\/api\/mail\/inbox\/[^/]+$/,
    handler: async (ctx) => {
      const agent = ctx.path.split("/")[4];
      return { status: 200, body: await inbox(agent) };
    },
  },
  {
    method: "POST",
    match: "/api/mail/send",
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as Parameters<typeof sendMail>[0];
      // FIX_FORWARD 5.7: per-agent mail rate limit — 50 mails / 5min / from.
      const fromAgent = body.fromAgent || "__unknown__";
      const r = await consumeRateLimit({
        key: `mail:${fromAgent}`,
        windowMs: 5 * 60 * 1000,
        max: 50,
      });
      if (!r.allowed) {
        return {
          status: 429,
          body: {
            error: "rate_limited",
            detail: `agent ${fromAgent} exceeded 50 mails / 5 min`,
            retry_after_ms: r.retryAfterMs,
          },
        };
      }
      // FRI-11 F3: resolve symbolic recipients ("parent" / "self") before validation.
      const resolved = await resolveRecipient(fromAgent, body.toAgent);
      if (!resolved.ok) return { status: 400, body: { error: resolved.error } };
      // FRI-11 F2: reject mail to unknown recipients before persisting the row.
      const check = await validateRecipient(resolved.agent);
      if (!check.ok) {
        return { status: 400, body: { error: check.error, suggestion: check.suggestion } };
      }
      return { status: 200, body: await sendMail({ ...body, toAgent: check.agent }) };
    },
  },
  {
    method: "POST",
    match: /^\/api\/mail\/\d+\/read$/,
    handler: async (ctx) => {
      const id = Number(ctx.path.split("/")[3]);
      const row = await getMail(id);
      if (!row) return { status: 404, body: { error: "mail not found" } };
      await markRead(id);
      return { status: 200, body: { ...row, delivery: "read", readAt: Date.now() } };
    },
  },
  {
    method: "POST",
    match: /^\/api\/mail\/\d+\/close$/,
    handler: async (ctx) => {
      const id = Number(ctx.path.split("/")[3]);
      const row = await getMail(id);
      if (!row) return { status: 404, body: { error: "mail not found" } };
      await closeMail(id);
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: "GET",
    match: "/api/mail/search",
    handler: async (ctx) => {
      const url = ctx.url;
      const q = url.searchParams.get("q") ?? undefined;
      const from = url.searchParams.get("from") ?? undefined;
      const to = url.searchParams.get("to") ?? undefined;
      const involves = url.searchParams.get("involves") ?? undefined;
      const typeRaw = url.searchParams.get("type");
      const deliveryRaw = url.searchParams.get("delivery");
      const priorityRaw = url.searchParams.get("priority");
      const since = url.searchParams.get("since") ?? undefined;
      const until = url.searchParams.get("until") ?? undefined;
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "") || 100, 500);
      const offset = parseInt(url.searchParams.get("offset") ?? "") || 0;
      const type = typeRaw
        ? (typeRaw.split(",").filter(Boolean) as Array<"message" | "notification" | "task">)
        : undefined;
      const delivery = deliveryRaw
        ? (deliveryRaw.split(",").filter(Boolean) as Array<"pending" | "read" | "closed">)
        : undefined;
      const priority = priorityRaw
        ? (priorityRaw.split(",").filter(Boolean) as Array<"normal" | "critical">)
        : undefined;
      try {
        const result = await searchMail({
          q,
          from,
          to,
          involves,
          type,
          delivery,
          priority,
          since,
          until,
          limit,
          offset,
        });
        return { status: 200, body: result };
      } catch (err) {
        return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },

  // --- Attachments / uploads --- (binary; own req/res, same-host gated)
  {
    method: "POST",
    match: "/api/uploads",
    auth: true,
    raw: async (ctx) => {
      const { req, res } = ctx;
      const contentLength = Number(req.headers["content-length"] ?? 0);
      // FIX_FORWARD 5.5: 15 MB hard cap, enforced at stream-receive.
      const MAX_BYTES = 15 * 1024 * 1024;
      if (contentLength > MAX_BYTES) {
        return json(res, 413, { error: `file exceeds ${MAX_BYTES} bytes` });
      }
      const filename = String(req.headers["x-filename"] ?? "upload").slice(0, 255);
      const mime = String(req.headers["content-type"] ?? "application/octet-stream");
      if (!ATTACHMENT_MIME_ALLOWLIST.has(mime.toLowerCase())) {
        return json(res, 415, {
          error: `unsupported mime: ${mime}`,
          allowed: [...ATTACHMENT_MIME_ALLOWLIST],
        });
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      try {
        for await (const c of req) {
          const buf = c as Buffer;
          received += buf.length;
          if (received > MAX_BYTES) {
            // Tear down the connection so a client lying about content-length
            // can't keep amplifying memory.
            aborted = true;
            req.destroy();
            return json(res, 413, { error: `file exceeds ${MAX_BYTES} bytes` });
          }
          chunks.push(buf);
        }
      } catch (err) {
        if (aborted) return; // already responded
        return json(res, 400, {
          error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) {
        return json(res, 400, { error: "empty body" });
      }
      try {
        const att = await uploadAttachment({ bytes, filename, mime });
        return json(res, 200, {
          sha256: att.sha256,
          filename: att.filename,
          mime: att.mime,
          sizeBytes: att.sizeBytes,
        });
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  },
  {
    method: "GET",
    match: /^\/api\/uploads\/[a-f0-9]{64}$/,
    auth: true,
    raw: async (ctx) => {
      const { res } = ctx;
      const sha = ctx.path.split("/")[3];
      const bytes = await readAttachmentBytes(sha);
      if (!bytes) return json(res, 404, { error: "not found" });
      const meta = await getAttachment(sha);
      const rawMime = (meta?.mime ?? "application/octet-stream").toLowerCase();
      // Only allow inline rendering for a small, well-understood set of MIME
      // types. Anything else is forced to download. `nosniff` blocks sniffing.
      const inlineSafe = INLINE_SERVE_MIME_ALLOWLIST.has(rawMime);
      const contentType = inlineSafe ? rawMime : "application/octet-stream";
      const safeFilename = sanitizeFilenameForHeader(meta?.filename ?? sha);
      const headers: Record<string, string> = {
        "content-type": contentType,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      };
      if (!inlineSafe) {
        headers["content-disposition"] =
          `attachment; filename="${safeFilename.ascii}"; filename*=UTF-8''${safeFilename.rfc5987}`;
      }
      res.writeHead(200, headers);
      res.end(bytes);
    },
  },

  // --- Apps (FRI-78) --- (same-host gated)
  {
    method: "GET",
    match: "/api/apps",
    auth: true,
    handler: async () => {
      const list = await listApps();
      const rows = await Promise.all(
        list.map(async (r) => {
          const detail = await inspectApp(r.id);
          return {
            ...r,
            agents: detail?.agents ?? [],
            schedules: detail?.schedules ?? [],
            mcpServers: detail?.mcpServers ?? [],
          };
        }),
      );
      return { status: 200, body: rows };
    },
  },
  {
    method: "POST",
    match: "/api/apps",
    auth: true,
    body: "json",
    handler: async (ctx) => {
      const body = ctx.body as { folderPath: string; adopt?: boolean };
      if (!body.folderPath) return { status: 400, body: { error: "folderPath required" } };
      try {
        const result = await installApp(body.folderPath, { adopt: !!body.adopt });
        return { status: 201, body: result };
      } catch (err) {
        if (err instanceof AppInstallError) {
          const status =
            err.code === "already_installed"
              ? 409
              : err.code === "agent_name_collision" ||
                  err.code === "schedule_name_collision" ||
                  err.code === "mcp_name_collision"
                ? 409
                : 400;
          return { status, body: { error: err.message, code: err.code } };
        }
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "GET",
    match: /^\/api\/apps\/[^/]+$/,
    auth: true,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      const row = await inspectApp(id);
      if (!row) return { status: 404, body: { error: "not found" } };
      return { status: 200, body: row };
    },
  },
  {
    method: "DELETE",
    match: /^\/api\/apps\/[^/]+$/,
    auth: true,
    body: "json-optional",
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      const body = ctx.body as { folderDisposition?: "archive" | "keep" | "delete" };
      try {
        const result = await uninstallApp(id, { folderDisposition: body.folderDisposition });
        return { status: 200, body: result };
      } catch (err) {
        if (err instanceof AppInstallError) {
          return { status: 404, body: { error: err.message, code: err.code } };
        }
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  },
  {
    method: "POST",
    match: /^\/api\/apps\/[^/]+\/reload$/,
    auth: true,
    handler: async (ctx) => {
      const id = decodeURIComponent(ctx.path.split("/")[3]);
      let result!: { id: string; changed: boolean };
      try {
        result = await reloadApp(id);
      } catch (err) {
        if (err instanceof AppInstallError) {
          return { status: 404, body: { error: err.message, code: err.code } };
        }
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      let stoppedWorkers = 0;
      // Stop workers even when manifest unchanged — picks up rotated secrets.
      try {
        stoppedWorkers = await stopWorkersForApp(id);
      } catch (err) {
        logger.log("warn", "app.reload.stop-workers.fail", {
          app: id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { status: 200, body: { ...result, stoppedWorkers } };
    },
  },
];

/** Request shape for `createAgent` — the same object `POST /api/agents` parses. */
export interface CreateAgentInput {
  type: AgentType;
  name: string;
  parentName: string;
  prompt: string;
  model?: string;
  ticketId?: string;
  /**
   * Builder workspace source. `repo` is either:
   *   - a local filesystem path to an existing git checkout (the worktree is
   *     created directly off it), OR
   *   - a remote URL (https / ssh / scp-style) when there is NO local checkout
   *     on this machine. In that case the daemon maintains a bare `--mirror`
   *     clone under `<DATA_DIR>/repos/<name>.git` and worktrees off the mirror.
   * The orchestrator resolves a repo NAME → URL before calling; the daemon
   * just needs to accept whichever form arrives in `repo`.
   */
  worktree?: { repo: string; branch?: string; fromRef?: string };
  reason?: string;
}

/**
 * Core agent-creation logic, extracted from the `POST /api/agents` route so
 * that in-process callers (the evolve auto-triage hook, FRI-40) can reuse it
 * without an HTTP round-trip. Behavior is byte-for-byte identical to the old
 * route body: it performs name validation (400), the duplicate-name check
 * (409 via `registry.getAgent`), the type check (400), the ADR-022
 * spawn-permission gate, workspace creation for builders, `registerAgent`,
 * `agent.spawn` telemetry, prompt assembly, the spawn user-block, and
 * `dispatchTurn`, then returns `{ status: 201, body: { name, turn_id } }`.
 *
 * Returning the 409 from inside this function is what gives the in-process
 * evolve call its dedup: a second scan that re-promotes the same proposal
 * hits the existing `triage-<id>` row and gets a 409, not a duplicate spawn.
 */
async function createAgent(
  body: CreateAgentInput,
  cfg: ReturnType<typeof loadConfig>,
  opts?: { evolveEscalation?: boolean },
): Promise<{ status: number; body: unknown }> {
  if (!body.name || !isValidAgentName(body.name)) {
    return {
      status: 400,
      body: {
        error: "invalid name (must be lowercase alphanumeric + dashes, up to 64 chars)",
      },
    };
  }
  if (await registry.getAgent(body.name)) {
    return { status: 409, body: { error: `agent "${body.name}" already exists` } };
  }
  if (
    body.type !== "builder" &&
    body.type !== "helper" &&
    body.type !== "bare" &&
    body.type !== "planner"
  ) {
    return {
      status: 400,
      body: { error: `cannot create agent of type "${body.type}" via this endpoint` },
    };
  }

  // ADR-022 spawn-permission gate. Resolve the caller's agent type by
  // looking up the parent row; absent parent ⇒ implicit orchestrator
  // (matches the implicit-create path in POST /api/chat/turn). Non-
  // orchestrator callers are restricted to spawning helpers and planners
  // (FRI-16) and must include a non-empty `reason`; planners are leaves
  // and cannot spawn at all.
  const callerRow = body.parentName ? await registry.getAgent(body.parentName) : null;
  const callerType: CallerType = callerRow?.type ?? "orchestrator";
  // FRI-149: `opts.evolveEscalation` is the un-forgeable carve-out marker. It is
  // a SEPARATE argument to this function (not a `body` / `CreateAgentInput`
  // field), so the public `POST /api/agents` route — which calls
  // `createAgent(body, cfg)` with no third arg — can never set it. Only the
  // in-process evolve scan hook passes `{ evolveEscalation: true }`.
  const rejection = validateSpawnPermissions({ type: body.type, reason: body.reason }, callerType, {
    evolveEscalation: opts?.evolveEscalation === true,
  });
  if (rejection) {
    return { status: rejection.status, body: rejection.body };
  }
  const persistedReason = callerType === "orchestrator" ? null : (body.reason ?? "").trim() || null;

  let workingDirectory = process.cwd();
  let worktreePath: string | undefined;
  let branch: string | undefined;
  // PR-271 BLOCKER 1: the original source repo for a builder, persisted on the
  // agent row so the archive route can resolve the correct git dir (the bare
  // mirror, in remote mode) deterministically rather than depending on the
  // in-workspace marker the SDK may delete first.
  let builderRepo: string | undefined;
  if (body.type === "builder") {
    const repo = body.worktree?.repo ?? process.cwd();
    builderRepo = repo;
    branch = body.worktree?.branch ?? `friday/${body.name}`;
    try {
      const ws = createWorkspace({
        name: body.name,
        baseRepo: repo,
        branch,
        fromRef: body.worktree?.fromRef,
      });
      workingDirectory = ws.path;
      worktreePath = ws.path;
    } catch (err) {
      return {
        status: 500,
        body: {
          error: `workspace creation failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // §9: propagate the spawning agent's `appId` to its child. Builders are
  // exempt — workspace containment (worktree cwd) is the stronger rule,
  // and builders can't be declared in a manifest in v1 anyway.
  const inheritedAppId =
    body.type !== "builder" && body.parentName ? await registry.getAppId(body.parentName) : null;
  await registry.registerAgent({
    name: body.name,
    type: body.type,
    parentName: body.parentName,
    ticketId: body.ticketId,
    worktreePath,
    branch,
    appId: inheritedAppId ?? undefined,
    spawnReason: persistedReason,
    // Persist the builder's source repo so archive can deterministically resolve
    // the teardown git dir (PR-271 BLOCKER 1).
    metaJson: builderRepo ? { repo: builderRepo } : undefined,
  });

  // FRI-16: planners inherit their parent's cwd (a planner under a builder
  // runs inside that builder's worktree, middle-path guarded). Resolve via
  // the same registry helper every other dispatch path (mail respawn,
  // watchdog refork, dispatch-listener) uses, so the spawn turn and every
  // later turn agree on the session cwd — the SDK encodes cwd into the
  // JSONL transcript path, and divergence breaks session resume (FRI-61).
  if (body.type === "planner") {
    const plannerRow = await registry.getAgent(body.name);
    if (plannerRow) {
      workingDirectory = await registry.workingDirectoryFor(plannerRow);
    }
  }

  // ADR-022 telemetry: emit one `agent.spawn` event per successful
  // spawn. Walks the parent chain to record true `depth` (1 =
  // orchestrator-rooted) and the orchestrator-rooted `parentChain`
  // capped at SPAWN_PARENT_CHAIN_CAP. The evolve depth scanner
  // (`scanAgentSpawnDepth`) feeds off these lines.
  try {
    const { depth, parentChain } = await computeSpawnDepth(body.parentName, registry.getAgent);
    logger.log("info", "agent.spawn", {
      parent: body.parentName,
      child: body.name,
      type: body.type,
      depth,
      parentChain,
      reason: persistedReason,
    });
  } catch (err) {
    // Telemetry failure must never block the spawn — the row is
    // already persisted and the worker is about to dispatch.
    logger.log("warn", "agent.spawn.telemetry.error", {
      agent: body.name,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const turnId = `t_${randomUUID()}`;
  const { systemPrompt: baseSystemPrompt } = await buildSystemPrompt({
    name: body.name,
    type: body.type,
    parentName: body.parentName,
  });
  const bootstrapResults = await runHooks("agent:bootstrap", {
    agentName: body.name,
    agentType: body.type,
    workingDirectory: worktreePath ?? workingDirectory,
    branch,
    parentName: body.parentName,
    spawnPrompt: body.prompt,
  });
  const bootstrapAppends = bootstrapResults
    .map((r) => r?.appendSystemPrompt)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const bootstrapAugmentedBase =
    bootstrapAppends.length > 0
      ? `${baseSystemPrompt}\n\n---\n\n${bootstrapAppends.join("\n\n")}`
      : baseSystemPrompt;
  const modelCfg = resolveModelForRole(cfg, body.type);
  const { body: wrappedSpawnPrompt, systemPrompt: spawnSystemPrompt } = await buildDispatchPrompt(
    { name: body.name, type: body.type, parentName: body.parentName },
    {
      kind: "agent_spawn",
      userText: body.prompt,
      baseSystemPromptOverride: bootstrapAugmentedBase,
      parentName: body.parentName,
    },
  );
  // FRI-71: persist the spawn-time prompt as a user block so the very first
  // turn renders with the originating user bubble (not just an orphan
  // assistant reply). The session id isn't known yet — `recordUserBlock`
  // falls back to '__pending__' and the post-turn JSONL recovery rewrites
  // it once the SDK assigns a real id.
  try {
    await recordUserBlock({
      turnId,
      agentName: body.name,
      text: body.prompt,
      source: "agent_spawn",
    });
  } catch (err) {
    logger.log("warn", "chat.turn.user-block.error", {
      agent: body.name,
      source: "agent_spawn",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  dispatchTurn({
    agentName: body.name,
    options: {
      agentName: body.name,
      agentType: body.type,
      workingDirectory,
      systemPrompt: spawnSystemPrompt,
      prompt: wrappedSpawnPrompt,
      turnId,
      model: body.model ?? modelCfg.name,
      thinking: modelCfg.thinking,
      effort: modelCfg.effort,
      daemonPort: resolveDaemonPort(cfg),
      parentName: body.parentName,
      mode: "long-lived",
    },
  });
  return { status: 201, body: { name: body.name, turn_id: turnId } };
}

function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ReturnType<typeof loadConfig>,
): void {
  // Phase 5: per-agent SSE channel. `?agent=<name>` restricts the
  // stream to live-turn events for that agent only. The dashboard
  // re-opens the connection on agent focus switch; events without an
  // `agent` field (e.g. connection_established, app_lifecycle) pass
  // through regardless so global daemon-level signals still reach the
  // client. Omitting the query string keeps the legacy global stream
  // for non-Zero callers + tests.
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const agentFilter = url.searchParams.get("agent");

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // Flush headers + an SSE comment immediately so the browser's EventSource
  // transitions to OPEN right away (rather than waiting for the first event
  // or keepalive, which can be 20s+ on a quiet daemon).
  res.flushHeaders();
  res.write(": connected\n\n");

  // First event on every new connection: connection_established carries the
  // daemon's boot_id (FIX_FORWARD 1.6). Clients cache it and reset their
  // per-agent cursors on mismatch — the canonical signal of a daemon
  // restart. We do NOT advance the bus seq for this event; it carries a
  // sentinel seq=0 since clients should never use it for replay cursoring.
  writeRawEvent(res, {
    v: 1,
    seq: 0,
    type: "connection_established",
    boot_id: getBootId(),
    boot_ts: getBootTs(),
    current_seq: eventBus.currentSeq(),
    ts: Date.now(),
  });

  // Replay strategy (FIX_FORWARD 1.9):
  //   - With Last-Event-ID: replay strictly newer events. The browser sets
  //     this header automatically across EventSource reconnects, so a
  //     transient blip resumes seamlessly.
  //   - Without Last-Event-ID (fresh page load): walk back 500 events from
  //     the current head so any in-flight block_start/block_delta the
  //     client missed is delivered. The chat-side per-agent dedup
  //     (FIX_FORWARD 1.7) handles duplicates against the canonical-blocks
  //     fetch that the client also issues on mount.
  //
  // Phase 5: when `?agent=<name>` is set, the daemon switches from
  // the legacy seq-cursor replay to a "replay the current turn's
  // buffer" model (plan §211). The per-agent buffer is bounded
  // (2000 events) and evicted on `turn_done`, so the replay is
  // always scoped to the in-flight turn — no Last-Event-ID needed.
  if (agentFilter) {
    for (const e of eventBus.replayForAgent(agentFilter)) {
      if (!passesAgentFilter(e, agentFilter)) continue;
      writeEvent(res, e);
    }
  } else {
    const lastEventIdHeader = req.headers["last-event-id"];
    const parsedLast = lastEventIdHeader ? Number(lastEventIdHeader) : NaN;
    const BACKWALK = 500;
    const replayFrom =
      Number.isFinite(parsedLast) && parsedLast >= 0
        ? (parsedLast as number)
        : Math.max(0, eventBus.currentSeq() - BACKWALK);
    for (const e of eventBus.replaySince(replayFrom)) {
      writeEvent(res, e);
    }
  }

  const unsub = eventBus.subscribe((e) => {
    if (!passesAgentFilter(e, agentFilter)) return;
    writeEvent(res, e);
  });
  const ka = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      // socket closed
    }
  }, cfg.sseKeepaliveSec * 1000);

  req.on("close", () => {
    clearInterval(ka);
    unsub();
  });
}

/**
 * Phase 5 per-agent SSE filter. When `?agent=` is set, drop events
 * whose `agent` field doesn't match. Events without an `agent` field
 * (connection_established, app_lifecycle) always pass through — they're
 * daemon-level signals every connected client needs to see.
 */
function passesAgentFilter(
  e: { type?: unknown; agent?: unknown },
  agentFilter: string | null,
): boolean {
  if (!agentFilter) return true;
  if (typeof e.agent !== "string") return true;
  return e.agent === agentFilter;
}

function writeEvent(res: ServerResponse, e: { type: string; seq: number }): void {
  try {
    res.write(`id: ${e.seq}\n`);
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  } catch {
    // socket closed
  }
}

/**
 * Write an SSE event that is NOT in the ring buffer — used for the
 * connection-handshake `connection_established` event. We skip the `id:`
 * line so the browser's `Last-Event-ID` cursor doesn't advance to seq=0,
 * which would defeat replay on the next reconnect.
 */
function writeRawEvent(res: ServerResponse, e: { type: string; [k: string]: unknown }): void {
  try {
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  } catch {
    // socket closed
  }
}

async function handleSystemCommand(
  res: ServerResponse,
  body: { command: string; args?: string },
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const args = (body.args ?? "").trim();
  switch (body.command) {
    case "archive": {
      if (!args) return json(res, 400, { error: "agent name required" });
      // Slash-command archive defaults to "abandoned" — the user didn't
      // signal outcome on the command line. The REST endpoint and MCP tool
      // require an explicit reason; this is the admin/CLI shortcut surface.
      void archiveAgent(args, { reason: "abandoned" });
      return json(res, 200, { ok: true, message: `archived ${args}` });
    }
    case "status": {
      return json(res, 200, {
        agents: await registry.listAgents(),
        ts: Date.now(),
      });
    }
    case "inspect": {
      if (!args) return json(res, 400, { error: "agent name required" });
      const a = await registry.getAgent(args);
      if (!a) return json(res, 404, { error: "agent not found" });
      return json(res, 200, a);
    }
    case "clear": {
      const cfg = loadConfig();
      const name = args || cfg.orchestratorName;
      const a = await registry.getAgent(name);
      if (!a) return json(res, 404, { error: `agent not found: ${name}` });
      // If a worker is currently running, tear it down so the next turn forks
      // a fresh process with no `resume` arg. setStatus + clearSession alone
      // wouldn't take effect until the worker exits naturally. Await the
      // refork before clearSession so the exit handler's setStatus(agent,
      // 'idle') reset can't race the session wipe.
      await forceWorkerRefork(name);
      await registry.clearSession(name);
      // Phase 5: `agent_lifecycle:refork` SSE retired — Zero replicates
      // the session-clear (agents.session_id=null) reactively.
      return json(res, 200, {
        ok: true,
        message: `clear: ${name} session cleared; next turn starts fresh`,
      });
    }
    case "scratch": {
      // `/scratch <topic>` — args is the seed topic, not the name. Names are
      // auto-generated as scratch-<adj>-<noun>, kebab-case + unique against
      // the live registry.
      const topic = args.trim();
      // Pre-fetch all existing agent names once so the name generator's
      // collision predicate stays sync (the loop tries random pairs).
      const existingNames = new Set((await registry.listAgents()).map((a) => a.name));
      const name = generateScratchName((n) => existingNames.has(n));
      await registry.registerAgent({
        name,
        type: "bare",
        parentName: undefined,
      });
      // Phase 5: `agent_lifecycle:spawn` SSE retired — Zero replicates
      // the agents INSERT to the dashboard sidebar reactively.

      // Seed the agent with the topic as its first user turn. Re-uses the
      // same dispatch path as /api/chat/turn so persistence + SSE work
      // identically, just bypasses the skill match (the topic is free text,
      // not a `/<skill>` invocation).
      if (topic) {
        const seedTurnId = `t_${randomUUID()}`;
        const modelCfg = resolveModelForRole(cfg, "bare");
        const { body: wrappedTopic, systemPrompt: scratchSystemPrompt } = await buildDispatchPrompt(
          { name, type: "bare" },
          { kind: "scratch", userText: topic },
        );
        // FRI-71: persist the seed topic as a user block so the bare agent's
        // first turn renders with the originating user bubble.
        try {
          await recordUserBlock({
            turnId: seedTurnId,
            agentName: name,
            text: topic,
            source: "scratch",
          });
        } catch (err) {
          logger.log("warn", "chat.turn.user-block.error", {
            agent: name,
            source: "scratch",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        dispatchTurn({
          agentName: name,
          options: {
            agentName: name,
            agentType: "bare",
            workingDirectory: process.cwd(),
            systemPrompt: scratchSystemPrompt,
            prompt: wrappedTopic,
            turnId: seedTurnId,
            model: modelCfg.name,
            thinking: modelCfg.thinking,
            effort: modelCfg.effort,
            resumeSessionId: undefined,
            daemonPort: resolveDaemonPort(cfg),
            parentName: undefined,
            mode: "long-lived",
          },
        });
      }

      return json(res, 200, { ok: true, agent: name });
    }
    case "restart": {
      // We rely on the process supervisor (tmux via `friday start`, or a
      // launchd / systemd unit per docs/run/) to respawn us. SIGTERM-then-let-
      // supervisor-restart is correct for any of those; a daemon launched
      // bare (no supervisor) will simply exit.
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
      return json(res, 200, { ok: true });
    }
    default:
      return json(res, 404, { error: `unknown system command: ${body.command}` });
  }
}

/**
 * Render a proposal as a ticket body. Includes signals as a brief evidence
 * appendix so the resulting ticket carries enough context to act on without
 * cross-referencing the proposal file.
 */
function renderProposalForTicket(p: Proposal): string {
  const sections = [p.proposedChange.trim()];
  if (p.signals.length > 0) {
    const lines = p.signals.map(
      (s) => `- \`${s.source}/${s.key}\` (${s.severity}, count=${s.count})`,
    );
    sections.push(`## Evidence\n\n${lines.join("\n")}`);
  }
  sections.push(
    `*Applied from evolve proposal \`${p.id}\` (${p.type}, blast: ${p.blastRadius}, score: ${p.score}).*`,
  );
  return sections.join("\n\n");
}

/**
 * Memory id slugifier. ASCII-only, lowercase, dashes for whitespace, dedup
 * runs of dashes, trim leading/trailing dashes. Not collision-resistant —
 * memory_save lets the caller pass an explicit id when that matters.
 */
function slugifyMemoryId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as T;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Parse an integer-shaped query param. Returns `undefined` if absent or NaN. */
function numericParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Allowlist of MIME types we accept for new uploads. Mirrors the dashboard's
 * file-picker `accept` attribute so the contract is consistent end-to-end.
 * The picker is a UI hint only — drag-drop and paste can deliver other
 * types — so the server enforces the same set.
 */
const ATTACHMENT_MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

/**
 * Subset of allowed MIMEs that are safe to serve inline (rendered by the
 * browser in-place). Anything outside this set is forced to download via
 * `Content-Disposition: attachment`. Conservative: even for a closed-loop
 * single-user daemon, we don't want the upload route to ever serve content
 * that could execute as script on the daemon's origin.
 */
const INLINE_SERVE_MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/**
 * Same-host authorization for write/read endpoints. Two layers of defense:
 *
 *  1. Shared secret on `x-friday-daemon-secret` (defeats other local
 *     processes that haven't read `~/.friday/.daemon-secret`).
 *  2. Host header must be a loopback name (defeats DNS-rebind: a hostile
 *     page resolving `attacker.example` to 127.0.0.1 will send
 *     `Host: attacker.example` and fail this check).
 *
 * FRI-2037 — THIS IS THE WORKER↔DAEMON AUTH WALL. Layer 2 encodes "the caller
 * is on this host", which stops being true the moment a worker runs in its own
 * container (FRI-2038). Every Friday MCP tool reaches the daemon through
 * `daemonFetch`, so a containerised worker sending `Host: friday-daemon:7610`
 * fails here and every tool call 403s.
 *
 * `resolveDaemonBaseUrl` makes the worker's side configurable; this side is
 * deliberately NOT yet, because loosening it is an authentication decision,
 * not a plumbing one. Whatever replaces layer 2 has to survive a real network
 * hop — the daemon secret alone does not, since it is a bearer token sitting
 * on a volume any builder in that container can read (the residual risk
 * FRI-2062 accepted). Do not relax `isLocalHost` without replacing it.
 */
function authorizeSameHost(req: IncomingMessage): boolean {
  if (!isLocalHost(req.headers.host)) return false;
  const provided = req.headers[DAEMON_SECRET_HEADER];
  if (typeof provided !== "string") return false;
  // Constant-time comparison to avoid timing oracles. The secret is short
  // enough that the loop cost is negligible.
  const expected = getDaemonSecret();
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Render a filename for `Content-Disposition`. Returns both an ASCII
 * fallback (for legacy clients) and an RFC 5987 percent-encoded form. We
 * strip control chars and double quotes, replace path separators, and cap
 * the length so the header never carries unbounded user input.
 */
function sanitizeFilenameForHeader(raw: string): {
  ascii: string;
  rfc5987: string;
} {
  // Strip path separators, control chars, and quotes that would break the
  // ASCII `filename="..."` form.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 200);
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_") || "attachment";
  const rfc5987 = encodeURIComponent(cleaned).replace(/['()]/g, escape);
  return { ascii, rfc5987 };
}
