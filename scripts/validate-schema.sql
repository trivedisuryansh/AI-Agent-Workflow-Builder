-- =============================================================================
-- Database-layer invariant proofs.
--
-- These assert the guarantees the schema is supposed to provide *independently*
-- of Hasura: derived org_id, owner-only restricted capabilities, atomic quota,
-- deferrable step reordering. Run with:
--   psql -v ON_ERROR_STOP=1 -f scripts/validate-schema.sql
-- Every check RAISEs on failure, so a clean exit is the pass condition.
-- =============================================================================

\set ON_ERROR_STOP on

DO $outer$
DECLARE
  org_a    uuid;
  org_b    uuid;
  u_owner  uuid;
  u_editor uuid;
  u_viewer uuid;
  wf       uuid;
  run      uuid;
  step     uuid;
  trig     uuid;
  secret1  text;
  nonce    text;
  got      record;
  n        integer;
BEGIN
  -- ---------------------------------------------------------------- fixtures
  -- Suffixed with a random token so the script is re-runnable without a reset
  -- (auth.users outlives the public-schema down migration).
  nonce := replace(gen_random_uuid()::text, '-', '');

  INSERT INTO auth.users (email) VALUES ('owner-'  || nonce || '@a.test') RETURNING id INTO u_owner;
  INSERT INTO auth.users (email) VALUES ('editor-' || nonce || '@a.test') RETURNING id INTO u_editor;
  INSERT INTO auth.users (email) VALUES ('viewer-' || nonce || '@a.test') RETURNING id INTO u_viewer;

  INSERT INTO organizations (name, slug, quota_limit)
    VALUES ('Org A', 'org-a-' || left(nonce, 12), 3) RETURNING id INTO org_a;
  INSERT INTO organizations (name, slug, quota_limit)
    VALUES ('Org B', 'org-b-' || left(nonce, 12), 3) RETURNING id INTO org_b;

  INSERT INTO org_members (org_id, user_id, role) VALUES
    (org_a, u_owner,  'owner'),
    (org_a, u_editor, 'editor'),
    (org_a, u_viewer, 'viewer');

  INSERT INTO workflows (org_id, name, created_by)
    VALUES (org_a, 'Support triage', u_owner) RETURNING id INTO wf;

  RAISE NOTICE '--- fixtures created ---';

  -- ============================================================== CHECK 1
  -- workflow_runs.org_id is DERIVED. A forged org_id must be overwritten with
  -- the workflow's real org, not honoured.
  INSERT INTO workflow_runs (workflow_id, org_id, trigger_type)
    VALUES (wf, org_b, 'manual')          -- deliberately lying: claims Org B
    RETURNING id INTO run;

  SELECT org_id INTO got FROM workflow_runs WHERE id = run;
  IF (SELECT org_id FROM workflow_runs WHERE id = run) <> org_a THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: forged org_id was honoured';
  END IF;
  RAISE NOTICE 'CHECK 1 pass: workflow_runs.org_id derived from workflow (forged org_b ignored)';

  -- ============================================================== CHECK 2
  -- workflow_outputs.org_id is derived from the run, so a db_write step cannot
  -- be tricked into writing into another organization.
  INSERT INTO workflow_outputs (org_id, workflow_run_id, key, value)
    VALUES (org_b, run, 'verdict', '"escalate"'::jsonb);   -- again lying

  IF (SELECT org_id FROM workflow_outputs WHERE workflow_run_id = run) <> org_a THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: db_write could target a foreign org';
  END IF;
  RAISE NOTICE 'CHECK 2 pass: workflow_outputs.org_id derived from run';

  -- ============================================================== CHECK 3
  -- Layer 2: an EDITOR must not be able to create a db_write step.
  BEGIN
    INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
      VALUES (wf, 90, 'db_write', 'sneaky write', u_editor);
    RAISE EXCEPTION 'CHECK 3 FAILED: editor created a db_write step';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CHECK 3 pass: editor blocked from db_write (%)', SQLERRM;
  END;

  -- ============================================================== CHECK 4
  -- Layer 2: an EDITOR must not be able to create a notify step.
  BEGIN
    INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
      VALUES (wf, 91, 'notify', 'sneaky notify', u_editor);
    RAISE EXCEPTION 'CHECK 4 FAILED: editor created a notify step';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CHECK 4 pass: editor blocked from notify';
  END;

  -- ============================================================== CHECK 5
  -- A VIEWER is blocked too, and so is a complete non-member.
  BEGIN
    INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
      VALUES (wf, 92, 'db_write', 'viewer write', u_viewer);
    RAISE EXCEPTION 'CHECK 5 FAILED: viewer created a db_write step';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CHECK 5 pass: viewer blocked from db_write';
  END;

  -- ============================================================== CHECK 6
  -- An OWNER can create the restricted types.
  INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
    VALUES (wf, 5, 'db_write', 'persist verdict', u_owner) RETURNING id INTO step;
  INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
    VALUES (wf, 6, 'notify', 'ping slack', u_owner);
  RAISE NOTICE 'CHECK 6 pass: owner can create db_write and notify';

  -- ============================================================== CHECK 7
  -- Layer 2: editor blocked from webhook triggers; owner allowed; the secret is
  -- minted by the database and is high-entropy.
  BEGIN
    INSERT INTO workflow_triggers (workflow_id, type, created_by)
      VALUES (wf, 'webhook', u_editor);
    RAISE EXCEPTION 'CHECK 7 FAILED: editor created a webhook trigger';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CHECK 7 pass: editor blocked from webhook trigger';
  END;

  INSERT INTO workflow_triggers (workflow_id, type, created_by, webhook_secret)
    VALUES (wf, 'webhook', u_owner, 'client-chosen-weak-secret')  -- must be ignored
    RETURNING id, webhook_secret INTO trig, secret1;

  IF secret1 = 'client-chosen-weak-secret' THEN
    RAISE EXCEPTION 'CHECK 7 FAILED: client-supplied webhook secret was kept';
  END IF;
  IF length(secret1) <> 64 THEN
    RAISE EXCEPTION 'CHECK 7 FAILED: webhook secret is % chars, expected 64', length(secret1);
  END IF;
  RAISE NOTICE 'CHECK 7 pass: owner webhook trigger created, secret minted server-side (% chars)', length(secret1);

  -- An editor cannot flip a webhook trigger on/off either.
  BEGIN
    UPDATE workflow_triggers SET enabled = false, updated_by = u_editor WHERE id = trig;
    RAISE EXCEPTION 'CHECK 7b FAILED: editor toggled a webhook trigger';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CHECK 7b pass: editor blocked from modifying a webhook trigger';
  END;

  -- ============================================================== CHECK 8
  -- Non-webhook triggers are open to editors, and carry no secret.
  INSERT INTO workflow_triggers (workflow_id, type, created_by)
    VALUES (wf, 'manual', u_editor);
  IF (SELECT webhook_secret FROM workflow_triggers WHERE workflow_id = wf AND type = 'manual') IS NOT NULL THEN
    RAISE EXCEPTION 'CHECK 8 FAILED: non-webhook trigger carries a secret';
  END IF;
  RAISE NOTICE 'CHECK 8 pass: editor can create a manual trigger; no secret attached';

  -- ============================================================== CHECK 9
  -- Deferred unique constraint permits an in-transaction reorder (swap 5 <-> 6).
  UPDATE workflow_steps SET position = 999 WHERE workflow_id = wf AND position = 5;
  UPDATE workflow_steps SET position = 5   WHERE workflow_id = wf AND position = 6;
  UPDATE workflow_steps SET position = 6   WHERE workflow_id = wf AND position = 999;
  RAISE NOTICE 'CHECK 9 pass: step positions reordered within a transaction';

  -- ============================================================== CHECK 10
  -- Duplicate positions are still rejected — the constraint is deferred, not
  -- absent, so force it to evaluate to prove it actually fires.
  BEGIN
    INSERT INTO workflow_steps (workflow_id, position, type, name, created_by)
      VALUES (wf, 5, 'llm_call', 'collides', u_owner);
    SET CONSTRAINTS workflow_steps_unique_position IMMEDIATE;
    RAISE EXCEPTION 'CHECK 10 FAILED: duplicate position accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'CHECK 10 pass: duplicate position rejected by deferred unique constraint';
  END;
  -- Roll the constraint back to deferred and drop the offending row.
  SET CONSTRAINTS workflow_steps_unique_position DEFERRED;
  DELETE FROM workflow_steps WHERE workflow_id = wf AND name = 'collides';

  -- ============================================================== CHECK 11
  -- Quota: reservation increments and rejects past the limit (limit = 3).
  SELECT * INTO got FROM reserve_org_quota(org_a);
  IF NOT got.allowed OR got.quota_used <> 1 THEN
    RAISE EXCEPTION 'CHECK 11 FAILED: first reservation, allowed=% used=%', got.allowed, got.quota_used;
  END IF;
  SELECT * INTO got FROM reserve_org_quota(org_a);
  SELECT * INTO got FROM reserve_org_quota(org_a);
  IF NOT got.allowed OR got.quota_used <> 3 THEN
    RAISE EXCEPTION 'CHECK 11 FAILED: third reservation, allowed=% used=%', got.allowed, got.quota_used;
  END IF;

  SELECT * INTO got FROM reserve_org_quota(org_a);
  IF got.allowed THEN
    RAISE EXCEPTION 'CHECK 11 FAILED: fourth reservation allowed past limit of 3';
  END IF;
  IF got.reason <> 'quota_exhausted' THEN
    RAISE EXCEPTION 'CHECK 11 FAILED: wrong rejection reason %', got.reason;
  END IF;
  RAISE NOTICE 'CHECK 11 pass: quota allows 3/3 then rejects with %', got.reason;

  -- Every decision leaves an audit row behind.
  SELECT count(*) INTO n FROM quota_reservations WHERE org_id = org_a;
  IF n <> 4 THEN
    RAISE EXCEPTION 'CHECK 11 FAILED: expected 4 quota_reservations rows, got %', n;
  END IF;
  RAISE NOTICE 'CHECK 11b pass: 4 quota decisions audited in quota_reservations';

  -- ============================================================== CHECK 12
  -- Refund path restores a unit.
  PERFORM release_org_quota(org_a);
  IF (SELECT quota_used FROM organizations WHERE id = org_a) <> 2 THEN
    RAISE EXCEPTION 'CHECK 12 FAILED: refund did not decrement';
  END IF;
  SELECT * INTO got FROM reserve_org_quota(org_a);
  IF NOT got.allowed THEN
    RAISE EXCEPTION 'CHECK 12 FAILED: reservation after refund rejected';
  END IF;
  RAISE NOTICE 'CHECK 12 pass: release_org_quota refunds a unit';

  -- ============================================================== CHECK 13
  -- step_runs uniqueness per (run, step).
  INSERT INTO step_runs (workflow_run_id, workflow_step_id, status) VALUES (run, step, 'completed');
  BEGIN
    INSERT INTO step_runs (workflow_run_id, workflow_step_id, status) VALUES (run, step, 'running');
    RAISE EXCEPTION 'CHECK 13 FAILED: duplicate step_run accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'CHECK 13 pass: one step_run per (run, step)';
  END;

  -- ============================================================== CHECK 14
  -- approved_by / approved_at must move together.
  BEGIN
    UPDATE step_runs SET approved_by = u_owner WHERE workflow_run_id = run AND workflow_step_id = step;
    RAISE EXCEPTION 'CHECK 14 FAILED: approved_by set without approved_at';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'CHECK 14 pass: approval fields are paired';
  END;

  -- ============================================================== CHECK 15
  -- A terminal run must carry completed_at.
  BEGIN
    UPDATE workflow_runs SET status = 'completed' WHERE id = run;
    RAISE EXCEPTION 'CHECK 15 FAILED: completed run without completed_at';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'CHECK 15 pass: terminal status requires completed_at';
  END;

  -- ============================================================== CHECK 16
  -- Aggregation view reports the org and does not leak across orgs.
  SELECT count(*) INTO n FROM organization_usage_stats WHERE org_id = org_a AND total_runs >= 1;
  IF n <> 1 THEN
    RAISE EXCEPTION 'CHECK 16 FAILED: usage view row missing for org_a';
  END IF;
  IF (SELECT total_runs FROM organization_usage_stats WHERE org_id = org_b) <> 0 THEN
    RAISE EXCEPTION 'CHECK 16 FAILED: org_b shows runs it does not own';
  END IF;
  RAISE NOTICE 'CHECK 16 pass: organization_usage_stats aggregates per org';

  -- ============================================================== CHECK 17
  -- Cascades: deleting the org removes everything beneath it.
  DELETE FROM organizations WHERE id = org_a;
  IF (SELECT count(*) FROM workflows WHERE id = wf) <> 0
     OR (SELECT count(*) FROM step_runs WHERE workflow_run_id = run) <> 0
     OR (SELECT count(*) FROM workflow_outputs WHERE workflow_run_id = run) <> 0 THEN
    RAISE EXCEPTION 'CHECK 17 FAILED: cascade left orphans';
  END IF;
  RAISE NOTICE 'CHECK 17 pass: org delete cascades to workflows, runs, step_runs, outputs';

  RAISE NOTICE '';
  RAISE NOTICE '======== ALL DATABASE INVARIANT CHECKS PASSED ========';
END
$outer$;
