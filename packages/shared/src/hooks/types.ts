import type { ActingUser } from "../prompts/loader.js";
import type { Skill } from "../skills.js";

export type HookEvent =
  | "agent:bootstrap"
  | "before_prompt_build"
  | "before_tool_call"
  | "before_compaction";

export interface SkillMatch {
  skill: Skill;
  userText: string;
}

export interface HookContextMap {
  "agent:bootstrap": {
    agentName: string;
    agentType: string;
    workingDirectory: string;
    branch?: string;
    /** FRI-127 §4: the spawning agent's name, threaded so the builder
     *  bootstrap trailer can tell the builder who to mail back. */
    parentName?: string;
    /** FRI-127 §4: the verbatim first-turn prompt the parent spawned this
     *  agent with, so a mail-woken builder retains its original mission
     *  (closes the FRI-71 gap). */
    spawnPrompt?: string;
  };
  before_prompt_build: {
    intent: string;
    intentTag: "user_chat" | "mail" | "scheduled" | "scratch" | "agent_spawn" | "compact";
    body: string;
    agentType: string;
    skillMatch?: SkillMatch;
    /** FRI-2016: the User this turn runs on behalf of, or absent when there is
     *  no human behind it (schedule, mail, agent_spawn). Rides the hook
     *  context so the block lands on the PER-TURN body — the system prompt is
     *  fork-time only, and the speaker varies turn to turn. */
    actingUser?: ActingUser;
  };
  before_tool_call: {
    workspacePath: string;
    toolName: string | undefined;
    toolInput: Record<string, unknown>;
    /** FRI-16: workspace-guard strictness — the planner-vs-builder selector.
     *  `"middle"` (planner inside a builder worktree) loosens Read/Glob/Grep
     *  to anywhere on disk while Write/Edit/Bash containment stays strict;
     *  absent defaults to `"strict"` (builder behavior, byte-identical to
     *  pre-FRI-16). */
    mode?: "strict" | "middle";
  };
  before_compaction: {
    sessionId: string;
    transcriptPath: string;
    trigger: "manual" | "auto";
  };
}

export interface HookResultMap {
  "agent:bootstrap": { appendSystemPrompt?: string };
  before_prompt_build: {
    prependBody?: string;
    appendSystemPrompt?: string;
    allowedToolsOverride?: string[];
  };
  before_tool_call: { deny?: { reason: string } };
  before_compaction: { snapshot?: unknown };
}

export type HookHandler<E extends HookEvent> = (
  ctx: HookContextMap[E],
) => Promise<HookResultMap[E] | void>;
