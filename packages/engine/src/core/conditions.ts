/**
 * Conditional branch evaluation.
 *
 * The condition reads a path out of the live run context — the actual output of
 * the step that just ran — and compares it. Nothing here is aware of which
 * workflow is executing, so a branch result cannot be pre-baked.
 */

import type { Condition, Json } from '../types.js';
import { resolvePath, type RunContext } from './context.js';

export interface ConditionEvaluation {
  result: boolean;
  /** What the path actually resolved to, persisted for debuggability. */
  resolved: Json | null;
  path: string;
  operator: string;
  expected: Json | null;
}

function asNumber(v: Json | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: Json | undefined): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function evaluateCondition(condition: Condition, ctx: RunContext): ConditionEvaluation {
  const actual = resolvePath(ctx, condition.path);
  const expected = condition.value ?? null;

  const base = {
    resolved: (actual ?? null) as Json | null,
    path: condition.path,
    operator: condition.operator,
    expected,
  };

  let result: boolean;

  switch (condition.operator) {
    case 'exists':
      result = actual !== undefined && actual !== null;
      break;
    case 'not_exists':
      result = actual === undefined || actual === null;
      break;
    case 'is_true':
      result = actual === true || actual === 'true';
      break;
    case 'is_false':
      result = actual === false || actual === 'false';
      break;

    case 'equals':
      result =
        typeof actual === 'object' && actual !== null
          ? JSON.stringify(actual) === JSON.stringify(expected)
          : actual === expected;
      break;
    case 'not_equals':
      result =
        typeof actual === 'object' && actual !== null
          ? JSON.stringify(actual) !== JSON.stringify(expected)
          : actual !== expected;
      break;

    case 'contains':
      result = Array.isArray(actual)
        ? actual.some((v) => JSON.stringify(v) === JSON.stringify(expected))
        : asString(actual).toLowerCase().includes(asString(expected).toLowerCase());
      break;
    case 'not_contains':
      result = Array.isArray(actual)
        ? !actual.some((v) => JSON.stringify(v) === JSON.stringify(expected))
        : !asString(actual).toLowerCase().includes(asString(expected).toLowerCase());
      break;

    case 'matches': {
      // Anchored implicitly by the author; we cap length to avoid pathological
      // patterns from a workflow config causing catastrophic backtracking.
      const pattern = asString(expected).slice(0, 500);
      try {
        result = new RegExp(pattern).test(asString(actual));
      } catch {
        result = false;
      }
      break;
    }

    case 'in':
      result = Array.isArray(expected)
        ? expected.some((v) => JSON.stringify(v) === JSON.stringify(actual ?? null))
        : false;
      break;

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === null || b === null) {
        result = false;
        break;
      }
      result =
        condition.operator === 'gt' ? a > b
        : condition.operator === 'gte' ? a >= b
        : condition.operator === 'lt' ? a < b
        : a <= b;
      break;
    }

    default: {
      // Exhaustiveness: an unknown operator is a config error, not a silent true.
      const never: never = condition.operator;
      throw new Error(`Unsupported condition operator: ${String(never)}`);
    }
  }

  return { result, ...base };
}
