import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CLI_CREDENTIAL_KEYS, claudeCodeChildEnv, isSecretKey } from "./shell-env.js";

/**
 * FRI-2059: the Claude Code child's environment.
 *
 * FRI-2012 established where the boundary actually is. The worker carries the
 * full daemon environment on purpose — it is Friday's own code and reaches the
 * database — but the Claude Code child is one level deeper, and its Bash tool
 * runs untrusted repository code. That child was getting raw `process.env`,
 * because the existing sanitizer also strips the Anthropic credentials the CLI
 * cannot start without.
 */

describe("claudeCodeChildEnv", () => {
  it("strips the credentials that reach past the container boundary", () => {
    // Each of these is on the list for a stated reason: the database, the
    // SUPERUSER connection that on a shared cluster reaches every
    // Organization, the identity that decrypts the whole vault, and the agent
    // socket — which is not a credential but authenticates as the operator to
    // every host their keys reach.
    const env = claudeCodeChildEnv({
      DATABASE_URL: "postgres://secret",
      FRIDAY_ADMIN_DATABASE_URL: "postgres://superuser",
      FRIDAY_AGE_IDENTITY: "AGE-SECRET-KEY-1",
      FRIDAY_AGE_IDENTITY_FILE: "/run/secrets/age",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      ZERO_UPSTREAM_DB: "postgres://secret",
      GITHUB_TOKEN: "ghp_xxx",
      BETTER_AUTH_SECRET: "s",
    });
    expect(Object.keys(env)).toEqual([]);
  });

  it("keeps the CLI's own credentials, which it cannot start without", () => {
    const env = claudeCodeChildEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
  });

  it("keeps ordinary variables — this is a deny-list, not an allow-list", () => {
    // Stripping PATH/HOME would break the agent's tools entirely, and the
    // point of FRI-2012's shell capture was that the Bash tool CAN find `gh`
    // and brew binaries.
    const env = claudeCodeChildEnv({ PATH: "/usr/bin", HOME: "/home/friday", LANG: "en_US.UTF-8" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/friday", LANG: "en_US.UTF-8" });
  });

  it("keeps the exception list SHORT, because each entry is exposed to Bash", () => {
    // Whatever the CLI holds, its children inherit — we cannot scrub a process
    // we do not spawn. So every addition here widens what untrusted repository
    // code can read, and a growing list is the signal that it wants to be a
    // credential proxy instead.
    expect(CLAUDE_CLI_CREDENTIAL_KEYS.size).toBeLessThanOrEqual(4);
    // Every exception must be secret-shaped — a non-secret key does not need
    // one, and listing it would hide that the list is doing nothing.
    for (const k of CLAUDE_CLI_CREDENTIAL_KEYS) {
      expect(isSecretKey(k), `${k} is not secret-shaped; it needs no exception`).toBe(true);
    }
  });

  it("drops non-string values rather than passing undefined through", () => {
    expect(claudeCodeChildEnv({ A: undefined, B: "b" })).toEqual({ B: "b" });
  });
});

describe("the worker actually uses it", () => {
  it("does not hand raw process.env to the Claude Code child", () => {
    // A source assertion, deliberately. The behavioural path runs inside the
    // SDK's `query()`, so the cheap way to verify the fix stays applied is to
    // check the call site — and the regression here is silent: the child
    // would simply receive more than it should, with every test still green.
    const src = readFileSync(join(import.meta.dirname, "agent/worker.ts"), "utf8");
    const envOverride = /env: \{ \.\.\.(\w+)\(\), \.\.\.shellEnv \}/.exec(src);
    expect(envOverride, "the child's env override changed shape").not.toBeNull();
    expect(envOverride![1]).toBe("claudeCodeChildEnv");
    expect(src).not.toMatch(/env: \{ \.\.\.process\.env, \.\.\.shellEnv \}/);
  });
});
