-- =============================================================================
-- AI Agent Workflow Builder — initial schema
--
-- Design notes that matter for security (see docs/architecture.md):
--   * Every authorization decision resolves through org_members. No table
--     carries a "role" column that could be trusted on its own.
--   * org_id on workflow_runs / workflow_outputs / notifications is DERIVED by
--     a BEFORE INSERT trigger from the parent row, never accepted from the
--     client. This makes cross-org writes structurally impossible rather than
--     merely forbidden by a permission rule.
--   * Restricted step types (db_write, notify) and webhook triggers are
--     enforced twice: once in Hasura permissions, once in a database trigger.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------

CREATE TABLE public.organizations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL
                       CONSTRAINT organizations_name_length
                       CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug               text NOT NULL UNIQUE
                       CONSTRAINT organizations_slug_format
                       CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,59}$'),
  quota_used         integer NOT NULL DEFAULT 0
                       CONSTRAINT organizations_quota_used_non_negative
                       CHECK (quota_used >= 0),
  quota_limit        integer NOT NULL DEFAULT 20
                       CONSTRAINT organizations_quota_limit_non_negative
                       CHECK (quota_limit >= 0),
  quota_period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.organizations IS
  'Tenant boundary. quota_used is incremented atomically by reserve_org_quota().';

-- -----------------------------------------------------------------------------
-- org_members  — the single source of truth for authorization
-- -----------------------------------------------------------------------------

CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL
               CONSTRAINT org_members_role_valid
               CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_members_unique_membership UNIQUE (org_id, user_id)
);

-- Primary authorization lookup: "is this user a member of this org, and as what?"
CREATE INDEX idx_org_members_org_user ON public.org_members (org_id, user_id);
-- Reverse lookup: "which orgs does this user belong to?" (org switcher)
CREATE INDEX idx_org_members_user      ON public.org_members (user_id);

COMMENT ON TABLE public.org_members IS
  'A role is only ever meaningful inside the organization the membership row points at.';

-- -----------------------------------------------------------------------------
-- workflows
-- -----------------------------------------------------------------------------

CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL
                CONSTRAINT workflows_name_length
                CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  status      text NOT NULL DEFAULT 'draft'
                CONSTRAINT workflows_status_valid
                CHECK (status IN ('draft', 'active', 'archived')),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflows_org         ON public.workflows (org_id);
CREATE INDEX idx_workflows_org_created ON public.workflows (org_id, created_at DESC);

CREATE TRIGGER workflows_set_updated_at
  BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- workflow_steps
-- -----------------------------------------------------------------------------

CREATE TABLE public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position    integer NOT NULL
                CONSTRAINT workflow_steps_position_non_negative
                CHECK (position >= 0),
  type        text NOT NULL
                CONSTRAINT workflow_steps_type_valid
                CHECK (type IN ('llm_call', 'http_request', 'db_write',
                                'notify', 'conditional_branch', 'approval_gate')),
  name        text NOT NULL
                CONSTRAINT workflow_steps_name_length
                CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  config      jsonb NOT NULL DEFAULT '{}'::jsonb
                CONSTRAINT workflow_steps_config_is_object
                CHECK (jsonb_typeof(config) = 'object'),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Deterministic ordering. DEFERRABLE so a reorder can shuffle several rows
  -- inside one transaction without tripping over an intermediate collision.
  CONSTRAINT workflow_steps_unique_position UNIQUE (workflow_id, position)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_workflow_steps_wf_pos ON public.workflow_steps (workflow_id, position);

CREATE TRIGGER workflow_steps_set_updated_at
  BEFORE UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- workflow_triggers
-- -----------------------------------------------------------------------------

CREATE TABLE public.workflow_triggers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type           text NOT NULL
                   CONSTRAINT workflow_triggers_type_valid
                   CHECK (type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  config         jsonb NOT NULL DEFAULT '{}'::jsonb
                   CONSTRAINT workflow_triggers_config_is_object
                   CHECK (jsonb_typeof(config) = 'object'),
  enabled        boolean NOT NULL DEFAULT true,

  -- Generated server-side by generate_webhook_secret(). Deliberately excluded
  -- from every Hasura select permission; readable only via the getWebhookUrl
  -- Action, which is owner-gated.
  webhook_secret text,

  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_triggers_unique_type UNIQUE (workflow_id, type),
  CONSTRAINT workflow_triggers_webhook_has_secret
    CHECK (type <> 'webhook' OR webhook_secret IS NOT NULL)
);

CREATE INDEX idx_workflow_triggers_workflow ON public.workflow_triggers (workflow_id);

CREATE TRIGGER workflow_triggers_set_updated_at
  BEFORE UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- workflow_runs
-- -----------------------------------------------------------------------------

CREATE TABLE public.workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,

  -- Denormalized from workflows.org_id by a BEFORE INSERT trigger so that run
  -- and step-run permissions need only one join, and so a forged org_id in a
  -- client payload is overwritten rather than honoured.
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  status          text NOT NULL DEFAULT 'pending'
                    CONSTRAINT workflow_runs_status_valid
                    CHECK (status IN ('pending', 'running', 'paused',
                                      'completed', 'failed', 'cancelled')),
  trigger_type    text NOT NULL
                    CONSTRAINT workflow_runs_trigger_type_valid
                    CHECK (trigger_type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  triggered_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Position of the next step to execute when a paused run resumes.
  resume_position integer,

  started_at      timestamptz,
  completed_at    timestamptz,
  paused_at       timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT workflow_runs_terminal_has_completed_at
    CHECK (status NOT IN ('completed', 'failed', 'cancelled') OR completed_at IS NOT NULL)
);

CREATE INDEX idx_workflow_runs_workflow_created ON public.workflow_runs (workflow_id, created_at DESC);
CREATE INDEX idx_workflow_runs_org_created      ON public.workflow_runs (org_id, created_at DESC);
CREATE INDEX idx_workflow_runs_status           ON public.workflow_runs (status)
  WHERE status IN ('pending', 'running', 'paused');

CREATE TRIGGER workflow_runs_set_updated_at
  BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- org_id is derived, never accepted.
CREATE OR REPLACE FUNCTION public.workflow_runs_derive_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT w.org_id INTO v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'workflow % does not exist', NEW.workflow_id USING ERRCODE = '23503';
  END IF;
  NEW.org_id := v_org;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_derive_org
  BEFORE INSERT OR UPDATE OF workflow_id, org_id ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.workflow_runs_derive_org();

-- -----------------------------------------------------------------------------
-- step_runs
-- -----------------------------------------------------------------------------

CREATE TABLE public.step_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id  uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid NOT NULL REFERENCES public.workflow_steps(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending'
                     CONSTRAINT step_runs_status_valid
                     CHECK (status IN ('pending', 'running', 'paused',
                                       'completed', 'failed', 'skipped')),
  input            jsonb,
  output           jsonb,
  error            text,
  attempt_count    integer NOT NULL DEFAULT 0
                     CONSTRAINT step_runs_attempt_count_non_negative
                     CHECK (attempt_count >= 0),
  started_at       timestamptz,
  completed_at     timestamptz,
  approved_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- One step_run per (run, step). Also makes approval idempotency checkable.
  CONSTRAINT step_runs_unique_per_run UNIQUE (workflow_run_id, workflow_step_id),
  CONSTRAINT step_runs_approval_fields_paired
    CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE INDEX idx_step_runs_run         ON public.step_runs (workflow_run_id);
CREATE INDEX idx_step_runs_run_created ON public.step_runs (workflow_run_id, created_at);

CREATE TRIGGER step_runs_set_updated_at
  BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- workflow_outputs — the ONLY table a db_write step may target
-- -----------------------------------------------------------------------------

CREATE TABLE public.workflow_outputs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  key             text NOT NULL
                    CONSTRAINT workflow_outputs_key_format
                    CHECK (key ~ '^[A-Za-z0-9_.-]{1,120}$'),
  value           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_outputs_unique_key UNIQUE (workflow_run_id, key)
);

CREATE INDEX idx_workflow_outputs_org ON public.workflow_outputs (org_id, created_at DESC);
CREATE INDEX idx_workflow_outputs_run ON public.workflow_outputs (workflow_run_id);

-- A db_write step cannot write into another organization even if its config
-- is tampered with: org_id is taken from the run, not from the payload.
CREATE OR REPLACE FUNCTION public.workflow_outputs_derive_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
BEGIN
  SELECT r.org_id INTO v_org FROM public.workflow_runs r WHERE r.id = NEW.workflow_run_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'workflow_run % does not exist', NEW.workflow_run_id USING ERRCODE = '23503';
  END IF;
  NEW.org_id := v_org;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_outputs_derive_org
  BEFORE INSERT OR UPDATE OF workflow_run_id, org_id ON public.workflow_outputs
  FOR EACH ROW EXECUTE FUNCTION public.workflow_outputs_derive_org();

-- -----------------------------------------------------------------------------
-- notifications — written by the notify step, drained by a Hasura Event Trigger
-- -----------------------------------------------------------------------------

CREATE TABLE public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE CASCADE,
  channel         text NOT NULL
                    CONSTRAINT notifications_channel_valid
                    CHECK (channel IN ('slack', 'email', 'log')),
  payload         jsonb NOT NULL
                    CONSTRAINT notifications_payload_is_object
                    CHECK (jsonb_typeof(payload) = 'object'),
  status          text NOT NULL DEFAULT 'pending'
                    CONSTRAINT notifications_status_valid
                    CHECK (status IN ('pending', 'sent', 'failed')),
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_org ON public.notifications (org_id, created_at DESC);
CREATE INDEX idx_notifications_run ON public.notifications (workflow_run_id);

CREATE TRIGGER notifications_set_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.notifications_derive_org()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.workflow_run_id IS NOT NULL THEN
    SELECT r.org_id INTO v_org FROM public.workflow_runs r WHERE r.id = NEW.workflow_run_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'workflow_run % does not exist', NEW.workflow_run_id USING ERRCODE = '23503';
    END IF;
    NEW.org_id := v_org;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_derive_org
  BEFORE INSERT OR UPDATE OF workflow_run_id, org_id ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_derive_org();

-- =============================================================================
-- Layer 2 enforcement in the database itself
--
-- Hasura permissions already forbid an editor from creating db_write / notify
-- steps and webhook triggers. These triggers are the second, independent line:
-- they hold even if a permission is later loosened by mistake.
--
-- created_by / updated_by are set by Hasura column PRESETS from
-- X-Hasura-User-Id and are not client-writable. A NULL actor means the write
-- came through the admin secret (migrations, seeds, the workflow engine
-- itself), which is server-side only and trusted by definition.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assert_org_owner(p_org_id uuid, p_user_id uuid, p_what text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN; -- trusted server-side context
  END IF;

  SELECT m.role INTO v_role
    FROM public.org_members m
   WHERE m.org_id = p_org_id AND m.user_id = p_user_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'user % is not a member of organization %', p_user_id, p_org_id
      USING ERRCODE = '42501';
  END IF;

  IF v_role <> 'owner' THEN
    RAISE EXCEPTION '% requires the organization owner role (caller role: %)', p_what, v_role
      USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_restricted_step_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org   uuid;
  v_actor uuid;
BEGIN
  IF NEW.type NOT IN ('db_write', 'notify') THEN
    RETURN NEW;
  END IF;

  v_actor := CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
                  ELSE COALESCE(NEW.updated_by, NEW.created_by) END;

  SELECT w.org_id INTO v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  PERFORM public.assert_org_owner(v_org, v_actor,
    format('creating or modifying a %s step', NEW.type));

  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_steps_enforce_restricted_type
  BEFORE INSERT OR UPDATE OF type, config, workflow_id ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.enforce_restricted_step_type();

CREATE OR REPLACE FUNCTION public.enforce_restricted_trigger_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org   uuid;
  v_actor uuid;
BEGIN
  IF NEW.type <> 'webhook' THEN
    RETURN NEW;
  END IF;

  v_actor := CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by
                  ELSE COALESCE(NEW.updated_by, NEW.created_by) END;

  SELECT w.org_id INTO v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  PERFORM public.assert_org_owner(v_org, v_actor,
    'creating or modifying a webhook trigger');

  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_triggers_enforce_restricted_type
  BEFORE INSERT OR UPDATE OF type, config, enabled, workflow_id ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_restricted_trigger_type();

-- Webhook secrets are minted by the database, never supplied by a client.
CREATE OR REPLACE FUNCTION public.generate_webhook_secret()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'webhook' THEN
    IF NEW.webhook_secret IS NULL OR length(NEW.webhook_secret) < 32 THEN
      NEW.webhook_secret := encode(gen_random_bytes(32), 'hex');
    END IF;
  ELSE
    NEW.webhook_secret := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_triggers_generate_secret
  BEFORE INSERT OR UPDATE OF type ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.generate_webhook_secret();

-- =============================================================================
-- Quota — atomic reservation
--
-- The check-and-increment happens while holding a row lock on the organization
-- (SELECT ... FOR UPDATE). Two concurrent triggerWorkflowRun calls against the
-- same organization serialize on that row, so the caller that arrives at the
-- limit observes the already-incremented value and is rejected. There is no
-- read-then-write window for them to race through.
--
-- The functions return SETOF quota_reservations rather than an ad-hoc record
-- type for two reasons: Hasura can only track set-returning functions whose
-- return type is a tracked table, and every allow/deny decision then leaves an
-- auditable row behind.
-- =============================================================================

CREATE TABLE public.quota_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  allowed     boolean NOT NULL,
  reason      text,
  quota_used  integer NOT NULL,
  quota_limit integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quota_reservations_org ON public.quota_reservations (org_id, created_at DESC);

COMMENT ON TABLE public.quota_reservations IS
  'Audit log of every quota allow/deny decision, written by reserve_org_quota().';

CREATE OR REPLACE FUNCTION public.reserve_org_quota(p_org_id uuid)
RETURNS SETOF public.quota_reservations
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  o public.organizations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.organizations WHERE id = p_org_id FOR UPDATE;

  IF NOT FOUND THEN
    -- No organization row to reference, so nothing can be logged; report inline.
    RETURN QUERY
      SELECT gen_random_uuid(), p_org_id, false, 'organization_not_found'::text, 0, 0, now();
    RETURN;
  END IF;

  -- Rolling monthly window: reset before evaluating the limit.
  IF o.quota_period_start < date_trunc('month', now()) THEN
    UPDATE public.organizations
       SET quota_used = 0,
           quota_period_start = date_trunc('month', now())
     WHERE public.organizations.id = p_org_id
    RETURNING * INTO o;
  END IF;

  IF o.quota_used >= o.quota_limit THEN
    RETURN QUERY
      INSERT INTO public.quota_reservations (org_id, allowed, reason, quota_used, quota_limit)
      VALUES (p_org_id, false, 'quota_exhausted', o.quota_used, o.quota_limit)
      RETURNING *;
    RETURN;
  END IF;

  UPDATE public.organizations
     SET quota_used = public.organizations.quota_used + 1
   WHERE public.organizations.id = p_org_id
  RETURNING * INTO o;

  RETURN QUERY
    INSERT INTO public.quota_reservations (org_id, allowed, reason, quota_used, quota_limit)
    VALUES (p_org_id, true, NULL, o.quota_used, o.quota_limit)
    RETURNING *;
END;
$$;

-- Refund a reservation when run creation fails after the quota was taken.
CREATE OR REPLACE FUNCTION public.release_org_quota(p_org_id uuid)
RETURNS SETOF public.quota_reservations
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  o public.organizations%ROWTYPE;
BEGIN
  UPDATE public.organizations
     SET quota_used = GREATEST(public.organizations.quota_used - 1, 0)
   WHERE public.organizations.id = p_org_id
  RETURNING * INTO o;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
    INSERT INTO public.quota_reservations (org_id, allowed, reason, quota_used, quota_limit)
    VALUES (p_org_id, false, 'refund', o.quota_used, o.quota_limit)
    RETURNING *;
END;
$$;

-- =============================================================================
-- Aggregation — exposed through Hasura as organization_usage_stats
-- =============================================================================

CREATE VIEW public.organization_usage_stats AS
SELECT
  o.id                                    AS org_id,
  o.name                                  AS org_name,
  o.quota_used,
  o.quota_limit,
  GREATEST(o.quota_limit - o.quota_used, 0) AS quota_remaining,
  o.quota_period_start,
  COUNT(r.id)                                                     AS total_runs,
  COUNT(r.id) FILTER (WHERE r.created_at >= o.quota_period_start)  AS runs_this_period,
  COUNT(r.id) FILTER (WHERE r.status = 'completed')                AS completed_runs,
  COUNT(r.id) FILTER (WHERE r.status = 'failed')                   AS failed_runs,
  COUNT(r.id) FILTER (WHERE r.status = 'paused')                   AS paused_runs,
  ROUND(
    AVG(EXTRACT(EPOCH FROM (r.completed_at - r.started_at)))
      FILTER (WHERE r.completed_at IS NOT NULL AND r.started_at IS NOT NULL)::numeric,
    2
  )                                                                AS avg_run_duration_seconds
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id, o.name, o.quota_used, o.quota_limit, o.quota_period_start;

COMMENT ON VIEW public.organization_usage_stats IS
  'Per-organization run counts and average wall-clock run duration. Exposed via '
  'Hasura with the same org_members-scoped select permission as every other table.';
