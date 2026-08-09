# Demo walkthrough

A shot list for the recording. Roughly 6–8 minutes at a normal pace. Every claim
below is something the system actually does — nothing here is staged.

Before recording:

```bash
docker compose up -d          # or point at Nhost Cloud
npm run hasura:apply
npm run seed                  # prints the webhook URL — keep the terminal open
npm run dev
```

Have ready: the app at `http://localhost:3000`, a terminal for the webhook
`curl`, and a second browser profile (or incognito window) so you can be signed
in as two organizations at once.

---

## 1. Sign in as the Org A owner  ·  ~30s

Open the app. Use the **Org A — Owner** quick-fill, sign in.

Point out in the header:
- the organization selector — it lists *only* organizations you belong to
- the **owner** role badge
- the quota meter: `n / 20 executions`

> "Nothing in this header came from the client. The role is a row in
> `org_members`, resolved by the same Hasura permission that guards every query."

---

## 2. Show the workflow  ·  ~45s

Select **Support ticket triage**. Walk the six steps:

```
1. LLM Call             Classify support ticket
2. HTTP Request         Enrich from external API
3. Conditional Branch   Does this need human approval?
4. Approval Gate        Human approval required
5. DB Write             Persist verdict        ← "owner only" badge
6. Notify               Announce outcome       ← "owner only" badge
```

Open the config on step 3 and read the condition aloud:

```json
{ "path": "steps.1.output.json.label", "operator": "equals", "value": "needs_approval" }
```

> "That path points at what the model returns *during this run*. There is no
> hardcoded branch result — you'll see the resolved value in the step output."

---

## 3. Run it manually  ·  ~60s

Press **Run workflow**. Do not refresh anything — that's the point.

Narrate as the rows light up:
- **LLM Call** completes — expand its output, show the real `json.label`,
  `provider: "gemini"`, and the token `usage`
- **HTTP Request** completes — show `status: 200` and the response body
- **Conditional Branch** completes — expand it: `matched: true`,
  `resolved: "needs_approval"`, and the branch it took
- **Approval Gate** turns amber: **⏸ Waiting for approval**

Then point at the run status: **PAUSED**, and at steps 5 and 6 still pending.

> "The run is genuinely stopped. `workflow_run.status` is `paused`, `paused_at`
> is set, and nothing after the gate has executed. The updates you just saw
> arrived over a GraphQL subscription filtered by `workflow_run_id`."

---

## 4. Approve and watch it resume  ·  ~45s

Press **Approve and resume**.

- the gate flips to completed and shows **approved**
- **DB Write** runs — expand it, show `written: true` and the `org_id` the
  database assigned
- **Notify** runs
- run status becomes **COMPLETED**

Press **Show persisted outputs & notifications**: the `verdict` row and the
notification marked `sent`.

> "The run only reached `completed` after the remaining steps actually ran.
> Approval resumes execution; it doesn't mark the run finished."

---

## 5. Trigger it by webhook  ·  ~45s

On the webhook trigger, press **Reveal URL** (owner-only — an editor gets a
permission error). Then in the terminal:

```bash
curl -X POST "<WEBHOOK_URL>" \
  -H "content-type: application/json" \
  -d '{"text":"Our checkout has been down for an hour and I want a refund."}'
```

Show the `202` and the returned `run_id`, then switch back and watch that run
appear and progress live.

Then show the **other branch** with a benign ticket:

```bash
curl -X POST "<WEBHOOK_URL>" \
  -H "content-type: application/json" \
  -d '{"text":"How do I change my avatar?"}'
```

This one classifies as `auto_resolve`, so the branch jumps past the gate: steps
4 and 5 show **skipped** and the run completes without pausing.

> "Same workflow, opposite path, decided by what the model actually returned."

And demonstrate a wrong secret is refused:

```bash
curl -i -X POST "<WEBHOOK_URL_WITH_WRONG_SECRET>"   # 401
```

---

## 6. The cross-organization proof  ·  ~2 min

This is the part that matters most. Open a second browser profile and sign in
with the **Org B — Owner** quick-fill.

**In the UI:** the organization selector offers only Org B. Org A's workflows
are not listed.

> "That's the boring half. Hiding things in a UI isn't security. Here's the
> interesting half."

Now attack it directly. Open the Hasura console (or use `curl`) with the **Org B
user's JWT** — not the admin secret — and paste real Org A UUIDs, which you can
read off the owner's screen.

**Read the workflow:**
```graphql
query { workflows(where: { id: { _eq: "<ORG_A_WORKFLOW_ID>" } }) { id name } }
```
→ `{"workflows": []}` — not an error, an empty set. The row does not exist for
this user.

**Drop the filter entirely:**
```graphql
query { workflows { id org_id name } }
```
→ only Org B's rows. The row-level filter applies whether or not you ask for it.

**Trigger it:**
```graphql
mutation { triggerWorkflowRun(workflow_id: "<ORG_A_WORKFLOW_ID>") { run_id } }
```
→ `"Workflow not found or you do not have access to it."`

> "Note the wording. It's identical to what you get for a UUID that doesn't
> exist anywhere — so this endpoint can't be used to discover which UUIDs are
> real workflows in other organizations."

**Approve someone else's gate:**
```graphql
mutation { approveStep(step_run_id: "<ORG_A_STEP_RUN_ID>") { run_status } }
```
→ `"Approval step not found or you do not have access to it."`

**Subscribe to their run:**
```graphql
subscription { step_runs(where: { workflow_run_id: { _eq: "<ORG_A_RUN_ID>" } }) { id status } }
```
→ stays `{"step_runs": []}` forever. Permissions apply to subscriptions exactly
as they do to queries.

Switch back to the Org A window to show that run is still sitting there
untouched — the failed attempts changed nothing.

---

## 7. Layer 2, if there's time  ·  ~45s

Sign in as **Org A — Editor**. Same organization, lower capability:

- the **Add step** dropdown offers no *DB Write* or *Notify*
- the **Add trigger** dropdown offers no *webhook*

Then submit it anyway, bypassing the UI:

```graphql
mutation {
  insert_workflow_steps_one(object: {
    workflow_id: "<ORG_A_WORKFLOW_ID>", position: 99,
    type: "db_write", name: "bypass attempt", config: {}
  }) { id }
}
```
→ refused by the Hasura permission check.

> "And if that permission were ever loosened by mistake, a database trigger
> refuses it too — it compares `created_by`, which Hasura stamps from the
> session and the client cannot set."

---

## Closing frame

```
npm test
```

96 tests: 36 unit, and 60 integration that sign in as the seeded users and send
real GraphQL — no admin secret, no test-only bypass. Including the cross-org
query, trigger, approval, and subscription attacks you just watched.
