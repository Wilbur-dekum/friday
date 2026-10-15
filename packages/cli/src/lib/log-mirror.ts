/**
 * Whether the supervisor mirrors logs to stdout (FRI-2053).
 *
 * Everything funnels to `~/.friday/logs/<service>.jsonl`. That is right under
 * launchd, whose plist already routes supervisor stdout to its own
 * StandardOutPath, and wrong in a container, where `docker logs` is the only
 * sink anyone can collect — and came back empty.
 *
 * Pure so the decision is testable without starting a supervisor.
 */
export function resolveMirrorToStdout(
  flag: string | undefined,
  pid: number = process.pid,
): boolean {
  // Explicit wins in both directions — same knob the children already use.
  if (flag === "on") return true;
  if (flag === "off") return false;
  // Otherwise infer from the role: a container runs the supervisor as init,
  // launchd never does. So a container gets logs with no configuration and
  // the laptop's behaviour is unchanged.
  return pid === 1;
}
