/**
 * FRI-150: shell-env capture behavior tests.
 *
 * Strategy: dependency-inject `spawnImpl` + `existsImpl` so we don't have to
 * mock `node:child_process` globally. The injected spawn returns a minimal
 * `EventEmitter`-shaped child whose stdout/stderr are also `EventEmitter`s,
 * so we can synthesize the same on('data')/on('exit') sequence the real
 * `cross-spawn` / Node spawn produces.
 *
 * Every assertion pins a specific value (env contents, fallback reason,
 * logged event name + fields). No `.not.toThrow()` as sole assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("./log.js", () => ({
  logger: { log: logMock, close: vi.fn() },
}));

const {
  captureShellEnv,
  getResolvedShellEnv,
  isSecretKey,
  sanitizeEnv,
  sanitizedProcessEnvForChild,
  __resetForTests,
  SECRET_LIKE_KEY_RE,
  EXPLICIT_SECRET_KEYS,
} = await import("./shell-env.js");

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
}

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const START = "__FRIDAY_SHELL_ENV_START__";
const END = "__FRIDAY_SHELL_ENV_END__";

function markerPayload(env: Record<string, string>, opts: { noisyPrefix?: string } = {}): string {
  const prefix = opts.noisyPrefix ?? "";
  return `${prefix}\n${START}\n${JSON.stringify(env)}\n${END}\n`;
}

beforeEach(() => {
  __resetForTests();
  logMock.mockClear();
});

afterEach(() => {
  __resetForTests();
});

describe("captureShellEnv — success path", () => {
  it("returns parsed env, source 'shell', logs daemon.shell-env.captured with shell + durationMs + path length", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });

    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        markerPayload({
          PATH: "/Users/me/.local/share/fnm/node-versions/v22.21.1/installation/bin:/usr/bin",
          FNM_DIR: "/Users/me/.local/share/fnm",
          HOME: "/Users/me",
        }),
      );
      child.emit("exit", 0, null);
    });

    const result = await promise;

    expect(result.source).toBe("shell");
    expect(result.shell).toBe("/bin/zsh");
    expect(result.env.PATH).toBe(
      "/Users/me/.local/share/fnm/node-versions/v22.21.1/installation/bin:/usr/bin",
    );
    expect(result.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
    expect(result.fallbackReason).toBeUndefined();
    // NIT-1: dropped the hollow `durationMs >= 0` assertion — replaced with a
    // typeof check in the log-event assertion below, where it actually
    // load-bears.

    // Spawn invoked with `-ilc` for zsh.
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [shellArg, argvArg] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(shellArg).toBe("/bin/zsh");
    expect(argvArg[0]).toBe("-ilc");
    expect(argvArg[1]).toContain(START);
    expect(argvArg[1]).toContain(END);

    // F4: captured event logs shell, durationMs, pathLength, newKeyCount —
    // but NOT the full `path` (the user's whole directory layout shouldn't
    // land in launchd.out.log on every boot).
    const captured = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.captured");
    expect(captured).toBeDefined();
    expect(captured?.[0]).toBe("info");
    expect(captured?.[2]).toMatchObject({
      shell: "/bin/zsh",
      pathLength: result.env.PATH.length,
    });
    expect(captured?.[2]).not.toHaveProperty("path");
    expect(typeof captured?.[2].durationMs).toBe("number");
    expect(typeof captured?.[2].newKeyCount).toBe("number");
  });

  it("uses -ilc flags for bash too", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/bash",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv[0]).toBe("-ilc");
  });

  it("uses -ic flags for tcsh", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/usr/local/bin/tcsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv[0]).toBe("-ic");
  });

  it("uses -Login -Command flags for pwsh", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/usr/local/bin/pwsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv.slice(0, 2)).toEqual(["-Login", "-Command"]);
  });

  it("NIT-2: nushell gets [-i, -l, -c] as separate flags (not joined -ilc, which nu parses as a single unknown flag)", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/opt/homebrew/bin/nu",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
  });

  it("NIT-2: fish gets [-i, -l, -c] as separate flags", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/opt/homebrew/bin/fish",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const [, argv] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(argv.slice(0, 3)).toEqual(["-i", "-l", "-c"]);
  });

  it("F3: parses the correct payload when rc-file output ECHOES the literal markers before the real ones (lastIndexOf wins)", async () => {
    // Simulates a corporate rc-file that grep-logs lines containing the
    // marker token, or a sourced helper that emits a bogus marker pair
    // before the real `node -e` runs. The real JSON.stringify(process.env)
    // is always the last marker pair emitted, so lastIndexOf for BOTH
    // markers picks the real payload.
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      const bogus = `${START}\n{"PATH":"/decoy/should/not/win","BOGUS_MARKER_PAIR":"1"}\n${END}\n`;
      child.stdout.emit("data", bogus);
      child.stdout.emit("data", markerPayload({ PATH: "/real/path", FNM_DIR: "/x" }));
      child.emit("exit", 0, null);
    });

    const result = await promise;
    expect(result.source).toBe("shell");
    expect(result.env.PATH).toBe("/real/path");
    expect(result.env.FNM_DIR).toBe("/x");
    expect(result.env.BOGUS_MARKER_PAIR).toBeUndefined();
  });

  it("parses marker-delimited JSON even when rc-file output prepends noise", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        markerPayload(
          { PATH: "/clean/path", FNM_DIR: "/Users/me/.local/share/fnm" },
          {
            noisyPrefix:
              'oh-my-zsh: Loading...\nwarning: foo\n[user@host] $\nbroken=printf "noise"\n',
          },
        ),
      );
      child.emit("exit", 0, null);
    });

    const result = await promise;
    expect(result.source).toBe("shell");
    expect(result.env.PATH).toBe("/clean/path");
    expect(result.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("seeds the singleton so subsequent getResolvedShellEnv() calls return it", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", markerPayload({ PATH: "/cached" }));
      child.emit("exit", 0, null);
    });
    await promise;

    const after = getResolvedShellEnv();
    expect(after.source).toBe("shell");
    expect(after.env.PATH).toBe("/cached");
  });
});

describe("captureShellEnv — fallback paths", () => {
  it("falls back to process.env with reason 'no-shell-detected' when $SHELL is missing AND /bin/zsh + /bin/bash don't exist", async () => {
    const prevShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const result = await captureShellEnv({
        existsImpl: () => false,
        spawnImpl: vi.fn() as unknown as typeof import("node:child_process").spawn,
      });
      expect(result.source).toBe("process");
      expect(result.fallbackReason).toBe("no-shell-detected");
      expect(result.shell).toBeUndefined();

      const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
      expect(evt).toBeDefined();
      expect(evt?.[0]).toBe("warn");
      expect(evt?.[2].reason).toBe("no-shell-detected");
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
    }
  });

  it("prefers /bin/zsh over $SHELL=/bin/sh on weird launchd boots", async () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const child = makeChild();
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
      const existsImpl = vi.fn((p: import("node:fs").PathLike) => p === "/bin/zsh");

      const promise = captureShellEnv({
        spawnImpl,
        existsImpl: existsImpl as unknown as typeof import("node:fs").existsSync,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", markerPayload({ PATH: "/usr/bin" }));
        child.emit("exit", 0, null);
      });
      const result = await promise;
      expect(result.shell).toBe("/bin/zsh");
      const [shellArg] = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(shellArg).toBe("/bin/zsh");
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });

  it("falls back when shell exits non-zero, with reason mentioning exit code + stderr tail", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stderr.emit("data", "zsh:7: command not found: nvm_use\n");
      child.emit("exit", 2, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/code=2/);
    expect(result.fallbackReason).toMatch(/nvm_use/);
    expect(result.shell).toBe("/bin/zsh");

    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
    expect(evt?.[2].shell).toBe("/bin/zsh");
    expect(evt?.[2].reason).toMatch(/code=2/);
  });

  it("times out and falls back with reason 'timed out after Nms'", async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      timeoutMs: 100,
      spawnImpl,
      existsImpl: () => true,
    });
    vi.advanceTimersByTime(150);
    const result = await promise;
    vi.useRealTimers();

    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/timed out after 100ms/);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    const evt = logMock.mock.calls.find((c) => c[1] === "daemon.shell-env.fallback");
    expect(evt?.[2].reason).toMatch(/timed out/);
  });

  it("falls back with reason 'markers not found' when the shell exits 0 but stdout lacks markers", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", "completely unrelated output\nno markers here\n");
      child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toBe("markers not found in shell output");
  });

  it("falls back with a JSON.parse error reason when the markers wrap invalid JSON", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit("data", `\n${START}\nthis-is-not-json\n${END}\n`);
      child.emit("exit", 0, null);
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toMatch(/JSON\.parse failed/);
  });

  it("falls back when the spawned shell raises an error event", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.emit("error", new Error("ENOENT zsh"));
    });
    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.fallbackReason).toBe("ENOENT zsh");
  });
});

describe("getResolvedShellEnv — pre-capture fallback", () => {
  it("returns a process.env snapshot with fallbackReason 'not-captured' before captureShellEnv runs", () => {
    process.env.__FRIDAY_TEST_KEY = "sentinel";
    try {
      const result = getResolvedShellEnv();
      expect(result.source).toBe("process");
      expect(result.fallbackReason).toBe("not-captured");
      expect(result.env.__FRIDAY_TEST_KEY).toBe("sentinel");
    } finally {
      delete process.env.__FRIDAY_TEST_KEY;
    }
  });
});

// FRI-150 (pivot, ADR-037): the worker-fork forwarding model retired with
// the move to per-worker capture. `serializeShellEnv`,
// `serializeShellEnvForWorker`, `loadResolvedShellEnvFromJson`, and the
// `SHELL_ENV_ENV_VAR` constant were removed. The round-trip /
// deserialize / F5 ARG_MAX guard tests retire with them.

describe("B1: secret-shaped key filter (sanitizeEnv / isSecretKey)", () => {
  it("matches the reviewer-named keys via the regex suffix rule", () => {
    expect(isSecretKey("BETTER_AUTH_SECRET")).toBe(true);
    expect(isSecretKey("ZERO_AUTH_SECRET")).toBe(true);
    expect(isSecretKey("ZERO_ADMIN_PASSWORD")).toBe(true);
    expect(isSecretKey("LINEAR_API_KEY")).toBe(true);
    expect(isSecretKey("ANTHROPIC_API_KEY")).toBe(true);
  });

  it("matches common secret-shaped suffixes", () => {
    expect(isSecretKey("GH_TOKEN")).toBe(true);
    expect(isSecretKey("CLOUDFLARE_TUNNEL_TOKEN")).toBe(true);
    expect(isSecretKey("MY_SERVICE_PASSWORD")).toBe(true);
    expect(isSecretKey("APP_PASSWD")).toBe(true);
    expect(isSecretKey("APP_PASSPHRASE")).toBe(true);
    expect(isSecretKey("APP_PRIVATE_KEY")).toBe(true);
    expect(isSecretKey("MY_CREDENTIAL")).toBe(true);
    expect(isSecretKey("AWS_CREDENTIALS")).toBe(true);
    expect(isSecretKey("POSTHOG_API_KEY")).toBe(true);
  });

  it("catches explicit URL-form secrets that don't match the suffix rule", () => {
    expect(EXPLICIT_SECRET_KEYS.has("DATABASE_URL")).toBe(true);
    expect(EXPLICIT_SECRET_KEYS.has("ZERO_UPSTREAM_DB")).toBe(true);
    expect(isSecretKey("DATABASE_URL")).toBe(true);
    expect(isSecretKey("ZERO_UPSTREAM_DB")).toBe(true);
  });

  it("does NOT match benign keys that happen to share substrings with secret words", () => {
    // PATH, HOME, SHELL, USER, TERM, LOGNAME, FNM_DIR, NVM_DIR, NODE_PATH, etc.
    expect(isSecretKey("PATH")).toBe(false);
    expect(isSecretKey("HOME")).toBe(false);
    expect(isSecretKey("SHELL")).toBe(false);
    expect(isSecretKey("USER")).toBe(false);
    expect(isSecretKey("FNM_DIR")).toBe(false);
    expect(isSecretKey("NVM_DIR")).toBe(false);
    expect(isSecretKey("NODE_PATH")).toBe(false);
    // Watch the suffix anchor: SECRET_DETECTOR_NAME ends in "NAME", not SECRET.
    expect(isSecretKey("SECRET_DETECTOR_NAME")).toBe(false);
    // XPC_SERVICE_NAME ends in NAME, shouldn't match.
    expect(isSecretKey("XPC_SERVICE_NAME")).toBe(false);
  });

  it("sanitizeEnv strips matched keys + preserves benign ones", () => {
    const input = {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      BETTER_AUTH_SECRET: "leaked-if-this-survives",
      LINEAR_API_KEY: "lin_api_xxx",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      DATABASE_URL: "postgresql://user:pw@host/db",
      FNM_DIR: "/x",
      GH_TOKEN: "ghp_xxx",
    };
    const sanitized = sanitizeEnv(input);
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/Users/me");
    expect(sanitized.FNM_DIR).toBe("/x");
    expect(sanitized.BETTER_AUTH_SECRET).toBeUndefined();
    expect(sanitized.LINEAR_API_KEY).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.GH_TOKEN).toBeUndefined();
  });

  it("SECRET_LIKE_KEY_RE is case-insensitive (defensive — most env vars are uppercase, but Windows-ish callers exist)", () => {
    expect(SECRET_LIKE_KEY_RE.test("my_secret")).toBe(true);
    expect(SECRET_LIKE_KEY_RE.test("My_Api_Key")).toBe(true);
  });

  it("sanitizedProcessEnvForChild strips secrets from a live process.env", () => {
    process.env.__FRIDAY_TEST_SECRET = "should-be-stripped";
    process.env.LINEAR_API_KEY = "should-also-be-stripped";
    process.env.__FRIDAY_TEST_BENIGN = "should-survive";
    try {
      const sanitized = sanitizedProcessEnvForChild();
      expect(sanitized.__FRIDAY_TEST_BENIGN).toBe("should-survive");
      expect(sanitized.__FRIDAY_TEST_SECRET).toBeUndefined();
      expect(sanitized.LINEAR_API_KEY).toBeUndefined();
    } finally {
      delete process.env.__FRIDAY_TEST_SECRET;
      delete process.env.LINEAR_API_KEY;
      delete process.env.__FRIDAY_TEST_BENIGN;
    }
  });
});

describe("B1: secret leak prevention through captureShellEnv (end-to-end)", () => {
  it("INPUT gate: hands a sanitized env to the spawned shell (BETTER_AUTH_SECRET NOT in spawn's env arg)", async () => {
    process.env.BETTER_AUTH_SECRET = "leak-marker-1";
    process.env.LINEAR_API_KEY = "leak-marker-2";
    process.env.ZERO_AUTH_SECRET = "leak-marker-3";
    process.env.__FRIDAY_BENIGN = "should-pass-through";
    try {
      const child = makeChild();
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

      const promise = captureShellEnv({
        shellOverride: "/bin/zsh",
        spawnImpl,
        existsImpl: () => true,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", markerPayload({ PATH: "/clean" }));
        child.emit("exit", 0, null);
      });
      await promise;

      const spawnOpts = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(spawnOpts.env.BETTER_AUTH_SECRET).toBeUndefined();
      expect(spawnOpts.env.LINEAR_API_KEY).toBeUndefined();
      expect(spawnOpts.env.ZERO_AUTH_SECRET).toBeUndefined();
      expect(spawnOpts.env.__FRIDAY_BENIGN).toBe("should-pass-through");
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.LINEAR_API_KEY;
      delete process.env.ZERO_AUTH_SECRET;
      delete process.env.__FRIDAY_BENIGN;
    }
  });

  it("OUTPUT gate: even if the shell re-introduces a secret (rc-file `export BETTER_AUTH_SECRET=...`), it's stripped from the cached env", async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

    const promise = captureShellEnv({
      shellOverride: "/bin/zsh",
      spawnImpl,
      existsImpl: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        markerPayload({
          PATH: "/clean",
          BETTER_AUTH_SECRET: "user-rc-set-this",
          ANTHROPIC_API_KEY: "and-this",
          DATABASE_URL: "postgresql://x:y@h/d",
          FNM_DIR: "/x",
        }),
      );
      child.emit("exit", 0, null);
    });
    const result = await promise;

    expect(result.source).toBe("shell");
    expect(result.env.PATH).toBe("/clean");
    expect(result.env.FNM_DIR).toBe("/x");
    expect(result.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.DATABASE_URL).toBeUndefined();
  });

  it("FALLBACK gate: secrets are stripped from the process.env snapshot too (timeout case)", async () => {
    process.env.BETTER_AUTH_SECRET = "should-not-leak-on-fallback";
    process.env.LINEAR_API_KEY = "should-not-leak-on-fallback";
    process.env.__FRIDAY_BENIGN_2 = "should-survive";
    try {
      vi.useFakeTimers();
      const child = makeChild();
      const spawnImpl = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;

      const promise = captureShellEnv({
        shellOverride: "/bin/zsh",
        timeoutMs: 100,
        spawnImpl,
        existsImpl: () => true,
      });
      vi.advanceTimersByTime(150);
      const result = await promise;
      vi.useRealTimers();

      expect(result.source).toBe("process");
      expect(result.env.BETTER_AUTH_SECRET).toBeUndefined();
      expect(result.env.LINEAR_API_KEY).toBeUndefined();
      expect(result.env.__FRIDAY_BENIGN_2).toBe("should-survive");
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
      delete process.env.LINEAR_API_KEY;
      delete process.env.__FRIDAY_BENIGN_2;
    }
  });

  // FRI-150 (pivot, ADR-037): the LOAD gate retired with the worker-fork
  // forwarding model. Workers capture their own env in-process; there is
  // no cross-process serialized payload to re-filter. The INPUT / OUTPUT
  // / FALLBACK gates above are the load-bearing B1 fences in the new
  // architecture.
});

describe("secret-key coverage after containerisation (FRI-2012)", () => {
  it("catches the keys that only started riding in env once we containerised", () => {
    // Measured in the compose stack: the daemon carries both of the first two.
    // FRIDAY_ADMIN_DATABASE_URL is the SUPERUSER connection — on ADR-051's
    // shared cluster that one credential reaches every Deployment's database.
    expect(isSecretKey("DATABASE_URL")).toBe(true);
    expect(isSecretKey("FRIDAY_ADMIN_DATABASE_URL")).toBe(true);
    expect(isSecretKey("FRIDAY_AGE_IDENTITY")).toBe(true);
    expect(isSecretKey("FRIDAY_AGE_IDENTITY_FILE")).toBe(true);
  });

  it("catches SSH_AUTH_SOCK — a delegated capability, not a credential", () => {
    // Nothing is readable through it, but a worker holding it authenticates
    // as the operator to any host or repo their keys reach.
    expect(isSecretKey("SSH_AUTH_SOCK")).toBe(true);
  });

  it("catches a *_DATABASE_URL added later, without anyone editing the list", () => {
    expect(isSecretKey("ANALYTICS_DATABASE_URL")).toBe(true);
    expect(isSecretKey("SOME_CONNECTION_STRING")).toBe(true);
    expect(isSecretKey("WAREHOUSE_DSN")).toBe(true);
  });

  it("still lets ordinary keys through", () => {
    for (const k of ["PATH", "HOME", "LANG", "TMPDIR", "NODE_ENV", "FRIDAY_DATA_DIR"]) {
      expect(isSecretKey(k)).toBe(false);
    }
  });

  it("sanitizeEnv drops exactly the secret-shaped keys", () => {
    const out = sanitizeEnv({
      PATH: "/usr/bin",
      FRIDAY_ADMIN_DATABASE_URL: "postgresql://postgres:su@db/postgres",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HOME: "/home/friday",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH"]);
  });
});
