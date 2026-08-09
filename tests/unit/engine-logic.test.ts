/**
 * Unit tests for the parts of the engine that are pure logic: condition
 * evaluation, template resolution, retry classification, the SSRF address
 * guard, and JSON extraction from an LLM completion.
 *
 * These need no database and no network, so they run anywhere. The behaviours
 * that require a real Hasura (permissions, quota, pause/resume) are covered in
 * tests/integration.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  backoffDelay,
  emptyContext,
  evaluateCondition,
  extractJson,
  isBlockedAddress,
  isRetryable,
  resolvePath,
  resolvePolicy,
  resolveTemplates,
  StepError,
  withRetry,
  type RunContext,
} from '@wfb/engine';

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    ...emptyContext({ id: 'run-1', workflow_id: 'wf-1', org_id: 'org-1' }, { body: { text: 'hello' } }),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------

describe('resolvePath', () => {
  it('walks nested objects and arrays', () => {
    const c = ctx({ previous: { output: { json: { items: [{ label: 'a' }] } }, status: 'completed' } });
    expect(resolvePath(c, 'previous.output.json.items.0.label')).toBe('a');
  });

  it('returns undefined for a missing path rather than throwing', () => {
    expect(resolvePath(ctx(), 'previous.output.nope')).toBeUndefined();
  });

  it('refuses to traverse prototype-polluting keys', () => {
    // A workflow config is untrusted input; it must not be able to reach
    // Object.prototype and read or influence anything global.
    expect(resolvePath(ctx(), '__proto__.constructor')).toBeUndefined();
    expect(resolvePath(ctx(), 'constructor.name')).toBeUndefined();
    expect(resolvePath(ctx(), 'trigger.__proto__')).toBeUndefined();
  });

  it('does not read inherited properties', () => {
    expect(resolvePath(ctx(), 'trigger.toString')).toBeUndefined();
  });
});

describe('resolveTemplates', () => {
  it('preserves type when the whole string is one placeholder', () => {
    const c = ctx({ previous: { output: { a: 1, b: [2, 3] }, status: 'completed' } });
    // Must yield the object itself, not "[object Object]".
    expect(resolveTemplates('{{previous.output}}', c)).toEqual({ a: 1, b: [2, 3] });
  });

  it('stringifies when interpolating into surrounding text', () => {
    const c = ctx({ previous: { output: { label: 'urgent' }, status: 'completed' } });
    expect(resolveTemplates('Ticket is {{previous.output.label}}!', c)).toBe('Ticket is urgent!');
  });

  it('resolves deep inside nested config objects', () => {
    const c = ctx({ previous: { output: { id: 42 }, status: 'completed' } });
    const out = resolveTemplates(
      { url: 'https://api.test/{{previous.output.id}}', headers: { 'x-run': '{{run.id}}' } },
      c,
    );
    expect(out).toEqual({ url: 'https://api.test/42', headers: { 'x-run': 'run-1' } });
  });

  it('renders a missing path as empty rather than the literal placeholder', () => {
    expect(resolveTemplates('value={{previous.output.missing}}', ctx())).toBe('value=');
  });

  it('reads the trigger payload, which is how webhook input reaches a step', () => {
    expect(resolveTemplates('{{trigger.body.text}}', ctx())).toBe('hello');
  });
});

describe('evaluateCondition', () => {
  const withOutput = (output: unknown) =>
    ctx({ previous: { output: output as never, status: 'completed' } });

  it('equals compares real runtime output', () => {
    const c = withOutput({ json: { label: 'needs_approval' } });
    const r = evaluateCondition(
      { path: 'previous.output.json.label', operator: 'equals', value: 'needs_approval' },
      c,
    );
    expect(r.result).toBe(true);
    expect(r.resolved).toBe('needs_approval');
  });

  it('equals is false for the other branch value', () => {
    const c = withOutput({ json: { label: 'auto_resolve' } });
    expect(
      evaluateCondition(
        { path: 'previous.output.json.label', operator: 'equals', value: 'needs_approval' },
        c,
      ).result,
    ).toBe(false);
  });

  it('numeric comparisons coerce numeric strings', () => {
    const c = withOutput({ json: { confidence: '0.82' } });
    expect(
      evaluateCondition({ path: 'previous.output.json.confidence', operator: 'gt', value: 0.7 }, c)
        .result,
    ).toBe(true);
  });

  it('numeric comparison against a non-number is false, not a throw', () => {
    const c = withOutput({ json: { confidence: 'high' } });
    expect(
      evaluateCondition({ path: 'previous.output.json.confidence', operator: 'gte', value: 0.5 }, c)
        .result,
    ).toBe(false);
  });

  it('exists / not_exists distinguish null from present', () => {
    const c = withOutput({ json: { label: null } });
    expect(evaluateCondition({ path: 'previous.output.json.label', operator: 'exists' }, c).result).toBe(false);
    expect(evaluateCondition({ path: 'previous.output.json.label', operator: 'not_exists' }, c).result).toBe(true);
    expect(evaluateCondition({ path: 'previous.output.json', operator: 'exists' }, c).result).toBe(true);
  });

  it('contains works on arrays and on strings', () => {
    expect(
      evaluateCondition(
        { path: 'previous.output.tags', operator: 'contains', value: 'urgent' },
        withOutput({ tags: ['billing', 'urgent'] }),
      ).result,
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: 'previous.output.text', operator: 'contains', value: 'URGENT' },
        withOutput({ text: 'this is urgent' }),
      ).result,
    ).toBe(true);
  });

  it('in checks membership of an allowed set', () => {
    expect(
      evaluateCondition(
        { path: 'previous.output.json.label', operator: 'in', value: ['needs_approval', 'escalate'] },
        withOutput({ json: { label: 'escalate' } }),
      ).result,
    ).toBe(true);
  });

  it('matches survives an invalid regex instead of crashing the run', () => {
    expect(
      evaluateCondition(
        { path: 'previous.output.text', operator: 'matches', value: '([unclosed' },
        withOutput({ text: 'anything' }),
      ).result,
    ).toBe(false);
  });

  it('reports what the path actually resolved to, for debuggability', () => {
    const r = evaluateCondition(
      { path: 'previous.output.json.label', operator: 'equals', value: 'x' },
      withOutput({ json: { label: 'y' } }),
    );
    expect(r).toMatchObject({ result: false, resolved: 'y', expected: 'x', path: 'previous.output.json.label' });
  });
});

// -----------------------------------------------------------------------------

describe('retry classification', () => {
  it('treats a permanent StepError as non-retryable', () => {
    expect(isRetryable(new StepError('bad config', { permanent: true }))).toBe(false);
  });

  it('treats a transient StepError as retryable', () => {
    expect(isRetryable(new StepError('502 upstream', { permanent: false }))).toBe(true);
  });

  it('gives an unknown throw one more chance', () => {
    expect(isRetryable(new TypeError('undefined is not a function'))).toBe(true);
  });

  it('backoff grows with the attempt number and is capped', () => {
    const rng = () => 0.999;
    expect(backoffDelay(1, 500, rng)).toBeLessThanOrEqual(500);
    expect(backoffDelay(3, 500, rng)).toBeLessThanOrEqual(2000);
    expect(backoffDelay(20, 500, rng)).toBeLessThanOrEqual(30_000);
  });

  it('step config can override the default policy', () => {
    expect(resolvePolicy({ max_attempts: 5, base_delay_ms: 10 }, { maxAttempts: 2, baseDelayMs: 500 }))
      .toEqual({ maxAttempts: 5, baseDelayMs: 10 });
    expect(resolvePolicy(undefined, { maxAttempts: 2, baseDelayMs: 500 }))
      .toEqual({ maxAttempts: 2, baseDelayMs: 500 });
    // Never fewer than one attempt.
    expect(resolvePolicy({ max_attempts: 0 }, { maxAttempts: 2, baseDelayMs: 5 }).maxAttempts).toBe(1);
  });
});

describe('withRetry', () => {
  it('retries a transient failure and succeeds on the second attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new StepError('flaky', { permanent: false }))
      .mockResolvedValueOnce('ok');

    const attempts: number[] = [];
    const result = await withRetry(
      fn,
      { maxAttempts: 2, baseDelayMs: 0 },
      (info) => void attempts.push(info.attempt),
      () => 0,
    );

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // Reported after EVERY attempt, so attempt_count is persisted mid-retry.
    expect(attempts).toEqual([1, 2]);
  });

  it('does not retry a permanent failure', async () => {
    const fn = vi.fn().mockRejectedValue(new StepError('401 unauthorized', { permanent: true }));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }, undefined, () => 0),
    ).rejects.toThrow('401 unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new StepError('always down', { permanent: false }));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }, undefined, () => 0),
    ).rejects.toThrow('always down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('signals willRetry so the step_run can show the pending retry', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new StepError('boom', { permanent: false }))
      .mockResolvedValueOnce('ok');
    const seen: Array<{ attempt: number; willRetry: boolean }> = [];

    await withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 }, (i) => {
      seen.push({ attempt: i.attempt, willRetry: i.willRetry });
    }, () => 0);

    expect(seen).toEqual([
      { attempt: 1, willRetry: true },
      { attempt: 2, willRetry: false },
    ]);
  });
});

// -----------------------------------------------------------------------------

describe('SSRF address guard', () => {
  it('blocks loopback, private, link-local and CGNAT ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.53.1.9',
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.169.254', // cloud instance metadata
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255']) {
      expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  it('blocks IPv6 loopback, link-local and unique-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 that hides a private address', () => {
    // ::ffff:127.0.0.1 is a classic bypass; the embedded v4 must be re-checked.
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks anything that is not a parseable IP', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });
});

// -----------------------------------------------------------------------------

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"label":"needs_approval"}')).toEqual({ label: 'needs_approval' });
  });

  it('parses JSON wrapped in a markdown fence', () => {
    expect(extractJson('```json\n{"label":"auto_resolve"}\n```')).toEqual({ label: 'auto_resolve' });
  });

  it('parses JSON embedded in prose, which models do constantly', () => {
    expect(extractJson('Sure! Here you go:\n{"label":"escalate","confidence":0.9}\nHope that helps.'))
      .toEqual({ label: 'escalate', confidence: 0.9 });
  });

  it('returns null when there is genuinely no JSON', () => {
    expect(extractJson('I cannot help with that.')).toBeNull();
  });
});
