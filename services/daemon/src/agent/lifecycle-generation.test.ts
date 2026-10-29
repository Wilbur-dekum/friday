/**
 * FRI-145 M2 — Generation = object identity.
 *
 * The Generation rule: a worker instance `w` is the *current* Generation of
 * its agent name iff `live.get(name) === w`. A Transition arriving from a
 * superseded Generation (a stale worker whose name was re-`live.set` by a
 * replacement, or already `live.delete`d by force-kill / archive / refork) is
 * a structural no-op — it must not write the Status projection, must not
 * delete the replacement's live entry, and must not re-finalize a turn.
 *
 * This rule replaces the two deleted LiveWorker flags — an intra-generation
 * re-entry / late-IPC guard and a cross-channel refork-suppress guard (both
 * documented in CONTEXT.md → "Agent turn lifecycle").
 *
 * These are stateful, layer-correct tests: they drive the real
 * `handleEvent` / `forceWorkerRefork` / `abortTurn` control flow against the
 * real live map and a real test Postgres (so the Status projection writes /
 * doesn't-write is observable on the actual `agents` row), mocking nothing
 * under test. Collaborators (`registry.setStatus`) are spied to pin the
 * "no stale write" half; the row read pins the durable post-state.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let lifecycle: typeof import("./lifecycle.js");
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_generation" });
  lifecycle = await import("./lifecycle.js");
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
  pid?: number;
}

/** A complete-enough LiveWorker double for the handleEvent / refork / abort
 *  paths driven below. `pgid: 0` makes killPgrp a no-op (no real SIGTERM). */
function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    pgid: 0,
    agentName: "gen-agent",
    agentType: "bare",
    model: "claude-opus-4-7",
    turnId: "turn-gen-1",
    sessionId: "sess-gen-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
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
  return { worker: w, handle };
}

describe("FRI-145 M2: Generation = object identity", () => {
  describe("(a) a superseded Generation's late IPC is a structural no-op", () => {
    it("late status-change from gen-A does NOT write agents.status; gen-B stays live", async () => {
      const NAME = "supersede-status";
      // gen-B is the current Generation: registered + live + working.
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");
      const { worker: genB } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genB",
        status: "working",
      });
      lifecycle.__putLiveWorkerForTest(NAME, genB as never);

      // gen-A is a stale worker instance for the SAME name that is no longer
      // the live entry (gen-B superseded it). It emits a late `idle`
      // status-change as it dies.
      const { worker: genA } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genA",
        status: "working",
      });

      const setStatusSpy = vi.spyOn(registry, "setStatus");

      await lifecycle.handleEvent(genA as never, { type: "status-change", status: "idle" });

      // Structural no-op: the stale gen-A status-change wrote NO projection.
      expect(setStatusSpy).not.toHaveBeenCalled();
      // Durable projection unchanged — still `working` from gen-B.
      expect((await registry.getAgent(NAME))?.status).toBe("working");
      // The live map still holds gen-B (not clobbered, not deleted).
      expect(lifecycle.peekLiveWorker(NAME)?.turnId).toBe("turn-genB");
      expect(lifecycle.isAgentLive(NAME)).toBe(true);

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });

    it("late error/turn-complete from gen-A publishes NO turn_done; gen-B stays live", async () => {
      const NAME = "supersede-terminal";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");
      const { worker: genB } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genB",
        status: "working",
      });
      lifecycle.__putLiveWorkerForTest(NAME, genB as never);

      const { eventBus } = await import("../events/bus.js");
      const captured: { type: string; turn_id?: string }[] = [];
      const unsub = eventBus.subscribe((e) =>
        captured.push(e as { type: string; turn_id?: string }),
      );

      const setStatusSpy = vi.spyOn(registry, "setStatus");

      // Stale gen-A late error, then late turn-complete — both for gen-A's
      // already-superseded turn.
      const { worker: genA } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genA",
        status: "working",
      });
      await lifecycle.handleEvent(
        genA as never,
        {
          type: "error",
          code: "late",
          message: "late error from dying gen-A",
          recoverable: false,
        } as never,
      );
      await lifecycle.handleEvent(
        genA as never,
        {
          type: "turn-complete",
          sessionId: "sess-genA",
        } as never,
      );
      unsub();

      // No turn_done for gen-A's turn (the Generation guard bailed before
      // publishing) — exactly the double-publish the old per-worker re-entry
      // flag prevented, now covered by the Generation no-op.
      expect(captured.filter((e) => e.type === "turn_done" && e.turn_id === "turn-genA")).toEqual(
        [],
      );
      // No projection write from the stale events.
      expect(setStatusSpy).not.toHaveBeenCalled();
      // gen-B is untouched.
      expect(lifecycle.peekLiveWorker(NAME)?.turnId).toBe("turn-genB");
      expect((await registry.getAgent(NAME))?.status).toBe("working");

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });

    it("late stale-turn prologue is skipped for a superseded gen-A (no force-kill cascade)", async () => {
      const NAME = "supersede-prologue";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");
      const { worker: genB } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genB",
      });
      lifecycle.__putLiveWorkerForTest(NAME, genB as never);

      const { logger } = await import("../log.js");
      const logSpy = vi.spyOn(logger, "log");

      // gen-A's turn is 5h old (would trip the 4h ceiling) — but it is a
      // superseded Generation, so the prologue's `isCurrentGeneration` gate
      // skips the stale-turn reaper entirely.
      const { worker: genA } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genA",
        turnStart: Date.now() - 5 * 60 * 60 * 1000,
      });
      await lifecycle.handleEvent(genA as never, { type: "heartbeat" });

      expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.turn.stale-killed")).toBeUndefined();
      // gen-B untouched.
      expect(lifecycle.peekLiveWorker(NAME)?.turnId).toBe("turn-genB");

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });
  });

  describe("(b) refork keeps the NEW Generation's live entry (name-keyed-delete clobber is gone)", () => {
    it("forceWorkerRefork deletes the OLD generation; a replacement set afterward survives", async () => {
      // This pins the latent `:446` bug the Generation rule fixes: the old
      // exit handler did an unconditional `live.delete(name)` that, if a
      // replacement Generation had already taken the name, would clobber the
      // replacement. We model the realistic ordering: refork removes genA,
      // a replacement genB is `live.set`, and a stale genA `exit`-shaped IPC
      // arriving afterward must NOT remove genB.
      const NAME = "refork-clobber";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");

      const { worker: genA, handle: handleA } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genA",
      });
      // Simulate the worker already gone so drainLiveWorker resolves
      // immediately (exitCode set → the early kill-pgrp branch returns).
      handleA.setAlive(false);
      lifecycle.__putLiveWorkerForTest(NAME, genA as never);

      // Refork tears down genA (live.delete) and writes idle.
      const drained = await lifecycle.forceWorkerRefork(NAME);
      expect(drained).toEqual([]);
      expect(lifecycle.isAgentLive(NAME)).toBe(false);
      expect((await registry.getAgent(NAME))?.status).toBe("idle");

      // A replacement Generation genB takes the name.
      const { worker: genB } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-genB",
        status: "working",
      });
      lifecycle.__putLiveWorkerForTest(NAME, genB as never);
      await registry.setStatus(NAME, "working");

      // Stale genA emits a late status-change (the shape a dying worker's IPC
      // takes). Under the old name-keyed logic this region would clobber the
      // live entry / projection; the Generation guard makes it a no-op.
      const setStatusSpy = vi.spyOn(registry, "setStatus");
      await lifecycle.handleEvent(genA as never, { type: "status-change", status: "idle" });

      // genB is STILL the live entry — the new-generation clobber is gone.
      expect(lifecycle.peekLiveWorker(NAME)?.turnId).toBe("turn-genB");
      expect(lifecycle.isAgentLive(NAME)).toBe(true);
      expect(setStatusSpy).not.toHaveBeenCalled();
      expect((await registry.getAgent(NAME))?.status).toBe("working");

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });
  });

  describe("(c) AC #17: abort-deadline-after-archive heals to archived (no idle clobber)", () => {
    it("a 500ms abort deadline firing AFTER archiveAgent does NOT write idle over archived", async () => {
      const NAME = "abort-after-archive";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");

      const { worker, handle } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-abort-archive",
        status: "working",
      });
      // Child already exited → archiveAgent's drainLiveWorker returns via the
      // early `exitCode !== null` branch (no real `child.once` on the double).
      handle.setAlive(false);
      lifecycle.__putLiveWorkerForTest(NAME, worker as never);

      vi.useFakeTimers();
      // Arm the 500ms force-kill deadline.
      expect(await lifecycle.abortTurn(NAME)).toBe(true);
      expect(handle.send).toHaveBeenCalledWith({ type: "abort" });

      // Spy AFTER the abort so we capture only writes from here on. Archive
      // runs first: it `live.delete`s NAME and writes `archived`.
      const setStatusSpy = vi.spyOn(registry, "setStatus");
      await lifecycle.archiveAgent(NAME, { reason: "abandoned" });
      expect(lifecycle.isAgentLive(NAME)).toBe(false);
      expect((await registry.getAgent(NAME))?.status).toBe("archived");

      // Now the abort deadline fires. forceKillStuckWorker(worker) runs, but
      // `live.get(NAME) !== worker` (archive deleted it) → Generation no-op.
      await vi.advanceTimersByTimeAsync(600);
      vi.useRealTimers();
      // Let any fire-and-forget chain settle.
      await new Promise((r) => setTimeout(r, 50));

      // The deadline's force-kill never wrote `idle` over `archived`.
      expect(setStatusSpy).not.toHaveBeenCalledWith(NAME, "idle");
      // Durable projection is still the terminal `archived`.
      expect((await registry.getAgent(NAME))?.status).toBe("archived");

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });

    it("the same abort deadline DOES finalize when no archive intervenes (control)", async () => {
      // Control for the test above: when the worker is still the current
      // Generation at deadline time, forceKillStuckWorker runs fully and
      // writes idle — proving the no-op in the archive case is the Generation
      // guard firing, not a dead deadline.
      const NAME = "abort-no-archive";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");

      const { worker } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-abort-plain",
        status: "working",
      });
      lifecycle.__putLiveWorkerForTest(NAME, worker as never);

      const { eventBus } = await import("../events/bus.js");
      const captured: { type: string; turn_id?: string; status?: string }[] = [];
      const unsub = eventBus.subscribe((e) =>
        captured.push(e as { type: string; turn_id?: string; status?: string }),
      );

      vi.useFakeTimers();
      expect(await lifecycle.abortTurn(NAME)).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      vi.useRealTimers();

      await vi.waitFor(
        () =>
          expect(
            captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-abort-plain"),
          ).toBeDefined(),
        { timeout: 5000, interval: 25 },
      );
      unsub();

      // Force-kill ran fully: live entry deleted, projection healed to idle.
      expect(lifecycle.isAgentLive(NAME)).toBe(false);
      expect((await registry.getAgent(NAME))?.status).toBe("idle");
      const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-abort-plain");
      expect(done?.status).toBe("aborted");

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });

    it("re-entry: a second forceKill path is a no-op after the first demotes the Generation", async () => {
      // The intra-generation idempotency the old per-worker re-entry flag gave
      // is now the Generation no-op: the first force-kill `live.delete`s, so any
      // racing second force-kill (e.g. a wedge IPC right behind the abort
      // deadline) sees `live.get(name) !== w` and bails. We exercise this via
      // two stale terminal IPCs after a real abort-deadline force-kill: they
      // must publish NO additional turn_done.
      const NAME = "reentry-idempotent";
      await registry.registerAgent({ name: NAME, type: "bare" });
      await registry.setStatus(NAME, "working");

      const { worker } = makeFakeWorker({
        agentName: NAME,
        turnId: "turn-reentry",
        status: "working",
      });
      lifecycle.__putLiveWorkerForTest(NAME, worker as never);

      const { eventBus } = await import("../events/bus.js");
      const captured: { type: string; turn_id?: string }[] = [];
      const unsub = eventBus.subscribe((e) =>
        captured.push(e as { type: string; turn_id?: string }),
      );

      vi.useFakeTimers();
      await lifecycle.abortTurn(NAME);
      await vi.advanceTimersByTimeAsync(600);
      vi.useRealTimers();
      await vi.waitFor(
        () =>
          expect(
            captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-reentry"),
          ).toBeDefined(),
        { timeout: 5000, interval: 25 },
      );

      // Exactly one turn_done from the force-kill so far.
      const before = captured.filter(
        (e) => e.type === "turn_done" && e.turn_id === "turn-reentry",
      ).length;
      expect(before).toBe(1);

      // The dying worker now emits late terminal IPCs. They are Generation
      // no-ops (the force-kill already `live.delete`d this worker).
      await lifecycle.handleEvent(
        worker as never,
        {
          type: "error",
          code: "late",
          message: "late",
          recoverable: false,
        } as never,
      );
      await lifecycle.handleEvent(
        worker as never,
        {
          type: "turn-complete",
          sessionId: "sess-reentry",
        } as never,
      );
      unsub();

      // Still exactly one turn_done — no double-publish.
      const after = captured.filter(
        (e) => e.type === "turn_done" && e.turn_id === "turn-reentry",
      ).length;
      expect(after).toBe(1);

      lifecycle.__deleteLiveWorkerForTest(NAME);
    });
  });
});
