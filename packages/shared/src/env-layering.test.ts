import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FRI-2014: `.env` and `.env.local` must LAYER, not compete.
 *
 * `localEnvPath()` returned `.env.local` when it existed and `.env` otherwise.
 * On a laptop `.env.local` usually does not exist, so `.env` was read and
 * everything worked. `friday restore` writes `.env.local` (the synced role
 * password), which flipped the choice and silently orphaned every key the
 * operator kept in `.env`. The Deployment booted healthy and every agent turn
 * came back `Not logged in · Please run /login`.
 *
 * Each case gets its own data dir and a fresh module registry, because
 * `ENV_PATH` / `ENV_LOCAL_PATH` bind to `DATA_DIR` at import time.
 */
describe("env file layering", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.FRIDAY_DATA_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FRIDAY_DATA_DIR;
    else process.env.FRIDAY_DATA_DIR = saved;
  });

  async function loadWith(files: { env?: string; envLocal?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "friday-env-layer-"));
    if (files.env !== undefined) writeFileSync(join(dir, ".env"), files.env);
    if (files.envLocal !== undefined) writeFileSync(join(dir, ".env.local"), files.envLocal);
    process.env.FRIDAY_DATA_DIR = dir;
    // ENV_PATH / ENV_LOCAL_PATH bind to DATA_DIR at import time, and
    // loadFridayConfig memoizes — so both modules must be re-evaluated per case.
    vi.resetModules();
    const mod = await import("./env.js");
    return mod.loadFridayConfig();
  }

  it("reads a key from .env even when .env.local exists (the migration shape)", async () => {
    const cfg = await loadWith({
      env: "ANTHROPIC_API_KEY=sk-ant-from-dot-env\n",
      // What `friday restore` writes, which used to shadow .env wholesale.
      envLocal: "DATABASE_URL=postgresql://friday:pw@postgres:5432/friday\n",
    });
    expect(cfg.anthropicApiKey).toBe("sk-ant-from-dot-env");
    expect(cfg.databaseUrl).toBe("postgresql://friday:pw@postgres:5432/friday");
  });

  it("lets .env.local win on conflict", async () => {
    const cfg = await loadWith({
      env: "ANTHROPIC_API_KEY=from-env\n",
      envLocal: "ANTHROPIC_API_KEY=from-env-local\n",
    });
    expect(cfg.anthropicApiKey).toBe("from-env-local");
  });

  it("still reads .env when .env.local is absent", async () => {
    const cfg = await loadWith({ env: "ANTHROPIC_API_KEY=only-in-env\n" });
    expect(cfg.anthropicApiKey).toBe("only-in-env");
  });
});
