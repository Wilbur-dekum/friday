import { describe, expect, it } from "vitest";
import { resolveDaemonBaseUrl } from "./config.js";

/**
 * FRI-2037 — the worker→daemon base URL is configuration, not a constant.
 *
 * `daemonFetch` hardcoded `http://127.0.0.1:<port>`, which every Friday MCP
 * tool funnels through. A worker in its own container (FRI-2038) resolves
 * `127.0.0.1` to itself, so that constant is one half of the seam this ticket
 * makes explicit.
 */
describe("resolveDaemonBaseUrl", () => {
  it("defaults byte-identically to the constant it replaced", () => {
    // The whole safety argument for this change: laptop and single-container
    // behaviour must not move. If this ever differs from
    // `http://127.0.0.1:${port}`, the default has drifted.
    expect(resolveDaemonBaseUrl(7610, {})).toBe("http://127.0.0.1:7610");
  });

  it("honours FRIDAY_DAEMON_URL when set", () => {
    expect(resolveDaemonBaseUrl(7610, { FRIDAY_DAEMON_URL: "http://friday-daemon:7610" })).toBe(
      "http://friday-daemon:7610",
    );
  });

  it("strips trailing slashes so paths do not double up", () => {
    // Every caller passes a path with a leading `/`; a configured value ending
    // in `/` would produce `http://host//api/...`.
    expect(resolveDaemonBaseUrl(7610, { FRIDAY_DAEMON_URL: "http://friday-daemon:7610/" })).toBe(
      "http://friday-daemon:7610",
    );
    expect(resolveDaemonBaseUrl(7610, { FRIDAY_DAEMON_URL: "http://friday-daemon:7610///" })).toBe(
      "http://friday-daemon:7610",
    );
  });

  it("ignores an empty or whitespace value rather than producing a bare path", () => {
    // An unset-but-present env var is common in compose files. Treating "" as
    // configured would make every URL path-relative and fail obscurely.
    expect(resolveDaemonBaseUrl(7610, { FRIDAY_DAEMON_URL: "" })).toBe("http://127.0.0.1:7610");
    expect(resolveDaemonBaseUrl(7610, { FRIDAY_DAEMON_URL: "   " })).toBe("http://127.0.0.1:7610");
  });
});
