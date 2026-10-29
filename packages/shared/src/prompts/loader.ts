import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOUL_PATH } from "../config.js";
import { loadFridayConfig } from "../env.js";

/**
 * Find the bundled prompts directory. At runtime we live at
 * `dist/prompts/loader.js`; the markdown files were copied into `dist/prompts/`
 * by the build's post-step. In tests we run from `src/prompts/loader.ts`.
 */
function bundledPromptsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Same dir contains the .md files (they sit alongside this loader).
  return here;
}

export interface PromptStack {
  /** CONSTITUTION.md — inviolate rules, all agents. */
  constitution: string;
  /** SOUL.md — identity, user-overridable. */
  soul: string;
  /** agents/<type>.md — per-role behavior. */
  agentBase: string;
  /** Concatenated protocols/*.md the agent's type opts into. */
  protocols: string;
}

export type AgentBaseKey = "orchestrator" | "builder" | "helper" | "scheduled" | "bare" | "planner";

/**
 * Protocols loaded automatically for an agent type, regardless of the
 * `protocolNames` argument passed to `readPromptStack`. Memory is system
 * capability — every agent that can write to the memory store needs the
 * framework. Builders are read-only and helpers are scoped, so they pick up
 * memory recall behavior from their own agent prompts without the full
 * save-side guidance.
 *
 * `pr-links` loads unconditionally for every type (FRI-131): any agent whose
 * output can reach a human through the dashboard markdown renderer should emit
 * GitHub PR/issue references as clickable markdown links rather than bare
 * `#123` text. It is intentionally NOT env-gated — Friday has no daemon-level
 * "GitHub is in use" signal (no `GH_TOKEN`/`GITHUB_TOKEN` is read anywhere), so
 * gating on a never-set var would mean the fragment never loads. The fragment
 * self-guards instead: it tells the agent to fall back to bare `#123` when
 * `gh`/`git remote` fails (no GitHub remote), so it is harmless to carry for an
 * agent on a repo with no GitHub origin.
 */
const DEFAULT_PROTOCOLS_BY_TYPE: Record<AgentBaseKey, readonly string[]> = {
  // FRI-152: `elicitation` (mcp__friday-elicitation__ask_user) loads for
  // every type that ships the MCP server. Match `buildMcpServers` in
  // `services/daemon/src/mcp/builder.ts`: orchestrator + scheduled +
  // bare. Builders/helpers are headless and don't prompt the user.
  orchestrator: ["memory", "pr-links", "elicitation"],
  scheduled: ["memory", "pr-links", "elicitation"],
  builder: ["pr-links"],
  helper: ["pr-links"],
  bare: ["memory", "pr-links", "elicitation"],
  // FRI-16: planners research deeply and save what they learn; they don't
  // ship the elicitation MCP server (questions go to the parent via mail).
  planner: ["memory", "pr-links"],
};

/**
 * Protocols that load only when their backing integration is configured at the
 * daemon level. Keeps the system prompt for agents on a fresh install lean —
 * if a user never sets `LINEAR_API_KEY`, they don't carry Linear lifecycle
 * guidance into every turn.
 *
 * FRI-150 (pivot, ADR-037): reads via `loadFridayConfig()` instead of
 * `process.env` so the prompt stack reflects the loaded config object,
 * not whatever happens to be in the inherited process tree.
 */
function envGatedProtocols(): string[] {
  const protocols: string[] = [];
  if (loadFridayConfig().linearApiKey) protocols.push("linear");
  return protocols;
}

export function readPromptStack(
  agentType: AgentBaseKey,
  protocolNames: string[] = [],
): PromptStack {
  const dir = bundledPromptsDir();
  const constitution = readFileSync(join(dir, "CONSTITUTION.md"), "utf8");
  const soul = readSoul();
  const agentBase = readFileSync(join(dir, "agents", `${agentType}.md`), "utf8");
  // Merge type-default protocols with env-gated and caller-requested ones,
  // dedup, preserve order. Env-gated protocols sit between type-defaults and
  // caller-requested so that explicit caller overrides still win on position.
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const name of [
    ...DEFAULT_PROTOCOLS_BY_TYPE[agentType],
    ...envGatedProtocols(),
    ...protocolNames,
  ]) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  const protocols = merged
    .map((name) => {
      const p = join(dir, "protocols", `${name}.md`);
      return existsSync(p) ? readFileSync(p, "utf8") : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  return { constitution, soul, agentBase, protocols };
}

export interface AgentIdentity {
  agentName: string;
  agentType: AgentBaseKey;
  parentName?: string;
}

/**
 * Identity preamble. Anchors the child on its literal name + parent name so it
 * never has to guess "who am I, who spawned me" — semantic substitutions like
 * `mail_send({to: "orchestrator"})` (a role, not a name) get dropped silently.
 * See FRI-11.
 */
export function renderIdentityBlock(identity: AgentIdentity): string {
  const lines: string[] = ["# Identity"];
  lines.push(`- Your agent name is \`${identity.agentName}\`.`);
  lines.push(`- Your agent type is \`${identity.agentType}\`.`);
  if (identity.parentName) {
    lines.push(`- Your parent agent is named \`${identity.parentName}\`.`);
    lines.push(
      `- To send mail back, use \`mail_send({to: "${identity.parentName}", ...})\` — or the symbolic \`mail_send({to: "parent", ...})\`. Never use role names like \`orchestrator\`, \`builder\`, \`helper\` — the daemon will reject them.`,
    );
  } else {
    lines.push(
      "- You have no parent agent. Mail recipients must be literal agent names (run `agent_list` to discover them).",
    );
  }
  return lines.join("\n");
}

/**
 * The **User** on whose behalf this turn is running (FRI-2016, ADR-052/053).
 *
 * `undefined` is a real and permanent case, not a gap to be filled later: a
 * scheduled run, a mail-triggered turn and an `agent_spawn` have no human
 * behind them. Code downstream must treat "no acting User" as normal rather
 * than as missing data — including ADR-053's role gate, where absent means
 * "not a User action" and not "allow".
 */
export interface ActingUser {
  id: string;
  /** Both NOT NULL on the `user` table, so neither is optional here. */
  name: string;
  email: string;
}

/**
 * Tell the agent who is speaking, as a PER-TURN block.
 *
 * ADR-052 wants Friday to address whoever is actually talking rather than a
 * generic "the user" — which matters the moment an Organization has more than
 * one member, and again per-Transport, where the same person arrives over
 * Slack and the web dashboard.
 *
 * FRI-2016 (reversal, before merge): this is NOT composed into the system
 * prompt. The daemon never re-sends a system prompt to a live worker —
 * `WorkerPromptCommand` has no `systemPrompt` field and `dispatchTurn`'s
 * live-worker branch does not carry one — so anything in the system prompt is
 * materialized once per worker FORK and frozen for every later turn of that
 * worker, including across `resume`. A long-lived orchestrator forked while
 * Ada was speaking would keep telling the model it is speaking with Ada after
 * Bob takes over: precisely the misattribution this block exists to prevent.
 *
 * This repo has made and reversed that mistake twice already — FRI-89 moved
 * memory recall off `systemPrompt.append`, FRI-167 did the same for the
 * datetime line. Both ride the per-turn body channel instead, which is a fresh
 * user message every turn and therefore resume-proof. So does this.
 *
 * Tagged like `<memory-context>` rather than headed like `# Identity`, because
 * the envelope is what signals "per-turn context" instead of "another element
 * of the prompt stack".
 *
 * The id is included deliberately. It is what tools stamp for the audit and
 * erasure obligations in ADR-053, so the agent must be able to name it without
 * inferring it from an email address.
 */
export function renderActingUserBlock(user: ActingUser): string {
  return [
    `<acting-user id="${user.id}">`,
    `You are speaking with ${user.name} <${user.email}>.`,
    `Use the id \`${user.id}\` verbatim when a tool asks which User acted.`,
    "Address this person directly. Do not assume they are the only User, and do not attribute their requests, preferences or history to anyone else.",
    "</acting-user>",
  ].join("\n");
}

/**
 * Compose the system prompt in the canonical order:
 *   1. CONSTITUTION
 *   2. SOUL
 *   3. Identity (when provided — FRI-11)
 *   4. Pinned facts (when provided — FRI-61; daemon-rendered from per-agent
 *      pinned memories)
 *   5. agents/<type>
 *   6. protocols/*
 *
 * Current datetime is NOT included here — it is appended inline in
 * worker.ts `runQuery` (FRI-52) so every turn carries the live time,
 * not the session-start time. This covers spawn turns, subsequent turns,
 * and mail-initiated turns inside long-lived workers uniformly.
 */
export function composeSystemPrompt(
  stack: PromptStack,
  identity?: AgentIdentity,
  pinnedFacts?: string,
): string {
  const identityBlock = identity ? renderIdentityBlock(identity) : "";
  // NOTE: the acting User is deliberately NOT here — see renderActingUserBlock.
  // The system prompt is fork-time only, and the speaker varies per turn.
  return [
    stack.constitution,
    stack.soul,
    identityBlock,
    pinnedFacts ?? "",
    stack.agentBase,
    stack.protocols,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * Build a human-readable current local date-and-time block for injection
 * into the system prompt. Derived from the system timezone at call time so
 * every new agent turn gets a fresh value.
 *
 * Format: "Friday, May 23 2026, 9:45 PM PDT (UTC-7)"
 */
function buildLocalDatetimeCore(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(now);
  const p: Record<string, string> = {};
  for (const { type, value } of parts) {
    p[type] = value;
  }
  // getTimezoneOffset() returns minutes *behind* UTC; negate for standard sign.
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMinutes);
  const hh = Math.floor(absMin / 60);
  const mm = absMin % 60;
  const offset = mm > 0 ? `UTC${sign}${hh}:${String(mm).padStart(2, "0")}` : `UTC${sign}${hh}`;
  const datetime = `${p.weekday}, ${p.month} ${p.day} ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod} ${p.timeZoneName} (${offset})`;
  return datetime;
}

export function renderLocalDatetime(): string {
  return `# currentDateTime\nCurrent local date and time: ${buildLocalDatetimeCore()}`;
}

/**
 * Single-line variant of the local date-and-time, wrapped in a `<current-time>`
 * tag for inline injection at the head of a per-turn user body. Contains no
 * newline so it composes cleanly with the turn prompt.
 */
export function renderLocalDatetimeLine(): string {
  return `<current-time>${buildLocalDatetimeCore()}</current-time>`;
}

/** First-boot copy: if ~/.friday/SOUL.md doesn't exist, install the default.
 *  Substitutes `{{YOUR_NAME}}` with the shell user's capitalized login name
 *  (e.g. `seth` → `Seth`) so the Address rule lands ready-to-use. Personal
 *  SOULs are never touched after first boot — the user owns the file. */
export function ensureSoul(): void {
  if (existsSync(SOUL_PATH)) return;
  const dir = bundledPromptsDir();
  const defaultSoul = readFileSync(join(dir, "fragments", "soul.default.md"), "utf8");
  const personalized = defaultSoul.replaceAll("{{YOUR_NAME}}", deriveUserName());
  writeFileSync(SOUL_PATH, personalized);
}

function deriveUserName(): string {
  const raw = process.env.USER || process.env.USERNAME || "";
  if (!raw) return "the user";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function readSoul(): string {
  if (existsSync(SOUL_PATH)) return readFileSync(SOUL_PATH, "utf8");
  // Fallback to bundled default.
  const dir = bundledPromptsDir();
  return readFileSync(join(dir, "fragments", "soul.default.md"), "utf8");
}
