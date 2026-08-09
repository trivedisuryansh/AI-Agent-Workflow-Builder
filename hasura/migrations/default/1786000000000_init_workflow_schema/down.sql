-- Reverse of 1786000000000_init_workflow_schema/up.sql

DROP VIEW IF EXISTS public.organization_usage_stats;

DROP FUNCTION IF EXISTS public.release_org_quota(uuid);
DROP FUNCTION IF EXISTS public.reserve_org_quota(uuid);

DROP TABLE IF EXISTS public.quota_reservations;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.workflow_outputs;
DROP TABLE IF EXISTS public.step_runs;
DROP TABLE IF EXISTS public.workflow_runs;
DROP TABLE IF EXISTS public.workflow_triggers;
DROP TABLE IF EXISTS public.workflow_steps;
DROP TABLE IF EXISTS public.workflows;
DROP TABLE IF EXISTS public.org_members;
DROP TABLE IF EXISTS public.organizations;

DROP FUNCTION IF EXISTS public.notifications_derive_org();
DROP FUNCTION IF EXISTS public.workflow_outputs_derive_org();
DROP FUNCTION IF EXISTS public.workflow_runs_derive_org();
DROP FUNCTION IF EXISTS public.generate_webhook_secret();
DROP FUNCTION IF EXISTS public.enforce_restricted_trigger_type();
DROP FUNCTION IF EXISTS public.enforce_restricted_step_type();
DROP FUNCTION IF EXISTS public.assert_org_owner(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.set_updated_at();
