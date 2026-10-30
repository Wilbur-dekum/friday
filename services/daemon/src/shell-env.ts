/**
 * FRI-150 (pivot, ADR-037): per-agent shell-env capture.
 *
 * The MCP SDK's `StdioClientTransport` deliberately allowlists env vars at
 * the spawn boundary — only HOME/LOGNAME/PATH/SHELL/TERM/USER from
 * `process.env` pass through to MCP children
 * (`@modelcontextprotocol/sdk@1.29.0/dist/esm/client/stdio.js:8-24`). On a
 * launchd-spawned daemon, that PATH is launchd's minimal floor, and a
 * clean install (no brew-installed Node) can't resolve `node`/`npx` in any
 * spawned MCP.
 *
 * The trust gradient (per ADR-037):
 *
 *   ~/.friday/.env         — closed config object, daemon-private secrets
 *   process.env (daemon)   — NO secrets (loadFridayConfig replaces dotenv pollution),
 *                            just operational vars + worker-fork inheritance
 *   worker process         — runs `$SHELL -ilc` at startup to capture user shell env
 *                            (no Friday secrets — they were never in process.env)
 *   Claude Code CLI        — worker passes the captured env into the SDK `query()`
 *                            `options.env` (`{ ...process.env, ...capturedShellEnv }`)
 *                            in buildQueryOptions → the CLI process gets the user's
 *                            interactive PATH/toolchain, not the daemon's launchd floor
 *   agent's Bash calls     — inherit the CLI process env → user shell env (full).
 *                            NOTE: the SDK `env` REPLACES its process.env default, so
 *                            the spread of process.env is load-bearing (keeps Friday's
 *                            operational vars + creds). Before FRI-150's env-injection
 *                            this was aspirational: nothing wired the capture into the
 *                            agent env, so a launchd-started daemon left the agent's
 *                            Bash on the minimal PATH (couldn't find `gh`/brew tools).
 *   MCP children           — RESTRICTED via per-server `env`: PATH + locale + toolchain
 *                            hints + manifest env + FRIDAY_APP_DIR (not the full capture)
 *
 * Pattern adopted from VS Code's `src/vs/platform/shell/node/shellEnv.ts`:
 * cold-start spawn the user's `$SHELL` as an interactive login shell, ask
 * Node to JSON.stringify(process.env), parse, cache.
 *
 * Capture lives in the worker entry (`services/daemon/src/agent/worker.ts`),
 * NOT at daemon boot — each forked worker captures its own. Per-worker-process
 * singleton; long-lived agents amortize the cost across many turns.
 *
 * Failure mode is well-understood territory (VS Code issue #113869,
 * "Unable to resolve your shell environment in a reasonable time"): on
 * timeout, non-zero shell exit, missing markers, or unparseable JSON we
 * fall back to a sanitized `process.env` snapshot and emit a structured
 * warning. The worker keeps going.
 *
 * Defense-in-depth: even though the worker's `process.env` should be free of
 * daemon secrets (loadFridayConfig refactor), `sanitizeEnv` strips
 * secret-shaped keys from both the input env handed to the spawned shell
 * AND the parsed output before caching. A user's `.zshrc` doing
 * `export GITHUB_TOKEN=...` still doesn't make it into MCP child env.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isContainer } from "@friday/shared";
import { logger } from "./log.js";

export const SHELL_ENV_TIMEOUT_ENV_VAR = "FRIDAY_SHELL_ENV_TIMEOUT_MS";
const START_MARKER = "__FRIDAY_SHELL_ENV_START__";
const END_MARKER = "__FRIDAY_SHELL_ENV_END__";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * B1: secret-shaped keys we never let cross the daemon ↔ shell-child or
 * daemon ↔ MCP-child boundary. The pattern catches `*_SECRET`, `*_TOKEN`,
 * `*_API_KEY`, `*_PASSWORD`, `*_PASSWD`, `*_PASSPHRASE`, `*_PRIVATE_KEY`,
 * `*_CREDENTIAL[S]`. Reviewer-named keys (BETTER_AUTH_SECRET,
 * ZERO_AUTH_SECRET, ZERO_ADMIN_PASSWORD, LINEAR_API_KEY, ANTHROPIC_API_KEY)
 * are all matched by the suffix rule.
 *
 * Exported for use in tests + so adversarial reviewers can audit the
 * filter shape without spelunking through the module.
 */
export const SECRET_LIKE_KEY_RE =
  /(?:^|_)(SECRET|SECRETS|TOKEN|API_KEY|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|CREDENTIAL|CREDENTIALS)$/i;

/**
 * B1: explicit secret-bearing keys whose name doesn't match the regex above
 * but which we know carry credentials in their value (e.g. Postgres URLs
 * with embedded passwords).
 */
export const EXPLICIT_SECRET_KEYS = new Set<string>([
  "DATABASE_URL",
  "ZERO_UPSTREAM_DB",
  // FRI-2012: containerisation moved configuration into the environment, so
  // keys that only ever lived in files now ride in `process.env`. Measured in
  // the compose stack: the daemon carries DATABASE_URL *and*
  // FRIDAY_ADMIN_DATABASE_URL, and the latter is the SUPERUSER connection —
  // on ADR-051's shared cluster that one credential reaches every
  // Deployment's database.
  "FRIDAY_ADMIN_DATABASE_URL",
  // The age identity decrypts the whole secrets vault; the file variant names
  // a path a worker could simply read.
  "FRIDAY_AGE_IDENTITY",
  "FRIDAY_AGE_IDENTITY_FILE",
  // Not a credential but a delegated capability: with the agent socket a
  // worker — or a postinstall script inside one — authenticates as the
  // operator to any host or repository their keys reach.
  "SSH_AUTH_SOCK",
]);

/**
 * FRI-2012: suffix patterns for families rather than individual names, so a
 * key added later is caught without anyone remembering to extend the list.
 * `*_DATABASE_URL` is the one that bit us — the explicit entry above covers
 * today's name, this covers tomorrow's.
 */
export const SECRET_LIKE_SUFFIX_RE = /_(DATABASE_URL|CONNECTION_STRING|DSN|IDENTITY)$/i;

/**
 * B1: predicate the in/out gates use to decide whether a key carries a
 * secret. Exported for tests.
 */
export function isSecretKey(key: string): boolean {
  return (
    EXPLICIT_SECRET_KEYS.has(key) || SECRET_LIKE_KEY_RE.test(key) || SECRET_LIKE_SUFFIX_RE.test(key)
  );
}

/**
 * B1: strip secret-shaped keys from an env map. Used both as the OUTPUT
 * gate (after parsing the captured JSON, before caching) and as the
 * INPUT gate (when handing `process.env` to the spawned shell child).
 * Belt-and-suspenders: either gate failing alone would have been the
 * leak, both have to fail simultaneously for a regression to land.
 */
export function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!isSecretKey(k)) out[k] = v;
  }
  return out;
}

/**
 * B1: NodeJS.ProcessEnv-typed variant for `child_process.spawn`'s `env`
 * field. Filters secrets out of `process.env` before handing it to the
 * spawned shell — the shell child never sees `BETTER_AUTH_SECRET` /
 * `LINEAR_API_KEY` / etc., so a malicious `.zshrc` can't exfiltrate
 * them via `JSON.stringify(process.env)` or any other mechanism.
 */
export function sanitizedProcessEnvForChild(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !isSecretKey(k)) out[k] = v;
  }
  return out;
}

/**
 * The ONLY secret-shaped keys the Claude Code child keeps (FRI-2059).
 *
 * FRI-2012 established that the boundary worth defending is one level deeper
 * than the worker: the env handed to the Claude Code child, which the agent's
 * Bash tool and everything it spawns inherit. That is where untrusted
 * repository code actually runs — and it was getting raw `process.env`,
 * because the existing sanitizer strips these four along with everything else
 * and the CLI cannot authenticate without them.
 *
 * So this is a deny-list with a named exception rather than a blanket strip.
 * Each entry is here because the CLI genuinely needs it AND the deny-list
 * would otherwise take it. A non-secret key like `ANTHROPIC_BASE_URL` passes
 * through on its own and must not be listed — an exception that excepts
 * nothing makes the list look like it is doing more than it is. A test
 * enforces both halves.
 *
 * RESIDUAL RISK, stated rather than implied: whatever the CLI holds, its own
 * children inherit, so the Anthropic credential does reach the Bash tool. We
 * cannot scrub a process we do not spawn. Narrowing that further means a
 * credential proxy, not a longer list — out of scope here, and the reason
 * this list must stay short.
 */
export const CLAUDE_CLI_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * `process.env` for the Claude Code child: secrets stripped, the CLI's own
 * credentials kept.
 *
 * Distinct from `sanitizedProcessEnvForChild`, which has no exceptions and is
 * right for the shell-capture child — that one only has to run `.zshrc`, so
 * it needs no Anthropic credential at all.
 */
export function claudeCodeChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== "string") continue;
    if (!isSecretKey(k) || CLAUDE_CLI_CREDENTIAL_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export type ShellEnvSource = "shell" | "process";

export interface ShellEnvResult {
  /** The resolved env. On `source === "process"` this is a snapshot of process.env. */
  env: Record<string, string>;
  source: ShellEnvSource;
  /** Resolved shell path on success; the path we attempted on capture failure; undefined when we couldn't detect any shell at all. */
  shell?: string;
  /** Reason for fallback when `source === "process"`. */
  fallbackReason?: string;
  durationMs: number;
}

let cached: ShellEnvResult | undefined;

/** Test-only: clear the singleton. Prefixed underscore to match repo idioms. */
export function __resetForTests(): void {
  cached = undefined;
}

/**
 * Return the cached shell-env result. Falls back to a `process.env`
 * snapshot if `captureShellEnv` was never called (defensive — every
 * caller should rely on the daemon boot path having seeded it).
 */
export function getResolvedShellEnv(): ShellEnvResult {
  if (cached) return cached;
  return {
    env: snapshotProcessEnv(),
    source: "process",
    fallbackReason: "not-captured",
    durationMs: 0,
  };
}

// FRI-150 (pivot, ADR-037): `serializeShellEnv` / `serializeShellEnvForWorker`
// / `loadResolvedShellEnvFromJson` retired with the move from daemon-boot
// capture + worker-fork forwarding to per-worker capture. Each worker
// now calls `captureShellEnv()` directly at startup. The F5 ARG_MAX guard
// has no use site (no env-var forwarding); the round-trip primitives
// have no caller.

export interface CaptureOptions {
  /** Override the env var-derived timeout. */
  timeoutMs?: number;
  /** Override shell detection (testing only). */
  shellOverride?: string;
  /** Inject a spawn implementation (testing only). */
  spawnImpl?: typeof spawn;
  /** Inject an existsSync implementation (testing only). */
  existsImpl?: typeof existsSync;
}

/**
 * Run the user's `$SHELL` once to capture the env it would hand a fresh
 * interactive login shell. Cached as a module singleton — call once at
 * boot. On any failure mode, returns a `process.env` snapshot and emits
 * a `daemon.shell-env.fallback` warning event.
 */
export async function captureShellEnv(opts: CaptureOptions = {}): Promise<ShellEnvResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? readTimeoutFromEnv() ?? DEFAULT_TIMEOUT_MS;
  const exists = opts.existsImpl ?? existsSync;
  const spawnFn = opts.spawnImpl ?? spawn;
  // FRI-2008: a container has no human-configured interactive login shell, so
  // the capture can only spawn a bare shell, pay the startup cost, and return
  // approximately `process.env` anyway. Worse, it makes the worker's
  // environment a function of whatever dotfiles happen to exist in the image —
  // unbounded and machine-dependent, which cannot stand once a worker runs
  // untrusted customer code. Skip straight to the process snapshot.
  if (!opts.shellOverride && isContainer()) {
    cached = fallback({ reason: "containerized", start });
    return cached;
  }

  const shell = opts.shellOverride ?? resolveShellPath(exists);

  if (!shell) {
    cached = fallback({ reason: "no-shell-detected", start });
    return cached;
  }

  try {
    const env = await runCapture(shell, timeoutMs, spawnFn);
    const durationMs = Date.now() - start;
    const newKeys = Object.keys(env)
      .filter((k) => !(k in process.env))
      .sort();
    cached = { env, source: "shell", shell, durationMs };
    // F4: do NOT log the full PATH at info level — a user grepping their
    // launchd.out.log shouldn't see their entire directory layout on
    // every daemon boot. `pathLength` + `newKeyCount` + `shell` is
    // enough breadcrumb to confirm the capture worked.
    logger.log("info", "daemon.shell-env.captured", {
      shell,
      durationMs,
      newKeyCount: newKeys.length,
      pathLength: typeof env.PATH === "string" ? env.PATH.length : 0,
    });
    return cached;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    cached = fallback({ reason, start, shell });
    return cached;
  }
}

function readTimeoutFromEnv(): number | undefined {
  const raw = process.env[SHELL_ENV_TIMEOUT_ENV_VAR];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function snapshotProcessEnv(): Record<string, string> {
  // B1: the fallback path also feeds MCP-child `env`, so secrets must be
  // stripped here too. Otherwise a shell-capture failure would still leak
  // BETTER_AUTH_SECRET, LINEAR_API_KEY, … through `getResolvedShellEnv()`
  // into spawned MCP children.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !isSecretKey(k)) out[k] = v;
  }
  return out;
}

function fallback(input: { reason: string; start: number; shell?: string }): ShellEnvResult {
  const durationMs = Date.now() - input.start;
  logger.log("warn", "daemon.shell-env.fallback", {
    reason: input.reason,
    shell: input.shell,
    durationMs,
  });
  return {
    env: snapshotProcessEnv(),
    source: "process",
    shell: input.shell,
    fallbackReason: input.reason,
    durationMs,
  };
}

/**
 * Detect the user's interactive shell. `$SHELL=/bin/sh` on weird launchd
 * boots is a useless signal — sh won't source zsh/bash rc files — so we
 * explicitly prefer `/bin/zsh`, then `/bin/bash`, before falling back to
 * a non-sh `$SHELL`.
 */
function resolveShellPath(exists: typeof existsSync): string | undefined {
  const fromEnv = process.env.SHELL;
  const isUseless = !fromEnv || fromEnv === "/bin/sh" || !exists(fromEnv);
  if (!isUseless) return fromEnv;
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

interface ShellInvocation {
  flags: string[];
  script: string;
}

function buildInvocation(shellPath: string): ShellInvocation {
  const name = basename(shellPath);
  const script = `node -e 'process.stdout.write("\\n${START_MARKER}\\n"+JSON.stringify(process.env)+"\\n${END_MARKER}\\n")'`;
  // VS Code shell-flag matrix from src/vs/platform/shell/node/shellEnv.ts.
  // bash/zsh/sh need both -i (run .bashrc/.zshrc) and -l (run .profile/.zprofile)
  // — neither alone covers what a fresh terminal session sees.
  switch (name) {
    case "pwsh":
    case "powershell":
      // PowerShell's quoting differs enough that we use a single-quoted JSON
      // emitter. `Out-Host` is the closest stdout-write equivalent for the
      // marker / JSON payload.
      return {
        flags: ["-Login", "-Command"],
        script: `node -e "process.stdout.write('\\n${START_MARKER}\\n'+JSON.stringify(process.env)+'\\n${END_MARKER}\\n')"`,
      };
    case "tcsh":
    case "csh":
      return { flags: ["-ic"], script };
    case "nu":
    case "fish":
      // NIT-2: nushell + fish parse their short flags individually — `-ilc`
      // is read as a single unknown flag and the shell errors out. VS Code's
      // matrix passes them as separate arguments.
      return { flags: ["-i", "-l", "-c"], script };
    case "bash":
    case "zsh":
    case "sh":
    default:
      return { flags: ["-ilc"], script };
  }
}

function runCapture(
  shellPath: string,
  timeoutMs: number,
  spawnFn: typeof spawn,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const { flags, script } = buildInvocation(shellPath);
    const child = spawnFn(shellPath, [...flags, script], {
      stdio: ["ignore", "pipe", "pipe"],
      // B1 INPUT gate: hand a sanitized env to the spawned shell so
      // `JSON.stringify(process.env)` (or any other rc-file behavior)
      // cannot exfiltrate Friday's secrets. Paired with the OUTPUT
      // gate inside the parse path below — both must fail simultaneously
      // for a secret to leak through to an MCP child.
      env: sanitizedProcessEnvForChild(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (op: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      op();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
        reject(new Error(`shell-env capture timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err: Error) => {
      finish(() => reject(err));
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (code !== 0) {
        finish(() => {
          const tail = stderr.trim().slice(-200);
          reject(
            new Error(
              `shell exited code=${code} signal=${signal ?? "none"}${tail ? `; stderr: ${tail}` : ""}`,
            ),
          );
        });
        return;
      }
      // F3: use `lastIndexOf` for BOTH markers so a noisy rc-file that
      // happens to echo the literal marker string before the real
      // payload (corporate startup banners, sourced log scripts, etc.)
      // can't beat the real markers. The real `JSON.stringify(process.env)`
      // payload is always the last marker pair emitted.
      const startIdx = stdout.lastIndexOf(START_MARKER);
      const endIdx = stdout.lastIndexOf(END_MARKER);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        finish(() => reject(new Error("markers not found in shell output")));
        return;
      }
      const json = stdout.slice(startIdx + START_MARKER.length, endIdx).trim();
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>;
        // B1 OUTPUT gate: strip secret-shaped keys from the parsed env
        // before resolving. Even if the spawned shell somehow re-introduces
        // a secret (rc file exports `BETTER_AUTH_SECRET=foo` on its own),
        // it never reaches the cache or any MCP child's `env`.
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && !isSecretKey(k)) env[k] = v;
        }
        finish(() => resolve(env));
      } catch (err) {
        finish(() =>
          reject(
            new Error(`JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`),
          ),
        );
      }
    });
  });
}
