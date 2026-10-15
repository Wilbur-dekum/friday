/**
 * FRI-2006 — the launchd-backed verbs must refuse in a container, not no-op.
 *
 * Measured before the fix: inside the compose stack `friday stop` printed
 * "stopping friday stack via launchd" and did nothing. Silently doing nothing
 * is worse than erroring, because the operator believes the stack is stopping.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { refuseInContainer } from "./lifecycle-guard.js";

afterEach(() => vi.restoreAllMocks());

describe("refuseInContainer", () => {
  it("refuses in a container", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(refuseInContainer("stop", true)).toBe(true);
    expect(err).toHaveBeenCalledOnce();
  });

  it("says what to do instead, not just that it failed", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    refuseInContainer("stop", true);
    const msg = err.mock.calls[0][0] as string;
    expect(msg).toContain("docker compose stop");
    // status is the verb that still works; a refusal that leaves the operator
    // with no way to answer "is it running?" is only half an answer.
    expect(msg).toContain("friday status");
  });

  it("is silent and permissive outside a container", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(refuseInContainer("stop", false)).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });

  it("names the verb it refused", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    refuseInContainer("restart", true);
    expect(err.mock.calls[0][0]).toContain("friday restart");
  });
});
