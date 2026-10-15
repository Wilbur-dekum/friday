/**
 * FRI-2008 — the container signal has to PROPAGATE.
 *
 * The bug this exists to prevent: `process.pid === 1` is only true in the
 * supervisor. The daemon, the dashboard and every forked worker are its
 * descendants, so a pid check is silently false in exactly the processes that
 * need the answer — which is how a container-aware branch can look correct and
 * never fire.
 */

import { describe, expect, it } from "vitest";
import { isContainer } from "./container.js";

describe("isContainer", () => {
  it("is true from the env flag regardless of pid — the propagating case", () => {
    // A worker is never PID 1, which is the whole point.
    expect(isContainer({ FRIDAY_CONTAINER: "1" }, 4242)).toBe(true);
    expect(isContainer({ FRIDAY_CONTAINER: "true" }, 4242)).toBe(true);
  });

  it("falls back to PID 1 when the flag is unset", () => {
    // Covers an image built elsewhere, or a supervisor run by hand.
    expect(isContainer({}, 1)).toBe(true);
    expect(isContainer({}, 4242)).toBe(false);
  });

  it("an explicit 0 wins over PID 1", () => {
    expect(isContainer({ FRIDAY_CONTAINER: "0" }, 1)).toBe(false);
    expect(isContainer({ FRIDAY_CONTAINER: "false" }, 1)).toBe(false);
  });

  it("treats an unrecognised value as unset rather than truthy", () => {
    expect(isContainer({ FRIDAY_CONTAINER: "yes" }, 4242)).toBe(false);
    expect(isContainer({ FRIDAY_CONTAINER: "yes" }, 1)).toBe(true);
  });
});
