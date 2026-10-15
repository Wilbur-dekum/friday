/**
 * FRI-2010 — where the age identity comes from.
 *
 * Containerising `.age-key` would put the decryption key on the same volume as
 * the `vault.enc` it decrypts (ADR-051). These pin the precedence that lets it
 * arrive at runtime instead, and — just as important — that a laptop with
 * neither env var set still reads the same file it always did.
 */

import { describe, expect, it } from "vitest";
import { selectAgeIdentity } from "./age.js";

describe("selectAgeIdentity", () => {
  it("falls back to disk when nothing is injected — the laptop case", () => {
    expect(selectAgeIdentity({ diskContents: "AGE-SECRET-KEY-DISK" })).toEqual({
      identity: "AGE-SECRET-KEY-DISK",
      source: "disk",
    });
  });

  it("prefers the env identity over disk", () => {
    expect(
      selectAgeIdentity({ envIdentity: "AGE-SECRET-KEY-ENV", diskContents: "AGE-SECRET-KEY-DISK" }),
    ).toEqual({ identity: "AGE-SECRET-KEY-ENV", source: "env" });
  });

  it("prefers a mounted file over disk", () => {
    expect(
      selectAgeIdentity({
        fileContents: "AGE-SECRET-KEY-FILE",
        diskContents: "AGE-SECRET-KEY-DISK",
      }),
    ).toEqual({ identity: "AGE-SECRET-KEY-FILE", source: "file" });
  });

  it("prefers env over a mounted file when both are set", () => {
    expect(
      selectAgeIdentity({
        envIdentity: "AGE-ENV",
        fileContents: "AGE-FILE",
        diskContents: "AGE-DISK",
      }),
    ).toEqual({ identity: "AGE-ENV", source: "env" });
  });

  it("trims surrounding whitespace — a mounted secret usually has a trailing newline", () => {
    expect(selectAgeIdentity({ fileContents: "AGE-SECRET-KEY-FILE\n" })?.identity).toBe(
      "AGE-SECRET-KEY-FILE",
    );
  });

  it("treats an empty or whitespace-only source as absent, not as an identity", () => {
    // An empty mounted file must fall through to disk rather than becoming a
    // blank identity that fails decryption with a confusing error.
    expect(selectAgeIdentity({ fileContents: "   \n", diskContents: "AGE-DISK" })).toEqual({
      identity: "AGE-DISK",
      source: "disk",
    });
    expect(selectAgeIdentity({ envIdentity: "", diskContents: "AGE-DISK" })?.source).toBe("disk");
  });

  it("returns undefined when there is no identity anywhere", () => {
    expect(selectAgeIdentity({})).toBeUndefined();
  });
});
