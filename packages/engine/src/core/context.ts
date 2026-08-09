/**
 * Run context and template interpolation.
 *
 * A step's config may reference values produced earlier in the run:
 *
 *   "{{previous.output.json.label}}"   the step immediately before
 *   "{{steps.2.output.text}}"          by position
 *   "{{trigger.body.subject}}"         the payload the run was started with
 *
 * Interpolation is deliberately a pure value lookup: no expressions, no
 * function calls, no property access on prototypes. A workflow config is
 * untrusted input authored by an editor, so it must not be able to reach
 * anything the engine did not explicitly put in the context object.
 */

import type { Json, JsonObject } from '../types';

export interface RunContext {
  /** Payload the run started with (manual input or webhook body). */
  trigger: Json;
  /** Output + status of the most recently completed step, if any. */
  previous: { output: Json; status: string } | null;
  /** Every completed step so far, keyed by position as a string. */
  steps: Record<string, { output: Json; status: string; name: string; type: string }>;
  /** Run/workflow identifiers, useful in notify and db_write templates. */
  run: { id: string; workflow_id: string; org_id: string };
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Resolve a dot path against the context. Returns undefined if absent. */
export function resolvePath(ctx: unknown, path: string): Json | undefined {
  const parts = path.split('.').filter((p) => p.length > 0);
  let cur: unknown = ctx;

  for (const part of parts) {
    if (DANGEROUS_KEYS.has(part)) return undefined;
    if (cur === null || cur === undefined) return undefined;

    if (Array.isArray(cur)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;

    // Own properties only — never walk up the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur as Json | undefined;
}

const FULL_TEMPLATE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const INLINE_TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Interpolate a single string.
 *
 * If the string is exactly one placeholder, the resolved value is returned with
 * its type intact — so `"body": "{{previous.output}}"` yields an object, not
 * "[object Object]". Mixed strings are stringified and concatenated.
 */
function interpolateString(input: string, ctx: RunContext): Json {
  const whole = FULL_TEMPLATE.exec(input);
  if (whole) {
    const v = resolvePath(ctx, whole[1]);
    return v === undefined ? null : v;
  }

  return input.replace(INLINE_TEMPLATE, (_match, path: string) => {
    const v = resolvePath(ctx, path.trim());
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Deeply interpolate every string in a JSON value. */
export function resolveTemplates(value: Json, ctx: RunContext): Json {
  if (typeof value === 'string') return interpolateString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = resolveTemplates(v as Json, ctx);
    }
    return out;
  }
  return value;
}

export function emptyContext(run: RunContext['run'], trigger: Json = {}): RunContext {
  return { trigger, previous: null, steps: {}, run };
}
