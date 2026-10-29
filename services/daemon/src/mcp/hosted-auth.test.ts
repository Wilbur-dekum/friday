import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callerFromRequest } from "./host.js";
import { __resetWorkerTokensForTest, mintWorkerToken } from "../agent/worker-tokens.js";

/**
 * FRI-2037: the daemon must DERIVE the caller from the per-worker token and
 * must never fall back to the `x-friday-caller-*` headers a worker sets for
 * itself. A fallback would reinstate the weakness this slice removes — any
 * worker holding the shared daemon secret impersonating any agent.
 */
describe("hosted MCP caller derivation", () => {
  beforeEach(() => __resetWorkerTokensForTest());
  afterEach(() => __resetWorkerTokensForTest());

  it("derives the caller from a minted token", () => {
    const token = mintWorkerToken({ callerName: "builder-7", callerType: "builder" });
    expect(callerFromRequest({ authorization: `Bearer ${token}` }, 7610)).toEqual({
      callerName: "builder-7",
      callerType: "builder",
      daemonPort: 7610,
    });
  });

  it("IGNORES self-asserted caller headers — no fallback path", () => {
    // The regression that matters. Headers alone must not identify anyone,
    // even well-formed ones naming a real agent type.
    expect(
      callerFromRequest(
        { "x-friday-caller-name": "friday", "x-friday-caller-type": "orchestrator" },
        7610,
      ),
    ).toBeNull();
  });

  it("does not let headers override the token's identity", () => {
    // A worker presenting its own valid token must not be able to act as a
    // different agent by also sending headers.
    const token = mintWorkerToken({ callerName: "builder-7", callerType: "builder" });
    const caller = callerFromRequest(
      {
        authorization: `Bearer ${token}`,
        "x-friday-caller-name": "friday",
        "x-friday-caller-type": "orchestrator",
      },
      7610,
    );
    expect(caller?.callerName).toBe("builder-7");
    expect(caller?.callerType).toBe("builder");
  });

  it("rejects forged, malformed and absent authorization", () => {
    expect(callerFromRequest({ authorization: "Bearer deadbeef" }, 7610)).toBeNull();
    expect(callerFromRequest({ authorization: "deadbeef" }, 7610)).toBeNull();
    expect(callerFromRequest({}, 7610)).toBeNull();
  });

  it("accepts the scheme case-insensitively", () => {
    const token = mintWorkerToken({ callerName: "a", callerType: "helper" });
    expect(callerFromRequest({ authorization: `bearer ${token}` }, 7610)?.callerName).toBe("a");
  });
});

/**
 * FRI-2037: `parentName` and `appId` decide which App's reminders and secrets
 * a caller reaches, and who it may spawn and mail. They must come from the
 * mint — as self-asserted headers they would be a privilege escalation.
 */
describe("scoping values are derived, never asserted", () => {
  beforeEach(() => __resetWorkerTokensForTest());
  afterEach(() => __resetWorkerTokensForTest());

  it("carries parentName and appId from the token", () => {
    const token = mintWorkerToken({
      callerName: "app-agent",
      callerType: "helper",
      parentName: "friday",
      appId: "app-alpha",
    });
    expect(callerFromRequest({ authorization: `Bearer ${token}` }, 7610)).toMatchObject({
      parentName: "friday",
      appId: "app-alpha",
    });
  });

  it("ignores a forged appId header — the escalation this closes", () => {
    // A worker minted for app-alpha must not reach app-beta's reminders or
    // secrets by naming it on the request.
    const token = mintWorkerToken({
      callerName: "app-agent",
      callerType: "helper",
      appId: "app-alpha",
    });
    const caller = callerFromRequest(
      { authorization: `Bearer ${token}`, "x-friday-app-id": "app-beta" },
      7610,
    );
    expect(caller?.appId).toBe("app-alpha");
  });

  it("leaves both undefined for a worker minted without them", () => {
    const token = mintWorkerToken({ callerName: "friday", callerType: "orchestrator" });
    const caller = callerFromRequest({ authorization: `Bearer ${token}` }, 7610);
    expect(caller?.appId).toBeUndefined();
    expect(caller?.parentName).toBeUndefined();
  });
});
