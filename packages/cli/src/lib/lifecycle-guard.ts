/**
 * FRI-2006: `start` / `stop` / `restart` are thin aliases over `launchctl`
 * (ADR-034), and `launchctl` does not exist in a container.
 *
 * Measured before writing this: inside the compose stack `friday stop` printed
 * "stopping friday stack via launchd" and did nothing at all. Silently doing
 * nothing is the worst available behaviour — worse than erroring, because the
 * operator believes the stack is stopping.
 *
 * Under ADR-050 the container runtime owns the lifecycle: you `docker stop`, or
 * your orchestrator restarts the Deployment. So these verbs have no container
 * meaning to be given, and the honest thing is to say so and exit non-zero.
 *
 * `status` is deliberately NOT guarded — "is this running?" is a real question
 * in a container, and it is answered by probing rather than by launchctl.
 */
import pc from "picocolors";
import { isContainer } from "@friday/shared";

/**
 * Refuse a launchd-backed verb when there is no launchd. Returns true when the
 * caller should stop; the caller exits rather than this function doing it, so
 * the behaviour stays testable.
 */
export function refuseInContainer(verb: string, containerized: boolean = isContainer()): boolean {
  if (!containerized) return false;
  console.error(
    pc.red(`\`friday ${verb}\` is not available in a container.`) +
      `\n  Lifecycle belongs to the container runtime here (ADR-050): use ` +
      `\`docker compose ${verb === "restart" ? "restart" : verb}\`, or whatever ` +
      `restarts the Deployment in your orchestrator.` +
      `\n  \`friday status\` still works — it probes the stack rather than asking launchd.`,
  );
  return true;
}
