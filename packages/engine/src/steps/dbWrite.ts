/**
 * db_write — controlled write into workflow_outputs.
 *
 * There is deliberately no SQL, table name, or column list in the step config.
 * The only thing a workflow author controls is a key and a JSON value; the
 * destination table is fixed and the owning organization is derived by a
 * database trigger from the run (see workflow_outputs_derive_org). So even an
 * owner who hand-crafts a config cannot write into another organization, and
 * an editor cannot create this step type at all.
 */

import { adminRequest } from '../lib/hasura.js';
import { StepError, type DbWriteConfig, type StepExecutionResult } from '../types.js';

const UPSERT_OUTPUT = /* GraphQL */ `
  mutation InsertWorkflowOutput($run_id: uuid!, $key: String!, $value: jsonb!) {
    insert_workflow_outputs_one(
      object: { workflow_run_id: $run_id, key: $key, value: $value }
      on_conflict: {
        constraint: workflow_outputs_unique_key
        update_columns: [value]
      }
    ) {
      id
      org_id
      key
      created_at
    }
  }
`;

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/;

export async function executeDbWrite(
  cfg: DbWriteConfig,
  runId: string,
): Promise<StepExecutionResult> {
  if (typeof cfg.key !== 'string' || !KEY_PATTERN.test(cfg.key)) {
    throw new StepError(
      `db_write "key" must match ${KEY_PATTERN} (got ${JSON.stringify(cfg.key)})`,
      { permanent: true },
    );
  }
  if (cfg.value === undefined) {
    throw new StepError('db_write requires a "value"', { permanent: true });
  }

  const data = await adminRequest<{
    insert_workflow_outputs_one: { id: string; org_id: string; key: string; created_at: string } | null;
  }>(UPSERT_OUTPUT, {
    run_id: runId,
    key: cfg.key,
    value: cfg.value,
  });

  const row = data.insert_workflow_outputs_one;
  if (!row) throw new StepError('db_write produced no row', { permanent: false });

  return {
    output: {
      written: true,
      output_id: row.id,
      // Echoed back from the database so the run record shows the org the
      // trigger actually assigned, not the one the config hoped for.
      org_id: row.org_id,
      key: row.key,
      created_at: row.created_at,
    },
  };
}
