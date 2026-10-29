import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// FRI-12: Stop force-kill safety net. The d5b1f6e commit made Stop's UX
// correct *when the worker is responsive* — but in the wedge case (SDK
// stuck on a 529, the abort IPC silently ignored), the bubble would hang
// in 'stopping' forever waiting for a turn_done that never comes.
//
// `abortTurn` now schedules a 2s deadline. If the worker doesn't ack
// (turn-complete or error IPC) in time, `forceKillStuckWorker` finalizes
// the turn (error block + turn_done aborted) and SIGTERMs the process
// group. A worker that responds in time clears the deadline.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_fk" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    // pgid 0 makes killPgrp a no-op — we don't want the test to actually
    // SIGTERM anything in the test runner.
    pgid: 0,
    agentName: "fk-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-fk-1",
    sessionId: "sess-fk-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1000,
    spawnedAt: Date.now() - 5000,
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    ...overrides,
  };
  return { worker: w, handle };
}

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  block_id?: string;
  kind?: string;
  code?: string;
  abort_reason?: "cooperative" | "forced";
}

describe("lifecycle: stop force-kill safety net (FRI-12)", () => {
  it("force-kills the worker when abort IPC is ignored for 500ms", async () => {
    const { abortTurn, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    // fakeTimers controls setTimeout for the abort deadline. Async time
    // advance also flushes microtasks — required because forceKillStuckWorker
    // is now async (ADR-023) and the fire-and-forget chain inside the
    // timer callback resolves after pending Postgres writes commit.
    vi.useFakeTimers();
    const { worker, handle } = makeFakeWorker();
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    expect(await abortTurn("fk-agent")).toBe(true);
    expect(handle.send).toHaveBeenCalledWith({ type: "abort" });

    // Before the deadline, no force-kill yet.
    await vi.advanceTimersByTimeAsync(300);
    expect(captured.find((e) => e.type === "turn_done")).toBeUndefined();

    // After the 500ms deadline, force-kill fires. forceKillStuckWorker is
    // fire-and-forget from the setTimeout callback, so wait on the observable
    // signal (turn_done) instead of a fixed real-time sleep.
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await vi.waitFor(
      () =>
        expect(
          captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-1"),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    // Error block was inserted with stopped_forced.
    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-fk-1"));
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("error");
    const payload = rows[0].contentJson as Record<string, unknown>;
    expect(payload.code).toBe("stopped_forced");
    // FRI-66: copy distinguishes "cooperative abort" (SDK honored it,
    // healthy path) from "Stop forced" (SDK iterator wedged, abnormal).
    expect(payload.headline).toContain("Stop forced");
    expect(payload.headline).toContain("SDK did not honor abort");

    // turn_done aborted was published, tagged with the force-kill reason
    // (FRI-95: dashboard reads abort_reason to pick the right terminal copy).
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-1");
    expect(done).toBeDefined();
    expect(done!.status).toBe("aborted");
    expect(done!.abort_reason).toBe("forced");

    // TurnErrorEvent with the stopped_forced code published too.
    const err = captured.find((e) => e.type === "error" && e.code === "stopped_forced");
    expect(err).toBeDefined();

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("does NOT force-kill when worker emits turn-complete before the deadline", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-2" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await abortTurn("fk-agent");

    // Worker responds at 200ms with turn-complete (the SDK aborted cleanly).
    await vi.advanceTimersByTimeAsync(200);
    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-fk-1",
    });

    // Advance well past the 500ms deadline to confirm the timer was cleared.
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // Wait for the cooperative turn_done from handleEvent above — once it
    // lands, the entire turn-complete path (incl. any side effects) has run.
    await vi.waitFor(
      () =>
        expect(
          captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-2"),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    // No stopped_forced block — the worker cleaned up.
    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-fk-2"));
    const stoppedForced = rows.find((r) => {
      const p = r.contentJson as { code?: string } | null;
      return p?.code === "stopped_forced";
    });
    expect(stoppedForced).toBeUndefined();

    // No stopped_forced TurnErrorEvent.
    expect(captured.find((e) => e.type === "error" && e.code === "stopped_forced")).toBeUndefined();

    // FRI-95: cooperative-abort turn_done carries abort_reason="cooperative".
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-2");
    expect(done).toBeDefined();
    expect(done!.status).toBe("aborted");
    expect(done!.abort_reason).toBe("cooperative");

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("does NOT force-kill when worker emits error IPC before the deadline", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-3" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await abortTurn("fk-agent");

    await vi.advanceTimersByTimeAsync(200);
    // Worker emits error IPC because SDK threw an AbortError.
    await handleEvent(worker as never, {
      type: "error",
      message: "aborted",
      recoverable: true,
    });

    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // Wait for the cooperative turn_done from handleEvent's error path —
    // once it lands, the error handler (incl. error-event publish) has run.
    await vi.waitFor(
      () =>
        expect(
          captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-3"),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    // The worker's error path emits TurnErrorEvent with code='aborted'
    // (because abortRequested is true). No stopped_forced anywhere.
    const aborted = captured.find((e) => e.type === "error" && e.code === "aborted");
    expect(aborted).toBeDefined();
    expect(captured.find((e) => e.code === "stopped_forced")).toBeUndefined();

    // FRI-95: error-path cooperative abort tags turn_done with "cooperative".
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-3");
    expect(done).toBeDefined();
    expect(done!.status).toBe("aborted");
    expect(done!.abort_reason).toBe("cooperative");

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("force-kill at 500ms race: late turn-complete after force-kill is ignored", async () => {
    // Pathological: worker responds RIGHT after the 500ms timer fires. The
    // force-kill flow already ran; the late turn-complete must be a no-op
    // so we don't double-publish turn_done.
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-4" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await abortTurn("fk-agent");
    await vi.advanceTimersByTimeAsync(700);
    // Now force-kill has run. The worker, dying, emits one final turn-complete.
    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-fk-1",
    });
    vi.useRealTimers();
    // Wait for the force-kill's turn_done — async fire-and-forget chain.
    await vi.waitFor(
      () =>
        expect(
          captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-4"),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    const turnDoneEvents = captured.filter(
      (e) => e.type === "turn_done" && e.turn_id === "turn-fk-4",
    );
    expect(turnDoneEvents.length).toBe(1);
    expect(turnDoneEvents[0].status).toBe("aborted");

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("abortTurn returns false when no live worker matches", async () => {
    const { abortTurn } = await import("./lifecycle.js");
    expect(await abortTurn("not-a-real-agent")).toBe(false);
  });

  // FRI-95 A.1: the LISTEN handler races the fast-path. After the fast-path
  // already drove the worker to idle (clearing the deadline), the LISTEN
  // handler's redundant abortTurn() must NOT re-arm a fresh deadline on
  // the cooperative worker. Pre-fix this would force-kill a worker that
  // had already cleanly aborted ~30ms earlier — see the log evidence in
  // the FRI-95 ticket for a real recurrence.
  it("A.1: second abortTurn on an idle worker is a no-op (no IPC, no deadline, no force-kill)", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker, handle } = makeFakeWorker({ turnId: "turn-fk-a1" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    // Fast-path abort. Worker is working — full body runs (IPC sent, deadline armed).
    expect(await abortTurn("fk-agent")).toBe(true);
    expect(handle.send).toHaveBeenCalledWith({ type: "abort" });
    const ipcCallsAfterFirst = handle.send.mock.calls.length;
    expect((worker as { abortDeadline?: NodeJS.Timeout }).abortDeadline).toBeDefined();

    // Worker honors the abort — error IPC clears the deadline AND flips status to idle.
    await vi.advanceTimersByTimeAsync(30);
    await handleEvent(worker as never, {
      type: "error",
      message: "aborted",
      recoverable: true,
    });
    expect((worker as { status: string }).status).toBe("idle");
    expect((worker as { abortDeadline?: NodeJS.Timeout }).abortDeadline).toBeUndefined();

    // LISTEN handler fires the second abortTurn ~91ms after the fast-path
    // (matching the real-world log timing). With the A.1 gate this is a no-op.
    expect(await abortTurn("fk-agent")).toBe(false);
    // No new IPC sent — the gate short-circuited before send().
    expect(handle.send.mock.calls.length).toBe(ipcCallsAfterFirst);
    // No new deadline armed — would otherwise force-kill at +500ms.
    expect((worker as { abortDeadline?: NodeJS.Timeout }).abortDeadline).toBeUndefined();
    // abortRequested still latched (idempotent state, not destructive).
    expect((worker as { abortRequested: boolean }).abortRequested).toBe(true);

    // Advance well past the 500ms window — confirm no force-kill fires.
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // Wait for the cooperative turn_done from the error IPC handleEvent
    // above — once it lands the entire error-path side effect has run.
    await vi.waitFor(
      () =>
        expect(
          captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-a1"),
        ).toBeDefined(),
      { timeout: 5000, interval: 25 },
    );
    unsub();

    // No stopped_forced block, no stopped_forced error event.
    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-fk-a1"));
    const stoppedForced = rows.find((r) => {
      const p = r.contentJson as { code?: string } | null;
      return p?.code === "stopped_forced";
    });
    expect(stoppedForced).toBeUndefined();
    expect(captured.find((e) => e.code === "stopped_forced")).toBeUndefined();

    __deleteLiveWorkerForTest("fk-agent");
  });

  // FRI-95 A.2: a status-change → idle (without an accompanying
  // turn-complete or error) must also clear the deadline. Otherwise a
  // worker that exits its for-await before emitting turn-complete leaves
  // the safety net armed and gets force-killed despite being idle.
  it("A.2: status-change → idle clears the abort deadline", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-a2" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await abortTurn("fk-agent");
    expect((worker as { abortDeadline?: NodeJS.Timeout }).abortDeadline).toBeDefined();

    // Lone status-change → idle, no turn-complete or error.
    await vi.advanceTimersByTimeAsync(100);
    await handleEvent(worker as never, {
      type: "status-change",
      status: "idle",
    });

    expect((worker as { status: string }).status).toBe("idle");
    expect((worker as { abortDeadline?: NodeJS.Timeout }).abortDeadline).toBeUndefined();

    // Advance past 500ms — would have force-killed without A.2.
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // negative-space: status-change → idle publishes no turn_done — there is
    // no positive arrival event to await. clearAbortDeadline ran synchronously
    // inside handleEvent above, so the deadline timer is gone before the
    // timer-advance; the absence assertions below can fire immediately.
    unsub();

    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-fk-a2"));
    const stoppedForced = rows.find((r) => {
      const p = r.contentJson as { code?: string } | null;
      return p?.code === "stopped_forced";
    });
    expect(stoppedForced).toBeUndefined();
    expect(captured.find((e) => e.code === "stopped_forced")).toBeUndefined();

    __deleteLiveWorkerForTest("fk-agent");
  });
});
