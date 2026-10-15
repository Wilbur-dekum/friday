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
  it("mirrors in a container", () => {
    expect(resolveMirrorToStdout(undefined, true)).toBe(true);
  });

  it("does not mirror under launchd, where the plist already captures stdout", () => {
    expect(resolveMirrorToStdout(undefined, false)).toBe(false);
  });

  it("honours an explicit `on` outside a container", () => {
    expect(resolveMirrorToStdout("on", false)).toBe(true);
  });

  it("honours an explicit `off` inside a container", () => {
    // The escape hatch matters: a container operator shipping logs by some
    // other route must be able to silence the duplicate stream.
    expect(resolveMirrorToStdout("off", true)).toBe(false);
  });

  it("treats an unrecognised value as unset rather than truthy", () => {
    expect(resolveMirrorToStdout("yes", false)).toBe(false);
    expect(resolveMirrorToStdout("", true)).toBe(true);
  });
});

describe("resolveMirrorToStdout — FRI-2006 regression", () => {
  it("does not depend on being PID 1", () => {
    // Adding `init: true` put tini at PID 1 and moved the supervisor to PID 7,
    // which silently switched stdout logging off and undid FRI-2053 with no
    // error anywhere. The signal must survive a reshuffled process tree.
    expect(resolveMirrorToStdout(undefined, true)).toBe(true);
  });
});
