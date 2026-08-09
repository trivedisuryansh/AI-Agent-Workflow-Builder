/**
 * llm_call — real LLM provider invocation.
 *
 * Groq and OpenRouter share the OpenAI chat-completions shape; Gemini has its
 * own. Errors are classified so the retry layer does not waste an attempt on an
 * invalid API key (permanent) but does retry a 429 or a 503 (transient).
 *
 * If LLM_API_KEY is unset the step falls back to a DISCLOSED stub: the output
 * carries `"stubbed": true` and the run's step output says so plainly. The stub
 * still derives its answer from the actual prompt text, so a conditional branch
 * downstream is still branching on step output rather than on a constant.
 */

import { config } from '../lib/env.js';
import { StepError, type Json, type LlmCallConfig, type StepExecutionResult } from '../types.js';

interface LlmResult {
  text: string;
  json: Json | null;
  model: string;
  provider: string;
  stubbed: boolean;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** Map an HTTP status from a provider onto retryable / permanent. */
function classify(status: number, provider: string, body: string): StepError {
  const snippet = body.slice(0, 400);
  const permanent = status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
  return new StepError(
    `${provider} returned HTTP ${status}: ${snippet}`,
    { permanent, details: { status, provider } },
  );
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
  provider: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    // Timeouts and socket errors are worth another attempt.
    throw new StepError(
      aborted ? `${provider} request timed out after ${timeoutMs}ms` : `${provider} request failed: ${String(err)}`,
      { permanent: false },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw classify(res.status, provider, text);

  try {
    return JSON.parse(text);
  } catch {
    throw new StepError(`${provider} returned unparseable JSON: ${text.slice(0, 300)}`, {
      permanent: false,
    });
  }
}

async function callOpenAiCompatible(
  cfg: LlmCallConfig,
  prompt: string,
  baseUrl: string,
  provider: string,
): Promise<LlmResult> {
  const model = cfg.model ?? config.llmModel();
  const messages: Array<{ role: string; content: string }> = [];
  if (cfg.system_prompt) messages.push({ role: 'system', content: cfg.system_prompt });
  messages.push({ role: 'user', content: prompt });

  const data = (await postJson(
    `${baseUrl}/chat/completions`,
    { authorization: `Bearer ${config.llmApiKey()}` },
    {
      model,
      messages,
      temperature: cfg.temperature ?? 0.2,
      max_tokens: cfg.max_tokens ?? 512,
      ...(cfg.parse_json ? { response_format: { type: 'json_object' } } : {}),
    },
    config.llmTimeoutMs(),
    provider,
  )) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: LlmResult['usage'];
  };

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new StepError(`${provider} response contained no message content`, { permanent: false });
  }

  return {
    text,
    json: null,
    model,
    provider,
    stubbed: false,
    usage: data.usage ?? null,
  };
}

async function callGemini(cfg: LlmCallConfig, prompt: string): Promise<LlmResult> {
  const model = cfg.model ?? config.llmModel();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(config.llmApiKey())}`;

  const data = (await postJson(
    url,
    {},
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(cfg.system_prompt
        ? { systemInstruction: { parts: [{ text: cfg.system_prompt }] } }
        : {}),
      generationConfig: {
        temperature: cfg.temperature ?? 0.2,
        maxOutputTokens: cfg.max_tokens ?? 512,
        ...(cfg.parse_json ? { responseMimeType: 'application/json' } : {}),
      },
    },
    config.llmTimeoutMs(),
    'gemini',
  )) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!text) {
    throw new StepError('gemini response contained no candidate text', { permanent: false });
  }

  return {
    text,
    json: null,
    model,
    provider: 'gemini',
    stubbed: false,
    usage: data.usageMetadata
      ? {
          prompt_tokens: data.usageMetadata.promptTokenCount,
          completion_tokens: data.usageMetadata.candidatesTokenCount,
          total_tokens: data.usageMetadata.totalTokenCount,
        }
      : null,
  };
}

/**
 * Offline fallback. Deterministic, derived from the prompt, and loudly labelled.
 * Never silently substituted for a configured provider: it is only reachable
 * when LLM_API_KEY is empty.
 */
function stubCompletion(cfg: LlmCallConfig, prompt: string): LlmResult {
  const lowered = prompt.toLowerCase();
  const urgentSignals = ['urgent', 'outage', 'down', 'critical', 'refund', 'angry', 'escalate', 'asap'];
  const hits = urgentSignals.filter((s) => lowered.includes(s));
  const label = hits.length > 0 ? 'needs_approval' : 'auto_resolve';

  const payload = {
    label,
    confidence: hits.length > 0 ? Math.min(0.6 + hits.length * 0.1, 0.95) : 0.55,
    reason:
      hits.length > 0
        ? `matched escalation signals: ${hits.join(', ')}`
        : 'no escalation signals found in the input',
  };

  return {
    text: JSON.stringify(payload),
    json: payload as unknown as Json,
    model: `${cfg.model ?? config.llmModel()} (STUB — no LLM_API_KEY configured)`,
    provider: 'stub',
    stubbed: true,
    usage: null,
  };
}

export async function executeLlmCall(
  rawConfig: LlmCallConfig,
  resolvedPrompt: string,
): Promise<StepExecutionResult> {
  if (typeof resolvedPrompt !== 'string' || resolvedPrompt.trim() === '') {
    throw new StepError('llm_call requires a non-empty "prompt" after template resolution', {
      permanent: true,
    });
  }

  const provider = (rawConfig.provider ?? config.llmProvider()).toLowerCase();
  const hasKey = config.llmApiKey() !== '';

  let result: LlmResult;
  if (!hasKey) {
    console.warn(
      '[llm_call] LLM_API_KEY is not set — using the disclosed offline stub. ' +
        'Output is marked { "stubbed": true }.',
    );
    result = stubCompletion(rawConfig, resolvedPrompt);
  } else {
    switch (provider) {
      case 'groq':
        result = await callOpenAiCompatible(rawConfig, resolvedPrompt, 'https://api.groq.com/openai/v1', 'groq');
        break;
      case 'openrouter':
        result = await callOpenAiCompatible(rawConfig, resolvedPrompt, 'https://openrouter.ai/api/v1', 'openrouter');
        break;
      case 'gemini':
        result = await callGemini(rawConfig, resolvedPrompt);
        break;
      default:
        throw new StepError(
          `Unsupported LLM provider "${provider}". Use groq, openrouter, or gemini.`,
          { permanent: true },
        );
    }
  }

  // Structured extraction: models wrap JSON in prose or fences often enough
  // that a downstream branch reading output.json.label needs this tolerance.
  if (rawConfig.parse_json && result.json === null) {
    result.json = extractJson(result.text);
  }

  return {
    output: {
      text: result.text,
      json: result.json,
      model: result.model,
      provider: result.provider,
      stubbed: result.stubbed,
      usage: result.usage as Json,
    },
  };
}

/** Pull the first JSON object out of a completion, tolerating ``` fences. */
export function extractJson(text: string): Json | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as Json;
    } catch {
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1)) as Json;
        } catch {
          /* fall through to next candidate */
        }
      }
    }
  }
  return null;
}
