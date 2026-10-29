/**
 * FRI-123: `buildDispatchPrompt(agentRow, intent)` — the single
 * entry point for "compose a system prompt + dispatch body for this
 * agent under this intent." Collapses the prior duplicated 12-line
 * prompt-assembly incantation (stack read + pinned-facts render +
 * system-prompt compose + hook-driven dispatch wrap) that was at 8
 * LIVE call sites.
 *
 * Pipeline:
 *   1. Base system prompt — `buildSystemPrompt(agentRow)`, OR
 *      `intent.baseSystemPromptOverride` verbatim when set
 *      (`agent_spawn` path threads the `agent:bootstrap`-augmented
 *      base through this slot; the bootstrap hook is workspace /
 *      lifecycle scope and stays caller-side).
 *   2. Pick `intentTag`, `intentText` (recall payload), and `body`
 *      (worker prompt argument) from the `DispatchIntent` variant —
 *      the union shape encodes which fields exist per kind.
 *   3. `runHooks('before_prompt_build')` — `memoryRecallHook` +
 *      `skillContextHook` are the live consumers. Hook results
 *      stitch into `{ systemPrompt, body, allowedToolsOverride }`.
 *
 * Hook handlers register from `services/daemon/src/hooks/register.ts`;
 * `memoryRecallHook` lives in this directory (sibling), `skillContextHook`
 * stays under `hooks/` (skill concern, not prompt concern).
 */

import { runHooks, type ActingUser, type SkillMatch } from "@friday/shared";
import { buildSystemPrompt, type PromptAgentRow } from "./build-system-prompt.js";
import type { DispatchIntent } from "./intent.js";

export interface BuiltDispatchPrompt {
  systemPrompt: string;
  body: string;
  allowedToolsOverride?: string[];
}

interface ResolvedIntent {
  intentTag: "user_chat" | "mail" | "scheduled" | "scratch" | "agent_spawn" | "compact";
  intentText: string;
  body: string;
  skillMatch?: SkillMatch;
}

export function resolveIntent(intent: DispatchIntent): ResolvedIntent {
  switch (intent.kind) {
    case "user_chat": {
      // Skill-detected variants already pre-stripped userText to the
      // args portion (the caller calls `matchSkillInvocation` before
      // building the intent); recall + body both use that.
      const text = intent.userText;
      return {
        intentTag: "user_chat",
        intentText: text,
        body: text,
        skillMatch: intent.skillMatch,
      };
    }
    case "mail":
      // Recall queries the raw concatenated mail bodies (semantic
      // signal); the worker receives the pre-formatted mail prompt
      // (mail headers + bodies, built by `comms/mail-prompt.ts`).
      return {
        intentTag: "mail",
        intentText: intent.intentText,
        body: intent.body,
      };
    case "scheduled":
      // Recall queries the raw task prompt (state.md scaffolding
      // would otherwise noise the memory query); the worker receives
      // the first-turn-with-state stitched body.
      return {
        intentTag: "scheduled",
        intentText: intent.intentText,
        body: intent.body,
      };
    case "scratch":
      return {
        intentTag: "scratch",
        intentText: intent.userText,
        body: intent.userText,
      };
    case "compact":
      // FRI-156 §B/§C: the body is the native `/compact` slash command
      // (leading slash is load-bearing — the SDK's claude_code preset
      // interprets it as compaction). `intentText` is empty so `memoryRecallHook`
      // has nothing to query even before its `intentTag === "compact"`
      // early-return, and the recall pollution a /compact turn would otherwise
      // cause never happens.
      return {
        intentTag: "compact",
        intentText: "",
        body: `/compact ${intent.instructions}`,
      };
    case "agent_spawn": {
      // FRI-127 §4: wrap the spawn body with a mail-back trailer naming the
      // parent so the child closes the loop. The recall payload (intentText)
      // stays the raw task text — the wrapper would otherwise noise the
      // memory query. The orphan case (no parentName) keeps the body
      // unchanged.
      const wrapped = intent.parentName
        ? `${intent.userText}\n\n---\n\n**When you finish, mail your parent \`${intent.parentName}\` with the result (\`mail_send({to: "${intent.parentName}", body: …})\`). Without that mail your parent never learns you're done.**`
        : intent.userText;
      return {
        intentTag: "agent_spawn",
        intentText: intent.userText,
        body: wrapped,
      };
    }
  }
}

/**
 * FRI-2016: `actingUser` is the User this turn runs on behalf of, threaded
 * through to prompt assembly so Friday can address whoever is speaking
 * (ADR-052) and tools can stamp the actor (ADR-053). Absent for every
 * non-human trigger — schedules, mail, `agent_spawn`.
 *
 * Note the `agent_spawn` branch below: a spawn override supplies its own base
 * system prompt, so the acting-User block does NOT appear there. That is
 * correct — a spawned Builder is working on behalf of its parent agent, not
 * conversing with a person — but it means "the prompt always names the User"
 * is NOT an invariant. Do not write downstream code that assumes it.
 */
export async function buildDispatchPrompt(
  agentRow: PromptAgentRow,
  intent: DispatchIntent,
  actingUser?: ActingUser,
): Promise<BuiltDispatchPrompt> {
  const baseSystemPrompt =
    intent.kind === "agent_spawn" && intent.baseSystemPromptOverride !== undefined
      ? intent.baseSystemPromptOverride
      : (await buildSystemPrompt(agentRow)).systemPrompt;

  const resolved = resolveIntent(intent);

  const results = await runHooks("before_prompt_build", {
    intent: resolved.intentText,
    intentTag: resolved.intentTag,
    body: resolved.body,
    agentType: agentRow.type,
    skillMatch: resolved.skillMatch,
    // FRI-2016 (reversal): the acting User rides the PER-TURN body via
    // `actingUserHook`, not the system prompt. The system prompt is
    // materialized once per worker fork and frozen across resume, while the
    // speaker varies turn to turn — see renderActingUserBlock.
    actingUser,
  });

  let body = resolved.body;
  let systemPrompt = baseSystemPrompt;
  let allowedToolsOverride: string[] | undefined;
  for (const r of results) {
    if (r.prependBody) body = `${r.prependBody}\n\n${body}`;
    if (r.appendSystemPrompt) {
      systemPrompt = `${systemPrompt}\n\n${r.appendSystemPrompt}`;
    }
    if (r.allowedToolsOverride) allowedToolsOverride = r.allowedToolsOverride;
  }
  return { body, systemPrompt, allowedToolsOverride };
}
