import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  renderActingUserBlock,
  type ActingUser,
  type PromptStack,
} from "./loader.js";

/**
 * FRI-2016 — the acting User reaches prompt assembly.
 *
 * Before this, `buildSystemPrompt`/`buildDispatchPrompt` took only an agent
 * row and an intent, so no user id reached the prompt at all even though
 * `blocks.user_id` was sitting on the originating row.
 */

const USER: ActingUser = {
  id: "nWFTfk2C2H2vLbxktOq3bteNYncT6xpw",
  name: "Ada",
  email: "ada@example.com",
};

const STACK: PromptStack = {
  constitution: "CONSTITUTION",
  soul: "SOUL",
  agentBase: "AGENT_BASE",
  protocols: "PROTOCOLS",
};

describe("renderActingUserBlock", () => {
  it("names the person and carries the id verbatim", () => {
    const out = renderActingUserBlock(USER);
    expect(out).toContain("Ada");
    expect(out).toContain("ada@example.com");
    // The id is what tools stamp for ADR-053's audit and erasure obligations,
    // so it must be present rather than inferable from the email.
    expect(out).toContain(USER.id);
  });

  it("warns against assuming a single User", () => {
    // The failure this guards against is Friday treating one Organization as
    // one person once E2 adds members — attributing someone else's history to
    // whoever happens to be speaking.
    expect(renderActingUserBlock(USER)).toMatch(/not assume they are the only User/i);
  });
});

describe("composeSystemPrompt with an acting User", () => {
  it("places the block after the agent's own identity", () => {
    const out = composeSystemPrompt(
      STACK,
      { agentName: "friday", agentType: "orchestrator" },
      undefined,
      USER,
    );
    const identityAt = out.indexOf("# Identity");
    const userAt = out.indexOf("# Who you are speaking with");
    const baseAt = out.indexOf("AGENT_BASE");
    expect(identityAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(identityAt);
    // ...and before the agent-type instructions, which may refer to either.
    expect(baseAt).toBeGreaterThan(userAt);
  });

  it("omits the block entirely when there is no acting User", () => {
    // A scheduled run, a mail-triggered turn and an agent_spawn have no human
    // behind them. That is a normal turn, so it must not render an "unknown
    // user" placeholder the model could then talk about.
    const out = composeSystemPrompt(STACK, { agentName: "friday", agentType: "orchestrator" });
    expect(out).not.toContain("# Who you are speaking with");
    expect(out).not.toMatch(/unknown/i);
  });

  it("still composes the rest of the stack in canonical order", () => {
    const out = composeSystemPrompt(
      STACK,
      { agentName: "friday", agentType: "orchestrator" },
      "# Pinned facts\n\n- x",
      USER,
    );
    const order = [
      "CONSTITUTION",
      "SOUL",
      "# Identity",
      "# Who you are speaking with",
      "# Pinned facts",
      "AGENT_BASE",
      "PROTOCOLS",
    ].map((s) => out.indexOf(s));
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
