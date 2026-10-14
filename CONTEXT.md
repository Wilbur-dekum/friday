# Friday

Domain language for the Friday agent platform — the headless daemon, the
SvelteKit dashboard, and the shared packages that bind them.

## Language

### Deployment and identity

**Deployment**:
One running Friday stack — daemon, zero-cache, dashboard, and one Postgres
database — serving exactly one **Organization**. Provisioned, upgraded, and
torn down by the **Control plane**, one per paying customer. The unit of
isolation: two Organizations never share a Deployment, and there is no tenancy
_within_ one.
_Avoid_: tenant (a Deployment is a customer's whole stack, not a row scope),
instance (acceptable synonym), install (reserve for the act of installing),
machine (a Deployment is not tied to one host).

**Organization**:
The single company a **Deployment** serves. A stored entity — one row, created
by setup alongside the first **User** — holding what is true of the company
rather than of any person: its name, its SSO domain allowlist, the org-owned
SOUL. But deliberately **not** a row scope: there is no `org_id` column on any
domain table, because one Deployment is one Organization by construction. The
**Control plane** holds the cross-Organization record; a Deployment knows only
its own.
_Avoid_: tenant (implies many per Deployment — there is exactly one), workspace,
team, account (that's the BetterAuth credential record), company (informal use
is fine).

**User**:
A human with an account on a **Deployment** (a BetterAuth `user` row). An
**Organization** has several; they collaborate through one shared Friday rather
than each holding their own. Distinct from "the user" as the prompt stack uses
it — that phrase assumes a single human and predates this concept.
_Avoid_: account (that's the BetterAuth credential record), member, employee
(informal use is fine), owner.

**Control plane**:
The single multi-tenant application that sits above every **Deployment** —
public marketing, signup, billing, legal, and support surfaces, plus the
provisioning and upgrade machinery that creates and maintains Deployments. The
only component that spans **Organization**s, and the only one a prospective
customer meets before they have a Deployment. A Deployment never talks to
another Deployment; it talks only to the Control plane.
_Avoid_: dashboard (that's the per-Deployment UI), admin (too vague),
orchestrator (taken — that's an agent type), fleet manager, mothership.

**Conversation**:
A thread of **Turn**s between one **User** and one agent. The unit a human
actually experiences; the agent is shared, the Conversation is not. One agent
has many Conversations — which is why per-**User** privacy is modelled here and
never as per-User agents (`agents.name` is a primary key that `mail`, `blocks`,
and `read_cursors` all reference by bare string, so there can only ever be one
`orchestrator`). Keyed by **User** and agent, **not** by **Transport**: one
continuous thread that Slack, email, and the web dashboard are all doorways
into. Carries one Claude SDK session, so continuity is structural rather than
reconstructed from **memory**, which stays shared across the **Organization**.
_Avoid_: thread (reserve for the _external_ thread a **Transport** maps onto —
a Slack `thread_ts`, an email `Message-ID` chain), chat (the UI surface, not the
entity), session (that's the SDK's per-Conversation handle, not the Conversation
itself), channel.

**Role**:
A **User**'s authority within their **Organization** — `admin | member`. Owned
by the **Control plane** (where membership and billing already live) and carried
in the login assertion, then mirrored into the **Deployment** so the tool gate
reads it without a network call per turn. An admin installs Friday Apps, manages
agents and schedules, reads secrets, and configures SSO and the org SOUL; a
member converses and uses the core tools. Orthogonal to _agent type_, which gates
which tools an **agent** may call: the effective gate is agent type × Role.
_Avoid_: permission (that's the finer-grained future model), scope (taken —
that's the personal/org data axis), tier, plan (that's billing), admin (the
value, not the concept).

**Scope**:
Whether a row belongs to one **User** or to the whole **Organization** —
`personal | org`. The boundary intuition is "conversations and personal records
are mine, work artifacts are ours": **Conversation**s, `inbox_items`, **Habit**s
and their **Check-in**s, and the per-user half of settings (**Theme**,
**Notification policy**, **DND**) are personal; agents, tickets, mail,
schedules, Apps, and **memory** are org. Memory being org-wide is a deliberate
stance, not an oversight — one shared brain is the point of a company assistant,
so a sensitive thing said in one **User**'s Conversation can reach another's
recall once the nightly consolidation pass has run.
_Avoid_: visibility (that's the UI consequence), private (ambiguous — personal
rows are still readable by the **Deployment**'s operators), tenant, role (that's
a User's authority, a different axis).

**Capacity source**:
Whose Anthropic credentials fund a **Deployment**'s agent turns — `friday`
(drawn against Friday's own org keys and billed through the **Control plane**)
or `byo` (the **Organization**'s own API key, held in its Deployment's vault).
A per-Deployment setting, not a per-**User** one. Distinct from the plan, which
decides price and **Usage cap** but not whose key is used.
_Avoid_: billing mode (that's the Control-plane view), API key (the credential,
not the choice), tier, plan.

**Usage cap**:
A hard per-**Deployment** ceiling on agent token spend, enforced **before** a
turn is dispatched. Applies under either **Capacity source** — under `friday`
it protects the margin, under `byo` it protects the customer from their own
autonomous agents, which is the same feature either way. Set by the **Control
plane** (which owns plans and billing), enforced in the daemon's dispatch path
against a running counter, and refused loudly rather than queued. Not the same
as the `usage` / `usage_request` tables, which record spend _after_ a turn and
are an audit trail, never a brake.
_Avoid_: quota (acceptable synonym), limit (too generic), budget (acceptable
informally), rate limit (that's requests per unit time, a different control).

### Theming

**Mode**:
The light/dark policy. One of `light | dark | system`. Resolved at runtime
via `prefers-color-scheme`; decides which slot of the active **Theme** is
in effect when the user is on **Sync**. Internal-only — there is no
user-facing **Mode** picker.
_Avoid_: theme (as a synonym for mode), color-scheme (when discussing the user's setting).

**Palette**:
A named, complete set of color tokens (e.g. **Dawn**, **Dusk**).
Palettes are not bimodal — each palette renders exactly as defined, in
whichever slot it sits. Every palette is selectable in any slot.
_Avoid_: theme (when referring to one named color set), skin, scheme.

**Palette kind**:
An intrinsic flag on each **Palette** — `light` or `dark` — describing the
visual style of its tokens. **Dawn** is `light`-kind; **Dusk** is
`dark`-kind. Kind is metadata, not a constraint on which slot a **Palette**
can occupy. It drives sub-themed renderers (Mermaid, Shiki) and the
browser-integration signals (`color-scheme`, `theme-color`) so they follow
the active **Palette**, not the user's **Mode**.

**Theme**:
The user's full theming selection. Has two configurations:

- **Single**: one **Palette** wins, regardless of **Mode**.
- **Sync**: one **Palette** per slot (light, dark); the active one follows
  the resolved **Mode**.

The user's three **Palette** picks (single, light, dark) are stored
independently and may each be unset. Until the user explicitly picks for a
slot, the resolver falls back to a built-in default — so toggling between
**Single** and **Sync** before any pick is a no-op visually.
_Avoid_: palette (when referring to the user's whole selection), preferences.

### Known palettes

**Dawn**: The warm, airy palette that currently sits in `:root` in
`app.css`. The Friday default for the light slot.

**Dusk**: The cool, technical blue palette that currently sits in `.dark`
in `app.css`. The Friday default for the dark slot.

### Surface tokens

**Chat aurora**: The three signature hues that drive the conic-gradient
animation around the chat input. Defined per-palette as
`--chat-aurora-1|2|3`. Each **Palette** picks its own three hues — these
aren't fixed brand colors; they're a per-palette aesthetic choice.

### Agent turn lifecycle

**Turn state**:
The authoritative in-daemon record of where an agent's worker sits in its
turn — `idle | working | aborting | force-killed` — together with its
current **Generation**. Lives in daemon memory; it is the source of truth.
_Avoid_: status (reserve that for the projection), worker state.

**Turn-state machine**:
The single module that owns an agent's **Turn state** and is the only
writer of it. Applies **Transition**s and emits intents
(`send-next`, `force-kill`, `recover`).
_Avoid_: lifecycle handler, worker manager, dispatcher.

**Transition**:
One state-affecting input applied to the **Turn-state machine** — a worker
IPC event, an abort, a force-kill, a refork, a spawn, or a worker exit.
_Avoid_: event (too broad), message.

**Transition queue**:
The per-agent-name serialized queue every **Transition** funnels through,
so transitions for one agent apply in strict arrival order with no
interleaving. The agent-keyed successor to the per-worker `ipcChain`.
_Avoid_: ipcChain (its narrower predecessor), mailbox.

**Generation**:
A worker instance's standing as the current owner of its agent name
(`live.get(name) === w`). A **Transition** arriving from a superseded
**Generation** is a structural no-op. Identity-as-epoch — promoted to a
monotonic counter only if cross-gap ordering is ever needed.
_Avoid_: epoch (unless promoted), version.

**Status projection**:
A read-optimized mirror of **Turn state**, written only inside a
**Transition** and never mutated independently — `w.status` (in-memory,
`idle | working`) and `agents.status` (durable, written through the
ADR-031 `registry.setStatus` gate, replicated to clients by Zero).
_Avoid_: status (when you mean the authoritative **Turn state**).

### Habits

**Habit**:
A named thing the user intends to do on a repeating cadence and checks off
(e.g. "brush teeth", "run a 5K"). The tracked definition — not any single
occurrence and not its streak. Has one of two **Habit mode**s.
_Avoid_: routine (kitchen owns that for recurring cooking patterns —
`kitchen_routine_add`; reusing it makes the glossary unable to
disambiguate), task, reminder (a reminder is a nudge; a Habit is a tracked
commitment).

**Check-in**:
A single logged completion of a **Habit** — one event, timestamped. A
**Period** may hold _many_ Check-ins (write 5 blog posts → 5 Check-ins) and
all of them are recorded as **volume**; only the first **Target**-many count
toward the **Streak**. The append-only atoms everything else is derived from.
_Avoid_: completion (acceptable synonym but prefer Check-in), tick, done.

**Period**:
The recurrence window a **Habit**'s **Target** is measured over — one of
`day | week | month | year`, optionally constrained to specific weekdays
(e.g. Mon/Wed/Fri ⇒ each of those days is its own day-Period). The unit the
**Streak** is counted in. Cron's vocabulary suggests _which_ Periods exist
but is not used to tally Check-ins into them.
_Avoid_: interval, cadence (use cadence informally for the whole
Target+Period shape, not for the window alone), bucket (that's
**Time-of-day bucket**, a display attribute — distinct).

**Target**:
The number of **Check-in**s required within one **Period** to _satisfy_ it
(default 1). "20 workouts/month" ⇒ Target 20, Period month. Check-ins beyond
the Target in a Period are still logged as volume but do not further advance
the **Streak**.
_Avoid_: goal (overloaded), quota (acceptable synonym).

**Satisfied period**:
A **Period** whose **Check-in** count reached its **Target**.

**Streak**:
The run of consecutive **Satisfied period**s for a **Habit**, counted in its
**Period** unit (days-in-a-row, months-in-a-row, …). A _derived, time-
dependent_ projection of the **Check-in** log against the **Target**/
**Period** and the current clock — never stored as truth, never created
directly by the user. Three states:

- **Dormant**: no run is active — either none has ever started, or the last
  one just broke. The next **Satisfied period** (re)starts it.
- **Active, current period pending**: N consecutive prior **Satisfied
  period**s; the current (open) Period is below **Target**. Shows **N** and
  holds — neither advanced nor broken.
- **Active, current period satisfied**: the open Period reached **Target** →
  shows **N+1**.

A Streak breaks on a _clock boundary_, not a Check-in: it drops to **Dormant**
the instant an unsatisfied **Period** _closes_ (e.g. midnight at month-end).
Because the value depends on `now()`, it is computed on read, not stored.
_Avoid_: count (too generic), habit (the Streak is not the Habit).

**Time-of-day bucket**:
An optional display/scheduling attribute on a **Habit** —
`morning | afternoon | evening | anytime`. Groups "today's habits" in the UI
and times an optional reminder. **Not** part of Check-in identity and **not**
a **Streak** determinant (v1).
_Avoid_: period (that's the **Streak** window), slot.

**Slot**:
One unit toward a **Period**'s **Target**; renders as one square in the UI. A
Period with Target N has N Slots, filled in order by **Check-in**s.
Two families by how a Slot resolves:

- **Per-day Slot** (Habits whose Target is per-day — daily, every-day, MWF):
  each Slot is bound to a specific day and **fills or slashes at that day's
  end**.
- **Floating Slot** (Habits whose Target is per multi-day Period — N/week,
  N/month, N/year): Slots are unbound, fill in order, stay **empty** while the
  Period is open, and the unfilled remainder **slashes only at Period close**.

Square states: empty (outline, not yet missed) · slashed (light diagonal,
expected-but-window-closed = a miss) · filled (the **Habit color**). Check-ins
past Target render as **overflow** (`+k`), counted as volume, not toward the
**Streak**.
_Avoid_: cell, box.

**Habit color**:
A per-**Habit** color stored as an **index** (1–7), never a hex. Each
**Palette** supplies the actual 7 colors via a habit ramp it must define —
the index map leans ROYGBIV but a Palette may reinterpret it within its own
language (e.g. **Phosphor** renders all seven as shades of green). Same
contract as the rest of the **Theme** system: the Habit picks a slot in the
ramp, the active **Palette** owns the value, so Habit colors re-theme
automatically.
_Avoid_: hue, swatch (UI affordance, not the stored value).

**Habit mode**:
The lifecycle shape of a **Habit**. One of:

- **Ongoing**: open-ended; the **Streak** grows indefinitely and the Habit
  never archives on its own.
- **Bounded**: has a defined window (start + end / start + length); the
  **Streak** runs against that window. When the window closes the Habit
  archives as _completed_ (window finished, Streak intact) or _expired_
  (window finished, Streak broken).

Motivation-neutral — **Bounded** covers a fitness challenge, a medication
course, and a free-trial cadence equally.
_Avoid_: challenge (too narrow — implies aspiration/fitness), fixed-duration
(clunky), goal/sprint/season (carry foreign domain baggage).

### Stateless intake

**Capture**:
A raw thought thrown at Friday from _outside_ the orchestrator chat flow — a
Watch-shortcut transcription, a PWA quick-add blurb. The unprocessed artifact:
text (audio later), plus its **Source**. A Capture is explicitly _not_ a chat
message; it never enters the orchestrator's turn loop directly.
_Avoid_: message (reserve for chat/mail), note, idea (too vague), inbox item
(that's only one possible outcome of a Capture).

**Source**:
Where a **Capture** originated — `watch | quick_add | …`. The one-shot,
no-reply end of the **Transport** spectrum; a Transport that expects an answer
is not a Source. Distinct from the `blocks.source` provenance enum
(`user_chat`, `mail`, …). Source is **pure provenance** — recorded for audit
and to stamp the resulting `blocks.source`, but it does **not** alter clean /
classify / gate behavior. Typed and
transcribed text are treated identically (a transcription can be _more_
faithful than a typo-laden typed line), so there is no per-source policy.

**Intake**:
The stateless pipeline a **Capture** passes through: clean → classify → route.
Holds no cross-Capture state — each Capture is processed independently. The new
piece; today routing is 100% the orchestrator deciding in-context, with no
classifier (`build-dispatch-prompt.ts`).
_Avoid_: ingest (acceptable for the endpoint, but Intake is the processing),
triage (that's the _inbox_ resurfacing step, a distinct later stage).

**Intake router** (a.k.a. **the classifier**):
The single cheap-model (Haiku) call at the heart of **Intake**. Stateless,
deliberately terse — it (a) rewrites the blurb clean, (b) classifies intent,
(c) picks a **Route**, (d) reports a **Confidence**. Returns a structured
verdict; it does not converse. Contrast the rich _assistant_ persona
(`SOUL.md`) — this is the stripped _intake_ persona.
_Avoid_: orchestrator (the router is NOT the orchestrator; the orchestrator is
just one possible **Route target**), agent (the router is a call, not a
long-lived agent).

**Intake persona**:
The terse, **code-owned** system prompt the **Intake router** runs under —
optimized for accurate cleanup and high-confidence routing, _not_ conversation.
A separate, parallel prompt stack: it does **not** use the ADR-005 assistant
stack (CONSTITUTION / SOUL / agent-base) — no warmth, no SOUL. It bakes in its
own _constitution-like_ directives (the goals: clean faithfully, route only
when confident, fall to **Unsorted** when not). It is not a user-editable
`~/.friday/` file; the **only** behavioral tuning surface is the registry
`guidance` per target.
_Avoid_: SOUL (that's the assistant persona — the opposite end), system prompt
(too generic).

**Route** / **Route target**:
The destination **Intake** picks for a cleaned **Capture**. One of three
families: a **core system** (reminder, habit, memory, ticket — reached by a
direct tool/mutator), an **agent** (an installed app's agent _or_ the
orchestrator — reached by **mail**, ADR-017), or the **Inbox** (the low-
confidence drop). Acting terminally on the Route is the router's job — it does
_not_ defer execution to the orchestrator (the orchestrator is reached only by
being mailed as a target).
_Avoid_: handler, channel.

Every **Route target** is a uniform **registry** entry — core and app alike —
declaring four things:

- **`id`**: `core:reminder | core:habit | core:memory | core:ticket` or
  `agent:<name>` (an app's bare agent, or the orchestrator).
- **`guidance`**: natural-language "route here when… / a complete action looks
  like…" prose injected into the classifier prompt. Core targets author it in
  code; app targets author it in `intakeRoutes[].describe`. This is the only
  lever that tunes routing/act-vs-propose (Gate 2 has no policy override).
- **`payloadSchema`**: the structured shape this target needs to act. For every
  `agent:<name>` target (apps _and_ orchestrator) the payload is simply the
  **mail message contents** to send that agent. Core targets define their own
  (reminder `{ text, dueDate? }`, memory `{ text }`, …).
- **`executor`**: the deterministic function that performs the action — the
  existing reminder mutator, habit tool, `mail_send`, etc. It returns a
  **result reference**: `{ undoable, inverseLabel?, deepLink }` — whether the
  action can be reversed, the human label for the inverse ("Delete the
  reminder"), and a deep-link to the artifact it created. This is what drives a
  **Done** item's Undo-vs-View CTA.

The menu is assembled at call time: core entries are baked in; **app** targets
are declared opt-in via the manifest `intakeRoutes[]` field — `{ agent,
describe }` pairs where `agent` must cross-ref a **`bare`-type** agent in the
same manifest (mail delivers to message-driven agents; `scheduled` agents are
cron-driven and not routable). An app with no `intakeRoutes` is not an intake
target. This un-defers the capability declaration ADR-021 set aside.
_Avoid_: capability (too broad — this is specifically a routing descriptor),
handler, channel.

**Intake verdict**:
The single structured object the **Intake router** emits per **Capture**:
`{ cleaned, targetId, payload, disposition, rationale }`. `targetId: null` ⇒
Gate 1 failure ⇒ **Unsorted**. `disposition: "act"` with a payload that
validates against the target's `payloadSchema` ⇒ run the executor, record a
**Done** item. `disposition: "propose"` — or a payload that fails validation —
⇒ record a **Proposed** item carrying the payload, so **approve** runs the same
executor later. The verdict is data, not prose: the classifier emits the
executable payload directly, which is what makes stateless "act now" possible
without a second agent to structure prose.
_Avoid_: classification, result.

**Inbox**:
The single **review surface** for everything **Intake** produces — not merely
the classification-failure drop. Surfaced as a header bell with a count and a
two-tone dot (low-priority tone when only reversible **Done** items await a
glance; attention tone when any **Proposed** or **Unsorted** item needs a
decision). Holds three **Inbox item** states:

- **Done**: a reversible **core system** action the router already executed
  (logged a habit, set a reminder, appended a memory, mailed an app agent).
  Shown FYI, with **undo**. Low-priority.
- **Proposed**: a higher-stakes action the router staged instead of firing
  (create a ticket, mail the orchestrator, anything external). Carries the
  full proposed action so **approve** executes it and **reject** discards it.
  Attention.
- **Unsorted**: a **Capture** the router could not confidently classify
  (Gate 1 failure). Needs a route assigned. Attention.

Each item has a fixed **`kind`** (set at creation) and a **`state`** that moves
`open → resolved` (`state`, not `status` — `status` is already taken by Turn
state / Status projection). Lifecycle:

- **Unsorted** → _triage_ (assign a target, which then executes or becomes
  Proposed) or _dismiss_ → `resolved`.
- **Proposed** → _approve_ (runs the very executor the act-path would have) or
  _reject_ → `resolved`.
- **Done** → already executed at intake. Always carries a CTA driven by the
  executor's **result reference**: if the executor is _undoable_, the CTA is
  **Undo** (tooltip names the inverse — "Delete the reminder"); if not (a sent
  mail can't be recalled), the CTA is **View**, a deep-link to the artifact
  (e.g. the Mail page with that message selected). **Auto-resolves on view** —
  opening the bell flips open Done items to `resolved` (undo stays available
  from history for a window). FYI, never nags.

The **bell count = open items**; two-tone by the most-urgent open kind present
(attention if any Proposed/Unsorted, else low-priority for Done-only).

**Triage** is **Seth's** job by default — he is the primary arbiter. There is
**no timed / nightly / out-of-band triage pass**. The orchestrator may read and
act on the Inbox (via tools) **only at Seth's explicit in-chat direction**
("work through my inbox") — pull, user-initiated, never scheduled.

Distinct from `mail_inbox` (inter-agent mail). The **Inbox** is the generic
**persisted, synced** actionable-item store; **Intake** is merely its first
**Producer**. It is _not_ the same thing as the **Notification** system: the
two converge only at the **bell badge count** (derived from open
attention-worthy Inbox items), never at storage — a Notification is
fire-and-forget and persists nothing, an Inbox item is durable Zero-replicated
state. The `inbox_items` action facet (`target_id`, `payload`, `undoable`,
`inverse_label`, `deep_link`, `kind`, `state`) is already producer-agnostic;
only `raw_text`/`cleaned_text`/`source` carry Intake provenance, so a future
non-Intake Producer can write a **Proposed**/**Done** row that resolves its
action through the same **Route target** registry.
_Avoid_: queue, backlog, drafts, notifications (the bell is the affordance;
the Inbox is the concept; Notifications are a _separate_ transient system),
triage (for the _resurfacing_ step only — not a synonym for Intake).

**Gate 1 / Gate 2**:
The two questions **Intake** answers about a cleaned **Capture** — _where_ and
_what_.

- **Gate 1 — Where?** Does the router know which **Route** this belongs to?
  No → **Unsorted** (Inbox, no CTA). Yes → continue to Gate 2.
- **Gate 2 — What?** Given the Route, does the router know enough to construct
  the _complete, safe_ action? Confident in the full action _and_ it's safe to
  perform unattended → **Done** (act now, with undo). Knows the Route but not
  the complete action — or the action is high-enough stakes to warrant a look
  → **Proposed** (staged for approve/reject).

Gate 2 is a _judgment over several heuristics_, not one static property:
payload completeness is primary (does the router know what message to mail,
what memory to save?); reversibility / stakes is a secondary modifier (a
commitment like a ticket, or open-ended work like mailing the orchestrator,
biases toward Proposed even when the payload is clear). Worked examples:

- "I finished a bike ride, log it" → Route: habit; payload: the bike-ride
  habit. Both clear → **Done**.
- "Cool idea: <idea>" → Route unclear → **Unsorted**.
- "Tell Kitchen we skipped dinner" → Route: mail Kitchen (clear); if the
  message is clear → **Done**; if the Route is clear but the message isn't →
  **Proposed**.
- "Remember <fact>" → Route: memory; payload: the fact → **Done**.

There is **no deterministic policy layer** over the classifier — act-vs-propose
is the model's judgment, full stop. The levers are the classifier prompt plus
the **routing guidance** each target contributes (core tools and apps alike);
safety is dialed in through that guidance, not through a structural override.

**Capture key**:
A long-lived bearer credential an external client (the Watch shortcut) uses to
POST a **Capture** — distinct from a BetterAuth login session. Implemented with
the BetterAuth **API Key plugin** (it owns the `apikey` table + migrations, per
ADR-015; hashed at rest, plaintext shown once at creation, rotation/expiry/
rate-limit built in). Issued per device via `friday capture-key create` or a
Settings card. Scoped with the plugin's permissions: `{ capture: ["write"] }`,
verified explicitly via `verifyApiKey`. Crucially the plugin's
`enableSessionForAPIKeys` is left at its default **`false`** — a Capture key
mints **no session**, so a leaked key can file Captures and nothing else; it
never grants dashboard access. The public entry point is a dashboard route
(`POST /api/capture`, a `PUBLIC_PATH`) that validates the key then proxies over
loopback to the daemon, which owns the classifier (ADR-002 — Claude SDK stays
daemon-side).
_Avoid_: token (overloaded — daemon-secret, Zero JWT), password, session.

### Transports

**Transport**:
A bidirectional, identity-bearing, threaded interface between a human and
Friday — Slack, email, SMS, the web UI, Linear, JIRA. Carries which **User**
spoke, which external thread they spoke in, and how Friday should sound back
(**Transport style**). The **Source**-into-**Intake** path is the degenerate
case: a Transport that expects no reply.
_Avoid_: channel (that's the outbound-only **Channel** of the Notification
system — a Transport may _use_ one), integration (too broad — the Linear API
client is an integration, not a Transport), adapter, source (that's one-shot
provenance).

**Transport style**:
The per-**Transport** register Friday speaks in — brevity, level of detail,
cadence, formatting. Declared by each Transport rather than inferred, because
the right answer differs sharply by medium: an SMS reply is one sentence, an
email reply is structured, a Slack thread reply is terse and link-heavy. A
_modulation_ of the assistant persona, never a replacement for it — the SOUL is
the same Friday in every Transport; only the register changes.
_Avoid_: persona (taken twice — the **Intake persona** and the SOUL assistant
persona; a Transport style replaces neither), profile (taken by the per-agent
sandbox profiles), tone (too narrow — style covers length and cadence too),
voice.

### Notifications

**Notification**:
A **fire-and-forget**, machine→human surfacing of a system event (a Builder
finished, mail arrived, a schedule fired, a low-confidence **Capture** needs a
look). The mirror of a **Capture** — where a Capture is _human→machine_ messy
input that gets cleaned, a Notification is _machine→human_ pre-authored output
that needs no cleaning. It is **not persisted as its own entity** (v1): a
transient _delivery_, never a row. The system that surfaces it is its own tier
— separate pipeline from **Intake** (no cleaning) and from **Chat/mail** (no
turn loop), even though all three share Postgres/Zero/the daemon under the hood.
_Avoid_: notification (lowercase, when you mean the bell affordance — that's the
**Inbox**), alert, message (reserve for chat/mail), event (too broad).

**Notification router**:
The **stateless, daemon-side** function that, per **Notification**, consults
**Settings** + **DND** + **presence** and fires zero or more **Channel**s. The
parallel to the **Intake router**, one tier up: it holds no cross-event state
and stores nothing. Lives in the daemon because the daemon is the single
server-side point that holds the VAPID key and the push subscriptions.
_Avoid_: dispatcher, notifier, intake router (the opposite-direction sibling).

**Channel**:
A delivery surface a **Notification router** can fire — **Toast** (ephemeral
in-app, self-dismissing, only for a present client) and **Push** (external Web
Push + the app-icon **badge** bump). The **bell is _not_ a Channel** — it is
the **Inbox**'s persistent surface; the two systems meet only at the shared
**badge count**. **Channels fan out**: one Notification may fire any subset.
_Avoid_: sink, output, bell (the bell belongs to the Inbox).

**Presence**:
Whether the user is actively viewing the app _right now_, used by the
**Notification router** to choose **Toast** over **Push**. **User-global and
OR-aggregated across all clients**: present on _any one_ client ⇒ present;
absent requires _every_ client absent. The daemon tracks per-client liveness
and reduces it to one user-level verdict. Reported client→daemon and treated
**fail-safe**: stale or unknown ⇒ treat as away ⇒ **Push**. Presence can only
ever _downgrade_ a Push to a Toast, never the reverse — a missed Toast is
acceptable, a missed Push is not.
_Avoid_: online, connected (an open transport is a coarse proxy, not Presence).

**Notification policy**:
The per-event-type **Setting** governing which **Channel**s a **Notification**
fires. Stored as a `notify_policy` JSON map on the `settings` table —
`{ <eventType>: { <channel>: <rule> } }` — where rule ∈ `never | present_only |
absent_only | always`. The rule vocabulary is **presence-based and
channel-agnostic**, so the open **Channel** set grows by adding a key, never by
expanding the rule enum (adding `email` later is purely additive). The settings
UI offers friendly presets (Auto / Always push / Toast only / Off) that are
pure sugar writing these rules — presets are a view, the map is the truth. A
global **DND** window overlays every policy (suppresses **Push**); one master
toggle lets a _critical_ class (`evolve_critical`, mail `priority='critical'`)
bypass DND.
_Avoid_: preferences (too broad); the preset names as a stored enum (they are
UX sugar, not the model — that was the rejected channel-hardcoded design).

## Relationships

- A **Theme** is either **Single** (one **Palette**) or **Sync** (a pair
  of **Palettes**, one per slot).
- The active **Palette** is determined by **Theme** + **Mode**:
  - **Single** → the chosen **Palette**, **Mode** ignored.
  - **Sync** → the **Palette** assigned to the slot matching the resolved
    **Mode**.
- Every **Palette** is available for every slot — there is no "light-only"
  or "dark-only" **Palette**.
- The active **Palette** stamps two classes on `<html>`:
  `.palette-<name>` (exactly one at a time) and `.dark` (iff the active
  **Palette**'s kind is dark). CSS token blocks key off `.palette-<name>`;
  kind-dependent rules (Shiki, Mermaid) key off `.dark`. The `.dark` class
  is repurposed: under the previous design it tracked the user's **Mode**;
  it now tracks the active **Palette**'s kind.
- **Theme** state is canonically stored in Postgres (`settings` table,
  flat columns); the dashboard mirrors it to localStorage on every change
  so the pre-paint FOUC script can resolve the active **Palette**
  synchronously on the next page load.

## Example dialogue

> **Dev:** "If the user picks **Dawn** as their dark-slot default, what happens at night?"
> **Domain expert:** "**Dawn** renders as **Dawn**. The active **Palette** is **Dawn**, the **Mode** is `dark`, but the page looks warm and light — the **Palette** owns the colors, not the **Mode**."

## UI surface names

**Appearance**: The Settings card that exposes the **Theme** controls
(Single/Sync toggle, **Palette** pickers). User-facing label only — not a
domain concept. Matches the convention macOS and GitHub use; keeps the
domain vocabulary (Mode/Palette/Theme/Kind) out of the user-facing UI.

## Flagged ambiguities

- "Conversation" was briefly ambiguous between transport-spanning and
  transport-scoped — resolved: a **Conversation** is keyed by **User** and agent
  and spans every **Transport**. A **Transport** is _per-turn_ context: it
  decides the **Transport style** of the reply and where the reply is delivered,
  never the identity of the Conversation. An external thread (Slack `thread_ts`,
  an email `Message-ID` chain) resolves to a Conversation plus a reply target;
  it is not a Conversation of its own.

- "Theme" historically meant "the Friday light/dark pair." It now means
  the user's whole theming selection. Old uses in commits / docs that
  refer to "the dark theme" usually mean the **Dusk Palette**.
- The Settings card titled "Theme" today is really a **Mode** picker; it
  is being renamed to **Appearance** and grown to expose the full **Theme**
  (Single/Sync + **Palette** picks).
- "status" was used for both the authoritative in-daemon state and the
  `agents.status` DB column — resolved: the authoritative concept is
  **Turn state**; `agents.status` and `w.status` are **Status projection**s
  of it. The pre-refactor `suppressIdleReset` / `forceKilled` flags were
  hand-rolled guards against a superseded **Generation** writing a
  projection; the **Generation** no-op rule replaces both.
