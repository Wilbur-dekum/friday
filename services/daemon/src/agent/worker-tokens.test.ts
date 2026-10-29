import { afterEach, describe, expect, it } from "vitest";
import {
  __resetWorkerTokensForTest,
  liveWorkerTokenCount,
  mintWorkerToken,
  resolveWorkerToken,
  revokeWorkerToken,
} from "./worker-tokens.js";

/**
 * FRI-2037. The weakness being closed: `callerName`/`callerType` arrived as
 * headers a worker set for itself, so any worker holding the shared daemon
 * secret could claim to be any agent.
 */
afterEach(() => __resetWorkerTokensForTest());

describe("worker tokens", () => {
  it("resolves to the identity the daemon minted it for", () => {
    const t = mintWorkerToken({ callerName: "friday", callerType: "orchestrator" });
    expect(resolveWorkerToken(t)).toMatchObject({
      callerName: "friday",
      callerType: "orchestrator",
    });
  });

  it("stops working the instant the worker exits", () => {
    // The property that made a registry preferable to a signed token: a
    // builder that finished must not keep a usable credential.
    const t = mintWorkerToken({ callerName: "builder-1", callerType: "builder" });
    expect(resolveWorkerToken(t)).not.toBeNull();
    revokeWorkerToken(t);
    expect(resolveWorkerToken(t)).toBeNull();
  });

  it("rejects absent, empty and unknown tokens", () => {
    expect(resolveWorkerToken(undefined)).toBeNull();
    expect(resolveWorkerToken("")).toBeNull();
    expect(resolveWorkerToken("not-a-real-token")).toBeNull();
  });

  it("gives two workers different tokens that cannot impersonate each other", () => {
    const a = mintWorkerToken({ callerName: "a", callerType: "builder" });
    const b = mintWorkerToken({ callerName: "b", callerType: "helper" });
    expect(a).not.toEqual(b);
    expect(resolveWorkerToken(a)?.callerName).toBe("a");
    expect(resolveWorkerToken(b)?.callerName).toBe("b");
    // Revoking one must not disturb the other.
    revokeWorkerToken(a);
    expect(resolveWorkerToken(a)).toBeNull();
    expect(resolveWorkerToken(b)?.callerName).toBe("b");
  });

  it("carries scoping values the worker must not assert for itself", () => {
    // parentName / appId are why friday-agents, friday-reminder and
    // friday-habit are not hosted yet: they must be DERIVED from the mint.
    const t = mintWorkerToken({
      callerName: "app-agent",
      callerType: "helper",
      parentName: "friday",
      appId: "some-app",
    });
    expect(resolveWorkerToken(t)).toMatchObject({ parentName: "friday", appId: "some-app" });
  });

  it("does not leak tokens as workers come and go", () => {
    const ts = [1, 2, 3].map((n) =>
      mintWorkerToken({ callerName: `w${n}`, callerType: "builder" }),
    );
    expect(liveWorkerTokenCount()).toBe(3);
    ts.forEach(revokeWorkerToken);
    expect(liveWorkerTokenCount()).toBe(0);
  });
});
