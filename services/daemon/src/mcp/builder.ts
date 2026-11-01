/**
 * Constructs the per-worker MCP server set given the caller's identity.
 * Called inside a forked worker process — never on the parent — because
 * `McpSdkServerConfigWithInstance` carries a live `McpServer` instance that
 * cannot cross the IPC boundary.
 *
 * Hard-gates which servers/tools each agent type sees. The model receives
 * tools as `mcp__<server-name>__<tool-name>`.
 */

import type { AgentType, ManifestMcpServer, McpServerConfig } from "@friday/shared";
import {
  buildSubstitutionMap,
  collectRefsFromEnvRecords,
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  isSecretsLocked,
  resolveDaemonBaseUrl,
} from "@friday/shared";
import type {
  McpSdkServerConfigWithInstance,
  McpHttpServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { logger } from "../log.js";
import { hostedServerPath, type HostedServerName } from "./host.js";
import { getResolvedShellEnv } from "../shell-env.js";
import { buildAppsServer, APPS_SERVER_NAME } from "./apps.js";
import { buildEchoServer, ECHO_SERVER_NAME } from "./echo.js";
import { buildMailServer, MAIL_SERVER_NAME } from "./mail.js";
import { buildAgentsServer, AGENTS_SERVER_NAME } from "./agents.js";
import { buildMemoryServer, MEMORY_SERVER_NAME } from "./memory.js";
import { buildTicketsServer, TICKETS_SERVER_NAME } from "./tickets.js";
import { buildScheduleServer, SCHEDULE_SERVER_NAME } from "./schedule.js";
import { buildReminderServer, REMINDER_SERVER_NAME } from "./reminder.js";
import { buildHabitServer, HABIT_SERVER_NAME } from "./habit.js";
import { buildEvolveServer, EVOLVE_SERVER_NAME } from "./evolve.js";
import { GITHUB_SERVER_NAME } from "./github.js";
import { buildInboxServer, INBOX_SERVER_NAME } from "./inbox.js";
import { buildIntegrationsServer, INTEGRATIONS_SERVER_NAME } from "./integrations.js";
import { buildElicitationServer, ELICITATION_SERVER_NAME } from "./elicitation.js";
import { buildSecretsServer, SECRETS_SERVER_NAME } from "./secrets.js";

export interface BuildMcpServersOptions {
  callerType: AgentType;
  callerName: string;
  daemonPort: number;
  parentName?: string;
  /**
   * User-configured stdio MCP servers (`~/.friday/config.json` → `mcpServers`).
   * Filtered by `scope` against `callerType`; entries whose name shadows a
   * built-in (`friday-*`) are rejected.
   */
  userMcpServers?: McpServerConfig[];
  /**
   * FRI-78: per-app context. Set by the spawn site when the caller agent
   * belongs to an installed app. The wiring loop appends each declared
   * stdio MCP server with `cwd = appContext.folderPath` and substitutes
   * `${VAR}` references in `env` from the app's `.env`. Per-app servers
   * are visible only to the app's own agents; the orchestrator (which has
   * no `appId`, so no `appContext`) never sees them.
   */
  appContext?: {
    appId: string;
    folderPath: string;
    mcpServers: ManifestMcpServer[];
    /** Parsed `.env` contents, when the app folder has one. */
    envFile?: Record<string, string>;
  };
}

export type AssembledMcpServers = Record<
  string,
  // FRI-2037: `http` joins the union because Friday's own servers are moving
  // to daemon-hosted endpoints. `sdk` stays for the in-process legacy form
  // (and the FRIDAY_MCP_HOSTED escape hatch); `stdio` is user-configured
  // servers and Apps, which are unaffected by this work.
  McpSdkServerConfigWithInstance | McpStdioServerConfig | McpHttpServerConfig
>;

/**
 * FRI-2037: whether Friday's own MCP servers are served by the daemon over
 * HTTP (default) or constructed in-process inside the worker (legacy).
 *
 * Defaults ON. The escape hatch exists so the pilot can be bisected without a
 * revert; it is not a supported configuration and goes away with the flag.
 */
export function useHostedMcp(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FRIDAY_MCP_HOSTED;
  return !(raw === "0" || raw === "false");
}

/**
 * FRI-2037: point a server at the daemon-hosted endpoint, or build it
 * in-process when the escape hatch is set.
 *
 * `fallback` is a thunk so the in-process server is only CONSTRUCTED when it
 * is actually used — otherwise every hosted server would still be built in the
 * worker, which is the cost this change exists to remove.
 */
function hostedOr(
  name: HostedServerName,
  opts: BuildMcpServersOptions,
  fallback: () => McpSdkServerConfigWithInstance,
): McpHttpServerConfig | McpSdkServerConfigWithInstance {
  if (!useHostedMcp()) return fallback();
  return hostedServerConfig(name, opts);
}

/**
 * Point a server at its daemon-hosted endpoint, with no in-process option.
 *
 * Extracted from `hostedOr` for servers that must NEVER be built in the
 * worker — `friday-github` holds a credential whose entire purpose is to stay
 * out of the process running untrusted repository code, so a fallback would
 * defeat the server rather than de-risk it.
 */
function hostedServerConfig(
  name: HostedServerName,
  opts: BuildMcpServersOptions,
): McpHttpServerConfig {
  const base = resolveDaemonBaseUrl(opts.daemonPort);
  // FRI-2087: the daemon secret goes ONLY to the loopback listener.
  //
  // Off-loopback this is the worker-facing listener, which authorizes by the
  // per-worker token (see `workerRouterDeps`). Sending the shared secret there
  // would be sending a credential to a surface that does not use it — and
  // worse, building the header CREATES one: `getDaemonSecret()` writes a fresh
  // secret when the file is absent, which in a builder container (no `/data`
  // mount) means minting a value the daemon has never seen. That silent
  // mismatch is what left a containerised Builder with no Friday tools.
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(base);
  return {
    type: "http",
    url: `${base}${hostedServerPath(name)}`,
    headers: {
      ...(loopback ? { [DAEMON_SECRET_HEADER]: getDaemonSecret() } : {}),
      // FRI-2037: the worker proves WHICH worker it is. The daemon derives
      // callerName/callerType from this token, so the worker no longer names
      // itself — a worker holding the shared secret could previously claim to
      // be any agent. Minted at spawn, revoked on exit (worker-tokens.ts).
      ...(process.env.FRIDAY_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.FRIDAY_WORKER_TOKEN}` }
        : {}),
    },
  };
}

export function buildMcpServers(opts: BuildMcpServersOptions): AssembledMcpServers {
  const servers: AssembledMcpServers = {};
  const ctx = {
    callerName: opts.callerName,
    callerType: opts.callerType,
    daemonPort: opts.daemonPort,
  };

  const substitutionMap = resolveSubstitutionMap(opts);

  // Echo stays for now as a sanity check; remove once the rest of the surface
  // is reliable.
  servers[ECHO_SERVER_NAME] = hostedOr(ECHO_SERVER_NAME, opts, () => buildEchoServer());

  // Every agent type can send/receive mail. Mail is the universal delivery
  // primitive (FIX_FORWARD 2.1/2.2); there is no separate `chat_reply` tool.
  servers[MAIL_SERVER_NAME] = hostedOr(MAIL_SERVER_NAME, opts, () => buildMailServer(ctx));

  // agent_create / agent_list / agent_archive / etc.: orchestrator + builder +
  // helper + bare (ADR-022; `bare` added by FRI-16 — the spawn matrix permits
  // bare→helper/planner with a reason, so its tool surface must expose
  // agent_create). The daemon-side guard at POST /api/agents enforces the
  // structural rules: only the orchestrator can spawn Builders, and non-
  // orchestrator callers must supply a non-empty `reason`. `scheduled`
  // remains excluded — it doesn't manage sub-agents (its FRI-149 evolve
  // escalation is daemon-internal, not MCP) — and `planner` is deliberately
  // excluded: planners are leaves by design (FRI-16 §4c); a planner that
  // needs help mails its parent.
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "builder" ||
    opts.callerType === "helper" ||
    opts.callerType === "bare"
  ) {
    servers[AGENTS_SERVER_NAME] = hostedOr(AGENTS_SERVER_NAME, opts, () =>
      buildAgentsServer({
        callerName: opts.callerName,
        callerType: opts.callerType,
        daemonPort: opts.daemonPort,
        parentName: opts.parentName,
      }),
    );
  }

  // friday-memory: every caller. Builders get a read-only filtered subset
  // (handled inside buildMemoryServer based on callerType).
  servers[MEMORY_SERVER_NAME] = hostedOr(MEMORY_SERVER_NAME, opts, () => buildMemoryServer(ctx));

  // friday-secrets: on-demand fetch for orchestrator/builder/helper/bare (ADR-038).
  // Scheduled + planner are excluded — headless leaves without secret disclosure.
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "builder" ||
    opts.callerType === "helper" ||
    opts.callerType === "bare"
  ) {
    servers[SECRETS_SERVER_NAME] = hostedOr(SECRETS_SERVER_NAME, opts, () =>
      buildSecretsServer({
        callerName: opts.callerName,
        callerType: opts.callerType,
        daemonPort: opts.daemonPort,
        appId: opts.appContext?.appId,
      }),
    );
  }

  // friday-tickets: orchestrator, builder, helper. Bare and scheduled don't
  // touch tickets directly.
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "builder" ||
    opts.callerType === "helper"
  ) {
    // FRI-2037 pilot: tickets is served by the DAEMON over HTTP rather than
    // constructed in-process here. Same `buildTicketsServer` code, same tool
    // definitions — it just runs on the other side of the boundary, which is
    // what gets the tool surface out of the process running untrusted
    // repository code (docs/sandbox.md residual risk #1).
    //
    // Opt-in while it is a pilot: `FRIDAY_MCP_HOSTED=0` restores the
    // in-process form, so a regression is one env var away from being
    // bisected rather than a revert. Remove the flag once the rest of the
    // surface has moved.
    servers[TICKETS_SERVER_NAME] = hostedOr(TICKETS_SERVER_NAME, opts, () =>
      buildTicketsServer(ctx),
    );
  }

  // friday-github: builders only (FRI-2078). It is the one agent type with a
  // branch and a repo on its row, and the route resolves both from there —
  // an orchestrator calling `pr_create` has nothing to open a PR from.
  //
  // ALWAYS hosted, with no `hostedOr` in-process fallback. The whole point is
  // that the GitHub credential stays out of the process running untrusted
  // repository code; an in-process variant would hand it straight back.
  if (opts.callerType === "builder") {
    servers[GITHUB_SERVER_NAME] = hostedServerConfig(GITHUB_SERVER_NAME, opts);
  }

  // friday-schedule: orchestrator only.
  if (opts.callerType === "orchestrator") {
    servers[SCHEDULE_SERVER_NAME] = hostedOr(SCHEDULE_SERVER_NAME, opts, () =>
      buildScheduleServer(ctx),
    );
  }

  // friday-reminder: ALL caller types. Reminders are user-facing chat
  // nudges that fire without waking any agent; an app sub-agent (e.g. the
  // kitchen agent) must be able to set one. Contrast friday-schedule, which
  // is orchestrator-only. Threads the per-app context (FRI-168) so app
  // sub-agents can emit idempotent, app-namespaced reminders — mirroring the
  // buildSecretsServer call above. Do NOT widen the shared `ctx`: that would
  // leak appId into mail/memory/tickets/etc.
  servers[REMINDER_SERVER_NAME] = hostedOr(REMINDER_SERVER_NAME, opts, () =>
    buildReminderServer({
      callerName: opts.callerName,
      callerType: opts.callerType,
      daemonPort: opts.daemonPort,
      appId: opts.appContext?.appId,
    }),
  );

  // friday-habit: ALL caller types (FRI-169). The habit tracker is a CORE
  // feature — every app sub-agent + the orchestrator must be able to add,
  // check off, and read Habits (contrast friday-schedule, orchestrator-only).
  // Threads the per-app context via an EXPLICIT options object (mirroring the
  // buildReminderServer/buildSecretsServer calls above). Do NOT widen the
  // shared `ctx`: that would leak appId into mail/memory/tickets/etc.
  servers[HABIT_SERVER_NAME] = hostedOr(HABIT_SERVER_NAME, opts, () =>
    buildHabitServer({
      callerName: opts.callerName,
      callerType: opts.callerType,
      daemonPort: opts.daemonPort,
      appId: opts.appContext?.appId,
    }),
  );

  // friday-evolve: orchestrator only. Sub-agents shouldn't be applying or
  // dismissing proposals — the meta-agent surfaces them via the orchestrator.
  if (opts.callerType === "orchestrator") {
    servers[EVOLVE_SERVER_NAME] = hostedOr(EVOLVE_SERVER_NAME, opts, () => buildEvolveServer(ctx));
  }

  // friday-apps: orchestrator only. App install/uninstall/reload + listing.
  // Sub-agents under an app can't pull the rug out from under themselves.
  if (opts.callerType === "orchestrator") {
    servers[APPS_SERVER_NAME] = hostedOr(APPS_SERVER_NAME, opts, () => buildAppsServer(ctx));
  }

  // friday-inbox: orchestrator only (FRI-171). Reads + acts on the stateless-
  // intake Inbox when Seth says "work through my inbox". Sub-agents don't
  // triage Captures — that's the orchestrator's job, at Seth's explicit
  // direction. Ordinary tools: NO timer/cron drives them (build contract §1).
  if (opts.callerType === "orchestrator") {
    servers[INBOX_SERVER_NAME] = hostedOr(INBOX_SERVER_NAME, opts, () => buildInboxServer(ctx));
  }

  // friday-integrations: every non-archived agent type. Cross-system imports
  // and writes (Linear today; future GH Issues, Jira). Sub-agents need this
  // so a builder can file a Linear follow-up directly instead of routing
  // every external write through the orchestrator. Gracefully no-ops if the
  // relevant API key isn't set on the daemon.
  servers[INTEGRATIONS_SERVER_NAME] = hostedOr(INTEGRATIONS_SERVER_NAME, opts, () =>
    buildIntegrationsServer(ctx),
  );

  // friday-elicitation: ask_user tool (FRI-152). Every agent that may need
  // to surface a structured prompt to Seth — orchestrator and bare types,
  // plus scheduled (which can dispatch back to the orchestrator for input).
  // Builders/helpers/planners run headless and shouldn't be prompting the
  // user directly; mail their parent instead (a planner routes user-facing
  // questions through its parent via mail — FRI-16, same discipline; the
  // FRI-152 unconditional built-in `AskUserQuestion` deny applies to
  // planners too).
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "bare" ||
    opts.callerType === "scheduled"
  ) {
    servers[ELICITATION_SERVER_NAME] = buildElicitationServer(ctx);
  }

  // playwright: built-in browser automation via Microsoft's @playwright/mcp.
  // Excluded for orchestrator to keep it responsive — long-running browser
  // calls belong in a spawned sub-agent. Headless + isolated so background
  // and parallel agents don't clobber each other (Chromium's SingletonLock
  // prevents shared profiles across processes anyway).
  if (opts.callerType !== "orchestrator") {
    servers[BROWSER_SERVER_NAME] = {
      type: "stdio",
      command: resolveStdioCommand("npx"),
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: shellEnvForStdio(),
    };
  }

  // User-configured stdio MCP servers from `~/.friday/config.json`. Each is
  // gated by its `scope` against the caller's agent type (no/empty scope =
  // all types). Reserved names (`friday-*` and built-ins like `playwright`)
  // are rejected to keep built-in tool namespaces clean. Malformed entries
  // are skipped, not thrown — a typo in config shouldn't break a worker.
  for (const s of opts.userMcpServers ?? []) {
    if (s.name.startsWith("friday-") || RESERVED_NAMES.has(s.name)) {
      logger.log("warn", "mcp.user.shadows-builtin", {
        name: s.name,
        callerType: opts.callerType,
        callerName: opts.callerName,
      });
      continue;
    }
    const inScope = !s.scope || s.scope.length === 0 || s.scope.includes(opts.callerType);
    if (!inScope) continue;
    if (!s.command) {
      logger.log("warn", "mcp.user.missing-command", {
        name: s.name,
        callerType: opts.callerType,
        callerName: opts.callerName,
      });
      continue;
    }
    servers[s.name] = {
      type: "stdio",
      command: resolveStdioCommand(s.command),
      args: s.args ?? [],
      // FRI-150: thread the daemon's captured shell env into per-server
      // `env`; manifest entries still win on top via spread order. The
      // SDK then merges `{...allowlist, ...config.env}`, so the manifest
      // and captured env both supersede the allowlist filter.
      env: {
        ...shellEnvForStdio(),
        ...substituteEnv(s.env ?? {}, substitutionMap),
      },
    };
  }

  // FRI-78: per-app stdio MCP servers. Only visible to the declaring
  // app's agents; the orchestrator never has `appContext` set. Resolved
  // relative to `appContext.folderPath`, with `${VAR}` substitution from
  // the app's own `.env`.
  if (opts.appContext) {
    const { appId, folderPath, mcpServers } = opts.appContext;
    for (const srv of mcpServers) {
      if (srv.name.startsWith("friday-") || RESERVED_NAMES.has(srv.name)) {
        logger.log("warn", "mcp.app.shadows-builtin", {
          name: srv.name,
          appId,
          callerName: opts.callerName,
        });
        continue;
      }
      if (servers[srv.name]) {
        logger.log("warn", "mcp.app.name-collision", {
          name: srv.name,
          appId,
          callerName: opts.callerName,
        });
        continue;
      }
      const resolvedArgs = srv.args.map((a) =>
        isLikelyAppPath(a) && !isAbsolute(a) ? join(folderPath, a) : a,
      );
      // FRI-36: the SDK's `McpStdioServerConfig` type doesn't declare `cwd`,
      // so any value we set is silently dropped and the spawned MCP inherits
      // the daemon's cwd. Apps must read their folder from `FRIDAY_APP_DIR`
      // (injected after manifest substitution so a manifest can't shadow it).
      // The `cwd` field below is kept as a forward-compatible hint in case
      // the SDK ever grows the field; it is a no-op today.
      servers[srv.name] = {
        type: "stdio",
        command: resolveStdioCommand(srv.command),
        args: resolvedArgs,
        // FRI-150: captured shell env carries the user's PATH + toolchain
        // (FNM_DIR, NVM_DIR, …) into the spawned MCP child. Manifest env
        // (after ${VAR} substitution) wins via the spread order, and
        // FRIDAY_APP_DIR is still injected last so a manifest can't
        // shadow it (FRI-36).
        env: {
          ...shellEnvForStdio(),
          ...substituteEnv(srv.env ?? {}, substitutionMap),
          FRIDAY_APP_DIR: folderPath,
        },
        cwd: folderPath,
      } as McpStdioServerConfig;
    }
  }

  return servers;
}

function isLikelyAppPath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  return arg.includes("/") || /\.(m?js|cjs|ts)$/i.test(arg);
}

function resolveSubstitutionMap(opts: BuildMcpServersOptions): Record<string, string> {
  const envRecords: Record<string, string>[] = [];
  for (const s of opts.userMcpServers ?? []) {
    if (s.env) envRecords.push(s.env);
  }
  if (opts.appContext) {
    for (const srv of opts.appContext.mcpServers) {
      if (srv.env) envRecords.push(srv.env);
    }
  }
  const referenced = collectRefsFromEnvRecords(envRecords);
  const map = buildSubstitutionMap({
    referenced,
    agentType: opts.callerType,
    appId: opts.appContext?.appId,
    legacyEnv: opts.appContext?.envFile,
  });
  for (const name of referenced) {
    if (!map[name]) {
      logger.log("warn", "secrets.substitution.missing", {
        name,
        locked: isSecretsLocked(),
        callerType: opts.callerType,
        callerName: opts.callerName,
        appId: opts.appContext?.appId,
      });
    }
  }
  return map;
}

/**
 * Substitute `${VAR}` references from the reference-only vault map (ADR-038).
 * No `process.env` fallback — daemon/worker process.env stays secret-free.
 */
export function substituteEnv(
  env: Record<string, string>,
  substitutionMap: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      return substitutionMap[name] ?? "";
    });
  }
  return out;
}

/**
 * FRI-150: rewrite `node` / `npx` to the daemon's pinned-Node absolute
 * paths so a clean-install MCP child (no brew Node, no globally-resolvable
 * `npx`) still spawns. `process.execPath` is the fnm-resolved pinned Node
 * we're running under (per FRI-146 supervisor shim); its sibling `npx`
 * ships with the same Node install. If the sibling is missing (some
 * exotic Node install), we pass `npx` through bare — the per-server env
 * merge above carries the captured shell PATH, so the SDK's
 * `cross-spawn` can still find it via PATH lookup.
 *
 * User-supplied absolute paths in manifests (anything not literally
 * `node` or `npx`) are untouched.
 */
export function resolveStdioCommand(command: string): string {
  if (command === "node") return process.execPath;
  if (command === "npx") {
    const sibling = join(dirname(process.execPath), "npx");
    // NIT-4: `existsSync` is not enough — a `.npx` placeholder file or a
    // non-executable script would pass it and then ENOEXEC at spawn time.
    // `accessSync(…, X_OK)` confirms the kernel will let us execute it.
    try {
      accessSync(sibling, fsConstants.X_OK);
      return sibling;
    } catch {
      return command;
    }
  }
  return command;
}

/**
 * FRI-150 (pivot, ADR-037): MCP children get a RESTRICTED subset of the
 * worker's captured shell env — not the full thing. The trust gradient
 * (agent gets shell, MCP gets restricted) is the OpenCode-flavored model
 * documented in ADR-037; the specific allowlist below is bespoke.
 *
 * Rationale per category:
 *
 *   - Process basics (HOME, USER, LOGNAME, TERM, TMPDIR) — SDK already
 *     allowlists most of these, but be explicit so the MCP child gets the
 *     captured-shell values (not the launchd-stripped defaults).
 *   - Locale (LANG, LC_*) — tools that emit dates / sort lists rely on
 *     these and are surprising to debug when missing.
 *   - Toolchain hint roots — node/python/ruby/rust/go/java/jvm/conda
 *     version managers all store their install root in a hint var, and a
 *     spawned MCP that itself shells out (e.g. an MCP written in Python
 *     that needs the user's `pyenv` install) needs the hint.
 *
 * Anything NOT on this list is dropped — including FRIDAY_*, SHELL,
 * any user secret a `.zshrc` might `export`, and the dozens of
 * dotfile-set vars (LANG_*, COLORTERM, ITERM_*, SSH_*, etc.) that have
 * no business being inherited by spawned MCP children.
 *
 * Exported so the ADR + tests can reference + assert against it.
 */
export const MCP_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Process basics (subset / superset of SDK's StdioClientTransport allowlist)
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TERM",
  "TMPDIR",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  // Node / JS toolchain hints
  "NVM_DIR",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "PNPM_HOME",
  "BUN_INSTALL",
  "DENO_INSTALL",
  "VOLTA_HOME",
  // Python / Ruby / Rust / Go / Java / JVM / conda toolchain hints
  "PYENV_ROOT",
  "ASDF_DATA_DIR",
  "RBENV_ROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOROOT",
  "JAVA_HOME",
  "M2_HOME",
  "CONDA_PREFIX",
  "SDKMAN_DIR",
  // Search-path hints used by build tools
  "MANPATH",
  "INFOPATH",
  "PKG_CONFIG_PATH",
]);

/**
 * FRI-150 (pivot, ADR-037): filter a captured-shell env down to the
 * `MCP_ENV_ALLOWLIST` for use as the per-server stdio `env` base. The
 * SDK then does `{...getDefaultEnvironment(), ...config.env}`; our
 * restricted output supersedes the SDK's HOME/PATH/SHELL/LOGNAME/TERM/
 * USER allowlist with values from the worker's captured shell.
 *
 * Anything not on the allowlist is dropped — daemon-internal vars
 * (FRIDAY_*), user-shell-set secrets (`export GITHUB_TOKEN=…` in
 * .zshrc), and unmodeled environment-leak surfaces.
 */
export function restrictedMcpEnv(captured: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const v = captured[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * Return the per-spawn restricted env base from the worker's captured
 * shell. Called by every stdio entry point; manifest env wins on top
 * via the caller's spread.
 */
function shellEnvForStdio(): Record<string, string> {
  return restrictedMcpEnv(getResolvedShellEnv().env);
}

export const BROWSER_SERVER_NAME = "playwright";

/** Names that user config cannot use (built-in stdio MCPs). The `friday-`
 * prefix check covers all in-process built-ins separately. */
const RESERVED_NAMES = new Set<string>([BROWSER_SERVER_NAME]);
