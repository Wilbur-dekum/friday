import { describe, expect, it } from "vitest";
import type { HookContextMap } from "@friday/shared";
import { actingUserHook } from "./acting-user-hook.js";

/**
 * FRI-2016: the acting User must arrive on the PER-TURN body, never the
 * system prompt — the system prompt is materialized once per worker fork and
 * frozen across `resume` (FRI-89 / FRI-167 established this twice already).
 */

function ctx(
  over: Partial<HookContextMap["before_prompt_build"]> = {},
): HookContextMap["before_prompt_build"] {
  return {
    intent: "hello",
    intentTag: "user_chat",
    body: "hello",
    agentType: "orchestrator",
    ...over,
  };
}

describe("actingUserHook", () => {
  it("returns a prependBody block when a User is acting", async () => {
    const out = await actingUserHook(
      ctx({ actingUser: { id: "u_1", name: "Ada", email: "ada@example.com" } }),
    );
    expect(out?.prependBody).toContain("Ada");
    // prependBody, never appendSystemPrompt — that is the whole point.
    expect(out).not.toHaveProperty("appendSystemPrompt");
  });

  it("returns nothing when there is no acting User", async () => {
    // A schedule, a mail trigger or an agent_spawn has no human behind it.
    // Absent must be silent: no block, and specifically no "unknown user"
    // placeholder for the model to talk about.
    expect(await actingUserHook(ctx({ intentTag: "scheduled" }))).toBeUndefined();
    expect(await actingUserHook(ctx({ intentTag: "agent_spawn" }))).toBeUndefined();
    expect(await actingUserHook(ctx())).toBeUndefined();
  });

  it("produces a different block per User, which is why it is per-turn", async () => {
    // Two turns, same worker, different speakers — the case a fork-time
    // system prompt cannot represent at all.
    const a = await actingUserHook(
      ctx({ actingUser: { id: "u_1", name: "Ada", email: "ada@example.com" } }),
    );
    const b = await actingUserHook(
      ctx({ actingUser: { id: "u_2", name: "Bob", email: "bob@example.com" } }),
    );
    expect(a?.prependBody).not.toEqual(b?.prependBody);
    expect(b?.prependBody).toContain("Bob");
    expect(b?.prependBody).not.toContain("Ada");
  });
});
