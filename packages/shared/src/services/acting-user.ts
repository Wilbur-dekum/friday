import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import type { ActingUser } from "../prompts/loader.js";

/**
 * Resolve the **User** behind a turn from the id stamped on its originating
 * block (FRI-2016).
 *
 * `blocks.user_id` is written by the `sendUserMessage` mutator from the
 * verified BetterAuth identity on the Zero push, so it is a trusted id rather
 * than anything the client chose. This turns it into the name and email the
 * prompt layer needs to address the person.
 *
 * Returns `null` for a null/empty id — a scheduled run, a mail-triggered turn
 * or an `agent_spawn` has no human behind it — and also when the id does not
 * resolve, which is the shape left behind after ADR-053's erasure action. Both
 * mean "run this turn without a User identity", never "fail the turn".
 */
export async function resolveActingUser(
  userId: string | null | undefined,
): Promise<ActingUser | null> {
  if (!userId) return null;
  const rows = await getDb()
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}
