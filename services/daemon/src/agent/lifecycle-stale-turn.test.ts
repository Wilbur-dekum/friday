import { readFileSync } from "node:fs";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// FRI-33: stale-turn ceiling and IPC error boundary.
//
// Observed in prod: a worker stays on the same turn for ~12.5h before the
// daemon process exits with a `daemon.fatal`. The stall watchdog
// (`worker.turn.stalled`) misses these because the worker emits periodic
// block-stops; only the *turn* never ends. Two scoped defenses:
//
//   1. Hard ceiling on `msSinceTurnStart`. Any inbound IPC from a worker
//      whose turn has run past the ceiling triggers a force-kill and a
//      structured `worker.turn.stale-killed` log line.
//   2. Try/catch around the `status-change` IPC branch so a malformed
//      payload can't escape into the unhandled `child.on("message")`
//      listener and crash the daemon.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_stale" });
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
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    // pgid 0 → killPgrp no-ops, so we don't actually SIGTERM the test runner.
    pgid: 0,
    agentName: "stale-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-stale-1",
    sessionId: "sess-stale-1",
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
    ...overrides,
  };
  return { worker: w, handle };
}

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  code?: string;
  message?: string;
}

describe("lifecycle: stale-turn ceiling (FRI-33)", () => {
  it("force-kills worker when an inbound IPC reports msSinceTurnStart > 4h, emits structured log", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");

    const FIVE_HOURS = 5 * 60 * 60 * 1000;
    const { worker } = makeFakeWorker({
      turnId: "turn-stale-old",
      turnStart: Date.now() - FIVE_HOURS,
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const logSpy = vi.spyOn(logger, "log");

    // Heartbeats are a valid trigger per the proposal — any inbound IPC
    // gives the daemon a chance to notice the wedge.
    await handleEvent(worker as never, { type: "heartbeat" });
    unsub();

    // Structured log emitted with exact event name + agent + msSinceTurnStart.
    const staleLog = logSpy.mock.calls.find(([, event]) => event === "worker.turn.stale-killed");
    expect(staleLog).toBeDefined();
    const [level, , payload] = staleLog!;
    expect(level).toBe("warn");
    const p = payload as { agent: string; msSinceTurnStart: number; turnId: string };
    expect(p.agent).toBe("stale-agent");
    expect(p.turnId).toBe("turn-stale-old");
    expect(p.msSinceTurnStart).toBeGreaterThanOrEqual(FIVE_HOURS);

    // Force-kill ran: error block persisted with turn_timed_out code.
    const rows = await getDb()
      .select()
      .from(schema.blocks)
      .where(eq(schema.blocks.turnId, "turn-stale-old"));
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("error");
    const errPayload = rows[0].contentJson as { code: string; headline: string };
    expect(errPayload.code).toBe("turn_timed_out");
    expect(errPayload.headline).toContain("Turn timed out");

    // turn_done emitted with status=error (timed-out, not a clean abort).
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-stale-old");
    expect(done).toBeDefined();
    expect(done!.status).toBe("error");

    // FRI-145 M2: the stale-turn force-kill demoted this Generation — the live
    // map no longer holds it, so a subsequent IPC for this `worker` is a
    // Generation no-op (`live.get(name) !== worker`). This replaces the deleted
    // per-worker re-entry flag the dying worker's late IPC used to check.
    expect(isAgentLive("stale-agent")).toBe(false);

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("does NOT force-kill when msSinceTurnStart is well under the ceiling, and the event is still processed", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    // Pin lastHeartbeat to a stale-but-known value so we can prove the
    // handler ran (the heartbeat branch updates `w.lastHeartbeat = Date.now()`
    // — adversarial review N3: bare "no log emitted" assertions would also
    // pass against a no-op `handleEvent`, so anchor on a positive side-effect).
    const ANCIENT = Date.now() - 30 * 60 * 1000;
    const { worker } = makeFakeWorker({
      turnId: "turn-fresh",
      turnStart: Date.now() - 60_000, // 1 minute in
      lastHeartbeat: ANCIENT,
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");
    await handleEvent(worker as never, { type: "heartbeat" });

    expect(
      logSpy.mock.calls.find(([, event]) => event === "worker.turn.stale-killed"),
    ).toBeUndefined();
    // FRI-145 M2: no force-kill fired, so the worker is still the current
    // Generation in the live map (force-kill is what demotes it).
    expect(isAgentLive("stale-agent")).toBe(true);
    // Proves handleEvent actually executed past the ceiling check.
    expect((worker as { lastHeartbeat: number }).lastHeartbeat).toBeGreaterThan(ANCIENT);

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("ceiling check is idempotent: no duplicate error block, no duplicate turn_done on repeat IPC", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({
      turnId: "turn-stale-idem",
      turnStart: Date.now() - 10 * 60 * 60 * 1000, // 10h
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const logSpy = vi.spyOn(logger, "log");
    await handleEvent(worker as never, { type: "heartbeat" });
    await handleEvent(worker as never, { type: "heartbeat" });
    await handleEvent(worker as never, {
      type: "status-change",
      status: "idle",
    });
    unsub();

    const staleLogs = logSpy.mock.calls.filter(([, event]) => event === "worker.turn.stale-killed");
    expect(staleLogs.length).toBe(1);

    // Load-bearing: exactly one error block in the DB for this turn.
    const errorRows = await getDb()
      .select()
      .from(schema.blocks)
      .where(and(eq(schema.blocks.turnId, "turn-stale-idem"), eq(schema.blocks.kind, "error")));
    expect(errorRows.length).toBe(1);

    // Load-bearing: exactly one turn_done emitted for this turn.
    const turnDoneCount = captured.filter(
      (e) => e.type === "turn_done" && e.turn_id === "turn-stale-idem",
    ).length;
    expect(turnDoneCount).toBe(1);

    __deleteLiveWorkerForTest("stale-agent");
  });
});

describe("lifecycle: IPC handler error boundary (FRI-33)", () => {
  // Adversarial review B1: the boundary lives at the outer IPC handler
  // (`safeHandleEvent`), not inside any single switch branch — every branch
  // calls `eventBus.publish` and any branch could blow up the daemon. Test
  // the boundary itself by driving `safeHandleEvent` directly (same call
  // shape that `child.on("message")` uses in production).

  // Phase 5: the `status-change` branch no longer publishes (the
  // legacy `agent_status` SSE was retired); only branches that still
  // hit eventBus.publish are exercised here. `turn-complete` still
  // publishes turn_done.
  for (const [branch, event] of [
    ["turn-complete", { type: "turn-complete", sessionId: "sess-x" } as const],
  ] as const) {
    it(`logs worker.ipc.error and does not rethrow when ${branch} branch throws`, async () => {
      const { safeHandleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
        await import("./lifecycle.js");
      const { eventBus } = await import("../events/bus.js");
      const { logger } = await import("../log.js");

      const { worker } = makeFakeWorker({ turnId: `turn-ipc-${branch}` });
      __putLiveWorkerForTest("stale-agent", worker as never);

      // Make every publish throw — simulates a downstream subscriber
      // blowing up (the real-world crash shape: any sync exception in
      // publish() used to bubble out of child.on("message") into Node's
      // default uncaughtException handler).
      const publishSpy = vi.spyOn(eventBus, "publish").mockImplementation((() => {
        throw new Error(`synthetic publish failure (${branch})`);
      }) as never);

      const logSpy = vi.spyOn(logger, "log");

      await expect(safeHandleEvent(worker as never, event)).resolves.toBeUndefined();

      await vi.waitFor(
        () => {
          const found = logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.error");
          expect(found).toBeDefined();
        },
        { timeout: 5000, interval: 25 },
      );
      const ipcErr = logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.error");
      expect(ipcErr).toBeDefined();
      const [level, , payload] = ipcErr!;
      expect(level).toBe("error");
      const p = payload as { agent: string; type: string; err: string };
      expect(p.agent).toBe("stale-agent");
      expect(p.type).toBe(branch);
      expect(p.err).toContain(`synthetic publish failure (${branch})`);

      publishSpy.mockRestore();
      __deleteLiveWorkerForTest("stale-agent");
    });
  }

  it("safeHandleEvent passes through normally when nothing throws", async () => {
    const { safeHandleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({ turnId: "turn-ipc-passthrough" });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");
    await expect(safeHandleEvent(worker as never, { type: "heartbeat" })).resolves.toBeUndefined();

    // No error log on the happy path.
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.error")).toBeUndefined();

    __deleteLiveWorkerForTest("stale-agent");
  });
});

describe("lifecycle: turn-end clears w.turnStart (FRI-110)", () => {
  // FRI-110: the stale-turn watchdog reads `w.turnStart` on every inbound
  // IPC. Before this fix, `turnStart` was set at fork time and never
  // cleared on turn-complete — so a worker that finished a turn and then
  // sat idle for 4h+ emitting between-turns `status-change: idle` IPC
  // would get force-killed by the watchdog measuring against the
  // long-completed turn's start time. Fix: clear `turnStart = undefined`
  // at every turn-end exit. The watchdog and the diagnostic log already
  // gate on truthy, so an undefined value short-circuits cleanly.
  //
  // Stateful code needs stateful tests (CLAUDE.md): the bug lives at the
  // boundary between the turn-complete write and the next IPC's read, so
  // AC #3 spans both events. Per-handler unit tests on the clear alone
  // would not catch a regression where the clear lands but the watchdog
  // grows a new read site that misses the new invariant.

  it("does not force-kill when worker has been idle (status=idle, turnStart cleared) for 5h after a completed turn", async () => {
    const { handleEvent, isAgentLive, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    // The post-FRI-110 idle-between-turns shape: `turnStart` undefined,
    // status idle, `completedAtLeastOnce` true. The worker has been sitting
    // here for 5h (longer than the 4h stale ceiling) before a status-change
    // IPC arrives — the watchdog must not arithmetic against an undefined
    // timestamp.
    const { worker } = makeFakeWorker({
      status: "idle",
      turnStart: undefined,
      turnId: "turn-completed-old",
      completedAtLeastOnce: true,
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");
    await handleEvent(worker as never, { type: "status-change", status: "idle" });

    // The bug-site assertion: watchdog did NOT force-kill.
    expect(logSpy.mock.calls.find(([, ev]) => ev === "worker.turn.stale-killed")).toBeUndefined();
    // FRI-145 M2: no force-kill fired, so the worker remains the current
    // Generation in the live map.
    expect(isAgentLive("stale-agent")).toBe(true);

    // Diagnostic log emitted with `msSinceTurnStart: null` — this is the
    // ternary fallback at the diagnostic site that already gates on
    // truthy. Pins that the clear *propagates* to the next IPC's read,
    // not just that the field was written.
    const ipcRecv = logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.recv");
    expect(ipcRecv).toBeDefined();
    const [, , payload] = ipcRecv!;
    const p = payload as { msSinceTurnStart: number | null };
    expect(p.msSinceTurnStart).toBe(null);

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("turn-complete handler clears turnStart so the next idle IPC does not arithmetic against a stale value", async () => {
    // AC #3: the load-bearing cross-boundary assertion. Drive turn-complete,
    // then drive a follow-up status-change: idle, and prove the watchdog's
    // and diagnostic log's reads both see `turnStart` as falsy.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({
      status: "working",
      turnStart: Date.now() - 60_000,
      turnId: "turn-complete-clear",
      sessionId: "sess-x",
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    // First: drive turn-complete with the matching sessionId so the usage-
    // insertion branch is reached without an `e.usage` payload (we don't
    // care about usage here, just the state transition).
    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-x",
    });

    // Clear and status flipped.
    expect((worker as { turnStart?: number }).turnStart).toBeUndefined();
    expect((worker as { status: string }).status).toBe("idle");

    // Second (cross-boundary): drive a follow-up status-change: idle. The
    // diagnostic log entry for this IPC must show `msSinceTurnStart: null`
    // — proving the clear actually propagates to the read sites.
    const logSpy = vi.spyOn(logger, "log");
    await handleEvent(worker as never, { type: "status-change", status: "idle" });

    const ipcRecv = logSpy.mock.calls.find(([, ev]) => ev === "worker.ipc.recv");
    expect(ipcRecv).toBeDefined();
    const [, , payload] = ipcRecv!;
    const p = payload as { msSinceTurnStart: number | null };
    expect(p.msSinceTurnStart).toBe(null);

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("case error handler clears turnStart on turn-end", async () => {
    // AC #4: same guarantee as turn-complete, on the error path. The error
    // path also finalizes the turn and flips status idle; without this
    // clear, a 4h idle period after an errored turn would also reap.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { worker } = makeFakeWorker({
      status: "working",
      turnStart: Date.now() - 60_000,
      turnId: "turn-error-clear",
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    await handleEvent(
      worker as never,
      {
        type: "error",
        code: "synthetic",
        message: "synthetic",
        recoverable: false,
      } as never,
    );

    expect((worker as { turnStart?: number }).turnStart).toBeUndefined();
    expect((worker as { status: string }).status).toBe("idle");

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("spawnTurn-fresh LiveWorker has turnStart=undefined; first start-IPC dispatch sets it", () => {
    // AC #5: file-level static contract test for Change 2. The fork-time
    // `LiveWorker` literal no longer carries an unconditional `turnStart:
    // Date.now()` write — instead, the `child.once("message", …)` callback
    // (which fires when the worker emits `ready`) is the natural "first
    // turn dispatched" site and sets turnStart there. This grep matches
    // the change's bundle boundary at lower cost than spinning up a real
    // worker subprocess.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "lifecycle.ts"), "utf8");

    // Locate the spawnTurn LiveWorker literal. Anchor on the literal
    // declaration and stop before the `live.set` that closes the spawn
    // setup so we are looking at the fork-time object literal only.
    const literalStart = src.indexOf("const w: LiveWorker = {");
    expect(literalStart).toBeGreaterThan(-1);
    const literalEnd = src.indexOf("live.set(input.agentName, w);");
    expect(literalEnd).toBeGreaterThan(literalStart);
    const literalBlock = src.slice(literalStart, literalEnd);

    // The unconditional fork-time turnStart write is gone.
    expect(literalBlock).not.toMatch(/turnStart:\s*Date\.now\(\),/);
    // The literal explicitly initializes turnStart to undefined (so
    // the field is present and the type stays satisfied).
    expect(literalBlock).toMatch(/turnStart:\s*undefined,/);

    // The `child.once("message", …)` callback now sets turnStart before
    // sending `start`. Anchor on the once block and stop before the
    // restampQueuedUserBlock call that closes the setup region.
    const onceStart = src.indexOf('child.once("message"');
    expect(onceStart).toBeGreaterThan(-1);
    const onceEnd = src.indexOf("restampQueuedUserBlock(", onceStart);
    expect(onceEnd).toBeGreaterThan(onceStart);
    const onceBlock = src.slice(onceStart, onceEnd);
    expect(onceBlock).toMatch(/w\.turnStart\s*=\s*Date\.now\(\)/);
  });
});
