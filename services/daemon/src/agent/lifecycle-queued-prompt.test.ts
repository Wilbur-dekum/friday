import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkerHandle, type FakeWorkerHandle } from "./worker-handle.fake.js";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// Pending-message feature: a second POST /api/chat/turn while the worker
// is mid-turn lands as status='queued' in the blocks table and parks in
// the worker's `nextPrompts` FIFO. When the drain path eventually fires
// the queued prompt, the row flips to status='complete' with a fresh ts
// and a `block_meta_update` SSE event tells the dashboard to unpin the
// bubble and re-sort it inline.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_queued" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
});

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  block_id?: string;
  ts?: number;
  role?: string;
  kind?: string;
}

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
    // pgid 0 makes killPgrp a no-op — we never want the test to SIGTERM
    // a real process.
    pgid: 0,
    agentName: "queued-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "t_existing",
    sessionId: "sess-1",
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
    ...overrides,
  };
  return { worker: w, handle };
}

describe("lifecycle: queued user-block dispatch", () => {
  it("recordUserBlock(status='queued') persists status='queued' on the row", async () => {
    const { recordUserBlock } = await import("./block-injectors.js");
    const { getBlockById } = await import("@friday/shared/services");

    const { blockId } = await recordUserBlock({
      turnId: "t_q1",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "follow up while busy",
      source: "user_chat",
      status: "queued",
    });

    const row = await getBlockById(blockId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("queued");
    expect(row!.role).toBe("user");
    expect(row!.source).toBe("user_chat");
    const parsed = JSON.parse(row!.contentJson) as { text: string };
    expect(parsed.text).toBe("follow up while busy");
  });

  it("emits block_complete with status='queued' on SSE (so the dashboard pins it)", async () => {
    const { recordUserBlock } = await import("./block-injectors.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    await recordUserBlock({
      turnId: "t_q2",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "another queued",
      source: "user_chat",
      status: "queued",
    });
    unsub();

    const event = captured.find(
      (e) => e.type === "block_complete" && e.turn_id === "t_q2" && e.role === "user",
    );
    expect(event).toBeDefined();
    expect(event!.status).toBe("queued");
  });

  it("recordUserBlock(status='complete') for user_chat DOES emit SSE (cross-client echo)", async () => {
    // FRI-78 follow-up: the daemon now always publishes the canonical
    // `block_complete` SSE for user_chat completes. Previously suppressed
    // to defend the sending browser's optimistic-bubble dedup, but that
    // suppression denied the message to other connected clients (browser
    // B, mobile, etc.). The sending browser dedupes via
    // `chat.svelte.ts:confirmPending` instead.
    const { recordUserBlock } = await import("./block-injectors.js");
    const { eventBus } = await import("../events/bus.js");

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const { blockId, seq } = await recordUserBlock({
      turnId: "t_immediate",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "fires immediately",
      source: "user_chat",
      // status defaults to 'complete'
    });
    unsub();

    expect(seq).toBeGreaterThan(0);
    const blockCompletes = captured.filter(
      (e) =>
        e.type === "block_complete" &&
        e.turn_id === "t_immediate" &&
        e.block_id === blockId &&
        e.status === "complete" &&
        e.role === "user",
    );
    expect(blockCompletes).toHaveLength(1);
  });

  it("dispatchTurn queues a second prompt for a working worker and signals prompts-pending", async () => {
    const { dispatchTurn, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { worker, handle } = makeFakeWorker();
    __putLiveWorkerForTest("queued-agent", worker as never);

    dispatchTurn({
      agentName: "queued-agent",
      options: {
        agentName: "queued-agent",
        agentType: "orchestrator",
        workingDirectory: "/tmp/fake",
        systemPrompt: "sys",
        prompt: "queued prompt",
        turnId: "t_q3",
        model: "claude-opus-4-7",
        daemonPort: 8765,
        mode: "long-lived",
      },
      userBlockId: "block-q3",
    });

    // The worker is "working" — the prompt should land in nextPrompts.
    const w = worker as { nextPrompts: Array<{ turnId: string; userBlockId?: string }> };
    expect(w.nextPrompts).toHaveLength(1);
    expect(w.nextPrompts[0].turnId).toBe("t_q3");
    expect(w.nextPrompts[0].userBlockId).toBe("block-q3");
    // ...and the worker is nudged to break at next iteration boundary.
    expect(handle.send).toHaveBeenCalledWith({ type: "prompts-pending" });

    __deleteLiveWorkerForTest("queued-agent");
  });

  it("removeQueuedPrompt yanks an entry out of nextPrompts and returns it", async () => {
    const { dispatchTurn, removeQueuedPrompt, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    const { worker } = makeFakeWorker();
    __putLiveWorkerForTest("queued-agent", worker as never);
    dispatchTurn({
      agentName: "queued-agent",
      options: {
        agentName: "queued-agent",
        agentType: "orchestrator",
        workingDirectory: "/tmp/fake",
        systemPrompt: "sys",
        prompt: "to-cancel",
        turnId: "t_cancel",
        model: "claude-opus-4-7",
        daemonPort: 8765,
        mode: "long-lived",
      },
      userBlockId: "block-cancel",
    });

    const w = worker as { nextPrompts: unknown[] };
    expect(w.nextPrompts).toHaveLength(1);

    const removed = removeQueuedPrompt("queued-agent", "t_cancel");
    expect(removed?.turnId).toBe("t_cancel");
    expect(removed?.prompt).toBe("to-cancel");
    expect(w.nextPrompts).toHaveLength(0);

    // No live worker → null, no throw.
    expect(removeQueuedPrompt("nonexistent", "t_xxx")).toBeNull();

    __deleteLiveWorkerForTest("queued-agent");
  });

  it("queued → drained: the DB row's status + ts track the drain timestamp; no SSE meta event (Phase 5)", async () => {
    // Phase 5: the legacy `block_meta_update` SSE event is retired —
    // Zero replicates the row UPDATE to the dashboard's blocks slice.
    // The test asserts the canonical DB state (status='complete' + a
    // fresh ts strictly greater than the original POST ts) AND that
    // no SSE event of that type fires.
    const { recordUserBlock } = await import("./block-injectors.js");
    const { __putLiveWorkerForTest, __deleteLiveWorkerForTest } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getBlockById } = await import("@friday/shared/services");

    const { blockId } = await recordUserBlock({
      turnId: "t_drain",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "I waited my turn",
      source: "user_chat",
      status: "queued",
    });
    const beforeRow = await getBlockById(blockId);
    expect(beforeRow!.status).toBe("queued");
    const beforeTs = beforeRow!.ts;

    const { worker, handle } = makeFakeWorker({
      // Pretend a queued prompt is parked behind the in-flight turn.
      nextPrompts: [
        {
          prompt: "I waited my turn",
          turnId: "t_drain",
          userBlockId: blockId,
        },
      ],
    });
    __putLiveWorkerForTest("queued-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    // negative-space (clock-advance): the assertion below requires
    // afterRow.ts > beforeTs. Wall-clock has to actually move forward; a
    // bounded real-time sleep is the right primitive — neither vi.waitFor
    // nor vi.useFakeTimers helps with a strictly-increasing real ts.
    await new Promise((r) => setTimeout(r, 10));

    // Drive turn-complete on the live worker. The handler drains
    // nextPrompts → sendPrompt → restampQueuedUserBlock fires.
    const { handleEvent } = await import("./lifecycle.js");
    await handleEvent(
      worker as never,
      {
        type: "turn-complete",
        sessionId: "sess-1",
        usage: undefined,
      } as never,
    );
    // restampQueuedUserBlock is fire-and-forget — wait for the DB row
    // to flip to complete with a fresher ts.
    await vi.waitFor(
      async () => {
        const r = await getBlockById(blockId);
        expect(r!.status).toBe("complete");
        expect(r!.ts).toBeGreaterThan(beforeTs);
      },
      { timeout: 5000, interval: 25 },
    );

    unsub();
    __deleteLiveWorkerForTest("queued-agent");

    // No block_meta_update SSE event — Phase 5 retired it.
    expect(captured.find((e) => e.type === "block_meta_update")).toBeUndefined();

    const afterRow = await getBlockById(blockId);
    expect(afterRow!.status).toBe("complete");
    expect(afterRow!.ts).toBeGreaterThan(beforeTs);
    // The queued IPC ran too: the worker received `prompt` after the drain.
    expect(handle.send).toHaveBeenCalledWith(expect.objectContaining({ type: "prompt" }));
  });

  it("queued prompt drains with the LIVE w.sessionId, not the POST-time resumeSessionId (FRI-127 §6)", async () => {
    const { dispatchTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");

    // The worker has already moved its session on to "sess-NEW" (a prior turn
    // resolved + the session-update IPC updated w.sessionId).
    const { worker, handle } = makeFakeWorker({ sessionId: "sess-NEW", status: "working" });
    __putLiveWorkerForTest("queued-agent", worker as never);

    // A new turn is POSTed while the worker is mid-turn. The dispatch captures
    // the now-stale "sess-OLD" as its resumeSessionId.
    dispatchTurn({
      agentName: "queued-agent",
      options: {
        agentName: "queued-agent",
        agentType: "orchestrator",
        workingDirectory: "/tmp/fake",
        systemPrompt: "sys",
        prompt: "queued while busy",
        turnId: "t_qsess",
        model: "claude-opus-4-7",
        daemonPort: 8765,
        resumeSessionId: "sess-OLD",
        mode: "long-lived",
      },
      userBlockId: "block-qsess",
    });

    // It parked in nextPrompts (worker was working). It must NOT carry sess-OLD
    // verbatim — the choke-point at dispatchTurn prefers existing.sessionId.
    const w = worker as { nextPrompts: Array<{ resumeSessionId?: string }> };
    expect(w.nextPrompts).toHaveLength(1);
    expect(w.nextPrompts[0].resumeSessionId).toBe("sess-NEW");

    // Drive the drain via turn-complete (no usage; orchestrator → no backstop).
    await handleEvent(
      worker as never,
      { type: "turn-complete", sessionId: "sess-NEW", usage: undefined } as never,
    );

    // The IPC the worker actually received resumes the live session.
    const sentIpc = handle.send.mock.calls
      .map((c) => c[0] as { type?: string; options?: { resumeSessionId?: string } })
      .find((m) => m.type === "prompt");
    expect(sentIpc).toBeDefined();
    expect(sentIpc).toMatchObject({
      type: "prompt",
      options: { resumeSessionId: "sess-NEW" },
    });

    __deleteLiveWorkerForTest("queued-agent");
  });

  it("listQueuedUserBlocks returns queued rows in ts order (oldest first)", async () => {
    const { recordUserBlock } = await import("./block-injectors.js");
    const { listQueuedUserBlocks } = await import("@friday/shared/services");

    const before = Date.now();
    const { blockId: b1 } = await recordUserBlock({
      turnId: "t_old",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "older",
      source: "user_chat",
      status: "queued",
    });
    // negative-space (clock-advance): the assertion below requires the
    // two rows' ts values to strictly differ. Wall-clock has to actually
    // move; a bounded real-time sleep is the right primitive here.
    await new Promise((r) => setTimeout(r, 5));
    const { blockId: b2 } = await recordUserBlock({
      turnId: "t_new",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "newer",
      source: "user_chat",
      status: "queued",
    });
    // A complete row should NOT show up in the queued list.
    await recordUserBlock({
      turnId: "t_done",
      agentName: "queued-agent",
      sessionId: "sess-1",
      text: "already complete",
      source: "user_chat",
      status: "complete",
    });

    const rows = await listQueuedUserBlocks();
    const ours = rows.filter((r) => r.agentName === "queued-agent");
    expect(ours.map((r) => r.blockId)).toEqual([b1, b2]);
    expect(ours[0].ts).toBeGreaterThanOrEqual(before);
    expect(ours[1].ts).toBeGreaterThanOrEqual(ours[0].ts);
  });
});
