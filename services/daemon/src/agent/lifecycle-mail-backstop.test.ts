/**
 * FRI-127 §5 / AC#11: mail-back backstop. A helper/builder that completes a
 * turn with content but without an outbound `mail_send` to its parent triggers
 * Option B (single-fire re-dispatch) on the first miss, then falls through to
 * Option C (structured warning log + `worker.no-mail-back` SSE event, no
 * re-dispatch) on the SECOND consecutive miss. A turn that DID mail the parent
 * resets the guard + streak.
 *
 * The detection counter increments at block-stop (where the tool_use input —
 * and thus `to` — is finalized), well before turn-complete, so there is no
 * race against an in-flight mail_send.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_mail_backstop" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  // FRI-145 M6: the block-stream accumulator (open blocks + the per-turn
  // `closed` set) is module-global. Tests in this file reuse turnId `t_h1` +
  // clientBlockId `b1`, so without a reset the second test's block-start hits
  // the per-block state machine's already-started/already-closed guard. Clear
  // it between cases.
  const { __resetForTest } = await import("./block-stream.js");
  __resetForTest();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeHelperWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  handle: FakeWorkerHandle;
} {
  const handle = fakeWorkerHandle();
  const w = {
    handle,
    pgid: 0,
    agentName: "helper-1",
    agentType: "helper",
    model: "claude-opus-4-7",
    parentName: "friday",
    turnId: "t_h1",
    sessionId: "sess-h",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1_000,
    spawnedAt: Date.now() - 5_000,
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    blocksThisTurn: 2,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
  return { worker: w, handle };
}

interface CapturedEvent {
  type: string;
  agent?: string;
  turn_id?: string;
  streak?: number;
}

async function driveTurnComplete(worker: unknown): Promise<void> {
  const { handleEvent } = await import("./lifecycle.js");
  await handleEvent(
    worker as never,
    { type: "turn-complete", sessionId: "sess-h", usage: undefined } as never,
  );
}

describe("mail-back backstop (FRI-127 §5)", () => {
  it("first no-mail-back miss re-dispatches exactly one nudge (Option B)", async () => {
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");
    const { worker, handle } = makeHelperWorker();
    __putLiveWorkerForTest("helper-1", worker as never);

    await driveTurnComplete(worker);

    const promptIpcs = handle.send.mock.calls
      .map((c) => c[0] as { type?: string; options?: { prompt?: string } })
      .filter((m) => m.type === "prompt");
    expect(promptIpcs).toHaveLength(1);
    expect(promptIpcs[0].options?.prompt).toMatch(/mail your parent/i);

    const w = worker as { noMailBackNudgedThisTurn: boolean; noMailBackStreak: number };
    expect(w.noMailBackNudgedThisTurn).toBe(true);
    expect(w.noMailBackStreak).toBe(1);

    __deleteLiveWorkerForTest("helper-1");
  });

  it("second consecutive miss does NOT re-dispatch; emits Option-C warning log + SSE with streak 2", async () => {
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");

    // Worker is mid-second-miss: the first nudge already fired (guard set,
    // streak 1), and this turn again produced content without mailing back.
    const { worker, handle } = makeHelperWorker({
      noMailBackNudgedThisTurn: true,
      noMailBackStreak: 1,
      turnId: "t_h2",
    });
    __putLiveWorkerForTest("helper-1", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));
    const logSpy = vi.spyOn(logger, "log");

    await driveTurnComplete(worker);

    // (a) no re-dispatch.
    const promptIpcs = handle.send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "prompt",
    );
    expect(promptIpcs).toHaveLength(0);

    // (b) structured warning log with streak 2.
    const warnCall = logSpy.mock.calls.find((c) => c[1] === "worker.no-mail-back-streak");
    expect(warnCall).toBeDefined();
    expect(warnCall![2]).toMatchObject({ agent: "helper-1", streak: 2 });

    // (c) SSE event published with {agent, turn_id, streak: 2}.
    const sse = captured.find((e) => e.type === "worker.no-mail-back");
    expect(sse).toMatchObject({ agent: "helper-1", turn_id: "t_h2", streak: 2 });

    logSpy.mockRestore();
    unsub();
    __deleteLiveWorkerForTest("helper-1");
  });

  it("a turn WITH mail_send(to=parent) resets the guard + streak; no nudge", async () => {
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");

    // The child reported home this turn (mailSendToParentThisTurn > 0) while a
    // prior miss had already armed the guard.
    const { worker, handle } = makeHelperWorker({
      mailSendToParentThisTurn: 1,
      noMailBackNudgedThisTurn: true,
      noMailBackStreak: 1,
    });
    __putLiveWorkerForTest("helper-1", worker as never);

    await driveTurnComplete(worker);

    const promptIpcs = handle.send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "prompt",
    );
    expect(promptIpcs).toHaveLength(0);

    const w = worker as { noMailBackNudgedThisTurn: boolean; noMailBackStreak: number };
    expect(w.noMailBackNudgedThisTurn).toBe(false);
    expect(w.noMailBackStreak).toBe(0);

    __deleteLiveWorkerForTest("helper-1");
  });

  it("block-stop counts a mail_send to the literal parent name", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeHelperWorker();
    __putLiveWorkerForTest("helper-1", worker as never);

    // Emit a block-start then a block-stop for a mail_send tool_use targeting
    // the parent. FRI-145 M6: the block-stream per-block state machine rejects
    // a block-stop with no preceding block-start (BLOCK_NOT_STARTED), so the
    // start is required — a real worker always emits start→stop. The counter
    // increment (at block-stop, before bsClose) is the unit under test.
    await handleEvent(
      worker as never,
      { type: "block-start", clientBlockId: "b1", kind: "tool_use", blockIndex: 0 } as never,
    );
    await handleEvent(
      worker as never,
      {
        type: "block-stop",
        clientBlockId: "b1",
        status: "complete",
        contentJson: JSON.stringify({
          tool_use_id: "tu_1",
          name: "mcp__friday-mail__mail_send",
          input: { to: "friday", body: "found X" },
        }),
      } as never,
    );

    expect((worker as { mailSendToParentThisTurn: number }).mailSendToParentThisTurn).toBe(1);
    __deleteLiveWorkerForTest("helper-1");
  });

  it("block-stop counts a mail_send to the symbolic `parent` recipient", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeHelperWorker();
    __putLiveWorkerForTest("helper-1", worker as never);

    // M6: block-start required before block-stop (BLOCK_NOT_STARTED otherwise).
    await handleEvent(
      worker as never,
      { type: "block-start", clientBlockId: "b1", kind: "tool_use", blockIndex: 0 } as never,
    );
    await handleEvent(
      worker as never,
      {
        type: "block-stop",
        clientBlockId: "b1",
        status: "complete",
        contentJson: JSON.stringify({
          tool_use_id: "tu_1",
          name: "mcp__friday-mail__mail_send",
          input: { to: "parent", body: "found X" },
        }),
      } as never,
    );

    expect((worker as { mailSendToParentThisTurn: number }).mailSendToParentThisTurn).toBe(1);
    __deleteLiveWorkerForTest("helper-1");
  });

  it("block-stop does NOT count a mail_send to a non-parent recipient", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { worker } = makeHelperWorker();
    __putLiveWorkerForTest("helper-1", worker as never);

    // M6: block-start required before block-stop (BLOCK_NOT_STARTED otherwise).
    await handleEvent(
      worker as never,
      { type: "block-start", clientBlockId: "b1", kind: "tool_use", blockIndex: 0 } as never,
    );
    await handleEvent(
      worker as never,
      {
        type: "block-stop",
        clientBlockId: "b1",
        status: "complete",
        contentJson: JSON.stringify({
          tool_use_id: "tu_1",
          name: "mcp__friday-mail__mail_send",
          input: { to: "some-other-agent", body: "hi" },
        }),
      } as never,
    );

    expect((worker as { mailSendToParentThisTurn: number }).mailSendToParentThisTurn).toBe(0);
    __deleteLiveWorkerForTest("helper-1");
  });

  it("no backstop for a zero-block turn (the wedge detector owns that case)", async () => {
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");
    const { worker, handle } = makeHelperWorker({ blocksThisTurn: 0 });
    __putLiveWorkerForTest("helper-1", worker as never);

    await driveTurnComplete(worker);

    const promptIpcs = handle.send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "prompt",
    );
    expect(promptIpcs).toHaveLength(0);
    expect((worker as { noMailBackStreak: number }).noMailBackStreak).toBe(0);

    __deleteLiveWorkerForTest("helper-1");
  });

  it("no backstop for an orchestrator (no parent)", async () => {
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");
    const { worker, handle } = makeHelperWorker({
      agentType: "orchestrator",
      parentName: undefined,
    });
    __putLiveWorkerForTest("helper-1", worker as never);

    await driveTurnComplete(worker);

    const promptIpcs = handle.send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "prompt",
    );
    expect(promptIpcs).toHaveLength(0);

    __deleteLiveWorkerForTest("helper-1");
  });
});
