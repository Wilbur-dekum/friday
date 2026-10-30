import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFridayConfigCache } from "../env.js";
import {
  composeSystemPrompt,
  readPromptStack,
  renderIdentityBlock,
  renderLocalDatetime,
  renderLocalDatetimeLine,
} from "./loader.js";

describe("renderIdentityBlock (FRI-11)", () => {
  it("pins the agent's literal name and parent name into the prompt", () => {
    const block = renderIdentityBlock({
      agentName: "mail-routing-parent-child",
      agentType: "builder",
      parentName: "friday",
    });
    expect(block).toContain("`mail-routing-parent-child`");
    expect(block).toContain("`friday`");
    expect(block).toContain('mail_send({to: "friday"');
    expect(block).toContain('mail_send({to: "parent"');
    expect(block).toMatch(/Never use role names/);
  });

  it("omits parent guidance when the agent has no parent", () => {
    const block = renderIdentityBlock({
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(block).toContain("`friday`");
    expect(block).not.toMatch(/Your parent agent/);
    expect(block).toMatch(/no parent agent/);
  });
});

describe("composeSystemPrompt with identity", () => {
  it("builder prompt includes the literal parent name when identity is passed", () => {
    const stack = readPromptStack("builder", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "builder-007",
      agentType: "builder",
      parentName: "friday",
    });
    expect(composed).toContain("# Identity");
    expect(composed).toContain("`builder-007`");
    expect(composed).toContain("Your parent agent is named `friday`");
    expect(composed).toContain("Role: Builder");
  });

  it("helper prompt includes the parent name", () => {
    const stack = readPromptStack("helper", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "helper-1",
      agentType: "helper",
      parentName: "friday",
    });
    expect(composed).toContain("Your parent agent is named `friday`");
  });

  it("bare prompt without parent emits 'no parent agent' line", () => {
    const stack = readPromptStack("bare", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "scratch-1",
      agentType: "bare",
    });
    expect(composed).toMatch(/no parent agent/);
  });

  it("omits the identity block entirely when no identity is provided", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack);
    expect(composed).not.toContain("# Identity");
  });
});

describe("the Builder's GitHub surface is tools, not `gh` (FRI-2078)", () => {
  /**
   * The persona used to prescribe `gh pr create` and `gh pr checks --watch`,
   * which ran on whatever `gh` login existed on the daemon's machine — a
   * credential Friday could not scope, revoke or attribute, and which does
   * not exist at all in a per-task container.
   *
   * Re-adding a `gh` instruction would silently restore that, with nothing
   * failing. Hence this guard: the regression is invisible otherwise.
   */
  const composed = () =>
    composeSystemPrompt(readPromptStack("builder", []), {
      agentName: "builder-1",
      agentType: "builder",
      parentName: "friday",
    });

  it("tells a Builder to use the hosted tools", () => {
    const text = composed();
    expect(text).toContain("pr_create");
    expect(text).toContain("pr_checks");
  });

  it("never tells a Builder to shell out to `gh`", () => {
    // Narrow on purpose: the words "gh" and "GitHub" appear legitimately all
    // over these prompts, so this matches an INSTRUCTION to run the binary.
    expect(composed()).not.toMatch(/\bgh (pr|repo|auth|api|issue)\b/);
  });

  it("states the no-merge rule without naming a command to avoid", () => {
    // "Do NOT run `gh pr merge`" named one route and implied others were
    // fine. There is no merge tool now, so the rule is about the absence.
    const text = composed();
    expect(text).toMatch(/never merge/i);
    expect(text).not.toMatch(/gh pr merge/);
  });
});

describe("SOUL is identity-neutral; orchestrator owns 'You are Friday' (FRI-127)", () => {
  const ORCH_FRAMING = "You are Friday: the user's personal AI orchestrator";

  it.each(["helper", "builder", "bare", "scheduled", "planner"] as const)(
    "%s composed prompt does NOT carry the orchestrator framing",
    (agentType) => {
      const stack = readPromptStack(agentType, []);
      const composed = composeSystemPrompt(stack, {
        agentName: "child-1",
        agentType,
        parentName: "friday",
      });
      expect(composed.includes(ORCH_FRAMING)).toBe(false);
    },
  );

  it("orchestrator composed prompt carries the framing exactly once", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    const occurrences = composed.split(ORCH_FRAMING).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("composeSystemPrompt pinned facts (FRI-61)", () => {
  it("includes the pinned-facts block verbatim between Identity and agentBase", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **repo**: lives at /tmp/test";
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      pinnedFacts,
    );
    expect(composed).toContain(pinnedFacts);
    // Order: Identity must precede pinned-facts, which must precede agentBase.
    const idxIdentity = composed.indexOf("# Identity");
    const idxPinned = composed.indexOf("# Pinned facts");
    const idxAgentBase = composed.indexOf(stack.agentBase);
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPinned).toBeGreaterThan(idxIdentity);
    expect(idxAgentBase).toBeGreaterThan(idxPinned);
  });

  it("omits the pinned-facts block when arg is undefined", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).not.toContain("# Pinned facts");
  });

  it("omits the pinned-facts block when arg is the empty string", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      "",
    );
    expect(composed).not.toContain("# Pinned facts");
  });

  it("renders pinned facts even when identity is omitted", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **x**: y";
    const composed = composeSystemPrompt(stack, undefined, pinnedFacts);
    expect(composed).toContain(pinnedFacts);
  });
});

describe("default protocols by agent type", () => {
  it("orchestrator stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
    expect(stack.protocols).toContain("Saving — make it reflexive");
  });

  it("scheduled stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("scheduled", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
  });

  it("bare stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("bare", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
  });

  it("builder stack does NOT include the memory protocol (builders are read-only)", () => {
    const stack = readPromptStack("builder", []);
    expect(stack.protocols).not.toContain("# Protocol: Memory");
  });

  it("helper stack does NOT include the memory protocol", () => {
    const stack = readPromptStack("helper", []);
    expect(stack.protocols).not.toContain("# Protocol: Memory");
  });

  it("does not duplicate the memory protocol when caller passes it explicitly", () => {
    const stack = readPromptStack("orchestrator", ["memory"]);
    const occurrences = stack.protocols.split("# Protocol: Memory").length - 1;
    expect(occurrences).toBe(1);
  });

  /* ---------------- FRI-16: planner (AC #4) ---------------- */

  it("planner stack auto-includes the memory protocol", () => {
    const stack = readPromptStack("planner", []);
    expect(stack.protocols).toContain("# Protocol: Memory");
  });

  it("planner stack does NOT include the elicitation protocol (questions go to the parent via mail)", () => {
    const stack = readPromptStack("planner", []);
    expect(stack.protocols).not.toContain("# Protocol: Asking the user a structured question");
  });

  it("planner agentBase is the Planner role prompt with the worktree-privilege sentence (AC #10)", () => {
    const stack = readPromptStack("planner", []);
    expect(stack.agentBase).toContain("# Role: Planner");
    expect(stack.agentBase).toContain(
      "You are the only sub-agent type that runs inside the parent's worktree",
    );
  });

  it("planner agentBase pins the handoff workflow literals (AC #17)", () => {
    const { agentBase } = readPromptStack("planner", []);
    expect(agentBase).toContain("/handoff");
    expect(agentBase).toContain("`Read` the tmp file");
    expect(agentBase).toContain("mail_send");
    expect(agentBase).toContain("[handoff] <topic>");
    expect(agentBase).toContain('"handoff"');
    expect(agentBase).toContain('"normal"');
  });

  it("planner agentBase does not claim the elicitation/ask_user surface (AC #10b)", () => {
    const { agentBase } = readPromptStack("planner", []);
    expect(agentBase).not.toContain("ask_user");
  });
});

describe("pr-links protocol (FRI-131, Option A — unconditional)", () => {
  const PR_LINKS_HEADER = "# Protocol: PR & Issue Links";

  // AC#2 — fragment loads for every agent type, with NO env precondition.
  it.each(["orchestrator", "builder", "helper", "scheduled", "bare", "planner"] as const)(
    "%s stack auto-includes the pr-links protocol",
    (agentType) => {
      const stack = readPromptStack(agentType, []);
      expect(stack.protocols).toContain(PR_LINKS_HEADER);
    },
  );

  // AC#3 — unconditional (no GitHub env) AND the builder-excludes-memory
  // invariant is untouched.
  it("loads for builder with no GitHub-related env, and does not regress the builder-excludes-memory invariant", () => {
    const hadGhToken = process.env.GH_TOKEN;
    const hadGithubToken = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const stack = readPromptStack("builder", []);
      // Unconditional: present even with no GitHub signal in the environment.
      expect(stack.protocols).toContain(PR_LINKS_HEADER);
      // Untouched invariant (loader.test.ts:164-169): builders never carry memory.
      expect(stack.protocols).not.toContain("# Protocol: Memory");
    } finally {
      if (hadGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = hadGhToken;
      if (hadGithubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = hadGithubToken;
    }
  });

  // AC#4 — fragment reaches the composed prompt, positioned last (after agentBase).
  it("reaches the composed prompt and sits after the identity block (protocols are last)", () => {
    const composed = composeSystemPrompt(readPromptStack("orchestrator", []), {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).toContain(PR_LINKS_HEADER);
    expect(composed.indexOf(PR_LINKS_HEADER)).toBeGreaterThan(composed.indexOf("# Identity"));
  });

  // AC#5 — no duplication when the caller also requests it explicitly.
  it("does not duplicate the pr-links protocol when caller passes it explicitly", () => {
    const stack = readPromptStack("orchestrator", ["pr-links"]);
    const occurrences = stack.protocols.split(PR_LINKS_HEADER).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("renderLocalDatetime (FRI-52)", () => {
  beforeEach(() => {
    // Pin to a known instant: 2026-05-23 21:45:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T21:45:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a section headed # currentDateTime", () => {
    const block = renderLocalDatetime();
    expect(block).toMatch(/^# currentDateTime\n/);
  });

  it("contains the label 'Current local date and time:'", () => {
    expect(renderLocalDatetime()).toContain("Current local date and time:");
  });

  it("includes a UTC offset in the form UTC±N", () => {
    expect(renderLocalDatetime()).toMatch(/\(UTC[+-]\d/);
  });

  it("includes an AM or PM marker", () => {
    expect(renderLocalDatetime()).toMatch(/[AP]M/);
  });

  it("includes a timezone abbreviation before the offset", () => {
    // Matches abbreviations like PDT, EST, UTC, IST, etc.
    expect(renderLocalDatetime()).toMatch(/[AP]M [A-Z]{2,5} \(UTC/);
  });
});

describe("renderLocalDatetimeLine (FRI-167)", () => {
  beforeEach(() => {
    // Pin TZ so the exact toBe below is deterministic across machines.
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T17:58:00-07:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("renders the exact single-line tagged form (AC2)", () => {
    expect(renderLocalDatetimeLine()).toBe(
      "<current-time>Monday, June 8 2026, 5:58 PM PDT (UTC-7)</current-time>",
    );
  });

  it("contains no newline and shares its core with renderLocalDatetime (AC1)", () => {
    const line = renderLocalDatetimeLine();
    expect(line.includes("\n")).toBe(false);

    const lineCore = line.replace(/^<current-time>/, "").replace(/<\/current-time>$/, "");
    const blockCore = renderLocalDatetime().replace(
      /^# currentDateTime\nCurrent local date and time: /,
      "",
    );
    expect(lineCore).toBe(blockCore);
    expect(lineCore).toBe("Monday, June 8 2026, 5:58 PM PDT (UTC-7)");
  });
});

describe("composeSystemPrompt datetime injection (FRI-52)", () => {
  it("does NOT include currentDateTime — injected per-turn in worker.ts runQuery, not at compose time", () => {
    const stack = readPromptStack("orchestrator", []);
    const composed = composeSystemPrompt(stack, {
      agentName: "friday",
      agentType: "orchestrator",
    });
    expect(composed).not.toContain("# currentDateTime");
    expect(composed).not.toContain("Current local date and time:");
  });

  it("pinned-facts still appears after identity when datetime is absent", () => {
    const stack = readPromptStack("orchestrator", []);
    const pinnedFacts = "# Pinned facts\n\n- **x**: y";
    const composed = composeSystemPrompt(
      stack,
      { agentName: "friday", agentType: "orchestrator" },
      pinnedFacts,
    );
    const idxIdentity = composed.indexOf("# Identity");
    const idxPinned = composed.indexOf("# Pinned facts");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxPinned).toBeGreaterThan(idxIdentity);
    expect(composed).not.toContain("# currentDateTime");
  });
});

describe("env-gated protocols (FRI-86)", () => {
  // FRI-150 (pivot, ADR-037): production code reads LINEAR_API_KEY via
  // `loadFridayConfig()`. Drive presence/absence via `process.env` override
  // + `clearFridayConfigCache()` so the next `readPromptStack` sees the new state.
  function setLinearKey(value: string | undefined): void {
    if (value === undefined) {
      delete process.env.LINEAR_API_KEY;
      clearFridayConfigCache();
    } else {
      process.env.LINEAR_API_KEY = value;
      clearFridayConfigCache();
    }
  }

  afterEach(() => {
    setLinearKey(undefined);
  });

  it("orchestrator stack auto-includes the linear protocol when LINEAR_API_KEY is set", () => {
    setLinearKey("test-key");
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).toContain("# Protocol: Linear");
    expect(stack.protocols).toContain("Closes FRI-N");
  });

  it("builder stack auto-includes the linear protocol when LINEAR_API_KEY is set", () => {
    setLinearKey("test-key");
    const stack = readPromptStack("builder", []);
    expect(stack.protocols).toContain("# Protocol: Linear");
  });

  it("omits the linear protocol when LINEAR_API_KEY is unset", () => {
    setLinearKey(undefined);
    const stack = readPromptStack("orchestrator", []);
    expect(stack.protocols).not.toContain("# Protocol: Linear");
  });

  it("does not duplicate the linear protocol when caller passes it explicitly", () => {
    setLinearKey("test-key");
    const stack = readPromptStack("orchestrator", ["linear"]);
    const occurrences = stack.protocols.split("# Protocol: Linear").length - 1;
    expect(occurrences).toBe(1);
  });
});
