import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import pc from "picocolors";
import {
  AGE_KEY_PATH,
  DAEMON_FIELD_ALIASES,
  DATA_DIR,
  ENV_LEGACY_PATH,
  ENV_LOCAL_PATH,
  ENV_PATH,
  MACHINE_ENV_KEYS,
  RECIPIENTS_PATH,
  clearFridayConfigCache,
  findMeta,
  generateAgeKeypair,
  getDb,
  identityToRecipient,
  initVault,
  patchFridayGitignore,
  resolveAgeIdentity,
  readMetaFile,
  removeSecret,
  schema,
  unlockVault,
  upsertSecret,
  writeVaultAndMeta,
} from "@friday/shared";
import type { AgentTypeName, SecretMeta, SecretMode } from "@friday/shared";
import { DaemonClient } from "../lib/api.js";
import { buildSecretRows, renderSecretsList } from "./secrets-format.js";

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function notifyDaemonReload(): Promise<void> {
  try {
    const client = new DaemonClient();
    await client.post("/api/secrets/reload", {});
  } catch {
    // daemon may be stopped during setup
  }
}

async function readPassword(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  process.stdout.write(prompt);
  const line = await rl.question("");
  rl.close();
  return line;
}

function parseAgents(raw: string | undefined): AgentTypeName[] | undefined {
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()) as AgentTypeName[];
}

function parseMode(raw: string | undefined): SecretMode {
  if (raw === "on-demand") return "on-demand";
  return "env";
}

async function auditCliFetch(meta: SecretMeta, reason: string): Promise<void> {
  const db = getDb();
  await db.insert(schema.secretsFetchLog).values({
    secretName: meta.name,
    callerName: "cli",
    callerType: "operator",
    appId: meta.app ?? null,
    reason: reason.slice(0, 512),
    source: "cli",
  });
}

export const secretsCommand = defineCommand({
  meta: { name: "secrets", description: "Age-encrypted secrets vault (ADR-038)" },
  subCommands: {
    init: defineCommand({
      meta: { name: "init", description: "Initialize vault + age keypair" },
      async run() {
        if (existsSync(AGE_KEY_PATH)) {
          console.error(pc.red(".age-key already exists — refusing to overwrite"));
          process.exit(1);
        }
        const { identity, recipient } = await generateAgeKeypair();
        await initVault(identity, recipient);
        const git = patchFridayGitignore();
        console.log(pc.green("  vault initialized"));
        console.log(pc.green(`  .age-key written (mode 600)`));
        if (git.removedEnvAllow) {
          console.log(pc.yellow("  removed !.env.* from ~/.friday/.gitignore"));
        }
        await notifyDaemonReload();
      },
    }),

    unlock: defineCommand({
      meta: { name: "unlock", description: "Test vault decryption" },
      args: { check: { type: "boolean", description: "Exit 1 if unlock fails" } },
      async run({ args }) {
        const result = await unlockVault(true);
        if (result.ok) {
          if (args.check) console.log(pc.green("vault unlock OK"));
          return;
        }
        console.error(pc.red(`vault unlock failed: ${result.reason}`));
        if (args.check) process.exit(1);
        process.exit(1);
      },
    }),

    list: defineCommand({
      meta: { name: "list", description: "List secret metadata" },
      args: { app: { type: "string", description: "Filter by app id" } },
      async run({ args }) {
        const unlock = await unlockVault(true);
        const meta = unlock.ok ? unlock.cache.meta : readMetaFile();
        const vaultKeys = unlock.ok
          ? new Set(Object.keys(unlock.cache.payload.secrets))
          : new Set<string>();
        const rows = buildSecretRows(meta.secrets, vaultKeys, {
          unlocked: unlock.ok,
          app: args.app as string | undefined,
        });
        for (const line of renderSecretsList(rows, { tty: output.isTTY === true })) {
          console.log(line);
        }
      },
    }),

    get: defineCommand({
      meta: { name: "get", description: "Print secret value (TTY only, audited)" },
      args: {
        name: { type: "positional", required: true },
        app: { type: "string" },
      },
      async run({ args }) {
        if (!output.isTTY) {
          console.error(pc.red("refusing to print secrets to a pipe"));
          process.exit(1);
        }
        const unlock = await unlockVault(true);
        if (!unlock.ok) {
          console.error(pc.red("vault locked"));
          process.exit(1);
        }
        const meta = findMeta(
          unlock.cache.meta,
          args.name as string,
          args.app as string | undefined,
        );
        if (!meta) {
          console.error("not found");
          process.exit(1);
        }
        const key = meta.app ? `apps/${meta.app}/${meta.name}` : meta.name;
        const value = unlock.cache.payload.secrets[key]?.value;
        if (value === undefined) {
          console.error("missing vault value");
          process.exit(1);
        }
        await auditCliFetch(meta, "friday secrets get");
        console.log(value);
      },
    }),

    set: defineCommand({
      meta: { name: "set", description: "Set a secret" },
      args: {
        name: { type: "positional", required: true },
        app: { type: "string" },
        mode: { type: "string", default: "env" },
        daemon: { type: "boolean" },
        agents: { type: "string" },
        value: { type: "string" },
      },
      async run({ args }) {
        const name = args.name as string;
        let value = args.value as string | undefined;
        if (!value) value = await readPassword(`Value for ${name}: `);
        const meta: SecretMeta = {
          name,
          mode: parseMode(args.mode as string | undefined),
          app: args.app as string | undefined,
          daemon: args.daemon === true ? true : undefined,
          agents: parseAgents(args.agents as string | undefined),
        };
        await upsertSecret(meta, value);
        clearFridayConfigCache();
        await notifyDaemonReload();
        console.log(pc.green(`  ${name} saved`));
      },
    }),

    "set-pair": defineCommand({
      meta: { name: "set-pair", description: "Set PREFIX_USERNAME + PREFIX_PASSWORD" },
      args: {
        prefix: { type: "positional", required: true },
        app: { type: "string" },
        mode: { type: "string", default: "env" },
        agents: { type: "string" },
      },
      async run({ args }) {
        const prefix = (args.prefix as string).toUpperCase();
        const mode = parseMode(args.mode as string | undefined);
        const agents = parseAgents(args.agents as string | undefined);
        const app = args.app as string | undefined;
        const user = await readPassword(`${prefix}_USERNAME: `);
        const pass = await readPassword(`${prefix}_PASSWORD: `);
        for (const [name, value] of [
          [`${prefix}_USERNAME`, user],
          [`${prefix}_PASSWORD`, pass],
        ] as const) {
          await upsertSecret({ name, mode, app, agents }, value);
        }
        clearFridayConfigCache();
        await notifyDaemonReload();
        console.log(pc.green(`  ${prefix}_USERNAME + ${prefix}_PASSWORD saved`));
      },
    }),

    unset: defineCommand({
      meta: { name: "unset", description: "Remove a secret" },
      args: {
        name: { type: "positional", required: true },
        app: { type: "string" },
      },
      async run({ args }) {
        await removeSecret(args.name as string, args.app as string | undefined);
        clearFridayConfigCache();
        await notifyDaemonReload();
        console.log(pc.green(`  ${args.name} removed`));
      },
    }),

    edit: defineCommand({
      meta: { name: "edit", description: "Edit vault JSON in $EDITOR" },
      async run() {
        const unlock = await unlockVault(true);
        if (!unlock.ok) {
          console.error(pc.red("vault locked"));
          process.exit(1);
        }
        const dir = join(DATA_DIR, "secrets");
        mkdirSync(dir, { recursive: true });
        const editPath = join(dir, `.edit-${Date.now()}`);
        writeFileSync(editPath, JSON.stringify(unlock.cache.payload, null, 2), "utf8");
        chmodSync(editPath, 0o600);
        const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
        const child = spawnSync(editor, [editPath], { stdio: "inherit" });
        if (child.status !== 0) {
          unlinkSync(editPath);
          process.exit(child.status ?? 1);
        }
        try {
          const edited = JSON.parse(readFileSync(editPath, "utf8")) as typeof unlock.cache.payload;
          await writeVaultAndMeta(edited, unlock.cache.meta);
          clearFridayConfigCache();
          await notifyDaemonReload();
          console.log(pc.green("  vault updated"));
        } finally {
          try {
            unlinkSync(editPath);
          } catch {
            // ignore
          }
        }
      },
    }),

    "migrate-from-env": defineCommand({
      meta: { name: "migrate-from-env", description: "Move integration keys from .env to vault" },
      async run() {
        if (!existsSync(ENV_PATH) && !existsSync(ENV_LEGACY_PATH)) {
          console.log("no legacy .env to migrate");
          return;
        }
        const legacyPath = existsSync(ENV_PATH) ? ENV_PATH : ENV_LEGACY_PATH;
        const parsed = parseDotEnv(readFileSync(legacyPath, "utf8"));
        if (!existsSync(AGE_KEY_PATH)) {
          console.error(pc.red("run `friday secrets init` first"));
          process.exit(1);
        }
        mkdirSync(join(DATA_DIR), { recursive: true });
        const localLines: string[] = ["# Friday machine-local env vars"];
        for (const [key, value] of Object.entries(parsed)) {
          if (MACHINE_ENV_KEYS.has(key)) {
            localLines.push(`${key}=${value}`);
            continue;
          }
          const daemon = key in DAEMON_FIELD_ALIASES;
          await upsertSecret(
            { name: key, mode: "env", daemon: daemon || undefined },
            String(value),
          );
        }
        writeFileSync(ENV_LOCAL_PATH, `${localLines.join("\n")}\n`);
        patchFridayGitignore();
        clearFridayConfigCache();
        await notifyDaemonReload();
        console.log(pc.green("  migrated machine keys → .env.local"));
        console.log(pc.green("  migrated integration keys → vault"));
        console.log(
          pc.yellow("  scrub plaintext from .env manually and `git rm --cached .env` if tracked"),
        );
      },
    }),

    audit: defineCommand({
      meta: { name: "audit", description: "Scan for plaintext secrets on disk" },
      args: { "git-history": { type: "boolean" } },
      async run({ args }) {
        const findings: string[] = [];
        if (existsSync(ENV_PATH)) findings.push(`${ENV_PATH} (plaintext .env still present)`);
        if (existsSync(join(DATA_DIR, "config.json"))) {
          const cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8")) as {
            mcpServers?: { env?: Record<string, string> }[];
          };
          for (const srv of cfg.mcpServers ?? []) {
            for (const v of Object.values(srv.env ?? {})) {
              if (!v.includes("${") && /key|token|secret|password/i.test(v)) {
                findings.push("config.json mcpServers contains literal secret values");
                break;
              }
            }
          }
        }
        const appsDir = join(DATA_DIR, "apps");
        if (existsSync(appsDir)) {
          for (const ent of readdirSync(appsDir, { withFileTypes: true })) {
            if (ent.isDirectory() && existsSync(join(appsDir, ent.name, ".env"))) {
              findings.push(`apps/${ent.name}/.env`);
            }
          }
        }
        if (findings.length === 0) console.log(pc.green("  no plaintext findings"));
        else for (const f of findings) console.log(pc.yellow(`  ${f}`));

        if (args["git-history"]) {
          const git = spawnSync("git", ["log", "-p", "--", ".env", "secrets/"], {
            cwd: DATA_DIR,
            encoding: "utf8",
          });
          if (git.stdout?.includes("=")) {
            console.log(pc.red("  git history may contain plaintext — rotate credentials"));
          }
        }
      },
    }),

    "public-key": defineCommand({
      meta: { name: "public-key", description: "Print age recipient for recipients.txt" },
      async run() {
        const identity = resolveAgeIdentity();
        if (!identity) {
          console.error("no .age-key");
          process.exit(1);
        }
        const recipient = existsSync(RECIPIENTS_PATH)
          ? readFileSync(RECIPIENTS_PATH, "utf8").trim()
          : await identityToRecipient(identity);
        console.log(recipient);
      },
    }),
  },
});
