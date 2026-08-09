# AI Agent Workflow Builder

An n8n-style workflow builder where users belong to organizations and build AI
workflows out of ordered steps: an LLM call, an HTTP request, a conditional
branch that reads real runtime output, an approval gate that pauses execution
until a human signs off, a controlled database write, and a notification
delivered through a Hasura Event Trigger.

Built on **Nhost** (PostgreSQL + Hasura + Auth), **Hasura GraphQL Engine**,
**PostgreSQL**, and **Next.js**, with **Groq / OpenRouter / Gemini** for the LLM
step.

The interesting part is not the step list — it is that authorization holds when
you stop using the UI. Every restriction is enforced in Hasura permissions and,
for the restricted capabilities, a second time in the database. There is a test
suite that attacks the system with valid credentials from the wrong organization
and asserts it gets nothing.

---

## Contents

- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Hasura setup](#hasura-setup)
- [Running locally](#running-locally)
- [Test users](#test-users)
- [The demonstration scenario](#the-demonstration-scenario)
- [Security model](#security-model)
- [Quota model](#quota-model)
- [Retry behaviour](#retry-behaviour)
- [LLM provider](#llm-provider)
- [Tests](#tests)
- [Repository layout](#repository-layout)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Architecture

```
Next.js (browser)  ──user JWT──▶  Hasura GraphQL  ──▶  PostgreSQL
       │                              │
       │                              ├─ Action ──▶ /api/actions/*   ─┐
       │                              ├─ Event ───▶ /api/events/*    ─┤ workflow engine
       │                              └─ Cron ────▶ /api/events/*    ─┘
       │                                                              │
       └────────── subscription (live step_runs) ◀── PostgreSQL ◀─────┘
```

Triggering a workflow does **not** execute it inline. `triggerWorkflowRun`
authorizes the caller, reserves quota atomically, and inserts a `workflow_run`.
A Hasura **Event Trigger** on that insert calls the engine, which runs the
steps. The client gets a run id back immediately and watches progress over a
**GraphQL subscription**. That keeps the HTTP request short, gives execution
Hasura's at-least-once redelivery, and means a crashed handler cannot orphan a
run.

Full reasoning: [`docs/architecture.md`](docs/architecture.md).

---

## Local setup

**Prerequisites:** Node 20+, an [Nhost](https://nhost.io) project (free tier is
fine), and an LLM API key (Groq's free tier is the quickest).

```bash
git clone <this-repo>
cd ai-agent-workflow-builder
npm install
cp .env.example .env.local        # then fill it in — see below
```

Download the Hasura CLI once (the apply script looks for it here first, and
falls back to a `hasura` on your PATH):

```bash
# macOS / Linux
mkdir -p .tools && curl -L https://github.com/hasura/graphql-engine/releases/download/v2.50.0/cli-hasura-darwin-amd64 -o .tools/hasura && chmod +x .tools/hasura

# Windows (PowerShell)
mkdir .tools; Invoke-WebRequest https://github.com/hasura/graphql-engine/releases/download/v2.50.0/cli-hasura-windows-amd64.exe -OutFile .tools\hasura.exe
```

Then:

```bash
npm run hasura:apply     # migrations + metadata
npm run seed             # organizations, users, demo workflow
npm run dev              # http://localhost:3000
```

---

## Environment variables

Copy `.env.example` to `.env.local`. Every variable listed there is actually
read by the code.

| Variable | Where it comes from | What it does |
|---|---|---|
| `NEXT_PUBLIC_NHOST_SUBDOMAIN` | Nhost dashboard | Builds the auth and GraphQL URLs. Public by design. |
| `NEXT_PUBLIC_NHOST_REGION` | Nhost dashboard | As above. |
| `HASURA_GRAPHQL_ENDPOINT` | Nhost → Hasura | Where the engine sends admin GraphQL. |
| `HASURA_GRAPHQL_ADMIN_SECRET` | Nhost → Settings → Hasura | **Server-side only.** Never prefixed `NEXT_PUBLIC_`, never sent to the browser. |
| `ACTION_WEBHOOK_SECRET` | You invent it | Shared secret Hasura sends to `/api/*`. Handlers reject requests without it, which is what makes `session_variables` trustworthy. Set the same value in Nhost's env vars. |
| `APP_BASE_URL` | `http://localhost:3000`, or your deploy URL | Where Hasura calls back. Also set it in Nhost env so metadata's `{{ACTION_BASE_URL}}` resolves. |
| `LLM_PROVIDER` | `groq` \| `openrouter` \| `gemini` | Which client the `llm_call` step uses. |
| `LLM_API_KEY` | Provider console | Leave empty only if you accept the disclosed stub. |
| `LLM_MODEL` | e.g. `llama-3.3-70b-versatile` | Model id. |
| `HTTP_STEP_ALLOW_PRIVATE_NETWORK` | `false` | Keep false. True disables the SSRF guard. |
| `NOTIFY_MODE` | `log` \| `slack` | `log` exercises the whole Event Trigger path without Slack credentials. |
| `SLACK_WEBHOOK_URL` | Slack | Only needed when `NOTIFY_MODE=slack`. |
| `STEP_MAX_ATTEMPTS` | `2` | Default retry attempts; per-step config overrides it. |
| `SEED_PASSWORD`, `TEST_ORG_*` | You choose | Used by `npm run seed` and the integration tests. |

**In the Nhost dashboard** (Settings → Environment Variables) also set
`ACTION_BASE_URL` and `ACTION_WEBHOOK_SECRET`. Hasura substitutes
`{{ACTION_BASE_URL}}` in the committed metadata, so the same metadata works
locally (with a tunnel) and in production without edits.

---

## Database setup

One migration, `hasura/migrations/default/1786000000000_init_workflow_schema/`,
creates everything: eleven tables, foreign keys, unique and check constraints,
indexes for the documented access patterns, `updated_at` triggers, the
`org_id`-derivation triggers, the Layer 2 enforcement triggers, the atomic
quota functions, and the `organization_usage_stats` view.

```bash
npm run hasura:apply          # applies migrations + metadata
```

The schema's guarantees are proven independently of Hasura by
`scripts/validate-schema.sql` — 18 assertions covering derived `org_id`,
owner-only capabilities, deferred-constraint reordering, quota exhaustion, and
cascade behaviour. Against any Postgres with an `auth.users` table:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f hasura/migrations/default/1786000000000_init_workflow_schema/up.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/validate-schema.sql
```

### Tables

| Table | Purpose |
|---|---|
| `organizations` | Tenant boundary; holds quota. |
| `org_members` | `(org_id, user_id, role)` — the only source of authority. |
| `workflows` | Definition, one per organization. |
| `workflow_steps` | Ordered steps; `UNIQUE (workflow_id, position) DEFERRABLE`. |
| `workflow_triggers` | manual / webhook / scheduled / database_event. |
| `workflow_runs` | One execution; `org_id` derived by trigger. |
| `step_runs` | One per (run, step); status, output, `attempt_count`, approval. |
| `workflow_outputs` | The only table `db_write` may target. |
| `notifications` | Written by `notify`, drained by an Event Trigger. |
| `quota_reservations` | Audit log of every allow/deny decision. |
| `organization_usage_stats` | View — the aggregation requirement. |

---

## Hasura setup

`hasura/metadata/` is committed and authoritative — nothing is configured by
hand in the console. It contains all table tracking, relationships in both
directions, permissions, three Actions, two Event Triggers, and one cron.

```bash
npm run hasura:apply     # apply + reload + fail on any inconsistency
node scripts/validate-metadata.mjs   # static assertions about the permissions
```

`validate-metadata.mjs` catches the mistakes Hasura itself would accept: an
empty filter (which exposes every row), a filter that never reaches
`org_members`, a missing Layer 2 clause, `webhook_secret` becoming selectable,
quota columns becoming user-updatable, or an Action losing its shared secret.

---

## Running locally

```bash
npm run dev          # Next.js on :3000 (UI + Action/Event handlers)
npm run typecheck
npm run build
npm run test:unit
```

Hasura Cloud must be able to reach `APP_BASE_URL`. For local development expose
port 3000 with a tunnel and set `ACTION_BASE_URL` in Nhost to the tunnel URL:

```bash
npx localtunnel --port 3000        # or ngrok http 3000
```

Without a tunnel the UI, queries, and subscriptions all work, but runs stay
`pending` because Hasura cannot call the engine.

---

## Test users

`npm run seed` creates two organizations and four users, all with
`SEED_PASSWORD` (default `Passw0rd!seed`):

| Email | Role | Organization |
|---|---|---|
| `owner.a@example.test` | owner | Org A |
| `editor.a@example.test` | editor | Org A |
| `viewer.a@example.test` | viewer | Org A |
| `owner.b@example.test` | owner | **Org B** — no membership in Org A |

It also builds the demo workflow in Org A and prints the webhook URL.

> Turn **off** "Require email verification" in Nhost (Auth → Sign-in methods),
> or the seeded users cannot sign in.

---

## The demonstration scenario

The seeded workflow, **Support ticket triage**:

```
1. LLM Call            classify the ticket, returning JSON
2. HTTP Request        enrich from a public API
3. Conditional Branch  reads step 1's ACTUAL output
      ├── label = needs_approval ──▶ 4. Approval Gate ─▶ 5. DB Write ─▶ 6. Notify
      └── otherwise ───────────────────────────────────────────────────▶ 6. Notify
```

**1 — Sign in as the Org A owner.** The header shows the organization, the role
badge, and `n / 20 executions`.

**2 — Run it.** Press **Run workflow**. Steps light up live over the
subscription — no refresh. The LLM call and HTTP request complete, the branch
evaluates, and the run stops at **⏸ Approval Gate — Waiting for approval**.
Run status is `paused`. Steps 5 and 6 have not run.

**3 — Approve.** Press **Approve and resume**. The gate records `approved_by`
and `approved_at`, DB Write and Notify execute, and the run reaches
`completed`. Expand a step to see its real output.

**4 — Trigger by webhook.** Reveal the URL on the webhook trigger (owner only),
then:

```bash
curl -X POST "$WEBHOOK_URL" -H "content-type: application/json" \
  -d '{"text":"Our checkout has been down for an hour and I want a refund."}'
```

Returns `202` with a run id. A neutral message such as
`{"text":"How do I change my avatar?"}` takes the other branch — steps 4 and 5
show as `skipped`, and the run completes without pausing.

**5 — Sign in as `owner.b@example.test`.** Org A's workflows are not listed.
The organization switcher offers only Org B.

**6 — Attack it directly.** With the Org B token, in the Hasura console or via
curl, using real Org A UUIDs:

```graphql
query { workflows(where: { id: { _eq: "<ORG_A_WORKFLOW_ID>" } }) { id name } }
# → { "workflows": [] }

mutation { triggerWorkflowRun(workflow_id: "<ORG_A_WORKFLOW_ID>") { run_id } }
# → "Workflow not found or you do not have access to it."

mutation { approveStep(step_run_id: "<ORG_A_STEP_RUN_ID>") { run_status } }
# → "Approval step not found or you do not have access to it."

subscription { step_runs(where: { workflow_run_id: { _eq: "<ORG_A_RUN_ID>" } }) { id status } }
# → { "step_runs": [] }  (forever)
```

All five are asserted in `tests/integration/`.

---

## Security model

**Layer 1 — organization + role.** One Hasura role, `user`. Organization roles
are rows in `org_members`, reached by a relationship traversal in every
permission. A role is never a session variable, because a Hasura role is global
while "editor" is local to one organization.

**Layer 2 — restricted capabilities.** `db_write` and `notify` steps and
`webhook` triggers are owner-only, expressed as an extra
`type: { _nin: [...] }` clause on the editor branch of the same permission — and
enforced a second time by a database trigger that compares `created_by` /
`updated_by` (set by Hasura column presets, not client-writable) against
`org_members`.

**Action authorization.** `approveStep` decides at runtime, walking
`step_run → workflow_run → workflow → organization → org_members` from the
step-run id alone. It also verifies the step really is an `approval_gate`, the
run really is paused, and the approval has not been consumed. The write is
conditional and checks `affected_rows`, so concurrent approvals cannot both
resume.

**Cross-org isolation.** Reads are filtered, Actions fail closed with an error
indistinguishable from not-found (so they cannot enumerate UUIDs), subscriptions
inherit the same filter, and `org_id` on runs/outputs/notifications is
*derived by a database trigger* rather than accepted — making cross-org writes
structurally impossible rather than merely forbidden.

**What is deliberately not writable by anyone:** `workflow_runs`, `step_runs`,
`workflow_outputs`, `notifications`, and `quota_reservations` have no
insert/update/delete permission for role `user`. That is what makes the quota
check unavoidable and approval impossible to fake.

---

## Quota model

**One workflow execution = one quota unit**, whatever the trigger (manual,
webhook, or scheduled) and regardless of how many steps run or whether the run
ultimately succeeds. Reserving on *attempt* rather than on success is the
conservative choice: an LLM call that fails still cost money.

Reserved **before** the run row is created, and refunded if creation fails. The
window is monthly, reset lazily on first use after the month rolls over.

Concurrency safety lives in `reserve_org_quota()`, which does the comparison and
the increment while holding `SELECT ... FOR UPDATE` on the organization row.
Concurrent callers serialize, so the ones past the limit observe the incremented
value and are refused. **Measured:** 200 concurrent reservations against a limit
of 25 grant exactly 25, with `quota_used` landing on exactly 25.

`quota_limit` is absent from every update permission, so nobody can raise their
own ceiling. The UI shows `used / limit`, remaining, and switches the Run button
to "Quota exhausted".

---

## Retry behaviour

External calls (`llm_call`, `http_request`) retry with **full-jitter exponential
backoff**: `delay = random(0, base × 2^(attempt-1))`, capped at 30s. Default 2
attempts; per-step `max_attempts` and `base_delay_ms` override it.

| Retried | Not retried |
|---|---|
| Network failure, timeout | 400, 401, 403, 404, 422 |
| HTTP 5xx | Invalid step config |
| 408, 429 | Unsupported provider |

Retrying a 401 just doubles the latency of a guaranteed failure, and retrying a
400 can double a side effect. `attempt_count` is persisted after **every**
attempt, so the subscription shows "attempt 2" while the retry is in flight.

---

## LLM provider

`llm_call` calls a real provider. Groq and OpenRouter use the OpenAI-compatible
chat-completions shape; Gemini uses `generateContent`. Configure with
`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`; a step's `config.provider` and
`config.model` override the defaults.

`parse_json: true` requests structured output and tolerates the ways models
actually reply — bare JSON, fenced blocks, or JSON embedded in prose — which is
what lets the conditional branch read `steps.1.output.json.label`.

**Stub disclosure.** If `LLM_API_KEY` is empty the step falls back to a
deterministic offline stub. It logs a warning, sets `"provider": "stub"` and
`"stubbed": true` in the step output, and labels the model
`"(STUB — no LLM_API_KEY configured)"`. It derives its answer from the actual
prompt text, so the branch still branches on step output rather than a constant.
It is never silently substituted for a configured provider. **Set a real key for
the demonstration.**

---

## Tests

```bash
npm run test:unit          # no credentials needed
npm run test:integration   # needs hasura:apply + seed + a reachable APP_BASE_URL
npm test                   # both
```

**Unit (36 tests, `tests/unit/`)** — condition operators, template resolution
including prototype-pollution refusal, retry classification and backoff, the
SSRF address guard (loopback, RFC1918, link-local, CGNAT, IPv6, IPv4-mapped
bypasses), and JSON extraction from messy completions.

**Integration (`tests/integration/`)** — signs in as the seeded users and sends
real GraphQL, with no admin secret and no test-only bypass:

- `authorization.test.ts` — role matrix (owner/editor can trigger, viewer
  cannot), organization visibility, and every cross-org read path including
  unfiltered queries and aggregates.
- `layer2-restrictions.test.ts` — owner can add `db_write`/`notify`/webhook,
  editor cannot; editor cannot promote a step into a restricted type, nor
  modify or delete an owner-created one; `webhook_secret` is unselectable.
- `execution.test.ts` — the full scenario: real LLM, real HTTP, branch on real
  output, pause, cross-org approval attack, cross-org **subscription** attack,
  approve, resume, completion, `db_write` landing in the right org, notify
  delivered by the Event Trigger, double-approval rejected, retry on 500 with
  `attempt_count = 2`, no retry on 404, and the webhook trigger.
- `quota.test.ts` — consumption, exhaustion, no run row on rejection,
  20 concurrent triggers against a limit of 5 granting exactly 5, per-org
  scoping, and the aggregation view.

Database-level proofs (independent of Hasura) live in
`scripts/validate-schema.sql`; metadata assertions in
`scripts/validate-metadata.mjs`.

---

## Repository layout

```
apps/web/                    Next.js — UI plus Action/Event/webhook handlers
  app/api/actions/*          triggerWorkflowRun, approveStep, getWebhookUrl
  app/api/events/*           Event Trigger + cron receivers
  app/api/webhook/[id]/      public webhook endpoint
  components/                builder, run panel, login
  lib/                       Nhost auth, GraphQL, subscriptions, queries
packages/engine/             @wfb/engine — framework-agnostic workflow engine
  src/core/                  engine, authz, quota, approval, retry, context
  src/steps/                 llm, http, dbWrite, notify
hasura/
  migrations/default/        the schema
  metadata/                  tables, permissions, actions, event triggers, cron
scripts/                     apply, seed, schema proofs, metadata assertions
tests/unit, tests/integration
docs/architecture.md
```

The engine is a separate package with no Next.js imports, so it is unit-testable
and could be moved to Nhost Functions or any Node host without change.

---

## Deployment

**Backend** — an Nhost project. Apply migrations and metadata with
`npm run hasura:apply` pointed at it, then set `ACTION_BASE_URL` and
`ACTION_WEBHOOK_SECRET` in Nhost's environment variables.

**Frontend and handlers** — the Next.js app deploys as one unit (Vercel or any
Node host). Set every non-`NEXT_PUBLIC_` variable as a server-side secret, and
point `ACTION_BASE_URL` at the deployed origin.

After deploying, confirm `hasura metadata inconsistency list` is empty and that
a run's subscription updates live in production.

---

## Known limitations

- **Loops are not supported.** A `conditional_branch` may only jump forward;
  a backward jump fails the run explicitly rather than looping.
- **Steps execute sequentially.** No parallel branches; the schema would
  support it, the engine does not.
- **Resumption runs inline in the approve request.** For a long tail after an
  approval gate this would be better as a second Event Trigger.
- **DNS rebinding is not fully closed.** The SSRF guard resolves and validates
  before connecting, but Node's `fetch` cannot pin the resolved address to the
  socket. Closing it needs a custom agent with a `lookup` hook or an egress
  proxy. Documented rather than papered over.
- **Session tokens live in `localStorage`**, the usual SPA trade-off against
  XSS. Mitigated by every sensitive operation re-deriving authority server-side.
- **Webhook secrets rotate by recreating the trigger.** There is no rotation
  endpoint.
- **The scheduled trigger sweep runs every 15 minutes**, so `every_minutes` is
  floored at 15.
- **One trigger per type per workflow**, enforced by a unique constraint.
