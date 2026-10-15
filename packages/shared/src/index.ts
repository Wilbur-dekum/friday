export * from "./config.js";
export * from "./daemon-secret.js";
export * from "./env.js";
export * from "./secrets/index.js";
export * from "./log.js";
export * from "./agents.js";
export * from "./usage.js";
export * from "./transcript.js";
export * from "./atomic-write.js";
export * from "./cron.js";
export * from "./skills.js";
export * from "./claude-sessions.js";
export * from "./hooks/index.js";
export * from "./prompts/loader.js";
export * from "./apps/manifest.js";
export * from "./container.js";
export * from "./db/row-census.js";
export * from "./db/client.js";
export * from "./db/migrate.js";
export * as schema from "./db/schema.js";
// Phase 4.3: NOTIFY channel names are referenced from both client
// and daemon — re-export the constant + type so daemon-side LISTEN
// handlers don't have to drill through the schema namespace.
export { LISTEN_CHANNELS, type ListenChannel } from "./db/schema.js";
// ADR-049: the typed intent seam. Re-exported from the root barrel so daemon
// LISTEN handlers `import { INTENT_STATUS, parseUserMessageContent } from
// "@friday/shared"` instead of re-spelling status literals / hand-parsing
// content_json. The module is node-free and also reachable via the client-safe
// `@friday/shared/sync` surface (where the mutators consume it).
export {
  INTENT_STATUS,
  INTENT_STATUS_TABLE,
  buildUserMessageContent,
  parseUserMessageContent,
  type IntentStatus,
  type UserMessageAttachment,
  type UserMessageContent,
  type ParsedUserMessageContent,
} from "./sync/intents.js";
// FRI-24: pgvector column dimensionality. Surfaced as a top-level named
// export so @friday/memory's embedder can size its output vector against the
// same single source of truth the schema's `vector(N)` column uses.
export { EMBEDDING_DIM } from "./db/schema.js";
export {
  provisionPostgres,
  reconcileSyncPublication,
  probePostgresHealth,
  dropFridayDatabaseForTest,
  ensureVectorExtension,
  hasVectorExtension,
  findPgBin,
  findPgIsReady,
  FRIDAY_PG_CONSTANTS,
  type PgHealth,
  type ProvisionResult,
  type PublicationReconcileResult,
} from "./db/pg-provision.js";
export { createTestDb, newTestClient, withTestDb, type TestDbHandle } from "./db/test-pg.js";
// Item #50 scaffold. Subprocess-spawning extensions are TODO; the
// current export gives every e2e test a per-test scratch Postgres
// with migrations applied + a single shared cleanup hook.
export { spawnTestSyncEnv, type SyncEnv } from "./test/sync-harness.js";

export type {
  WireEvent,
  TurnStartedEvent,
  TurnErrorEvent,
  TurnDoneEvent,
  AgentMessageEvent,
  TurnUsage,
  BlockKind,
  BlockStartEvent,
  BlockDeltaEvent,
  BlockCompleteEvent,
  ConnectionEstablishedEvent,
  AppLifecycleEvent,
  // FRI-142 (ADR-048): the ephemeral in-app Notification toast SSE event.
  ToastEvent,
} from "./wire/events.js";

export { stringifyToolResult } from "./wire/tool-result.js";

// FRI-171 (ADR-047): cross-cutting Intake / Inbox data shapes. Type-only and
// node-free, so they're safe to consume from both the daemon (classifier +
// executors) and the dashboard (Inbox store + bell), and to re-export
// `import type` from the client-bundled `sync/` surface.
export type {
  CoreRouteTargetId,
  RouteTargetId,
  IntakeSource,
  InboxKind,
  InboxState,
  IntakeVerdict,
  InboxItem,
} from "./intake/types.js";

// FRI-142 (ADR-048): cross-cutting Notification contracts. Type-only + `const`
// literals, node-free (no `web-push`, which is daemon-only), so they're safe to
// consume from the daemon (router/presence/push), the dashboard (Settings
// policy UI, toast renderer, presence + subscribe flows), and the service
// worker. DEFAULT_NOTIFY_POLICY and the *_TYPES/CHANNELS/RULES tuples are
// runtime values; the rest are types.
export {
  NOTIFY_EVENT_TYPES,
  CHANNELS,
  DELIVERY_RULES,
  DEFAULT_NOTIFY_POLICY,
} from "./notify/types.js";
export type {
  NotifyEventType,
  Channel,
  DeliveryRule,
  NotifyPolicy,
  NotifyEvent,
  PresenceReport,
  PushSubscribePayload,
} from "./notify/types.js";
