/**
 * Thin client over a local Ollama server's `/api/chat` endpoint. No new
 * dependency — uses the global `fetch` (Node 24+).
 */

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatOptions {
  /** Override the base URL for this call. Defaults to getOllamaUrl(). */
  baseUrl?: string;
  /** Override the model for this call. Defaults to getOllamaModel(). */
  model?: string;
  /** Pass 'json' to ask Ollama to constrain output to valid JSON. */
  format?: 'json';
  /**
   * Thinking-model toggle. Omitted = the model's default, which for thinking models is to
   * think: measured ~55s vs ~1s for a one-message classification. Short classifiers should
   * pass false.
   */
  think?: boolean;
  /**
   * Sampling options passed through to Ollama. Classifiers want temperature 0 (repeatable,
   * so an eval measures the prompt rather than the dice) and a num_predict cap (JSON mode
   * can otherwise run on until the timeout). Merged with `numCtx`/`temperature` below if both
   * are given; this object's fields win on overlap.
   */
  options?: { temperature?: number; num_predict?: number };
  /** Abort the request after this many ms. Default 120_000 (LLM calls are slow). */
  timeoutMs?: number;
  /**
   * Context window in tokens. Ollama's default is small and it silently drops
   * the start of an over-long prompt (the system prompt goes first), so callers
   * sending large prompts should set this.
   */
  numCtx?: number;
  /** Sampling temperature. 0 makes repeat calls on the same prompt return the same answer. */
  temperature?: number;
  /**
   * How long Ollama keeps the model loaded after this call ("30s", "5m", 0 = unload now).
   * Omitted = the server default (5 minutes), which keeps several GB resident between calls.
   */
  keepAlive?: string | number;
}

export function getOllamaUrl(): string {
  return process.env.APOTHEOSIS_OLLAMA_URL ?? 'http://localhost:11434';
}

export function getOllamaModel(): string {
  return process.env.APOTHEOSIS_OLLAMA_MODEL ?? 'gemma4:e2b';
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
}

/**
 * Send a chat completion request to Ollama and return the assistant's
 * response text. Throws on network failure, non-2xx status, or a malformed
 * response — callers should surface this as "Ollama is unreachable / failed"
 * rather than swallow it.
 */
export async function chat(
  messages: OllamaChatMessage[],
  opts: OllamaChatOptions = {}
): Promise<string> {
  const baseUrl = opts.baseUrl ?? getOllamaUrl();
  const model = opts.model ?? getOllamaModel();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(opts.format ? { format: opts.format } : {}),
        ...(opts.numCtx !== undefined || opts.temperature !== undefined || opts.options
          ? {
              options: {
                ...(opts.numCtx !== undefined ? { num_ctx: opts.numCtx } : {}),
                ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
                ...opts.options,
              },
            }
          : {}),
        ...(opts.think !== undefined ? { think: opts.think } : {}),
        ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Ollama at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama request failed (${res.status} ${res.statusText}): ${body}`);
  }

  const data = (await res.json()) as OllamaChatResponse;
  const content = data.message?.content;
  if (!content) {
    throw new Error('Ollama response did not include message content.');
  }
  return content;
}

/**
 * Health check — hits /api/tags with a short timeout. Never throws; returns
 * false on any failure (connection refused, timeout, non-2xx, etc).
 */
export async function isAvailable(
  opts: { baseUrl?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? getOllamaUrl();
  const timeoutMs = opts.timeoutMs ?? 1500;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Names of the models Ollama currently has in memory (`/api/ps`). Never throws; [] on failure. */
export async function loadedModels(opts: { baseUrl?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const baseUrl = opts.baseUrl ?? getOllamaUrl();
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 1500) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (data.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Frees a model's memory right away instead of waiting out its keep_alive. Only asks when the
 * model is actually loaded, so it never loads a model just to unload it. Returns whether it
 * unloaded anything. Never throws.
 */
export async function unloadModel(model = getOllamaModel(), opts: { baseUrl?: string } = {}): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? getOllamaUrl();
  const loaded = await loadedModels({ baseUrl });
  if (!loaded.some((name) => name === model || name === `${model}:latest`)) return false;
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
