/**
 * Are we running inside a container?
 *
 * Needed in several places that must behave differently there — a read-only
 * secret mount is not the shared-machine exposure the permission check was
 * written for; there is no interactive login shell to capture; `docker logs`
 * is the only collectable sink.
 *
 * An explicit env var rather than inspecting PID, because **the signal has to
 * propagate**. Only the supervisor is PID 1; the daemon, the dashboard and
 * every forked worker are its descendants, so a `process.pid === 1` test is
 * silently false in exactly the processes that most need the answer. The
 * Dockerfile sets `FRIDAY_CONTAINER=1` once and child env inheritance carries
 * it everywhere.
 *
 * PID 1 remains as a fallback so an image built elsewhere, or a supervisor
 * started by hand under `docker run`, still gets the right answer.
 */
export function isContainer(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): boolean {
  const flag = env.FRIDAY_CONTAINER;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return pid === 1;
}
