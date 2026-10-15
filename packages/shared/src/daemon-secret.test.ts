/**
 * FRI-2009 — how the daemon-secret permission check reacts to a file it did
 * not create.
 *
 * FIX_FORWARD 5.9 made any group/other bit a fatal exit. That is right on a
 * shared machine and wrong for a secret-manager mount, which arrives read-only
 * at 0644 (Kubernetes) or 0444 (Docker secrets) — there the same check is a
 * boot crash-loop whose remedy cannot be followed. These pin both halves so
 * neither regresses into the other.
 */

import { describe, expect, it } from "vitest";
import { classifySecretMode } from "./daemon-secret.js";

describe("classifySecretMode", () => {
  it("accepts 0600", () => {
    expect(classifySecretMode({ perm: 0o600, repaired: false, containerized: false })).toBe("ok");
  });

  it("accepts a loose mode that was successfully repaired", () => {
    // The common case on a writable volume: we own it, so we just fix it.
    expect(classifySecretMode({ perm: 0o644, repaired: true, containerized: false })).toBe("ok");
  });

  it("still refuses to boot on a shared host when it cannot be repaired", () => {
    // The original threat: another OS user reads the secret and impersonates
    // the daemon's clients. Unchanged behaviour.
    expect(classifySecretMode({ perm: 0o644, repaired: false, containerized: false })).toBe(
      "fatal",
    );
  });

  it("warns rather than exiting for a read-only mount in a container", () => {
    // 0644 is how a Kubernetes secret volume lands. Inside a container those
    // bits expose the file to Friday's own processes, not to other tenants —
    // crash-looping the Deployment is worse than the exposure.
    expect(classifySecretMode({ perm: 0o644, repaired: false, containerized: true })).toBe("warn");
  });

  it("treats a world-readable Docker secret (0444) the same way", () => {
    expect(classifySecretMode({ perm: 0o444, repaired: false, containerized: true })).toBe("warn");
    expect(classifySecretMode({ perm: 0o444, repaired: false, containerized: false })).toBe(
      "fatal",
    );
  });

  it("flags group-only exposure, not just world", () => {
    expect(classifySecretMode({ perm: 0o640, repaired: false, containerized: false })).toBe(
      "fatal",
    );
  });

  it("ignores the owner-execute bit, which is not an exposure", () => {
    expect(classifySecretMode({ perm: 0o700, repaired: false, containerized: false })).toBe("ok");
  });
});
