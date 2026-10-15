/**
 * FRI-2053 — the supervisor's stdout-mirroring decision.
 *
 * The bug this guards: in a container every log went to a file inside the
 * container and `docker logs` was empty, so the only collectable sink had
 * nothing in it. The fix keys off the supervisor's role rather than a flag
 * someone has to remember to set.
 */

import { describe, expect, it } from "vitest";
import { resolveMirrorToStdout } from "./log-mirror.js";

describe("resolveMirrorToStdout", () => {
  it("mirrors when running as PID 1 — the container case", () => {
    expect(resolveMirrorToStdout(undefined, 1)).toBe(true);
  });

  it("does not mirror under launchd, where the plist already captures stdout", () => {
    expect(resolveMirrorToStdout(undefined, 4242)).toBe(false);
  });

  it("honours an explicit `on` even when not PID 1", () => {
    expect(resolveMirrorToStdout("on", 4242)).toBe(true);
  });

  it("honours an explicit `off` even as PID 1", () => {
    // The escape hatch matters: a container operator shipping logs by some
    // other route must be able to silence the duplicate stream.
    expect(resolveMirrorToStdout("off", 1)).toBe(false);
  });

  it("treats an unrecognised value as unset rather than truthy", () => {
    expect(resolveMirrorToStdout("yes", 4242)).toBe(false);
    expect(resolveMirrorToStdout("", 1)).toBe(true);
  });
});
