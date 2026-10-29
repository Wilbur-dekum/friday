/**
 * FRI-148 §5.C: real-time FSM violation heal in `safeHandleEvent`.
 *
 * Three load-bearing properties:
 *   L1 — every `IllegalBlockTransitionError` thrown by the block-stream
 *        core is caught at the IPC boundary, increments the per-turn
 *        `illegalTransitionsThisTurn` counter, and surfaces as a typed
 *        `block.transition.illegal` warn log line (NOT a generic
 *        `worker.ipc.error`, which would double-count in Evolve and lose
 *        the structured op / code / clientBlockId attribution).
 *   L2 — once the per-turn count crosses `FSM_VIOLATION_THRESHOLD` (3),
 *        a dedicated `block.transition.illegal.threshold` warn log
 *        emits AND `forceKillStuckWorker` runs with
 *        `reason: "fsm-violation"`. The L1 log STILL emits on the
 *        threshold trip (one occurrence + one trip — not either-or).
 *   Reset — the per-turn counter resets at every dispatch boundary
 *        (LiveWorker construction, spawn-fresh first-turn dispatch,
 *        `sendPrompt`) so a worker that hit two violations on the
 *        previous turn doesn't inherit that ledger into the next one.
 *
 * Test pattern follows lifecycle-stale-turn.test.ts / lifecycle-block-
 * cancel.test.ts: synthetic LiveWorker injected via `__putLiveWorkerForTest`,
 * `block-cancel` for an unknown `clientBlockId` as the canonical FSM
 * violation (BLOCK_NOT_STARTED — same shape pinned in
 * lifecycle-block-cancel.test.ts → "stale block-cancel … rejected by the
 * block state machine"), eventBus + logger spied for assertion.
 */

import { readFileSync } from "node:fs";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_fsm_violation" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
  const { __resetForTest } = await import("./block-stream.js");
  __resetForTest();
});

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: Record<string, unknown> & { illegalTransitionsThisTurn: number };
  handle: FakeWorkerHandle;
} {
  // FRI-2037: a WorkerHandle double, not a ChildProcess one. Every case in
  // this file is a pure mock test — no real processes — so the shared fake is
  // the right tool here (contrast lifecycle-abort-tool-kill, which spawns a
  // real tree and needs a handle that really signals).
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    // pgid 0 → killPgrp no-ops, so we don't actually SIGTERM the test runner.
    pgid: 0,
    agentName: "fsm-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-fsm-1",
    sessionId: "sess-fsm-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    // FRI-145 M3: setWorkerStatus reads/writes both turnState + status.
    turnState: "working",
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: 0,
    // The field under test. Matches the LiveWorker construction default
    // exercised in §4 of the ticket.
    illegalTransitionsThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
  return { worker: w, handle };
}

describe("lifecycle: FSM violation heal (FRI-148 §5.C)", () => {
  it("safeHandleEvent emits block.transition.illegal not worker.ipc.error for IllegalBlockTransitionError", async () => {
    const { safeHandleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({ turnId: "turn-fsm-l1" });
    __putLiveWorkerForTest("fsm-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");

    // block-cancel for an unknown clientBlockId throws
    // IllegalBlockTransitionError(code: BLOCK_NOT_STARTED) inside the
    // block-stream core. The L1 heal must convert that into a typed
    // `block.transition.illegal` warn log and SUPPRESS the generic
    // `worker.ipc.error` (otherwise the Evolve allowlist double-counts).
    await expect(
      safeHandleEvent(
        worker as never,
        {
          type: "block-cancel",
          clientBlockId: "c-unknown",
        } as never,
      ),
    ).resolves.toBeUndefined();

    const illegalCalls = logSpy.mock.calls.filter(([, ev]) => ev === "block.transition.illegal");
    expect(illegalCalls).toHaveLength(1);
    const [level, , payload] = illegalCalls[0];
    expect(level).toBe("warn");
    expect(payload).toMatchObject({
      agent: "fsm-agent",
      type: "block-cancel",
      turnId: "turn-fsm-l1",
      clientBlockId: "c-unknown",
      code: "BLOCK_NOT_STARTED",
      op: "cancel",
      countThisTurn: 1,
    });

    // The generic boundary log must NOT fire — that path is reserved for
    // *un*typed throws; a typed FSM violation is fully owned by the L1/L2
    // branch above.
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.error")).toBeUndefined();

    // Below the threshold → no L2 trip, no force-kill.
    expect(
      logSpy.mock.calls.find(([, ev]) => ev === "block.transition.illegal.threshold"),
    ).toBeUndefined();
    expect(
      logSpy.mock.calls.find(([, ev]) => ev === "worker.fsm-violation.force-kill"),
    ).toBeUndefined();

    // Counter pinned at exactly 1 for the single violation.
    expect(worker.illegalTransitionsThisTurn).toBe(1);

    __deleteLiveWorkerForTest("fsm-agent");
  });

  it("three illegal transitions trigger threshold + force-kill (fsm-violation)", async () => {
    const { safeHandleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({ turnId: "turn-fsm-l2" });
    __putLiveWorkerForTest("fsm-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");

    // First violation: count=1, L1 only.
    await safeHandleEvent(
      worker as never,
      {
        type: "block-cancel",
        clientBlockId: "c-unknown-1",
      } as never,
    );
    expect(worker.illegalTransitionsThisTurn).toBe(1);
    expect(logSpy.mock.calls.filter(([, ev]) => ev === "block.transition.illegal")).toHaveLength(1);
    expect(
      logSpy.mock.calls.find(([, ev]) => ev === "block.transition.illegal.threshold"),
    ).toBeUndefined();
    // Worker still the current Generation — no force-kill yet.
    expect(isAgentLive("fsm-agent")).toBe(true);

    // Second violation: count=2, still L1 only.
    await safeHandleEvent(
      worker as never,
      {
        type: "block-cancel",
        clientBlockId: "c-unknown-2",
      } as never,
    );
    expect(worker.illegalTransitionsThisTurn).toBe(2);
    expect(logSpy.mock.calls.filter(([, ev]) => ev === "block.transition.illegal")).toHaveLength(2);
    expect(
      logSpy.mock.calls.find(([, ev]) => ev === "block.transition.illegal.threshold"),
    ).toBeUndefined();
    expect(isAgentLive("fsm-agent")).toBe(true);

    // Third violation: count=3 → trip.
    await safeHandleEvent(
      worker as never,
      {
        type: "block-cancel",
        clientBlockId: "c-unknown-3",
      } as never,
    );
    expect(worker.illegalTransitionsThisTurn).toBe(3);

    // L1 STILL fires on the threshold trip — the count increment and the
    // per-occurrence log emit BEFORE the threshold check, so the L1 ledger
    // is complete (three occurrences logged) AND the L2 trip records the
    // boundary crossing.
    const illegalLogs = logSpy.mock.calls.filter(([, ev]) => ev === "block.transition.illegal");
    expect(illegalLogs).toHaveLength(3);
    expect(illegalLogs[2][2]).toMatchObject({
      agent: "fsm-agent",
      countThisTurn: 3,
      clientBlockId: "c-unknown-3",
      code: "BLOCK_NOT_STARTED",
      op: "cancel",
    });

    // L2 fires exactly once with the threshold + count.
    const thresholdLogs = logSpy.mock.calls.filter(
      ([, ev]) => ev === "block.transition.illegal.threshold",
    );
    expect(thresholdLogs).toHaveLength(1);
    expect(thresholdLogs[0][2]).toMatchObject({
      agent: "fsm-agent",
      turnId: "turn-fsm-l2",
      countThisTurn: 3,
      threshold: 3,
    });

    // forceKillStuckWorker(reason: "fsm-violation") ran:
    //   - dedicated `worker.fsm-violation.force-kill` log emitted
    //   - the worker's Generation was demoted (live.delete), so
    //     `isAgentLive` flips to false. This is what production sees: the
    //     next dispatchTurn forks a fresh worker.
    const forceKillLogs = logSpy.mock.calls.filter(
      ([, ev]) => ev === "worker.fsm-violation.force-kill",
    );
    expect(forceKillLogs).toHaveLength(1);
    expect(forceKillLogs[0][2]).toMatchObject({
      agent: "fsm-agent",
      turnId: "turn-fsm-l2",
      illegalTransitionsThisTurn: 3,
    });
    expect(isAgentLive("fsm-agent")).toBe(false);

    // Sibling force-kill reason logs MUST NOT fire — fsm-violation is its
    // own branch, not aliased onto wedge/abort/stale.
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.wedge.force-kill")).toBeUndefined();
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.abort.force-kill")).toBeUndefined();
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.turn.stale-killed")).toBeUndefined();

    // Generation already demoted; explicit delete is a defensive no-op.
    __deleteLiveWorkerForTest("fsm-agent");
  });

  describe("illegalTransitionsThisTurn resets at every dispatch boundary", () => {
    it("(a) fresh LiveWorker init: counter === 0", async () => {
      // Pins the construction-time default. The fake worker mirrors the
      // shape of the real LiveWorker init block in lifecycle.ts; the
      // ticket §4 boundary is the `illegalTransitionsThisTurn: 0` line
      // sitting alongside `blocksThisTurn: 0`.
      const { worker } = makeFakeWorker();
      expect(worker.illegalTransitionsThisTurn).toBe(0);
    });

    it("(b) spawn-fresh path (ready-handshake callback) resets the counter", () => {
      // The spawn-fresh boundary lives inside the `child.once("message", ...)`
      // callback in `spawnTurn`, which fires after the worker emits its
      // first `ready` IPC. Driving a real fork from a unit test is too
      // heavy (worker.js spins up the SDK CLI), so pin the boundary
      // structurally: the source MUST contain
      // `w.illegalTransitionsThisTurn = 0` adjacent to the existing
      // `w.turnStart = Date.now()` inside the spawn-fresh callback.
      // Read from disk rather than the compiled `dist/` so the assertion
      // tracks the editable source.
      const __filename = fileURLToPath(import.meta.url);
      const lifecycleSrc = readFileSync(join(dirname(__filename), "lifecycle.ts"), "utf-8");

      // Locate the ready-handshake block and confirm both the turnStart
      // write AND the illegalTransitionsThisTurn reset live inside it. We
      // anchor on the `start` IPC send, the well-known terminator of the
      // spawn-fresh callback (it fires right after the per-turn resets). A
      // future refactor that moves the block trips an anchor rather than
      // silently passing.
      //
      // FRI-2037 renamed the anchors — `child.once("message"` became
      // `handle.onceMessage(` and `send(child, {` became `handle.send({`
      // when the worker boundary moved behind the runtime seam. The assertion
      // is unchanged; only the names it looks for moved.
      const onceIdx = lifecycleSrc.indexOf("handle.onceMessage(");
      expect(onceIdx).toBeGreaterThan(-1);
      const sendIdx = lifecycleSrc.indexOf("handle.send({", onceIdx);
      expect(sendIdx).toBeGreaterThan(onceIdx);
      const onceBlock = lifecycleSrc.slice(onceIdx, sendIdx);
      expect(onceBlock).toContain("w.turnStart = Date.now()");
      expect(onceBlock).toContain("w.illegalTransitionsThisTurn = 0");
    });

    it("(c) sendPrompt resets the counter mid-conversation", async () => {
      const { dispatchTurn, safeHandleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
        await import("./lifecycle.js");

      const { worker, handle } = makeFakeWorker({
        turnId: "turn-fsm-reset-prev",
        // Worker is idle (just finished a turn) so dispatchTurn takes the
        // sendPrompt branch instead of forking. status === "idle" is the
        // dispatchTurn gate.
        turnState: "idle",
        status: "idle",
      });
      __putLiveWorkerForTest("fsm-agent", worker as never);

      // (1) Pre-reset: one illegal transition lands on the in-flight turn.
      await safeHandleEvent(
        worker as never,
        {
          type: "block-cancel",
          clientBlockId: "c-pre-reset",
        } as never,
      );
      expect(worker.illegalTransitionsThisTurn).toBe(1);

      // (2) Boundary: a new prompt arrives, dispatchTurn takes the
      // sendPrompt branch. sendPrompt is the third reset site.
      dispatchTurn({
        agentName: "fsm-agent",
        options: {
          agentName: "fsm-agent",
          agentType: "orchestrator",
          workingDirectory: "/tmp/fake",
          systemPrompt: "test",
          prompt: "next turn",
          turnId: "turn-fsm-reset-next",
          model: "claude-opus-4-7",
          daemonPort: 0,
          mode: "long-lived",
        },
      });
      // sendPrompt is synchronous; it stamps the new turn id AND zeroes
      // the per-turn counter before returning.
      expect(worker.illegalTransitionsThisTurn).toBe(0);
      expect(worker.turnId).toBe("turn-fsm-reset-next");
      // The send IPC fired (sanity: dispatchTurn actually took the
      // sendPrompt branch, not the queue branch which would `send` a
      // `prompts-pending` instead).
      expect(handle.send).toHaveBeenCalled();

      // (3) Post-reset: another illegal transition lands on the new turn.
      // The counter starts from 0, so it lands at 1 — NOT 2 (which would
      // be the regression if sendPrompt forgot to reset).
      await safeHandleEvent(
        worker as never,
        {
          type: "block-cancel",
          clientBlockId: "c-post-reset",
        } as never,
      );
      expect(worker.illegalTransitionsThisTurn).toBe(1);

      __deleteLiveWorkerForTest("fsm-agent");
    });
  });
});
