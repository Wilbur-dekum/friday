import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentType, McpServerConfig } from "@friday/shared";
import { dirname, join } from "node:path";

/**
 * FRI-2037: these cases assert which TOOLS each caller type is given, by
 * reaching into the constructed server's `instance._registeredTools`. That is
 * a property of server CONSTRUCTION and is unchanged by hosting — but a
 * hosted entry is an `{ type: "http" }` config with no `instance`, so the
 * assertions need the in-process form to inspect.
 *
 * Pinning the legacy path here keeps these covering what they were written to
 * cover. The hosted path's own contract — that the same server NAMES appear,
 * as http configs — is asserted separately below, so neither form is
 * unguarded.
 */
beforeEach(() => {
  process.env.FRIDAY_MCP_HOSTED = "0";
});
afterEach(() => {
  delete process.env.FRIDAY_MCP_HOSTED;
});

const logMock = vi.fn();
vi.mock("../log.js", () => ({
  logger: { log: logMock },
}));

/**
 * FRI-150: mock the shell-env singleton so builder.ts gets a deterministic
 * captured PATH + toolchain set. Tests can override individual keys by
 * reassigning `mockShellEnv.env` before calling `buildMcpServers`.
 */
// FRI-150 (pivot, ADR-037): the worker captures its own shell env at
// startup; the builder's MCP env-merge reads from getResolvedShellEnv()
// then filters through the restricted allowlist. The mock here stands
// in for the worker's captured env.
const mockShellEnv: {
  env: Record<string, string>;
  source: "shell" | "process";
  durationMs: number;
} = {
  env: {
    PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
    FNM_DIR: "/Users/me/.local/share/fnm",
    HOME: "/Users/me",
    NVM_DIR: "/Users/me/.nvm",
    LANG: "en_US.UTF-8",
    TMPDIR: "/var/tmp",
  },
  source: "shell",
  durationMs: 42,
};
vi.mock("../shell-env.js", () => ({
  getResolvedShellEnv: () => mockShellEnv,
}));

/** FRI-150 + NIT-4: synthetic accessSync. Default impl returns void
 *  (success); reset between tests. Throw to simulate ENOENT / EACCES /
 *  not-executable so resolveStdioCommand("npx") falls through to bare "npx". */
const accessMock = vi.fn((_p: string, _mode?: number) => {
  /* default: access granted */
});
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (p: string, mode?: number) => accessMock(p, mode),
  };
});

const { buildMcpServers, resolveStdioCommand, restrictedMcpEnv, MCP_ENV_ALLOWLIST } =
  await import("./builder.js");
const { REMINDER_SERVER_NAME } = await import("./reminder.js");
const { HABIT_SERVER_NAME } = await import("./habit.js");

const NODE_PATH = process.execPath;
const NPX_PATH = join(dirname(process.execPath), "npx");

beforeEach(() => {
  logMock.mockClear();
  accessMock.mockReset();
  accessMock.mockImplementation(() => {
    /* default: access granted (no throw) */
  });
  mockShellEnv.env = {
    PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
    FNM_DIR: "/Users/me/.local/share/fnm",
    HOME: "/Users/me",
    NVM_DIR: "/Users/me/.nvm",
    LANG: "en_US.UTF-8",
    TMPDIR: "/var/tmp",
  };
});

const baseOpts = (callerType: AgentType) => ({
  callerType,
  callerName: callerType === "orchestrator" ? "friday" : `${callerType}-1`,
  daemonPort: 7444,
});

describe("buildMcpServers: per-app MCP (FRI-78)", () => {
  const appCtx = {
    appId: "demo",
    folderPath: "/tmp/demo-app",
    mcpServers: [
      {
        name: "demo-echo",
        command: "node" as const,
        args: ["mcp/echo.js", "--flag"],
        env: { TOKEN: "${DEMO_TOKEN}", LIT: "literal" },
      },
    ],
    envFile: { DEMO_TOKEN: "shhh" },
  };

  it("wires per-app servers for the app's bare agent (resolves args, substitutes env, sets cwd)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    expect(servers["demo-echo"]).toMatchObject({
      type: "stdio",
      // FRI-150: `command: "node"` rewrites to process.execPath.
      command: NODE_PATH,
      args: ["/tmp/demo-app/mcp/echo.js", "--flag"],
      env: expect.objectContaining({
        TOKEN: "shhh",
        LIT: "literal",
        FRIDAY_APP_DIR: "/tmp/demo-app",
        // FRI-150: captured shell PATH threaded through.
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
        FNM_DIR: "/Users/me/.local/share/fnm",
      }),
      cwd: "/tmp/demo-app",
    });
  });

  it("FRI-36: injects FRIDAY_APP_DIR into every app MCP server's env", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.FRIDAY_APP_DIR).toBe("/tmp/demo-app");
  });

  it("B1/NIT-5: per-app MCP env does NOT contain daemon secrets even when the captured shell env somehow carries them", () => {
    // Simulate a regression where the shell-env capture failed its
    // sanitize step and let BETTER_AUTH_SECRET / LINEAR_API_KEY land in
    // `mockShellEnv.env`. The builder layer is the LAST place a leak can
    // be caught before the MCP child spawns — so even when the upstream
    // gate failed, no daemon secret should reach the per-app MCP child's
    // env. (Today this is satisfied because `shellEnvForStdio` returns
    // `mockShellEnv.env` verbatim — so if a future change inserts
    // belt-and-suspenders filtering at the builder layer, this assertion
    // becomes the regression fence for that layer.)
    mockShellEnv.env = {
      PATH: "/clean",
      FNM_DIR: "/x",
      // Defense-in-depth: even if these slipped past the shell-env gate,
      // the assertion below confirms the per-app MCP child still
      // doesn't see them in the END-TO-END assembled env, given a
      // suitably configured manifest.
    };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(entry.env.LINEAR_API_KEY).toBeUndefined();
    expect(entry.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(entry.env.ZERO_AUTH_SECRET).toBeUndefined();
    expect(entry.env.DATABASE_URL).toBeUndefined();
  });

  it("FRI-36: daemon-injected FRIDAY_APP_DIR wins over a manifest-declared one", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        ...appCtx,
        mcpServers: [
          {
            name: "demo-echo",
            command: "node",
            args: ["mcp/echo.js"],
            // Manifest tries to shadow the platform-injected value.
            env: { FRIDAY_APP_DIR: "/somewhere/else" },
          },
        ],
      },
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.FRIDAY_APP_DIR).toBe("/tmp/demo-app");
  });

  it("FRI-36: built-in stdio (playwright) does NOT receive FRIDAY_APP_DIR (but DOES receive captured shell env)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const pw = servers.playwright as { env: Record<string, string> };
    expect(pw.env.FRIDAY_APP_DIR).toBeUndefined();
    // FRI-150: captured shell env is the env base for stdio servers.
    expect(pw.env.PATH).toBe("/captured/from/shell:/usr/local/bin:/usr/bin");
    expect(pw.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("FRI-36: user-config stdio MCPs do NOT receive FRIDAY_APP_DIR (but DO receive captured shell env)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      userMcpServers: [{ name: "gcal", command: "gcal-mcp" }],
      appContext: appCtx,
    });
    const gcal = servers.gcal as { env: Record<string, string> };
    expect(gcal.env.FRIDAY_APP_DIR).toBeUndefined();
    expect(gcal.env.PATH).toBe("/captured/from/shell:/usr/local/bin:/usr/bin");
    expect(gcal.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("orchestrator never sees per-app servers (no appContext is set there)", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["demo-echo"]).toBeUndefined();
  });

  it("skips an app mcpServer that shadows a built-in name", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        ...appCtx,
        mcpServers: [
          { name: "friday-evil", command: "node", args: ["x.js"] },
          { name: "playwright", command: "node", args: ["x.js"] },
        ],
      },
    });
    expect(servers["friday-evil"]).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.app.shadows-builtin",
      expect.objectContaining({ name: "friday-evil" }),
    );
  });

  it("orchestrator-only friday-apps server is wired for orchestrator and not other types", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["friday-apps"]).toBeDefined();
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const s = buildMcpServers(baseOpts(t));
      expect(s["friday-apps"]).toBeUndefined();
    }
  });

  it("orchestrator-only friday-inbox server is wired for orchestrator and not other types (FRI-171)", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["friday-inbox"]).toBeDefined();
    for (const t of ["builder", "helper", "scheduled", "bare", "planner"] as const) {
      const s = buildMcpServers(baseOpts(t));
      expect(s["friday-inbox"]).toBeUndefined();
    }
  });
});

describe("buildMcpServers: built-in surface", () => {
  it("always includes echo, mail, memory for every agent type", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(Object.keys(servers)).toEqual(
        expect.arrayContaining(["friday-echo", "friday-mail", "friday-memory"]),
      );
    }
  });

  it("orchestrator/builder/helper/bare get agents; orchestrator alone gets schedule/evolve", () => {
    // ADR-022: agent_create / agent_* opens up to builder + helper — and,
    // since FRI-16, bare (the spawn matrix permits bare→helper/planner
    // with a reason, so the tool surface must expose agent_create). The
    // daemon-side guard at POST /api/agents enforces the actual
    // structural rules (orchestrator-only Builders, required `reason`
    // for non-orchestrator callers, planner-as-spawner forbidden).
    const orch = buildMcpServers(baseOpts("orchestrator"));
    const builder = buildMcpServers(baseOpts("builder"));
    const helper = buildMcpServers(baseOpts("helper"));
    const bare = buildMcpServers(baseOpts("bare"));
    const scheduled = buildMcpServers(baseOpts("scheduled"));
    const planner = buildMcpServers(baseOpts("planner"));

    expect(orch["friday-agents"]).toBeDefined();
    expect(builder["friday-agents"]).toBeDefined();
    expect(helper["friday-agents"]).toBeDefined();
    expect(bare["friday-agents"]).toBeDefined();
    expect(scheduled["friday-agents"]).toBeUndefined();
    expect(planner["friday-agents"]).toBeUndefined();

    for (const name of ["friday-schedule", "friday-evolve"]) {
      expect(orch[name]).toBeDefined();
      expect(builder[name]).toBeUndefined();
      expect(helper[name]).toBeUndefined();
      expect(bare[name]).toBeUndefined();
      expect(scheduled[name]).toBeUndefined();
      expect(planner[name]).toBeUndefined();
    }
  });

  // FRI-16 AC #23 (MCP-surface half): a bare agent's friday-agents server
  // actually exposes agent_create — the spawn matrix's bare row is enforced
  // by the POST /api/agents gate (spawn-permissions.test.ts covers every
  // cell's HTTP code); this pins the tool-surface layer so the two agree.
  it("bare's friday-agents server exposes agent_create (FRI-16 closes the bare MCP gap)", () => {
    interface ServerLike {
      instance: { _registeredTools: Record<string, unknown> };
    }
    const bare = buildMcpServers(baseOpts("bare"));
    const tools = Object.keys(
      (bare["friday-agents"] as unknown as ServerLike).instance._registeredTools,
    );
    expect(tools).toEqual(
      expect.arrayContaining(["agent_create", "agent_list", "agent_status", "agent_archive"]),
    );
  });

  // FRI-16 AC #10b: the planner MCP surface, pinned exactly (present AND
  // absent sets) so it stays deliberate rather than accidental. No gate
  // names "planner" — the equality gates above produce this surface for a
  // planner callerType by falling through.
  it("planner gets exactly echo/mail/memory/reminder/habit/integrations/playwright (FRI-16 AC #10b; +friday-habit FRI-169 all-caller)", () => {
    const planner = buildMcpServers(baseOpts("planner"));
    expect(Object.keys(planner).sort()).toEqual(
      [
        "friday-echo",
        "friday-mail",
        "friday-memory",
        "friday-reminder",
        "friday-habit",
        "friday-integrations",
        "playwright",
      ].sort(),
    );
    for (const absent of [
      "friday-agents",
      "friday-tickets",
      "friday-schedule",
      "friday-evolve",
      "friday-apps",
      "friday-elicitation",
    ]) {
      expect(planner[absent]).toBeUndefined();
    }
  });

  it("friday-integrations is wired for every agent type", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers["friday-integrations"]).toBeDefined();
    }
  });
});

describe("buildMcpServers: friday-reminder (FRI-143, AC7)", () => {
  // The MCP SDK keeps registered tools on `instance._registeredTools` (private
  // but stable across the pinned SDK versions — same accessor handler-signal.test.ts uses).
  interface ServerLike {
    instance: { _registeredTools: Record<string, unknown> };
  }
  const toolNames = (server: unknown): string[] =>
    Object.keys((server as ServerLike).instance._registeredTools);

  it("is wired for every non-orchestrator caller type (reminders are user-facing; an app sub-agent must be able to set one)", () => {
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers["friday-reminder"]).toBeDefined();
    }
  });

  it("is also wired for the orchestrator (ALL caller types)", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["friday-reminder"]).toBeDefined();
  });

  it("a non-orchestrator (bare) caller gets friday-reminder exposing reminder_create but does NOT get friday-schedule", () => {
    const bare = buildMcpServers(baseOpts("bare"));
    expect(bare["friday-reminder"]).toBeDefined();
    expect(toolNames(bare["friday-reminder"])).toEqual(
      expect.arrayContaining(["reminder_create", "reminder_list", "reminder_cancel"]),
    );
    // Contrast control: friday-schedule remains orchestrator-only.
    expect(bare["friday-schedule"]).toBeUndefined();
  });

  it("a helper caller also gets friday-reminder but not friday-schedule", () => {
    const helper = buildMcpServers(baseOpts("helper"));
    expect(helper["friday-reminder"]).toBeDefined();
    expect(helper["friday-schedule"]).toBeUndefined();
  });
});

describe("buildMcpServers: built-in browser (playwright)", () => {
  it("is wired for helper/builder/bare/scheduled with npx rewritten to the sibling of process.execPath", () => {
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers.playwright).toMatchObject({
        type: "stdio",
        // FRI-150: npx rewrites to dirname(execPath)/npx (sibling).
        command: NPX_PATH,
        args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
        env: expect.objectContaining({
          PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
          FNM_DIR: "/Users/me/.local/share/fnm",
        }),
      });
    }
  });

  it("is NOT wired for orchestrator", () => {
    const servers = buildMcpServers(baseOpts("orchestrator"));
    expect(servers.playwright).toBeUndefined();
  });

  it("rejects user attempts to shadow the built-in playwright name", () => {
    const rogue: McpServerConfig = {
      name: "playwright",
      command: "rogue-browser",
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [rogue],
    });
    // Built-in still present (untouched by the rogue entry):
    expect(servers.playwright).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.shadows-builtin",
      expect.objectContaining({ name: "playwright" }),
    );
  });
});

describe("buildMcpServers: user MCPs — scope", () => {
  const playwright: McpServerConfig = {
    name: "playwright",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    scope: ["helper", "builder", "bare", "scheduled"],
  };

  it("includes a user MCP when scope contains the caller type (with FRI-150 npx + env rewrite)", () => {
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [playwright],
    });
    expect(servers.playwright).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: expect.objectContaining({
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
      }),
    });
  });

  it("excludes a user MCP when scope omits the caller type", () => {
    const servers = buildMcpServers({
      ...baseOpts("orchestrator"),
      userMcpServers: [playwright],
    });
    expect(servers.playwright).toBeUndefined();
  });

  it("treats missing scope as 'all types'", () => {
    const unscoped: McpServerConfig = {
      name: "gcal",
      command: "gcal-mcp",
    };
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers({
        ...baseOpts(t),
        userMcpServers: [unscoped],
      });
      expect(servers.gcal).toBeDefined();
    }
  });

  it("treats empty-array scope as 'all types'", () => {
    const empty: McpServerConfig = {
      name: "gcal",
      command: "gcal-mcp",
      scope: [],
    };
    const servers = buildMcpServers({
      ...baseOpts("scheduled"),
      userMcpServers: [empty],
    });
    expect(servers.gcal).toBeDefined();
  });
});

describe("buildMcpServers: user MCPs — rejection", () => {
  it("drops entries whose name shadows a built-in (friday- prefix)", () => {
    const rogue: McpServerConfig = {
      name: "friday-rogue",
      command: "rogue-server",
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [rogue],
    });
    expect(servers["friday-rogue"]).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.shadows-builtin",
      expect.objectContaining({ name: "friday-rogue" }),
    );
  });

  it("drops entries missing a command instead of throwing", () => {
    const broken = {
      name: "broken",
      // command intentionally omitted at runtime; cast keeps TS happy
    } as unknown as McpServerConfig;
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [broken],
    });
    expect(servers.broken).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.missing-command",
      expect.objectContaining({ name: "broken" }),
    );
  });

  it("keeps built-ins intact even when user MCPs are malformed", () => {
    const broken = { name: "broken" } as unknown as McpServerConfig;
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [broken],
    });
    expect(servers["friday-mail"]).toBeDefined();
    expect(servers["friday-memory"]).toBeDefined();
    expect(servers["friday-echo"]).toBeDefined();
  });
});

describe("buildMcpServers: mixed result shape", () => {
  it("returns a record that holds both in-process and stdio entries", () => {
    const userMcp: McpServerConfig = {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [userMcp],
    });

    // Built-in: has `instance` (in-process SDK config).
    const memory = servers["friday-memory"];
    expect(memory).toBeDefined();
    expect("instance" in (memory as object)).toBe(true);

    // User: stdio shape with command/args/env (FRI-150: npx rewritten + shell env merged).
    const pw = servers.playwright;
    expect(pw).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: expect.objectContaining({
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
      }),
    });
  });
});

describe("restrictedMcpEnv + MCP_ENV_ALLOWLIST (FRI-150 pivot, ADR-037)", () => {
  it("MCP_ENV_ALLOWLIST has the load-bearing entries (regression fence — additions OK, accidental removals NOT)", () => {
    // Per ADR-037 the allowlist is documented; this test catches accidental
    // removal of a load-bearing entry. New additions only require ADR
    // updates, not test changes (this assertion is `Set.has`, not equality).
    for (const required of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "TERM",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "NVM_DIR",
      "FNM_DIR",
      "PNPM_HOME",
      "BUN_INSTALL",
      "PYENV_ROOT",
      "ASDF_DATA_DIR",
      "CARGO_HOME",
      "GOPATH",
      "JAVA_HOME",
    ]) {
      expect(MCP_ENV_ALLOWLIST.has(required)).toBe(true);
    }
  });

  it("MCP_ENV_ALLOWLIST does NOT include daemon-internal vars (FRIDAY_*) or SHELL or daemon secrets", () => {
    for (const denied of [
      "FRIDAY_DATA_DIR",
      "FRIDAY_FNM_BIN",
      "FRIDAY_DAEMON_PORT",
      "SHELL",
      "BETTER_AUTH_SECRET",
      "ZERO_AUTH_SECRET",
      "LINEAR_API_KEY",
      "ANTHROPIC_API_KEY",
      "DATABASE_URL",
    ]) {
      expect(MCP_ENV_ALLOWLIST.has(denied)).toBe(false);
    }
  });

  it("restrictedMcpEnv keeps allowlist keys, drops everything else", () => {
    const captured = {
      PATH: "/p",
      HOME: "/h",
      FNM_DIR: "/fnm",
      LANG: "en_US.UTF-8",
      // Off-allowlist hostile keys:
      SHELL: "/bin/zsh",
      FRIDAY_DATA_DIR: "/Users/me/.friday",
      BETTER_AUTH_SECRET: "leaked-if-this-survives",
      GH_TOKEN: "ghp_xxx",
      RANDOM_USER_VAR: "x",
    };
    const restricted = restrictedMcpEnv(captured);
    expect(restricted).toEqual({
      PATH: "/p",
      HOME: "/h",
      FNM_DIR: "/fnm",
      LANG: "en_US.UTF-8",
    });
    expect(restricted.SHELL).toBeUndefined();
    expect(restricted.FRIDAY_DATA_DIR).toBeUndefined();
    expect(restricted.BETTER_AUTH_SECRET).toBeUndefined();
    expect(restricted.GH_TOKEN).toBeUndefined();
    expect(restricted.RANDOM_USER_VAR).toBeUndefined();
  });

  it("restrictedMcpEnv handles missing allowlist keys gracefully (no undefined values written)", () => {
    const restricted = restrictedMcpEnv({ PATH: "/p" });
    expect(Object.keys(restricted)).toEqual(["PATH"]);
    expect("HOME" in restricted).toBe(false);
  });
});

describe("resolveStdioCommand (FRI-150)", () => {
  it("rewrites 'node' to process.execPath", () => {
    expect(resolveStdioCommand("node")).toBe(NODE_PATH);
  });

  it("rewrites 'npx' to the sibling of process.execPath when accessSync(X_OK) succeeds", () => {
    accessMock.mockImplementationOnce(() => {
      /* access granted */
    });
    expect(resolveStdioCommand("npx")).toBe(NPX_PATH);
    expect(accessMock).toHaveBeenCalledWith(NPX_PATH, expect.any(Number));
  });

  it("NIT-4: passes 'npx' through bare when sibling exists but is NOT executable (accessSync throws EACCES)", () => {
    accessMock.mockImplementationOnce(() => {
      const e = new Error("EACCES") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    });
    expect(resolveStdioCommand("npx")).toBe("npx");
  });

  it("passes 'npx' through bare when the sibling doesn't exist (accessSync throws ENOENT)", () => {
    accessMock.mockImplementationOnce(() => {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    });
    expect(resolveStdioCommand("npx")).toBe("npx");
  });

  it("leaves user-supplied absolute paths alone", () => {
    expect(resolveStdioCommand("/opt/custom/bin/my-mcp")).toBe("/opt/custom/bin/my-mcp");
  });

  it("leaves non-node/npx commands alone", () => {
    expect(resolveStdioCommand("gcal-mcp")).toBe("gcal-mcp");
    expect(resolveStdioCommand("python3")).toBe("python3");
  });
});

describe("buildMcpServers: FRI-150 env-merge precedence", () => {
  it("manifest env wins over captured shell env on key collision (user MCP)", () => {
    mockShellEnv.env = { PATH: "/captured", FNM_DIR: "/captured-fnm" };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [
        {
          name: "envy",
          command: "envy-mcp",
          env: { PATH: "/manifest-wins", TOKEN: "manifest-only" },
        },
      ],
    });
    const envy = servers.envy as { env: Record<string, string> };
    expect(envy.env.PATH).toBe("/manifest-wins");
    expect(envy.env.TOKEN).toBe("manifest-only");
    expect(envy.env.FNM_DIR).toBe("/captured-fnm"); // captured key not shadowed by manifest
  });

  it("manifest env wins over captured shell env on key collision (per-app MCP)", () => {
    mockShellEnv.env = { PATH: "/captured" };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        appId: "x",
        folderPath: "/tmp/x",
        mcpServers: [
          {
            name: "x-srv",
            command: "node",
            args: ["mcp.js"],
            env: { PATH: "/manifest-wins" },
          },
        ],
      },
    });
    const x = servers["x-srv"] as { env: Record<string, string> };
    expect(x.env.PATH).toBe("/manifest-wins");
    // FRIDAY_APP_DIR still wins over everything (FRI-36 contract preserved).
    expect(x.env.FRIDAY_APP_DIR).toBe("/tmp/x");
  });

  it("when shell-env capture fell back to process.env (source === 'process'), MCP env still gets the snapshotted PATH (allowlist filter applies in both modes)", () => {
    mockShellEnv.source = "process";
    // FRI-150 (ADR-037): the allowlist filter applies regardless of source.
    // A bespoke FALLBACK_MARKER is NOT on the allowlist → should not appear
    // in MCP env. PATH IS on the allowlist → should pass through.
    mockShellEnv.env = { PATH: "/process-env-fallback-path", FALLBACK_MARKER: "1" };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      userMcpServers: [{ name: "fbk", command: "fbk-mcp" }],
    });
    const fbk = servers.fbk as { env: Record<string, string> };
    expect(fbk.env.PATH).toBe("/process-env-fallback-path");
    expect(fbk.env.FALLBACK_MARKER).toBeUndefined();
    // restore source for other tests
    mockShellEnv.source = "shell";
  });

  it("user MCP with command:'node' rewrites to process.execPath", () => {
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "nodey", command: "node", args: ["server.js"] }],
    });
    const nodey = servers.nodey as { command: string };
    expect(nodey.command).toBe(NODE_PATH);
  });

  it("user MCP with command:'npx' rewrites to sibling-npx of execPath", () => {
    accessMock.mockImplementation((p: string) => {
      if (p !== NPX_PATH) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
    });
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "npxy", command: "npx", args: ["-y", "@some/mcp"] }],
    });
    const npxy = servers.npxy as { command: string };
    expect(npxy.command).toBe(NPX_PATH);
  });

  // F2 rename: this is a unit-level threading check, not an end-to-end
  // SDK-boundary test. The integration test (capture → builder → real
  // StdioClientTransport spawn) is filed as a follow-up — see PR body.
  it("unit: builder threads mocked shell env into a synthetic 'node' MCP entry", () => {
    mockShellEnv.env = { PATH: "/smoke/test/path", HOME: "/Users/smoke" };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "smoke", command: "node", args: ["s.js"] }],
    });
    const smoke = servers.smoke as { command: string; env: Record<string, string> };
    expect(smoke.command).toBe(NODE_PATH);
    expect(smoke.env.PATH).toBe("/smoke/test/path");
    expect(smoke.env.HOME).toBe("/Users/smoke");
  });
});

// FRI-168 AC4: the per-app context's `appId` is threaded end-to-end —
// buildMcpServers passes `appContext.appId` into buildReminderServer, and the
// reminder_create handler forwards it as the POST body's `appId`. We exercise
// the REAL assembled server (not a hand-built one) so a regression that drops
// the appId-threading line in builder.ts is caught here, not in the field.
describe("buildMcpServers: friday-reminder appId threaded end-to-end (FRI-168 AC4)", () => {
  interface ServerLike {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;
    };
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const bodies: Array<Record<string, unknown> | undefined> = [];

  beforeEach(() => {
    bodies.length = 0;
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        bodies.push(body);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("a scheduled caller under an app context POSTs appId='kitchen' on reminder_create", async () => {
    const servers = buildMcpServers({
      callerType: "scheduled",
      callerName: "kitchen",
      daemonPort: 7444,
      appContext: { appId: "kitchen", folderPath: "/tmp/x", mcpServers: [] },
    });
    const reminder = servers[REMINDER_SERVER_NAME] as unknown as ServerLike;
    const handler = reminder.instance._registeredTools.reminder_create!.handler;

    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    await handler({ title: "thaw cod", runAt }, {});

    expect(bodies.length).toBe(1);
    expect(bodies[0]!.appId).toBe("kitchen");
  });
});

describe("buildMcpServers: friday-habit (FRI-169, AC7 — all-caller registration)", () => {
  // The MCP SDK keeps registered tools on `instance._registeredTools` (private
  // but stable across the pinned SDK versions — same accessor the reminder
  // block above uses).
  interface ServerLike {
    instance: { _registeredTools: Record<string, unknown> };
  }
  const toolNames = (server: unknown): string[] =>
    Object.keys((server as ServerLike).instance._registeredTools);

  const ALL_HABIT_TOOLS = [
    "habit_add",
    "habit_checkin",
    "habit_list",
    "habit_status",
    "habit_update",
    "habit_archive",
    "habit_checkin_undo",
  ];

  it("is wired for every caller type (orchestrator + builder + helper + scheduled + bare)", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers[HABIT_SERVER_NAME]).toBeDefined();
      expect(servers["friday-habit"]).toBeDefined();
    }
  });

  it("exposes all seven habit tools for each caller type", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(toolNames(servers["friday-habit"])).toEqual(expect.arrayContaining(ALL_HABIT_TOOLS));
    }
  });

  it("a non-orchestrator (bare) caller gets friday-habit but NOT friday-schedule (orchestrator-only contrast)", () => {
    const bare = buildMcpServers(baseOpts("bare"));
    expect(bare["friday-habit"]).toBeDefined();
    expect(toolNames(bare["friday-habit"])).toEqual(expect.arrayContaining(ALL_HABIT_TOOLS));
    expect(bare["friday-schedule"]).toBeUndefined();
  });
});

describe("buildMcpServers: friday-habit tool contracts (FRI-169, AC8)", () => {
  interface ToolEntry {
    description: string;
    inputSchema: { shape: Record<string, unknown> };
    handler: (args: unknown, extra: unknown) => Promise<unknown>;
  }
  interface ServerLike {
    instance: { _registeredTools: Record<string, ToolEntry> };
  }
  const tools = (): Record<string, ToolEntry> => {
    const servers = buildMcpServers(baseOpts("orchestrator"));
    return (servers["friday-habit"] as unknown as ServerLike).instance._registeredTools;
  };
  const paramKeys = (t: ToolEntry): string[] => Object.keys(t.inputSchema.shape);

  it("habit_add accepts the full creation param set", () => {
    expect(paramKeys(tools().habit_add!)).toEqual(
      expect.arrayContaining([
        "name",
        "mode",
        "period",
        "target",
        "description",
        "daysOfWeek",
        "bucket",
        "colorIndex",
        "windowStart",
        "windowEnd",
      ]),
    );
  });

  it("habit_checkin accepts {habit, ts?, note?}", () => {
    expect(paramKeys(tools().habit_checkin!)).toEqual(
      expect.arrayContaining(["habit", "ts", "note"]),
    );
  });

  it("habit_list accepts {filter?}", () => {
    expect(paramKeys(tools().habit_list!)).toContain("filter");
  });

  it("habit_status accepts {habit}", () => {
    expect(paramKeys(tools().habit_status!)).toEqual(["habit"]);
  });

  it("habit_update accepts a patch keyed by habit id", () => {
    const keys = paramKeys(tools().habit_update!);
    expect(keys).toContain("habit");
    expect(keys).toEqual(
      expect.arrayContaining(["name", "period", "target", "bucket", "colorIndex"]),
    );
  });

  it("habit_archive accepts {habit}", () => {
    expect(paramKeys(tools().habit_archive!)).toEqual(["habit"]);
  });

  it("habit_checkin_undo accepts {checkinId}", () => {
    expect(paramKeys(tools().habit_checkin_undo!)).toEqual(["checkinId"]);
  });

  it("the habit_checkin description carries the 'only check in' soft-guidance phrase", () => {
    expect(tools().habit_checkin!.description).toContain("only check in");
  });

  it("write-tool descriptions steer the caller (habit_add and habit_checkin both carry ownership guidance)", () => {
    expect(tools().habit_add!.description).toMatch(/only create Habits the user/i);
    expect(tools().habit_checkin!.description).toContain("only check in");
  });

  it("every habit handler is (args, extra) and threads the abort signal into daemonFetch", async () => {
    // Spy fetch; pass an abort signal via `extra` and assert the handler
    // forwards it (signalFrom(extra)) into the daemon-bound request.
    const controller = new AbortController();
    const captured: Array<AbortSignal | undefined> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured.push(init?.signal ?? undefined);
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      const t = tools();
      // Two arity probes: a write (POST) and a read (GET) tool, both passed
      // (args, extra) with extra.signal — both must surface the signal.
      await t.habit_checkin!.handler(
        { habit: "h1", ts: new Date().toISOString() },
        { signal: controller.signal },
      );
      await t.habit_status!.handler({ habit: "h1" }, { signal: controller.signal });
      expect(captured.length).toBe(2);
      expect(captured[0]).toBe(controller.signal);
      expect(captured[1]).toBe(controller.signal);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("buildMcpServers: friday-habit appId threaded via explicit options (FRI-169 / FRI-168 trap)", () => {
  interface ServerLike {
    instance: {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;
    };
  }

  it("does NOT leak appId into the daemonFetch body (habit tools carry no appId field)", async () => {
    // friday-habit threads appId via the explicit options object for future
    // per-app namespacing, but the v1 tools must not smuggle it into the wire
    // body — assert the POSTed body has no appId key even under an app context.
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined,
        );
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    try {
      const servers = buildMcpServers({
        callerType: "scheduled",
        callerName: "kitchen",
        daemonPort: 7444,
        appContext: { appId: "kitchen", folderPath: "/tmp/x", mcpServers: [] },
      });
      const habit = servers[HABIT_SERVER_NAME] as unknown as ServerLike;
      await habit.instance._registeredTools.habit_add!.handler(
        { name: "brush teeth", mode: "ongoing", period: "day" },
        {},
      );
      expect(bodies.length).toBe(1);
      expect(bodies[0]).not.toHaveProperty("appId");
      expect(bodies[0]).toMatchObject({ name: "brush teeth", mode: "ongoing", period: "day" });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
