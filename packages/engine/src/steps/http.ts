/**
 * http_request — generic outbound HTTP with an SSRF guard.
 *
 * THREAT MODEL
 * ------------
 * A workflow step config is authored by an organization editor and executed by
 * our server. Without a guard that is a server-side request forgery primitive:
 * an editor could point a step at http://169.254.169.254/ (cloud metadata), at
 * a Hasura instance on localhost, or at anything else reachable from inside the
 * deployment network but not from the public internet.
 *
 * Mitigations implemented here:
 *   1. Scheme allowlist — http/https only (no file:, gopher:, data:).
 *   2. DNS resolution of the hostname, then rejection of loopback, private
 *      (RFC1918), link-local, CGNAT, unique-local v6, and unspecified targets.
 *      Resolving first is what defeats a hostname that points at 127.0.0.1.
 *   3. Redirects are NOT followed automatically; each hop is re-validated, so a
 *      public URL cannot 302 into the private range.
 *   4. Response size cap and a hard timeout.
 *
 * Residual risk, stated honestly: DNS rebinding between our check and the
 * kernel's connect() is still theoretically possible because Node's fetch does
 * not let us pin the resolved address to the socket. Closing that fully needs a
 * custom agent with a lookup hook or an egress proxy; for this project the
 * remaining window is documented rather than fixed.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { config } from '../lib/env';
import { StepError, type Json, type HttpRequestConfig, type StepExecutionResult } from '../types';

const MAX_REDIRECTS = 3;

/** Reject addresses that are not safely public. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);

  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                        // 0.0.0.0/8 unspecified
    if (a === 10) return true;                       // RFC1918
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true;         // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                       // multicast + reserved
    return false;
  }

  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;         // unspecified / loopback
    if (lower.startsWith('fe80')) return true;                  // link-local
    if (/^f[cd]/.test(lower)) return true;                      // unique-local fc00::/7
    // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }

  return true; // not a recognizable IP
}

async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new StepError(`http_request has a malformed url: ${rawUrl}`, { permanent: true });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StepError(`http_request only permits http/https, got ${url.protocol}`, {
      permanent: true,
    });
  }

  if (config.httpAllowPrivateNetwork()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string }>;

  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new StepError(`http_request could not resolve host ${host}`, { permanent: false });
    }
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new StepError(
        `http_request blocked: ${host} resolves to non-public address ${address}. ` +
          'Set HTTP_STEP_ALLOW_PRIVATE_NETWORK=true only in a trusted local environment.',
        { permanent: true, details: { host, address } },
      );
    }
  }

  return url;
}

export async function executeHttpRequest(cfg: HttpRequestConfig): Promise<StepExecutionResult> {
  if (typeof cfg.url !== 'string' || cfg.url.trim() === '') {
    throw new StepError('http_request requires a "url"', { permanent: true });
  }

  const method = (cfg.method ?? 'GET').toUpperCase();
  const timeoutMs = cfg.timeout_ms ?? config.httpTimeoutMs();
  const acceptExtra = new Set(cfg.accept_status ?? []);

  let currentUrl = await assertUrlAllowed(cfg.url);
  let res: Response | null = null;
  const startedAt = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      res = await fetch(currentUrl, {
        method,
        headers: {
          accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
          'user-agent': 'ai-workflow-builder/1.0 (+http_request step)',
          ...(cfg.headers ?? {}),
          ...(cfg.body !== undefined && method !== 'GET' && method !== 'HEAD'
            ? { 'content-type': 'application/json' }
            : {}),
        },
        body:
          cfg.body !== undefined && method !== 'GET' && method !== 'HEAD'
            ? typeof cfg.body === 'string'
              ? cfg.body
              : JSON.stringify(cfg.body)
            : undefined,
        redirect: 'manual', // every hop is re-validated below
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new StepError(
        aborted
          ? `http_request timed out after ${timeoutMs}ms (${method} ${currentUrl.href})`
          : `http_request network failure: ${String(err)}`,
        { permanent: false },
      );
    } finally {
      clearTimeout(timer);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw new StepError(`http_request exceeded ${MAX_REDIRECTS} redirects`, { permanent: true });
      }
      // Re-run the full guard on the redirect target.
      currentUrl = await assertUrlAllowed(new URL(location, currentUrl).href);
      continue;
    }
    break;
  }

  if (!res) throw new StepError('http_request produced no response', { permanent: false });

  const durationMs = Date.now() - startedAt;
  const ok = (res.status >= 200 && res.status < 300) || acceptExtra.has(res.status);

  const raw = await readCapped(res, config.httpMaxResponseBytes());
  const contentType = res.headers.get('content-type') ?? '';
  let parsed: Json | null = null;
  if (contentType.includes('json')) {
    try {
      parsed = JSON.parse(raw) as Json;
    } catch {
      // A malformed body from a 2xx is a real failure worth surfacing, but the
      // text is preserved below so the run record shows what actually arrived.
      if (ok) {
        throw new StepError(
          `http_request got HTTP ${res.status} with content-type json but an unparseable body: ${raw.slice(0, 200)}`,
          { permanent: false, details: { status: res.status } },
        );
      }
    }
  }

  if (!ok) {
    // 4xx (other than 408/429) will not change on a retry; 5xx and throttling will.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    throw new StepError(
      `http_request got HTTP ${res.status} from ${currentUrl.href}: ${raw.slice(0, 300)}`,
      { permanent, details: { status: res.status, body: raw.slice(0, 500) } },
    );
  }

  return {
    output: {
      status: res.status,
      ok: true,
      url: currentUrl.href,
      duration_ms: durationMs,
      headers: {
        'content-type': contentType,
      },
      json: parsed,
      text: parsed === null ? raw.slice(0, 4000) : null,
    },
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new StepError(`http_request response exceeded ${maxBytes} bytes`, { permanent: true });
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
