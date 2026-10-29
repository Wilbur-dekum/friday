/**
 * FRI-123: `buildSystemPrompt(agentRow)` — single source of truth for
 * "render an agent's base system prompt." Pulls the prompt stack,
 * renders pinned facts (FRI-61), and threads both through
 * `composeSystemPrompt` from `@friday/shared`.
 *
 * Two callers:
 *   - The watchdog refork notice path (`agent/watchdog.ts`) which
 *     dispatches without an intent — no `before_prompt_build` hooks
 *     fire, so this entry point is used directly.
 *   - `buildDispatchPrompt` (sibling file) for every other call
 *     site, which then runs the hook pipeline on top of this base.
 *
 * Replaces the duplicated 12-line incantation
 * (`readPromptStack` + `renderPinnedFacts` + `composeSystemPrompt`)
 * that was repeated at 10 call sites in the daemon. Site classification
 * + the `DispatchIntent` union lives in `intent.ts`.
 */

import { composeSystemPrompt, readPromptStack, type AgentBaseKey } from "@friday/shared";
import { listPinnedForAgent } from "@friday/memory";

/**
 * Narrow shape accepted by both `buildSystemPrompt` and
 * `buildDispatchPrompt`. Structurally satisfied by `AgentEntry`
 * (registry rows) and by the POST-body shape of `POST /api/agents`
 * for the spawn path — no caller has to construct a synthetic
 * `AgentEntry`.
 */
export interface PromptAgentRow {
  name: string;
  type: AgentBaseKey;
  parentName?: string;
}

/**
 * Render pinned facts (FRI-61) into a `# Pinned facts` section, or
 * the empty string when the agent has no pins. Internal helper —
 * folded from the deleted `agent/pinned-facts.ts` (the renderer was
 * called only via `composeSystemPrompt`'s `pinnedFacts` slot, so it
 * belongs inside the system-prompt builder now).
 */
async function renderPinnedFacts(agentName: string): Promise<string> {
  const pins = await listPinnedForAgent(agentName);
  if (pins.length === 0) return "";
  return [
    "# Pinned facts",
    "",
    "Authoritative facts pinned for this agent. Treat as ground truth; do not re-derive or ask.",
    "",
    ...pins.map((p) => `- **${p.title}**: ${p.content.trim()}`),
  ].join("\n");
}

export interface BuiltSystemPrompt {
  systemPrompt: string;
}

export async function buildSystemPrompt(agentRow: PromptAgentRow): Promise<BuiltSystemPrompt> {
  const stack = readPromptStack(agentRow.type, []);
  const pinnedFacts = await renderPinnedFacts(agentRow.name);
  const systemPrompt = composeSystemPrompt(
    stack,
    {
      agentName: agentRow.name,
      agentType: agentRow.type,
      parentName: agentRow.parentName,
    },
    pinnedFacts,
  );
  return { systemPrompt };
}
