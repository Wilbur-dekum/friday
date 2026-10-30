/**
 * PR E: continuous invariant auditor. Catches impossible agent states
 * that would otherwise linger until the next daemon restart — zombie
 * builders whose worktree was deleted, rows marked `working` with no
 * live worker.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let workspaceRoot: string;
let registry: typeof import("./registry.js");
let audit: (typeof import("./invariants.js"))["audit"];
let lifecycle: typeof import("./lifecycle.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "invariants" });
  workspaceRoot = mkdtempSync(join(tmpdir(), "friday-invariants-ws-"));
  registry = await import("./registry.js");
  ({ audit } = await import("./invariants.js"));
  lifecycle = await import("./lifecycle.js");
});

afterAll(async () => {
  await handle.drop();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await handle.truncate();
});

afterEach(async () => {
  // Belt-and-braces — most state lives in the registry table which the
  // beforeEach truncate already clears. Bypass the FSM gate via the
  // privileged auditor-heal path so orchestrator rows can be wiped too
  // (the gate forbids `* → archived` for orchestrators).
  for (const a of await registry.listAgents()) {
    if (a.status === "archived") continue;
    if (a.type === "orchestrator") {
      // No archived edge for orchestrators; setStatus to idle is fine.
      await registry.setStatus(a.name, "idle").catch(() => {});
      continue;
    }
    await registry.archiveAgent(a.name, { reason: "abandoned" }).catch(() => {});
  }
});

describe("invariant auditor", () => {
  it("Rule 1: archives a builder whose worktree dir is missing", async () => {
    const worktreePath = join(workspaceRoot, "ghost-1");
    // Deliberately do NOT create the directory.
    await registry.registerAgent({
      name: "ghost-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/ghost-1",
    });
    // Force the row out of the default "idle" so the migration-skip
    // scenario is reproduced (the real bug had status=working post
    // mail-recovery).
    await registry.setStatus("ghost-1", "working");

    const result = await audit();

    expect(result.archived).toContain("ghost-1");
    expect((await registry.getAgent("ghost-1"))?.status).toBe("archived");
  });

  it("Rule 1: does NOT archive a builder whose worktree exists", async () => {
    const worktreePath = join(workspaceRoot, "healthy-1");
    mkdirSync(worktreePath, { recursive: true });
    await registry.registerAgent({
      name: "healthy-1",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/healthy-1",
    });
    await registry.setStatus("healthy-1", "idle");

    const result = await audit();

    expect(result.archived).not.toContain("healthy-1");
    expect((await registry.getAgent("healthy-1"))?.status).toBe("idle");
  });

  it("Rule 1: leaves a CONTAINER-owned builder alone, path invisible or not", async () => {
    // FRI-2080. A container workspace is a volume at `/workspace` inside the
    // builder container, so `existsSync` is false for every one of them on
    // the daemon. Without the ownership check this rule archives every
    // containerised Builder on its first audit tick — and then keeps doing
    // it, which is a false alarm loud enough to train people to ignore a
    // real one.
    await registry.registerAgent({
      name: "boxed-1",
      type: "builder",
      parentName: "friday",
      worktreePath: "/workspace",
      branch: "friday/boxed-1",
      metaJson: { repo: "https://github.com/acme/web", workspaceOwner: "container" },
    });
    // `idle`, not `working`: rule 2 ("working ⇒ live") would demote a working
    // row with no live worker and muddy what this case is about.
    await registry.setStatus("boxed-1", "idle");

    const result = await audit();

    expect(result.archived).not.toContain("boxed-1");
    expect((await registry.getAgent("boxed-1"))?.status).toBe("idle");
  });

  it("Rule 1: still archives a DAEMON-owned builder that says so explicitly", async () => {
    // The control for the case above: an explicit `daemon` owner must behave
    // exactly like the absent one, or old rows and new rows diverge.
    await registry.registerAgent({
      name: "ghost-explicit",
      type: "builder",
      parentName: "friday",
      worktreePath: join(workspaceRoot, "ghost-explicit"),
      branch: "friday/ghost-explicit",
      metaJson: { repo: process.cwd(), workspaceOwner: "daemon" },
    });
    await registry.setStatus("ghost-explicit", "working");

    expect((await audit()).archived).toContain("ghost-explicit");
  });

  it("Rule 1: already-archived builders with missing worktrees are left alone", async () => {
    const worktreePath = join(workspaceRoot, "already-gone");
    await registry.registerAgent({
      name: "already-gone",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/already-gone",
    });
    await registry.archiveAgent("already-gone", { reason: "abandoned" });

    const result = await audit();

    expect(result.archived).not.toContain("already-gone");
    expect((await registry.getAgent("already-gone"))?.status).toBe("archived");
  });

  it("Rule 2: demotes a `working` agent that isn't in the live map", async () => {
    await registry.registerAgent({
      name: "zombie-1",
      type: "bare",
    });
    await registry.setStatus("zombie-1", "working");
    // Critical assumption: nothing in the live map for "zombie-1".
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation((name: string) => name !== "zombie-1");

    const result = await audit();

    expect(result.demoted).toContain("zombie-1");
    expect((await registry.getAgent("zombie-1"))?.status).toBe("idle");
  });

  it("Rule 2: leaves working agents alone when they ARE in the live map", async () => {
    await registry.registerAgent({
      name: "real-worker",
      type: "bare",
    });
    await registry.setStatus("real-worker", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockImplementation((name: string) => name === "real-worker");

    const result = await audit();

    expect(result.demoted).not.toContain("real-worker");
    expect((await registry.getAgent("real-worker"))?.status).toBe("working");
  });

  it("Rule 1 takes precedence over Rule 2 (archive supersedes demote)", async () => {
    // A builder that is BOTH working and orphan-worktree gets archived,
    // not demoted to idle. Archive is the terminal state; idle would
    // let it slip back into mail-recovery on the next boot.
    const worktreePath = join(workspaceRoot, "both-bad");
    await registry.registerAgent({
      name: "both-bad",
      type: "builder",
      parentName: "friday",
      worktreePath,
      branch: "friday/both-bad",
    });
    await registry.setStatus("both-bad", "working");
    vi.spyOn(lifecycle, "isAgentLive").mockReturnValue(false);

    const result = await audit();

    expect(result.archived).toContain("both-bad");
    expect(result.demoted).not.toContain("both-bad");
    expect((await registry.getAgent("both-bad"))?.status).toBe("archived");
  });

  it("Rule 3: heals orchestrator stuck at archived (FRI-113 / ADR-031)", async () => {
    // The FSM gate prevents new orchestrator-archived writes, but a
    // pre-FSM row (or an external psql edit) could still land in this
    // illegal resting state. Rule 3 heals it through the privileged
    // unchecked path because the FSM matrix has no `archived → idle`
    // edge.
    const { getDb, schema } = await import("@friday/shared");
    const { eq } = await import("drizzle-orm");
    const now = new Date();
    // Seed directly via the DB to bypass the gate (which would forbid
    // this write).
    await getDb().insert(schema.agents).values({
      name: "friday",
      type: "orchestrator",
      status: "archived",
      archiveReason: "abandoned",
      createdAt: now,
      updatedAt: now,
    });
    expect((await registry.getAgent("friday"))?.status).toBe("archived");

    const result = await audit();

    expect(result.healed).toContain("friday");
    expect((await registry.getAgent("friday"))?.status).toBe("idle");

    // Verify `archive_reason` was also cleared on heal so the next
    // observer doesn't read a stale "this was abandoned" tag on an
    // active orchestrator.
    const rows = await getDb()
      .select({ archiveReason: schema.agents.archiveReason })
      .from(schema.agents)
      .where(eq(schema.agents.name, "friday"))
      .limit(1);
    expect(rows[0]?.archiveReason).toBeNull();
  });
});
