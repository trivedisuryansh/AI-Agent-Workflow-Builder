# Deployment

The backend is an Nhost project. The frontend and the Action / Event Trigger
handlers deploy together as one Next.js app, because Hasura needs a single
public base URL to call back into.

Current state of the Nhost project `vguruqkdjttgihjhmuxd` (region `ap-south-1`):

- [x] Migrations applied — all 11 tables, functions, triggers and the usage view
- [ ] Metadata applied — blocked on the two environment variables below
- [ ] Seeded
- [ ] Handlers deployed

---

## Step 1 — Nhost dashboard settings

**Auth → Sign-in methods → turn OFF "Require email verification."**
It defaults ON. There is no SMTP configured, so seeded users would be created
but unable to sign in, and `npm run seed` fails on the first account.

**Settings → Environment Variables → add both:**

| Name | Value |
|---|---|
| `ACTION_BASE_URL` | the deployed app's origin, no trailing slash, e.g. `https://your-app.vercel.app` |
| `ACTION_WEBHOOK_SECRET` | `5aa9b040ca132535263341103ac0dbf5acf4fd3c4b3aab6d08db4fb71e3ef383` |

These are read by **Hasura**, not by the app. The committed metadata refers to
`{{ACTION_BASE_URL}}`, which is why the same metadata works locally and in the
cloud without edits — and why `replace_metadata` fails with
*"Value for environment variables not found: ACTION_BASE_URL"* until it is set.

---

## Step 2 — deploy the Next.js app

It is a monorepo, so the build needs the workspace root:

- **Root Directory:** `apps/web`
- **Framework preset:** Next.js
- Leave install/build commands at their defaults — the root `package.json`
  declares npm workspaces, and `@wfb/engine` is compiled by Next via
  `transpilePackages`.

### Environment variables on the hosting platform

Server-side (secret — never exposed to the browser):

```
HASURA_GRAPHQL_ENDPOINT=https://vguruqkdjttgihjhmuxd.hasura.ap-south-1.nhost.run/v1/graphql
HASURA_GRAPHQL_ADMIN_SECRET=<your Nhost admin secret>
ACTION_WEBHOOK_SECRET=5aa9b040ca132535263341103ac0dbf5acf4fd3c4b3aab6d08db4fb71e3ef383
APP_BASE_URL=https://your-app.vercel.app

LLM_PROVIDER=gemini
LLM_API_KEY=<your Gemini key>
LLM_MODEL=gemini-flash-latest
LLM_TIMEOUT_MS=60000

HTTP_STEP_ALLOW_PRIVATE_NETWORK=false
NOTIFY_MODE=log
STEP_MAX_ATTEMPTS=2
STEP_RETRY_BASE_DELAY_MS=500
```

Public (inlined into the browser bundle at build time):

```
NEXT_PUBLIC_NHOST_SUBDOMAIN=vguruqkdjttgihjhmuxd
NEXT_PUBLIC_NHOST_REGION=ap-south-1
NEXT_PUBLIC_SHOW_DEMO_LOGINS=true
```

> **Do NOT set `NEXT_PUBLIC_NHOST_AUTH_URL` or `NEXT_PUBLIC_NHOST_GRAPHQL_URL`
> in production.** Those exist only to point the app at the local
> docker-compose stack. If they leak into a deployment the browser will try to
> reach `localhost` and every request will fail.

`ACTION_WEBHOOK_SECRET` must be **byte-identical** to the value in Nhost. It is
what proves an inbound `/api/actions/*` request really came from Hasura; without
it, anyone could POST a forged `session_variables` block and impersonate any
user. A mismatch shows up as every Action failing with `403 Forbidden`.

---

## Step 3 — apply metadata and seed

Once `ACTION_BASE_URL` is set in Nhost and the app is live, from the repo root:

```bash
# 1. bring the local stack up — it is the source the merge reads from
docker compose up -d
npm run hasura:apply

# 2. merge into Nhost Cloud, preserving its auth/storage tables
node scripts/hasura-merge-metadata.mjs \
  --target=https://vguruqkdjttgihjhmuxd.hasura.ap-south-1.nhost.run \
  --target-secret=<admin secret>

# 3. seed Cloud
NEXT_PUBLIC_NHOST_SUBDOMAIN=vguruqkdjttgihjhmuxd \
NEXT_PUBLIC_NHOST_REGION=ap-south-1 \
HASURA_GRAPHQL_ENDPOINT=https://vguruqkdjttgihjhmuxd.hasura.ap-south-1.nhost.run/v1/graphql \
HASURA_GRAPHQL_ADMIN_SECRET=<admin secret> \
APP_BASE_URL=https://your-app.vercel.app \
npm run seed
```

`hasura-merge-metadata.mjs` exists because `hasura metadata apply` performs a
*replace*, and the Nhost project already tracks 16 tables across `auth` and
`storage`. Replacing wholesale would untrack them and break sign-in and storage.
The script preserves everything outside the `public` schema, along with the
target's database connection block, and writes a full backup to
`.tools/nhost-metadata-backup.json` before touching anything.

---

## Step 4 — verify against Cloud

```bash
NEXT_PUBLIC_NHOST_SUBDOMAIN=vguruqkdjttgihjhmuxd \
NEXT_PUBLIC_NHOST_REGION=ap-south-1 \
HASURA_GRAPHQL_ENDPOINT=https://vguruqkdjttgihjhmuxd.hasura.ap-south-1.nhost.run/v1/graphql \
HASURA_GRAPHQL_ADMIN_SECRET=<admin secret> \
APP_BASE_URL=https://your-app.vercel.app \
npm run test:integration
```

All 60 integration tests should pass against Cloud exactly as they do locally.

Then walk the scenario in the browser: sign in as the Org A owner, run the
workflow, watch it pause, approve it, watch it finish — then sign in as
`owner.b@example.test` and confirm Org A is invisible.

---

## Gotchas worth knowing

**Nhost's edge rate-limits.** Roughly thirty rapid requests to
`*.hasura.<region>.nhost.run` got this machine temporarily blocked: the TLS
handshake still completed, but every HTTP request had its connection closed with
zero bytes read. It cleared itself after ~60 seconds. If you see
`UND_ERR_SOCKET: other side closed` while TLS succeeds, wait a minute rather
than retrying in a loop.

**`maxDuration` is capped at 60s on Vercel Hobby**, and exceeding it fails the
deploy rather than being clamped. The workflow-run event route is set to 60.

**Free-tier Gemini quotas are per model.** `gemini-2.0-flash` returned 429 on
this project while `gemini-flash-latest` worked — hence the model choice.

**Gemini thinking models bill reasoning tokens against `max_tokens`.** They
routinely spend 100–200 tokens before emitting a character, so a low limit
silently truncates the answer. The engine now raises a clear error on
`finishReason: MAX_TOKENS` instead of returning a half-written completion, and
the Gemini default is 2048.

**Rotate the credentials** that were pasted into a chat transcript during
development — the Nhost admin secret (regenerable in the dashboard) and the
Gemini API key.
