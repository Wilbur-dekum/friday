import { vi, type Mock } from "vitest";
import type { WorkerHandle } from "./worker-runtime.js";

/**
 * Test double for a {@link WorkerHandle} (FRI-2037).
 *
 * Before the runtime seam, every lifecycle test hand-rolled
 * `{ send: vi.fn(), exitCode, killed }` and cast it onto `LiveWorker.child`.
 * Ten files carried their own copy, each asserting against the raw
 * `ChildProcess` shape — so the tests were coupled to HOW a worker runs, which
 * is exactly what the seam exists to decouple.
 *
 * This replaces all ten. It is also strictly more capable than what it
 * replaces: the old doubles could not deliver events, so a test wanting to
 * observe an exit had to reach for real subprocesses or skip the case. Here
 * `emitExit` / `emitMessage` drive the listeners directly.
 *
 * Liveness is a settable flag rather than `exitCode`/`killed`, because the
 * seam's contract is "is it alive", not "what node property says so" — a
 * container runtime has neither field.
 */
export interface FakeWorkerHandle extends WorkerHandle {
  send: Mock<(msg: unknown) => void>;
  terminate: Mock<(signal: "SIGTERM" | "SIGKILL") => Promise<void>>;
  terminateDescendants: Mock<(signal: "SIGTERM" | "SIGKILL") => Promise<number>>;
  /** Flip what `isAlive()` reports. */
  setAlive(alive: boolean): void;
  /** Fire the registered exit listeners (both `onExit` and `onceExit`). */
  emitExit(code?: number | null, signal?: NodeJS.Signals | null): void;
  /** Fire the registered message listeners, including the one-shot. */
  emitMessage(raw: unknown): void;
}

export function fakeWorkerHandle(
  opts: { pid?: number; alive?: boolean; descendantsKilled?: number } = {},
): FakeWorkerHandle {
  let alive = opts.alive ?? true;
  const messageListeners: Array<(raw: unknown) => void> = [];
  const onceMessageListeners: Array<() => void> = [];
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const onceExitListeners: Array<() => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];

  const handle: FakeWorkerHandle = {
    pid: opts.pid ?? 0,
    send: vi.fn<(msg: unknown) => void>(),
    terminate: vi.fn<(signal: "SIGTERM" | "SIGKILL") => Promise<void>>(async () => {
      // Terminating stops the worker, so liveness has to follow — otherwise a
      // test's second `isAlive()` would still say true and the force-kill
      // paths would look like they double-signal.
      alive = false;
    }),
    terminateDescendants: vi.fn<(signal: "SIGTERM" | "SIGKILL") => Promise<number>>(
      async () => opts.descendantsKilled ?? 0,
    ),
    onMessage: (cb) => void messageListeners.push(cb),
    onceMessage: (cb) => void onceMessageListeners.push(cb),
    onError: (cb) => void errorListeners.push(cb),
    onExit: (cb) => void exitListeners.push(cb),
    onceExit: (cb) => void onceExitListeners.push(cb),
    isAlive: () => Promise.resolve(alive),
    setAlive: (v) => {
      alive = v;
    },
    emitExit: (code = 0, signal = null) => {
      alive = false;
      for (const cb of exitListeners) cb(code, signal);
      // `once` semantics: fire and clear, so a second exit cannot re-run them.
      const once = onceExitListeners.splice(0);
      for (const cb of once) cb();
    },
    emitMessage: (raw) => {
      for (const cb of messageListeners) cb(raw);
      const once = onceMessageListeners.splice(0);
      for (const cb of once) cb();
    },
  };
  return handle;
}
