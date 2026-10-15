import { isContainer } from "@friday/shared";

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
  containerized: boolean = isContainer(),
): boolean {
  // Explicit wins in both directions — same knob the children already use.
  if (flag === "on") return true;
  if (flag === "off") return false;
  // Otherwise infer from the environment, NOT from being PID 1.
  //
  // FRI-2006: adding `init: true` put tini at PID 1 and moved the supervisor to
  // PID 7 — which silently switched this off and undid FRI-2053, with no error
  // anywhere. `isContainer()` reads FRIDAY_CONTAINER from the image, so it
  // survives anything that reshuffles the process tree.
  return containerized;
}
