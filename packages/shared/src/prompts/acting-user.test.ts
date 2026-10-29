import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  renderActingUserBlock,
  type ActingUser,
  type PromptStack,
} from "./loader.js";

/**
 * FRI-2016 — the acting User reaches the turn.
 *
 * The first implementation composed this into the SYSTEM prompt, which is
 * wrong for a reason this repo has already hit twice (FRI-89 memory recall,
 * FRI-167 datetime): the daemon never re-sends a system prompt to a live
 * worker, so it is materialized once per worker fork and frozen across
 * `resume`. A long-lived orchestrator would keep naming whoever forked it.
 *
 * It now rides the per-turn body channel. These tests pin that.
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

  it("is a tagged per-turn envelope, not a prompt-stack heading", () => {
    // `<memory-context>` and `<skill-context>` are the in-repo precedent for
    // per-turn blocks. A `# Heading` would read as a peer of `# Identity` —
    // i.e. as a system-prompt stack element, which is exactly the shape this
    // block must not have.
    const out = renderActingUserBlock(USER);
    expect(out.startsWith("<acting-user")).toBe(true);
    expect(out.trimEnd().endsWith("</acting-user>")).toBe(true);
    expect(out).not.toMatch(/^#/m);
  });
});

describe("composeSystemPrompt", () => {
  it("never contains the acting User — the system prompt is fork-time only", () => {
    // THE regression test. `WorkerPromptCommand` has no `systemPrompt` field
    // and `dispatchTurn`'s live-worker branch does not carry one, so anything
    // here is frozen for the life of the worker while the speaker varies per
    // turn. If a future change threads a user into this function, this fails.
    const out = composeSystemPrompt(STACK, { agentName: "friday", agentType: "orchestrator" });
    expect(out).not.toContain("acting-user");
    expect(out).not.toContain("Ada");
    expect(out).not.toContain(USER.id);
  });

  it("still composes the rest of the stack in canonical order", () => {
    const out = composeSystemPrompt(
      STACK,
      { agentName: "friday", agentType: "orchestrator" },
      "# Pinned facts\n\n- x",
    );
    const order = [
      "CONSTITUTION",
      "SOUL",
      "# Identity",
      "# Pinned facts",
      "AGENT_BASE",
      "PROTOCOLS",
    ].map((s) => out.indexOf(s));
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
