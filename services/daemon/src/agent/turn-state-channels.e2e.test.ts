/**
 * FRI-145 M4 — boundary integration: the four former `agents.status` channels
 * now have EXACTLY ONE writer (the Turn-state machine), and the fakes the M3
 * unit tests use agree with the REAL collaborators.
 *
 * Test layer: this drives the REAL control flow — `lifecycle.archiveAgent`,
 * `lifecycle.healAgentStatus`, `lifecycle.setAgentProjection`, the real
 * `registry` (against a scratch Postgres via `createTestDb`), the real
 * `eventBus`, and the real agent-keyed Transition queue. Nothing under test is
 * mocked. Only the assertions read state; the convergence + ordering are the
 * real machine's.
 *
 * Why `.e2e.test.ts`: it stands up a scratch PG and exercises the cross-module
 * single-writer contract end to end (registry FSM gate ↔ machine ↔ queue ↔
 * eventBus), the kind of cross-boundary bug a pure-helper test can't catch.
 *
 * Covers:
 *   - Concurrent archive + boot-reset + heal for ONE agent cannot produce an
 *     out-of-order `agents.status`: the agent-keyed queue serializes them and
 *     the terminal `archived` wins (it is enqueued last and is the sink).
 *   - AC #13 contract pin: the real `registry.setStatus` rejects an illegal
 *     transition with code `INVALID_STATUS_TRANSITION`, and the real `eventBus`
 *     emits a Transition's published events in submission order.
 *   - AC #17: an abort-deadline force-kill that fires AFTER an archive does NOT
 *     write `idle` over `archived` (Generation no-op).
 *   - AC #19: the apps-installer archive path archives its agents to
 *     `agents.status="archived"` after the M4 routing change.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";

// Don't leak Linear API calls in tests that don't install a fetch mock.
delete process.env.LINEAR_API_KEY;

let handle: TestDbHandle;
let lifecycle: typeof import("./lifecycle.js");
let registry: typeof import("./registry.js");
let eventBus: (typeof import("../events/bus.js"))["eventBus"];

beforeAll(async () => {
  handle = await createTestDb({ label: "turn_state_channels" });
  lifecycle = await import("./lifecycle.js");
  registry = await import("./registry.js");
  ({ eventBus } = await import("../events/bus.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A LiveWorker double good enough for the archive / abort-deadline paths.
 *
 *  FRI-2037: `handle`, not `child`. This file is excluded from `pnpm test`,
 *  so it kept the pre-seam shape straight through the migration —
 *  `w.handle.send` threw `Cannot read properties of undefined`, which
 *  surfaced as an unhandled rejection rather than a clean failure.
 *
 *  `pgid: 0` keeps killPgrp a no-op (no real SIGTERM). The handle starts NOT
 *  alive, which is what the old `exitCode: 0` meant: `drainLiveWorker` takes
 *  its early "already gone" branch and resolves immediately, so worker
 *  teardown after an archive Transition doesn't hang on the full drain. */
function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  workerHandle: FakeWorkerHandle;
} {
  const workerHandle = fakeWorkerHandle({ pid: 0, alive: false });
  const w = {
    handle: workerHandle,
    pgid: 0,
    agentName: "ch-agent",
    agentType: "bare",
    model: "claude-opus-4-7",
    turnId: "turn-ch-1",
    sessionId: "sess-ch-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    turnState: "working",
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
  return { worker: w, workerHandle };
}

describe("FRI-145 M4: single writer of agents.status (real collaborators)", () => {
  it("concurrent archive + boot-reset + heal for ONE agent → archived wins, in order", async () => {
    const NAME = "converge-1";
    await registry.registerAgent({ name: NAME, type: "bare" });
    await registry.setStatus(NAME, "working");

    // Capture the order in which the REAL setStatus / archive DB doors fire,
    // so we can prove the agent-keyed queue serialized them (no interleave).
    // Pass-through spies: record the call, then delegate to the REAL door.
    const doorOrder: string[] = [];
    const origSet = registry.setStatus;
    vi.spyOn(registry, "setStatus").mockImplementation(async (name, status, opts) => {
      doorOrder.push(`set:${status}`);
      return origSet(name, status, opts);
    });
    const origArchive = registry.archiveAgent;
    vi.spyOn(registry, "archiveAgent").mockImplementation(async (name, opts) => {
      doorOrder.push("archive");
      return origArchive(name, opts);
    });

    // Fire all three channels "concurrently" — boot-reset (→idle), heal (→idle),
    // archive (→archived, the terminal sink). The agent-keyed queue serializes
    // them in enqueue order; archive is enqueued LAST so it is the resting state.
    const p1 = lifecycle.setAgentProjection(NAME, "idle");
    const p2 = lifecycle.healAgentStatus(NAME, "idle", { clearArchiveReason: true });
    const p3 = lifecycle.archiveAgent(NAME, { reason: "abandoned" });
    await Promise.all([p1, p2, p3]);

    // The terminal archive write is the resting state; nothing wrote over it.
    expect((await registry.getAgent(NAME))?.status).toBe("archived");
    // The three doors fired in strict submission order — proving serialization
    // (heal uses the unchecked path, so it does NOT appear as a `set:` door).
    expect(doorOrder).toEqual(["set:idle", "archive"]);
  });

  it("AC #13 contract: real registry.setStatus rejects an illegal transition with INVALID_STATUS_TRANSITION", async () => {
    await registry.registerAgent({ name: "fsm-illegal", type: "bare" });
    await registry.archiveAgent("fsm-illegal", { reason: "abandoned" }); // → archived (terminal)

    const { IllegalTransitionError } = registry;
    // `archived` is terminal for non-orchestrators: archived → working has no
    // FSM edge, so the gate throws.
    let thrown: unknown;
    try {
      await registry.setStatus("fsm-illegal", "working");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IllegalTransitionError);
    expect((thrown as InstanceType<typeof IllegalTransitionError>).code).toBe(
      "INVALID_STATUS_TRANSITION",
    );
    // The terminal row is unchanged by the rejected write.
    expect((await registry.getAgent("fsm-illegal"))?.status).toBe("archived");
  });

  it("AC #13 contract: real eventBus emits a Transition's published events in submission order", async () => {
    const NAME = "bus-order";
    await registry.registerAgent({ name: NAME, type: "bare" });
    await registry.setStatus(NAME, "working");
    // `workerHandle`, not `handle`: the module-level `handle` is the test DB.
    const { worker, workerHandle } = makeFakeWorker({ agentName: NAME, turnId: "turn-bus" });
    workerHandle.setAlive(true); // keep it alive so finalize/publish run on this gen
    lifecycle.__putLiveWorkerForTest(NAME, worker as never);

    // turn_started opens the eventBus turn buffer so per-agent events route.
    eventBus.publish({
      v: 1,
      type: "turn_started",
      turn_id: "turn-bus",
      agent: NAME,
      ts: Date.now(),
    });

    const captured: { type: string; seq: number }[] = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push({ type: (e as { type: string }).type, seq: (e as { seq: number }).seq }),
    );

    // Drive a real `error` Transition through the machine (handleEvent → the
    // fail Transition → executeIntents → real eventBus.publish). It publishes
    // `error` THEN `turn_done` — the executor's intent order.
    await lifecycle.handleEvent(
      worker as never,
      {
        type: "error",
        code: "boom",
        message: "real error transition",
        recoverable: false,
      } as never,
    );
    unsub();

    const types = captured.map((c) => c.type);
    // The machine emits the in-band error event strictly before turn_done.
    const errIdx = types.indexOf("error");
    const doneIdx = types.indexOf("turn_done");
    expect(errIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(errIdx).toBeLessThan(doneIdx);
    // seq is monotonic in submission order across the whole emission stream.
    const seqs = captured.map((c) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    lifecycle.__deleteLiveWorkerForTest(NAME);
    // The error Transition wrote idle (the heal projection) durably.
    expect((await registry.getAgent(NAME))?.status).toBe("idle");
  });

  it("AC #17: abort-deadline force-kill after archive does NOT write idle over archived", async () => {
    const NAME = "abort-after-archive";
    await registry.registerAgent({
      name: NAME,
      type: "builder",
      parentName: "orchestrator",
      worktreePath: `/tmp/${NAME}-ws`,
      branch: `friday/${NAME}`,
    });
    await registry.setStatus(NAME, "working");

    const { worker } = makeFakeWorker({
      agentName: NAME,
      turnId: "turn-aaa",
      status: "working",
    });
    lifecycle.__putLiveWorkerForTest(NAME, worker as never);

    // Arm the 500ms abort deadline. abortTurn's only gate is `status ===
    // "working"` (not exitCode), so the deadline arms; with a fake (pgid 0)
    // worker the descendant kill is a no-op and the deadline timer is the only
    // thing that fires.
    // `abortTurn` became async with the FRI-2037 seam (it awaits
    // `terminateDescendants`). Asserting on the un-awaited call compared a
    // Promise to `true` — a failure for the wrong reason, which hid the real
    // one underneath it.
    expect(await lifecycle.abortTurn(NAME)).toBe(true);

    // Archive runs WHILE the deadline is armed: it deletes the live entry and
    // writes `archived`. This supersedes the worker's Generation.
    await lifecycle.archiveAgent(NAME, { reason: "abandoned" });
    expect(lifecycle.isAgentLive(NAME)).toBe(false);
    expect((await registry.getAgent(NAME))?.status).toBe("archived");

    // Now let the 500ms abort deadline fire. forceKillStuckWorker(w) sees
    // `live.get(name) !== w` (archive deleted it) and is a Generation no-op:
    // it must NOT reach its setStatus(idle). Wait past the 500ms unref'd timer.
    await new Promise((r) => setTimeout(r, 650));

    // The terminal `archived` projection survived the late deadline.
    expect((await registry.getAgent(NAME))?.status).toBe("archived");
  });
});

describe("FRI-145 M4: apps-installer archive path (AC #19)", () => {
  it("uninstallApp archives its owned agents to status=archived via the machine route", async () => {
    const installer = await import("../apps/installer.js");
    const { getDb, schema } = await import("@friday/shared");
    const db = getDb();

    // Register an app row + an agent owned by it.
    const APP_ID = "test-app";
    await db.insert(schema.apps).values({
      id: APP_ID,
      name: "Test App",
      version: "1.0.0",
      manifestVersion: 1,
      folderPath: "/tmp/nonexistent-test-app",
      manifestJson: {},
      status: "installed",
      installedAt: new Date(),
    });
    await registry.registerAgent({ name: "app-agent", type: "bare" });
    await registry.setAppId("app-agent", APP_ID);

    // Uninstall — the installer's `void lifecycleArchiveAgent(name, ...)` path
    // (installer.ts:535) now routes through the machine's archive Transition.
    await installer.uninstallApp(APP_ID, { folderDisposition: "keep" });

    // The fire-and-forget archive settles on the agent-keyed queue.
    await vi.waitFor(
      async () => {
        expect((await registry.getAgent("app-agent"))?.status).toBe("archived");
      },
      { timeout: 5000, interval: 25 },
    );
  });
});
