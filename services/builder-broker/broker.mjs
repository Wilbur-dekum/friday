#!/usr/bin/env node
/**
 * Builder broker — the narrow privileged seam for FRI-2038.
 *
 * Per-task builder containers need something to create them. The obvious
 * implementation is mounting `/var/run/docker.sock` into the Deployment
 * container, and it is the wrong one: **Docker socket access is host-root
 * equivalent**, and that container also runs the unsandboxed orchestrator. It
 * would mean anything escaping into the Deployment escapes the host, which
 * guts the boundary FRI-2062 decided and FRI-2072 reinforced.
 *
 * So the socket lives HERE instead, in a process that does exactly one thing.
 * The daemon asks for a builder; it cannot ask for anything else.
 *
 * ## What makes this narrow rather than a socket by proxy
 *
 * A broker that forwards caller-supplied container specs is just the Docker
 * socket with extra steps. The caller therefore does NOT choose:
 *
 *  - the image — fixed by `BROKER_BUILDER_IMAGE`
 *  - the mounts — a per-builder named volume, nothing from the host
 *  - privileges — never `Privileged`, `CapAdd`, `PidMode`, `NetworkMode: host`
 *  - resource limits — fixed by broker config
 *  - the command — the image's own entrypoint
 *
 * It supplies a task id and a small allowlisted set of env values. Everything
 * else is the broker's to decide, which is what keeps the privilege
 * proportionate to the job.
 *
 * ## Deliberately dependency-free
 *
 * No npm packages. A privileged process is the last place to inherit a
 * dependency tree, and the Docker Engine API is plain HTTP over a unix
 * socket, so `node:http` is sufficient.
 */

import { createServer, request as httpRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";

const DOCKER_SOCK = process.env.BROKER_DOCKER_SOCKET ?? "/var/run/docker.sock";
const LISTEN_PORT = Number(process.env.BROKER_PORT ?? 7612);
const LISTEN_HOST = process.env.BROKER_HOST ?? "0.0.0.0";
/** The ONLY image a builder may run. Caller cannot influence it. */
const BUILDER_IMAGE = process.env.BROKER_BUILDER_IMAGE ?? "";
/** Shared secret the daemon presents. Required — the broker is privileged. */
const BROKER_TOKEN = process.env.BROKER_TOKEN ?? "";
/**
 * Network the builder joins, so it can reach the worker-facing listener.
 *
 * FRI-2039 expects this to be an `internal: true` Docker network: one with no
 * route off itself, which is what makes egress deny-by-default STRUCTURAL
 * rather than a rule something has to remember to apply. The cloud metadata
 * endpoint is then unreachable because there is no path to it.
 */
const BUILDER_NETWORK = process.env.BROKER_BUILDER_NETWORK ?? "";
/**
 * The allowlisted hole back out (FRI-2039): the daemon's CONNECT proxy.
 *
 * Set by the OPERATOR here, never by the caller — `ALLOWED_ENV` below does not
 * include the proxy variables, so a caller cannot point a builder at a proxy
 * of its own choosing and cannot unset them to try its luck directly. Unset
 * means no proxy is offered, which on an internal network is egress fully
 * closed.
 */
const EGRESS_PROXY = process.env.BROKER_EGRESS_PROXY ?? "";
const MEM_LIMIT_BYTES = Number(process.env.BROKER_MEM_LIMIT_BYTES ?? 2 * 1024 * 1024 * 1024);
const NANO_CPUS = Number(process.env.BROKER_NANO_CPUS ?? 2_000_000_000); // 2 CPUs
const PIDS_LIMIT = Number(process.env.BROKER_PIDS_LIMIT ?? 512);
/** Seconds Docker waits after SIGTERM before SIGKILL, when the caller says nothing. */
const DEFAULT_STOP_GRACE = 10;
const MAX_STOP_GRACE = 30;

/**
 * Env keys the daemon may set on a builder.
 *
 * An allowlist, not a filter: a caller that could set arbitrary env could set
 * `NODE_OPTIONS` and execute its own code at container start, which would
 * make the image restriction meaningless.
 */
const ALLOWED_ENV = new Set([
  "FRIDAY_WORKER_TOKEN",
  "FRIDAY_DAEMON_URL",
  "FRIDAY_AGENT_NAME",
  "FRIDAY_TASK_ID",
  // FRI-2076: the branch the worker checks out after cloning /workspace.
  "FRIDAY_WORKSPACE_BRANCH",
]);

/** Containers this broker started, so it only ever stops its own. */
const owned = new Map(); // taskId -> containerId

function fail(res, status, error) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function ok(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Constant-time bearer check. */
function authorized(req) {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return false;
  const m = /^Bearer (.+)$/i.exec(raw.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(BROKER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Call the Docker Engine API over its unix socket. */
function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCK,
        method,
        path,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const parsed = data ? safeJson(data) : undefined;
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(`docker ${method} ${path} -> ${res.statusCode}: ${data.slice(0, 200)}`),
            );
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** A task id must be safe to use as a container and volume name. */
/**
 * Hosts a builder must reach WITHOUT the proxy: the daemon itself.
 *
 * Derived from the proxy URL rather than configured separately, because they
 * are the same process — the daemon is both the API the worker calls and the
 * proxy it goes out through. Two settings that must agree is a way for them to
 * disagree.
 */
export function egressNoProxy(proxyUrl) {
  try {
    const host = new URL(proxyUrl).hostname;
    return ["localhost", "127.0.0.1", host].filter(Boolean).join(",");
  } catch {
    return "localhost,127.0.0.1";
  }
}

function validTaskId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(id);
}

/**
 * Build the container spec. Everything security-relevant is decided here, so
 * a reviewer can see the whole privilege surface in one place.
 */
export function buildContainerSpec(taskId, callerEnv) {
  const env = Object.entries(callerEnv ?? {})
    .filter(([k]) => ALLOWED_ENV.has(k))
    .map(([k, v]) => `${k}=${String(v)}`);
  if (EGRESS_PROXY) {
    // Both spellings: tools disagree on case, and a tool that reads neither
    // simply fails closed on an internal network, which is the right default.
    //
    // `NO_PROXY` carries the proxy's own host because that host is also the
    // daemon — the worker's API calls, git route and command channel all go
    // there, and routing them through CONNECT would refuse them (not on the
    // allowlist, and not port 443).
    const noProxy = egressNoProxy(EGRESS_PROXY);
    env.push(
      `HTTPS_PROXY=${EGRESS_PROXY}`,
      `https_proxy=${EGRESS_PROXY}`,
      `HTTP_PROXY=${EGRESS_PROXY}`,
      `http_proxy=${EGRESS_PROXY}`,
      `NO_PROXY=${noProxy}`,
      `no_proxy=${noProxy}`,
    );
  }
  return {
    Image: BUILDER_IMAGE,
    Env: env,
    Labels: { "friday.builder": "1", "friday.task": taskId },
    HostConfig: {
      // One named volume per task, for the worktree. Bounded to one
      // assignment, per FRI-2038 — not per turn, because `.git/hooks` and
      // `node_modules` survive a reattached volume anyway and claiming
      // per-turn ephemerality would be a guarantee we do not keep.
      Mounts: [
        {
          Type: "volume",
          Source: `friday-builder-${taskId}`,
          Target: "/workspace",
        },
      ],
      // Resource limits are cgroups here rather than Darwin-honoured
      // `ulimit`s, which is one of the upsides FRI-2038 names.
      Memory: MEM_LIMIT_BYTES,
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      // Explicitly NOT privileged, and no capabilities added. Stated rather
      // than omitted so a future edit has to delete a line that says why.
      Privileged: false,
      CapAdd: [],
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: false, // builds write outside /workspace (npm cache, tmp)
      AutoRemove: false, // teardown is explicit, so exit status is observable
      ...(BUILDER_NETWORK ? { NetworkMode: BUILDER_NETWORK } : {}),
    },
  };
}

async function createBuilder(req, res, body) {
  if (!BUILDER_IMAGE) return fail(res, 500, "BROKER_BUILDER_IMAGE is not configured");
  const { taskId, env } = body ?? {};
  if (!validTaskId(taskId))
    return fail(res, 400, "taskId must match /^[a-z0-9][a-z0-9_.-]{0,62}$/");
  if (owned.has(taskId)) return fail(res, 409, `builder already running for task ${taskId}`);

  const spec = buildContainerSpec(taskId, env);
  const created = await docker("POST", `/containers/create?name=friday-builder-${taskId}`, spec);
  const id = created?.Id;
  if (!id) return fail(res, 502, "docker did not return a container id");
  await docker("POST", `/containers/${id}/start`);
  owned.set(taskId, id);
  log("builder.created", { taskId, containerId: id.slice(0, 12) });
  return ok(res, { taskId, containerId: id });
}

async function inspectBuilder(res, taskId) {
  const id = owned.get(taskId);
  if (!id) return fail(res, 404, "no such builder");
  const info = await docker("GET", `/containers/${id}/json`);
  return ok(res, {
    taskId,
    running: Boolean(info?.State?.Running),
    exitCode: info?.State?.ExitCode ?? null,
  });
}

/**
 * Stop and remove a builder.
 *
 * `grace` is how the caller expresses urgency, and it is the only expression
 * available: a container has no process group an outside caller can signal, so
 * the daemon's SIGTERM/SIGKILL distinction arrives here as "give it the
 * default stop timeout" versus "none". The abort path's forced kill fires at
 * 500ms, and a fixed 10s stop would have made that deadline meaningless for a
 * containerised worker.
 */
async function deleteBuilder(res, taskId, graceParam) {
  const id = owned.get(taskId);
  // Idempotent: a teardown that races an exit must not 500.
  if (!id) return ok(res, { taskId, removed: false });
  const grace = clampGrace(graceParam);
  try {
    await docker("POST", `/containers/${id}/stop?t=${grace}`);
  } catch {
    // Already stopped is fine; the remove below is what matters.
  }
  await docker("DELETE", `/containers/${id}?v=1&force=1`);
  owned.delete(taskId);
  log("builder.removed", { taskId, containerId: id.slice(0, 12), grace });
  return ok(res, { taskId, removed: true });
}

/** Caller-supplied, so bounded here rather than trusted. */
export function clampGrace(raw) {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_STOP_GRACE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_STOP_GRACE;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_STOP_GRACE);
}

function log(event, fields) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), service: "builder-broker", event, ...fields }) +
      "\n",
  );
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d ? safeJson(d) : {}));
  });
}

export function startBroker() {
  if (!BROKER_TOKEN) {
    process.stderr.write("builder-broker: BROKER_TOKEN is required; refusing to start\n");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req)) return fail(res, 401, "bearer token required");
        const url = new URL(req.url ?? "/", "http://broker");
        const m = /^\/builders\/([^/]+)$/.exec(url.pathname);
        if (req.method === "POST" && url.pathname === "/builders") {
          return await createBuilder(req, res, await readBody(req));
        }
        if (req.method === "GET" && m) return await inspectBuilder(res, m[1]);
        if (req.method === "DELETE" && m)
          return await deleteBuilder(res, m[1], url.searchParams.get("grace"));
        return fail(res, 404, "not found");
      } catch (err) {
        log("broker.error", { message: err instanceof Error ? err.message : String(err) });
        return fail(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
  });
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    log("broker.listening", { host: LISTEN_HOST, port: LISTEN_PORT, image: BUILDER_IMAGE });
  });
  return server;
}

// Only start when run directly, so the spec builder stays unit-testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  startBroker();
}
