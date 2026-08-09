# Architecture

## Shape

```
Next.js (browser)  ──user JWT──▶  Hasura GraphQL  ──▶  PostgreSQL
       │                              │
       │                              ├─ Action ──▶ /api/actions/*   ─┐
       │                              ├─ Event ───▶ /api/events/*    ─┤ workflow engine
       │                              └─ Cron ────▶ /api/events/*    ─┘   (@wfb/engine)
       │                                                                   │
       └────────── subscription (step_runs, live) ◀── PostgreSQL ◀─────────┘
```

The browser holds only a user JWT. The admin secret exists solely in server-side
environment variables and is used by the engine to write run state the calling
user is not permitted to write directly — always after an explicit authorization
check, never to answer a question on the user's behalf.

## Why the schema is split this way

`organizations` is the tenant boundary and the only place quota lives.
`org_members` is deliberately a separate table rather than a `role` column
anywhere else: a role is meaningful only *inside* an organization, so it has to
be an edge between a user and an org, not an attribute of either. Every
permission in the system is a traversal that ends at an `org_members` row.

`workflows` holds definition; `workflow_runs` holds execution. Separating them
means a run keeps a faithful record even as the workflow is edited afterwards.
`workflow_steps` is separate from `workflows` so ordering, types, and per-step
config are rows that permissions can discriminate on — which is what makes
"editors may add steps, but not *these* step types" expressible. `step_runs` is
per-(run, step) so the UI has a row to subscribe to for every box it draws, and
so `attempt_count` and approval fields have somewhere to live.

`workflow_triggers` is separate from workflows because a trigger is a distinct
capability with its own permission story (webhooks are owner-only). Finally,
`workflow_outputs` and `notifications` exist so that `db_write` and `notify`
have a fixed, safe destination rather than accepting a table name from config.

## Layer 1 — organization membership and role

Every permission is scoped through a relationship path that terminates in
`org_members` filtered by `X-Hasura-User-Id`. For workflows:

```yaml
filter:
  organization:
    org_members:
      user_id: { _eq: X-Hasura-User-Id }
      role: { _in: [owner, editor] }
```

There is exactly one Hasura role, `user`. Organization roles are never Hasura
roles and never session variables, because a Hasura role is global while
"editor" is local to one organization. A user who is an owner in Org B gets
nothing extra in Org A — the traversal simply finds no membership row.

Reads are open to all three roles. Writes to workflows and steps require
owner/editor. Membership management requires owner. `workflow_runs`,
`step_runs`, `workflow_outputs`, `notifications`, and `quota_reservations` have
**no** insert/update/delete permission for `user` at all: they are written only
by the engine. That is what makes the quota check unavoidable and approval
impossible to fake with a plain mutation.

## Layer 2 — restricted capabilities

Being an editor does not confer every capability. `db_write` and `notify` steps,
and `webhook` triggers, are owner-only. This is expressed as a second clause in
the same permission rather than a second role:

```yaml
check:
  _or:
    - workflow: { organization: { org_members: { user_id: {_eq: X-Hasura-User-Id}, role: {_eq: owner} } } }
    - _and:
        - workflow: { organization: { org_members: { user_id: {_eq: X-Hasura-User-Id}, role: {_eq: editor} } } }
        - type: { _nin: [db_write, notify] }
```

It is enforced twice. Independently of Hasura, a `BEFORE INSERT OR UPDATE`
trigger compares the row's `created_by`/`updated_by` (set by Hasura column
presets from the session, not client-writable) against `org_members` and raises
`42501`. If a permission were ever loosened by mistake, the database still
refuses. The update rule also blocks converting a permitted step *into* a
restricted one, and `workflow_triggers.type` is not updatable at all so a manual
trigger cannot be promoted to a webhook.

## Approval — a runtime decision, so an Action

Whether an approval is legitimate depends on state no row-level rule can see:
is the run currently paused, is this step really an `approval_gate`, has it
already been consumed. So `approveStep` is a Hasura Action. Its handler takes
only `step_run_id` and derives everything else:

```
step_run → workflow_run → workflow → organization → org_members(caller) → role
```

Nothing is read from the request body but the step-run id. Cross-org and
nonexistent ids return the *same* "not found" message, so the Action cannot be
used to confirm which UUIDs are real. The write is then conditional
(`status = paused AND approved_by IS NULL`) and checks `affected_rows`, so two
simultaneous approvals cannot both resume the run.

## Pause and resume

Reaching an `approval_gate` sets `step_run.status = paused`,
`workflow_run.status = paused`, `paused_at`, and `resume_position` (the position
of the next step), then returns. Nothing downstream executes. On approval the
engine re-enters with `mode: 'resume'`, rebuilds the template context by
replaying the persisted `step_runs` outputs — so resumption is stateless and
survives a process restart — and continues from `resume_position`. The run
reaches `completed` only after the remaining steps actually run.

## Execution and branching

Steps run sequentially by `position ASC`. A `conditional_branch` evaluates its
condition against the live context (`steps.1.output.json.label`, i.e. what the
LLM returned *this run*) and returns a target. Jumping forward marks every
step passed over as `skipped`, so the untaken branch is visible rather than
stuck pending. Backward jumps are refused; loops are not supported.

Retries wrap external calls with full-jitter exponential backoff.
Errors are classified: 5xx, 408, 429, timeouts, and socket failures are retried;
4xx, invalid config, and auth failures are not, because a second attempt cannot
change the outcome. `attempt_count` is persisted after *every* attempt, so a
subscription shows "attempt 2" while the retry is still in flight.

## Live status

The frontend subscribes to `step_runs` filtered by `workflow_run_id`. The
subscription runs through the ordinary select permission, so subscribing to
another organization's run id yields an empty stream rather than a leak. The UI
never writes an optimistic status: pressing Approve calls the Action and then
renders whatever the socket reports, which is why a post-approval failure shows
as failed rather than as a wishful "done".

## Quota

One workflow execution = one unit, reserved *before* the run row is created and
refunded if creation fails. The check and increment happen inside
`reserve_org_quota()` while holding `SELECT ... FOR UPDATE` on the organization
row, so concurrent callers serialize and the surplus ones observe the
incremented value. Doing this in application code would reintroduce the classic
race where N requests all read the same pre-increment value. Measured: 200
concurrent reservations against a limit of 25 grant exactly 25.

## Cross-organization isolation

Five distinct paths, all closed:

| Attack | What stops it |
|---|---|
| Query Org A's workflow by id | Row-level select filter → empty set |
| Trigger Org A's workflow | `triggerWorkflowRun` membership lookup → not found |
| Approve Org A's gate | `approveStep` chain traversal → not found |
| Subscribe to Org A's run | Same select permission applies to subscriptions |
| Write into Org A via `db_write` | `org_id` derived by a DB trigger from the run |

The last one is structural rather than a rule: `workflow_runs.org_id`,
`workflow_outputs.org_id`, and `notifications.org_id` are overwritten by
`BEFORE INSERT` triggers with the value derived from the parent row, so a forged
`org_id` in any payload is discarded rather than honoured.
