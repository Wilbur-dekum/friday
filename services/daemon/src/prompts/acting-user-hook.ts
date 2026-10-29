import { renderActingUserBlock, type HookContextMap, type HookResultMap } from "@friday/shared";

/**
 * FRI-2016: inject the acting User as a per-turn body block.
 *
 * A `before_prompt_build` hook rather than a `composeSystemPrompt` argument,
 * for the reason FRI-89 and FRI-167 both established the hard way: the daemon
 * never re-sends a system prompt to a live worker. `WorkerPromptCommand` has
 * no `systemPrompt` field, and `dispatchTurn`'s live-worker branch builds the
 * command without one — so a system-prompt block is materialized once per
 * worker FORK and frozen for every later turn, including across `resume`.
 *
 * The speaker is the canonical per-turn-varying value: ADR-052 keeps ONE
 * Conversation per agent spanning every Transport, so turn N and turn N+1 can
 * come from different Users in the same worker and the same SDK session. In
 * the system prompt, a long-lived orchestrator would keep naming whoever
 * forked it — the exact misattribution the block exists to prevent.
 *
 * Mirrors `memoryRecallHook`, which carries the same reversal note.
 */
export async function actingUserHook(
  ctx: HookContextMap["before_prompt_build"],
): Promise<HookResultMap["before_prompt_build"] | void> {
  // Absent is normal and must be silent: a schedule, a mail trigger or an
  // agent_spawn has no human behind it. No "unknown user" placeholder — that
  // gives the model something to talk about that is not true.
  if (!ctx.actingUser) return;
  return { prependBody: renderActingUserBlock(ctx.actingUser) };
}
