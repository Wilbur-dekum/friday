import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentType } from "@friday/shared";

/**
 * Per-worker bearer tokens for the worker→daemon tool plane (FRI-2037).
 *
 * The problem this solves is NOT "the worker needs a credential" — it already
 * had one, the shared daemon secret. It is that the daemon had no way to tell
 * WHICH worker was calling. `callerName` / `callerType` arrived as headers the
 * worker set for itself, so any worker holding the shared secret could claim
 * to be any agent. That was tolerable only because the secret also implied
 * "same host" and every worker was a child of this daemon; it stops being
 * tolerable the moment workers are containerised (FRI-2038) and it is what
 * blocks hosting `friday-agents` / `friday-reminder` / `friday-habit`, whose
 * `parentName` / `appId` are scoping values a worker must not get to assert.
 *
 * So a token is minted per worker at spawn and the daemon DERIVES the caller
 * from it. The worker never names itself again.
 *
 * Opaque and registry-backed rather than signed, deliberately:
 *
 *  - Revocation is the property that matters here. A worker's token must stop
 *    working the instant it exits, and a builder that finished an hour ago must
 *    not be able to act. A signed token cannot be withdrawn before its expiry
 *    without a revocation list, which is the registry again with extra steps.
 *  - Statelessness buys nothing: workers are children of this daemon and do
 *    not outlive it, so there is no restart to survive. If that ever changes
 *    (a worker container outliving a daemon restart), this becomes a table
 *    rather than a Map, and the shape here does not have to change.
 *
 * The token is NOT a replacement for the `authorizeSameHost` gate yet. Both
 * apply: the gate still requires the daemon secret and a loopback `Host`, and
 * the token identifies the caller. That ordering is deliberate — this change
 * is strictly stronger than what it replaces, and nothing is loosened until
 * FRI-2038 actually needs a non-loopback bind, at which point the Host layer
 * comes off and the token carries the boundary alone.
 */

export interface WorkerIdentity {
  callerName: string;
  callerType: AgentType;
  /** Scoping values a worker must never assert for itself. Empty today — the
   *  servers that need them are not hosted yet — but they belong here, derived
   *  from the mint, which is what makes hosting those servers safe. */
  parentName?: string;
  appId?: string;
}

/** token → the identity the daemon minted it for. */
const tokens = new Map<string, WorkerIdentity>();

/** Mint a token for a worker about to spawn. */
export function mintWorkerToken(identity: WorkerIdentity): string {
  // 256 bits from the CSPRNG; base64url so it is header- and env-safe.
  const token = randomBytes(32).toString("base64url");
  tokens.set(token, { ...identity });
  return token;
}

/**
 * Resolve a bearer token to the identity it was minted for.
 *
 * Constant-time over the CANDIDATE SET rather than a Map lookup: a plain
 * `tokens.get(token)` leaks, through timing, whether a guessed prefix matched
 * an existing key. The set is small (one entry per live worker), so the scan
 * costs nothing worth measuring.
 */
export function resolveWorkerToken(token: string | undefined): WorkerIdentity | null {
  if (!token) return null;
  const candidate = Buffer.from(token);
  let found: WorkerIdentity | null = null;
  for (const [known, identity] of tokens) {
    const expected = Buffer.from(known);
    if (expected.length !== candidate.length) continue;
    if (timingSafeEqual(expected, candidate)) found = identity;
  }
  return found;
}

/**
 * Revoke a worker's token. Called when the worker exits, so a token cannot
 * outlive the process it was minted for.
 */
export function revokeWorkerToken(token: string | undefined): void {
  if (token) tokens.delete(token);
}

/** Test-only: drop every token so cases cannot leak into each other. */
export function __resetWorkerTokensForTest(): void {
  tokens.clear();
}

/** Test/diagnostic: how many tokens are outstanding. */
export function liveWorkerTokenCount(): number {
  return tokens.size;
}
