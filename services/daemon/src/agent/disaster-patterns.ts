/**
 * Catastrophe-pattern checks for Bash tool calls (M1 in the Builder
 * sandboxing plan). Sits behind the realpath containment check in
 * `workspace-guard.ts` and rejects Bash commands that would do
 * irrecoverable damage outside the workspace even when the absolute-path
 * scan misses them (tilde-prefixed paths, recursive `rm`, `git push
 * --force origin main`, persistence-write redirections, package-manager
 * lifecycle scripts, etc.).
 *
 * Scoped to honest-but-mistaken models. Not an adversarial sandbox — a
 * model intentionally hiding intent via shell tricks will defeat these.
 * The kernel-level `sandbox-exec` profile (M2) is the backstop.
 */

import { parse } from "shell-quote";
import { homedir } from "node:os";
import { basename } from "node:path";

const HOME = homedir();

/** Paths a Builder must never write to. Tilde-expanded at load time. */
const WRITE_DENY_PREFIXES: string[] = [
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gcloud`,
  `${HOME}/.kube`,
  `${HOME}/.docker`,
  `${HOME}/.gnupg`,
  `${HOME}/.netrc`,
  `${HOME}/.config/gh`,
  `${HOME}/.config/git`,
  `${HOME}/.config/fish`,
  `${HOME}/Library/LaunchAgents`,
  `${HOME}/Library/LaunchDaemons`,
  `/Library/LaunchAgents`,
  `/Library/LaunchDaemons`,
  `${HOME}/Library/Keychains`,
  `/Library/Keychains`,
  `/etc`,
];

const WRITE_DENY_LITERALS = new Set<string>([
  `${HOME}/.zshrc`,
  `${HOME}/.zprofile`,
  `${HOME}/.bashrc`,
  `${HOME}/.bash_profile`,
  `${HOME}/.profile`,
]);

/** Binaries with no legitimate Builder use; persistence/privilege footguns. */
const BINARY_DENY = new Set<string>([
  "launchctl",
  "crontab",
  "at",
  "defaults",
  "pmset",
  "osascript",
  "sudo",
  "su",
  "tccutil",
]);

/** Package managers that run lifecycle scripts unconditionally on install. */
const PKG_MANAGERS_UNSAFE_BY_DEFAULT = new Set<string>(["npm", "yarn"]);
const PKG_INSTALL_SUBCMDS = new Set<string>(["install", "i", "add"]);

const PROTECTED_BRANCHES = new Set<string>(["main", "master", "HEAD"]);

/** Sequence/pipeline operators that delimit logical commands. */
const SEQUENCE_OPS = new Set<string>([";", "&&", "||", "|", "&"]);

/** File-redirection operators; their immediate-next token is the target. */
const REDIRECT_OPS = new Set<string>([">", ">>", "<", "<<", "<<<", "&>", "&>>"]);

const WORKSPACE_MARKER = ".friday-workspace.json";

// ─────────────────────────────────────────────────────────────────────────
// Token normalization

interface Tok {
  kind: "arg" | "op" | "subst";
  value?: string;
  op?: string;
}

function expandTilde(s: string): string {
  if (s === "~") return HOME;
  if (s.startsWith("~/")) return HOME + s.slice(1);
  return s;
}

/**
 * `shell-quote.parse` outputs `$(...)` as a token sequence:
 *   `"$", {op: "("}, ...inner..., {op: ")"}`.
 * Collapse those into a single `{kind: "subst"}` marker so callers can
 * reason about argument positions.
 */
function normalizeTokens(raw: ReadonlyArray<unknown>): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === "$" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next && typeof next === "object" && (next as { op?: string }).op === "(") {
        let depth = 1;
        i += 1;
        while (i + 1 < raw.length && depth > 0) {
          i++;
          const inner = raw[i];
          if (inner && typeof inner === "object") {
            const innerOp = (inner as { op?: string }).op;
            if (innerOp === "(") depth++;
            else if (innerOp === ")") depth--;
          }
        }
        out.push({ kind: "subst" });
        continue;
      }
    }
    if (typeof t === "string") {
      out.push({ kind: "arg", value: expandTilde(t) });
    } else if (t && typeof t === "object") {
      const op = (t as { op?: string }).op;
      if (typeof op === "string") {
        out.push({ kind: "op", op });
      }
    }
  }
  return out;
}

function splitCommands(tokens: Tok[]): Tok[][] {
  const cmds: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of tokens) {
    if (t.kind === "op" && SEQUENCE_OPS.has(t.op!)) {
      if (cur.length) cmds.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) cmds.push(cur);
  return cmds;
}

interface ParsedCommand {
  /** Positional argv. Indices for which the original token was a `$(...)`
   *  substitution carry the empty string here; check `substAt` for the flag. */
  argv: string[];
  substAt: boolean[];
  /** Files appearing as redirection targets (>, >>, <, etc.). */
  redirectTargets: string[];
  redirectSubst: boolean[];
}

function parseCommand(tokens: Tok[]): ParsedCommand {
  const argv: string[] = [];
  const substAt: boolean[] = [];
  const redirectTargets: string[] = [];
  const redirectSubst: boolean[] = [];
  let pendingRedirect = false;
  for (const t of tokens) {
    if (t.kind === "op") {
      if (REDIRECT_OPS.has(t.op!)) pendingRedirect = true;
      continue;
    }
    if (pendingRedirect) {
      pendingRedirect = false;
      if (t.kind === "arg") {
        redirectTargets.push(t.value!);
        redirectSubst.push(false);
      } else {
        redirectTargets.push("");
        redirectSubst.push(true);
      }
      continue;
    }
    if (t.kind === "arg") {
      argv.push(t.value!);
      substAt.push(false);
    } else {
      argv.push("");
      substAt.push(true);
    }
  }
  return { argv, substAt, redirectTargets, redirectSubst };
}

// ─────────────────────────────────────────────────────────────────────────
// Path helpers

function startsWithPath(p: string, root: string): boolean {
  return p === root || p.startsWith(root + "/");
}

/**
 * `.git/hooks`, anywhere — including INSIDE the worktree (FRI-2042).
 *
 * Every other deny path is absolute and outside the workspace. This one is
 * the inversion: a path the Builder otherwise owns, denied because of what
 * git does with it. A hook dropped here re-executes on the next
 * checkout/commit, and it survives on the reattached worktree volume — which
 * is the specific mechanism that makes per-turn container ephemerality
 * illusory, and why FRI-2038 states its guarantee as "bounded to one
 * assignment" rather than per-turn.
 *
 * Relative as well as absolute, because the worker's cwd IS the worktree, so
 * `.git/hooks/post-checkout` is the form this actually takes.
 */
const GIT_HOOKS_SEGMENT = /(^|\/)\.git\/hooks(\/|$)/;

function isGitHooksPath(p: string): boolean {
  return GIT_HOOKS_SEGMENT.test(p);
}

function isUnderDenyPath(p: string): boolean {
  if (WRITE_DENY_LITERALS.has(p)) return true;
  if (isGitHooksPath(p)) return true;
  return WRITE_DENY_PREFIXES.some((d) => startsWithPath(p, d));
}

/**
 * Treat anything that doesn't start with the workspace path as outside.
 * Relative paths are treated as inside — the worker's cwd is the worktree
 * and the SDK enforces that, so a bare `node_modules` is inside.
 * Empty-variable-expansion (`$UNSET/`) lands in shell-quote as `/` — that's
 * absolute and not under the workspace, so it's correctly flagged.
 */
function isOutsideWorkspace(p: string, workspaceReal: string): boolean {
  if (!p) return true;
  if (!p.startsWith("/")) return false;
  return !startsWithPath(p, workspaceReal);
}

// ─────────────────────────────────────────────────────────────────────────
// Rule checks

function checkBinary(cmd: ParsedCommand): string | null {
  if (cmd.substAt[0]) {
    return `Bash blocked — command itself is a command substitution ($(...))`;
  }
  const bin = basename(cmd.argv[0] ?? "");
  if (BINARY_DENY.has(bin)) {
    return `Bash blocked — "${bin}" is on the disaster-prevention deny list`;
  }
  return null;
}

function checkRm(cmd: ParsedCommand, workspaceReal: string): string | null {
  if (basename(cmd.argv[0] ?? "") !== "rm") return null;

  const positional: { value: string; subst: boolean }[] = [];
  let recursive = false;
  for (let i = 1; i < cmd.argv.length; i++) {
    const a = cmd.argv[i];
    const isSubst = cmd.substAt[i];
    if (!isSubst && a.startsWith("-")) {
      if (a === "--recursive") recursive = true;
      else if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a)) recursive = true;
    } else {
      positional.push({ value: a, subst: isSubst });
    }
  }
  // Workspace marker protection (rule 8) — even non-recursive `rm`
  // mustn't wipe the marker file.
  for (const p of positional) {
    if (!p.subst && basename(p.value) === WORKSPACE_MARKER) {
      return `rm blocked — refusing to remove ${WORKSPACE_MARKER} (worker identity marker)`;
    }
  }
  if (!recursive) return null;
  for (const p of positional) {
    if (p.subst) {
      return `rm -r blocked — argument is a command substitution ($(...))`;
    }
    if (isOutsideWorkspace(p.value, workspaceReal)) {
      return `rm -r blocked — argument "${p.value}" resolves outside workspace`;
    }
  }
  return null;
}

function checkFind(cmd: ParsedCommand, workspaceReal: string): string | null {
  if (basename(cmd.argv[0] ?? "") !== "find") return null;
  const hasDelete = cmd.argv.includes("-delete");
  let hasExecRm = false;
  for (let i = 0; i < cmd.argv.length - 1; i++) {
    if (cmd.argv[i] === "-exec" && basename(cmd.argv[i + 1] ?? "") === "rm") {
      hasExecRm = true;
      break;
    }
  }
  if (!hasDelete && !hasExecRm) return null;
  // The starting path is the first positional after `find` that doesn't
  // start with `-`. There can be multiple; check all.
  const startPaths: { value: string; subst: boolean }[] = [];
  for (let i = 1; i < cmd.argv.length; i++) {
    const a = cmd.argv[i];
    if (a.startsWith("-")) break;
    startPaths.push({ value: a, subst: cmd.substAt[i] });
  }
  if (startPaths.length === 0) {
    return `find -delete/-exec rm blocked — no starting path specified`;
  }
  for (const p of startPaths) {
    if (p.subst) {
      return `find -delete/-exec rm blocked — starting path is a command substitution ($(...))`;
    }
    if (isOutsideWorkspace(p.value, workspaceReal)) {
      return `find -delete/-exec rm blocked — starting path "${p.value}" resolves outside workspace`;
    }
  }
  return null;
}

function checkRedirectTargets(cmd: ParsedCommand): string | null {
  for (let i = 0; i < cmd.redirectTargets.length; i++) {
    const t = cmd.redirectTargets[i];
    if (cmd.redirectSubst[i]) continue;
    if (isUnderDenyPath(t)) {
      return `Bash blocked — redirection target "${t}" is under a protected path`;
    }
  }
  return null;
}

function checkCpMv(cmd: ParsedCommand): string | null {
  const bin = basename(cmd.argv[0] ?? "");
  if (bin !== "cp" && bin !== "mv") return null;
  // Positional args = non-flag tokens.
  const positional: { value: string; subst: boolean }[] = [];
  for (let i = 1; i < cmd.argv.length; i++) {
    const a = cmd.argv[i];
    const isSubst = cmd.substAt[i];
    if (!isSubst && a.startsWith("-")) continue;
    positional.push({ value: a, subst: isSubst });
  }
  if (positional.length < 2) return null;
  // Last positional is the destination for cp/mv.
  const dest = positional[positional.length - 1];
  if (dest.subst) {
    return `${bin} blocked — destination is a command substitution ($(...))`;
  }
  if (isUnderDenyPath(dest.value)) {
    return `${bin} blocked — destination "${dest.value}" is under a protected path`;
  }
  return null;
}

function checkTee(cmd: ParsedCommand): string | null {
  if (basename(cmd.argv[0] ?? "") !== "tee") return null;
  for (let i = 1; i < cmd.argv.length; i++) {
    const a = cmd.argv[i];
    if (!cmd.substAt[i] && a.startsWith("-")) continue;
    if (cmd.substAt[i]) {
      return `tee blocked — argument is a command substitution ($(...))`;
    }
    if (isUnderDenyPath(a)) {
      return `tee blocked — target "${a}" is under a protected path`;
    }
  }
  return null;
}

function checkGit(cmd: ParsedCommand): string | null {
  if (basename(cmd.argv[0] ?? "") !== "git") return null;
  // Find the subcommand: first non-flag arg after `git`.
  let sub: string | undefined;
  let subIdx = -1;
  for (let i = 1; i < cmd.argv.length; i++) {
    if (!cmd.argv[i].startsWith("-")) {
      sub = cmd.argv[i];
      subIdx = i;
      break;
    }
  }
  if (!sub) return null;

  // FRI-2042: relocating the hooks directory is the same persistence with a
  // different path, and no path check can catch it — the dangerous value is
  // an ordinary-looking directory the repo already contains.
  if (sub === "config" && cmd.argv.some((a) => /^core\.hooksPath$/i.test(a))) {
    return `git config core.hooksPath blocked — relocating hooks is a persistence vector (FRI-2042)`;
  }
  if (sub === "filter-branch" || sub === "filter-repo") {
    return `git blocked — "${sub}" is irrevocable`;
  }
  if (sub === "update-ref" && cmd.argv.includes("-d")) {
    return `git update-ref -d blocked — refusing to delete refs`;
  }
  if (sub === "reflog") {
    if (cmd.argv.includes("expire") && cmd.argv.some((a) => a.startsWith("--expire=now"))) {
      return `git reflog expire --expire=now blocked — irrevocable`;
    }
  }
  if (sub === "gc" && cmd.argv.includes("--aggressive")) {
    return `git gc --aggressive blocked — irrevocable`;
  }
  if (sub === "worktree") {
    // Allow git worktree add/list, deny remove of own worktree (cwd-based).
    if (cmd.argv[subIdx + 1] === "remove") {
      return `git worktree remove blocked — refusing to remove own worktree`;
    }
  }
  if (sub === "push") {
    // Walk args after `push` looking for force flags and the refspec.
    const after = cmd.argv.slice(subIdx + 1);
    const force = after.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease");
    // Refspecs are positional args (no leading `-`). Collect them.
    const positionals: { value: string; subst: boolean }[] = [];
    for (let j = subIdx + 1; j < cmd.argv.length; j++) {
      const a = cmd.argv[j];
      if (!cmd.substAt[j] && a.startsWith("-")) continue;
      positionals.push({ value: a, subst: cmd.substAt[j] });
    }
    // Typical form: git push [<remote>] [<refspec>...].
    // For ":branch" deletes, the colon-prefixed token can appear in any
    // positional slot — scan all.
    for (const p of positionals) {
      if (p.subst) {
        return `git push blocked — refspec is a command substitution ($(...))`;
      }
      if (p.value.startsWith(":")) {
        const branch = p.value.slice(1).replace(/^refs\/heads\//, "");
        if (PROTECTED_BRANCHES.has(branch)) {
          return `git push blocked — refusing to delete remote branch "${branch}"`;
        }
      }
      if (force) {
        // Refspec form: [+]src[:dst] — protected if dst (or src when no dst)
        // is a protected branch.
        const stripped = p.value.replace(/^\+/, "");
        const [src, dst] = stripped.includes(":") ? stripped.split(":", 2) : [stripped, stripped];
        const target = (dst || src).replace(/^refs\/heads\//, "");
        if (PROTECTED_BRANCHES.has(target)) {
          return `git push --force blocked — refusing to force-push to "${target}"`;
        }
      }
    }
  }
  return null;
}

function checkPackageManager(cmd: ParsedCommand): string | null {
  const bin = basename(cmd.argv[0] ?? "");
  // pnpm v9+ already requires explicit opt-in via `pnpm.onlyBuiltDependencies`
  // (or `pnpm approve-builds`) before running any postinstall. We trust that
  // gate and let `pnpm install` / `pnpm add` through unmodified — otherwise we
  // break legitimate flows like Husky prepare hooks and repo-vetted native
  // module builds. npm and classic yarn run all postinstalls by default, so
  // those still require explicit `--ignore-scripts`.
  if (!PKG_MANAGERS_UNSAFE_BY_DEFAULT.has(bin)) return null;
  const sub = cmd.argv[1];
  // `yarn` with no subcommand defaults to install in classic yarn.
  const isInstall =
    (bin === "yarn" && (!sub || PKG_INSTALL_SUBCMDS.has(sub))) ||
    (bin === "npm" && PKG_INSTALL_SUBCMDS.has(sub ?? ""));
  if (!isInstall) return null;
  // Allowed when --ignore-scripts is present in any form.
  const ignoreScripts = cmd.argv.some(
    (a) => a === "--ignore-scripts" || a === "--ignore-scripts=true",
  );
  if (ignoreScripts) return null;
  return `${bin} ${sub ?? ""} blocked — require --ignore-scripts (lifecycle scripts can run arbitrary code)`;
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point

type RuleFn = (cmd: ParsedCommand, workspaceReal: string) => string | null;

const RULES: RuleFn[] = [
  checkBinary,
  checkRm,
  checkFind,
  checkRedirectTargets,
  checkCpMv,
  checkTee,
  checkGit,
  checkPackageManager,
];

/**
 * Inspect a Bash `command` string for catastrophe patterns. Returns the
 * deny reason on the first matching rule across all logical commands in
 * the string; null if every clause is allowed.
 */
export function checkBashForDisaster(command: string, workspaceReal: string): string | null {
  if (!command.trim()) return null;
  let raw: ReadonlyArray<unknown>;
  try {
    raw = parse(command, process.env as Record<string, string>);
  } catch {
    return `Bash blocked — unparseable command`;
  }
  const tokens = normalizeTokens(raw);
  const logicalCommands = splitCommands(tokens);
  for (const tokset of logicalCommands) {
    const cmd = parseCommand(tokset);
    if (cmd.argv.length === 0) continue;
    for (const rule of RULES) {
      const reason = rule(cmd, workspaceReal);
      if (reason) return reason;
    }
  }
  return null;
}
