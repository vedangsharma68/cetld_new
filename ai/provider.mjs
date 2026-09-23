const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_CHARS = 256 * 1024;

function assertServerRuntime() {
  if (typeof globalThis.window !== 'undefined') throw new AIError('INVALID_ARGUMENT', 400);
}

// Keep the production path on OpenRouter's free endpoints. The explicit
// primary is multimodal for invoice images/PDFs; the router is a compatible
// free fallback for assistant and future WhatsApp calls.
export const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
export const DEFAULT_FALLBACK_MODEL = 'openrouter/free';
export const VERIFIED_FREE_MODELS = Object.freeze([DEFAULT_MODEL, DEFAULT_FALLBACK_MODEL]);

const SAFE_MESSAGES = Object.freeze({
  INVALID_MODEL: 'The configured AI model is not available.',
  API_KEY_MISSING: 'AI service is not configured.',
  TIMEOUT: 'The AI service request timed out.',
  NETWORK_ERROR: 'The AI service could not be reached.',
  AUTH_FAILED: 'AI service authentication failed.',
  RATE_LIMITED: 'The AI service is temporarily rate limited.',
  PROVIDER_UNAVAILABLE: 'The AI service is temporarily unavailable.',
  PROVIDER_ERROR: 'The AI service request failed.',
  INVALID_RESPONSE: 'The AI service returned an invalid response.',
  INVALID_OUTPUT: 'The AI service returned output that could not be used.',
  INVALID_ARGUMENT: 'The AI request is invalid.',
});

export class AIError extends Error {
  constructor(code, status = 502) {
    const safeCode = Object.hasOwn(SAFE_MESSAGES, code) ? code : 'PROVIDER_ERROR';
    super(SAFE_MESSAGES[safeCode]);
    this.name = 'AIError';
    this.code = safeCode;
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  }
}

export function isModelId(value) {
  return typeof value === 'string'
    && value.length <= 160
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(value);
}

export function isFreeModelId(value) {
  return VERIFIED_FREE_MODELS.includes(value);
}

export function sanitizeModelSettings({ primaryModel, fallbackModel } = {}) {
  const primary = isFreeModelId(primaryModel) ? primaryModel : DEFAULT_MODEL;
  if (fallbackModel === null) return { primaryModel: primary, fallbackModel: null };
  if (isFreeModelId(fallbackModel) && fallbackModel !== primary) {
    return { primaryModel: primary, fallbackModel };
  }
  return {
    primaryModel: primary,
    fallbackModel: primary === DEFAULT_MODEL ? DEFAULT_FALLBACK_MODEL : DEFAULT_MODEL,
  };
}

/** Check a model against OpenRouter's public catalog without requiring an API key. */
export async function verifyModel(modelId, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  assertServerRuntime();
  if (!isFreeModelId(modelId)) throw new AIError('INVALID_MODEL', 400);
  if (typeof fetchImpl !== 'function') throw new AIError('NETWORK_ERROR', 503);
  const controller = new AbortController();
  let timeoutId;
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new AIError('TIMEOUT', 504));
      }, Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : 10_000));
    });
    const request = Promise.resolve().then(() => fetchImpl(`${OPENROUTER_BASE_URL}/models`, { method: 'GET', signal: controller.signal })).then(async (response) => {
      if (!response.ok) throw statusError(response.status);
      const text = await readBoundedText(response);
      let body;
      try { body = JSON.parse(text); } catch { throw new AIError('INVALID_RESPONSE'); }
      if (!Array.isArray(body?.data)) throw new AIError('INVALID_RESPONSE');
      const entry = body.data.find((model) => model?.id === modelId);
      if (!entry) throw new AIError('INVALID_MODEL', 404);
      if (!isFreeCatalogEntry(entry)) throw new AIError('INVALID_MODEL', 400);
      // Only return catalog metadata, never provider response/error text.
      return { id: entry.id, name: typeof entry.name === 'string' ? entry.name.slice(0, 300) : null };
    });
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (error?.name === 'AbortError') throw new AIError('TIMEOUT', 504);
    throw new AIError('NETWORK_ERROR', 503);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isFreeCatalogEntry(entry) {
  if (entry?.id === 'openrouter/free') return true;
  if (!isFreeModelId(entry?.id)) return false;
  // Older test doubles and older catalog responses may omit pricing. The
  // canonical :free suffix remains the fallback in that case; when pricing
  // is present, require both token prices to be zero.
  if (!entry?.pricing || typeof entry.pricing !== 'object') return true;
  return Number(entry.pricing.prompt) === 0 && Number(entry.pricing.completion) === 0;
}

function invalidArgument() {
  return new AIError('INVALID_ARGUMENT', 400);
}

async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new AIError('INVALID_RESPONSE');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let byteCount = 0;
    let output = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AIError('INVALID_RESPONSE');
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  }
  const text = await response.text();
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxBytes) throw new AIError('INVALID_RESPONSE');
  return text;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw invalidArgument();
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) throw invalidArgument();
  // Ensure callers can safely serialize the request before contacting OpenRouter.
  const serialized = safeJsonStringify(messages);
  if (serialized.length > 15 * 1024 * 1024) throw invalidArgument();
}

function normalizeContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let combined = '';
    for (const part of content) {
      if (!part || typeof part !== 'object' || typeof part.text !== 'string') throw new AIError('INVALID_RESPONSE');
      combined += part.text;
      if (combined.length > MAX_CONTENT_CHARS) throw new AIError('INVALID_OUTPUT', 502);
    }
    return combined;
  }
  throw new AIError('INVALID_RESPONSE');
}

function retryable(error) {
  return error instanceof AIError && (
    (error.code === 'INVALID_MODEL' && error.status === 404)
    || error.code === 'TIMEOUT'
    || error.code === 'NETWORK_ERROR'
    || error.code === 'RATE_LIMITED'
    || (error.code === 'PROVIDER_UNAVAILABLE' && error.status >= 500)
  );
}

function statusError(status) {
  if (status === 401 || status === 403) return new AIError('AUTH_FAILED', status);
  if (status === 429) return new AIError('RATE_LIMITED', status);
  if (status === 408) return new AIError('TIMEOUT', status);
  if (status >= 500) return new AIError('PROVIDER_UNAVAILABLE', status);
  return new AIError('PROVIDER_ERROR', status);
}

export class AIProvider {
  #apiKey;
  constructor({
    primaryModel = DEFAULT_MODEL,
    fallbackModel = DEFAULT_FALLBACK_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    apiKey = globalThis.process?.env?.OPENROUTER_API_KEY,
    fetchImpl = globalThis.fetch,
    catalogTtlMs = DEFAULT_CATALOG_TTL_MS,
    maxAttempts = 3,
    retryDelayMs = 100,
    sleepImpl = (delay) => new Promise(resolve => setTimeout(resolve, delay)),
  } = {}) {
    assertServerRuntime();
    if (!isFreeModelId(primaryModel) || (fallbackModel !== null && !isFreeModelId(fallbackModel))) {
      throw new AIError('INVALID_MODEL', 400);
    }
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.#apiKey = typeof apiKey === 'string' ? apiKey : '';
    this.fetchImpl = fetchImpl;
    this.catalogTtlMs = Number.isFinite(catalogTtlMs) ? Math.max(0, catalogTtlMs) : DEFAULT_CATALOG_TTL_MS;
    this.maxAttempts = Number.isInteger(maxAttempts) ? Math.min(3, Math.max(1, maxAttempts)) : 3;
    this.retryDelayMs = Number.isFinite(retryDelayMs) ? Math.min(1000, Math.max(0, retryDelayMs)) : 100;
    this.sleepImpl = typeof sleepImpl === 'function' ? sleepImpl : (() => Promise.resolve());
    this.catalog = null;
    this.catalogFetchedAt = 0;
  }

  async generate({ messages, maxTokens, tools, toolChoice, plugins, ...options } = {}) {
    validateMessages(messages);
    const requestOptions = { ...options };
    if (maxTokens !== undefined) {
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) throw invalidArgument();
      requestOptions.max_tokens = maxTokens;
    }
    if (tools !== undefined) requestOptions.tools = tools;
    if (toolChoice !== undefined) requestOptions.tool_choice = toolChoice;
    if (plugins !== undefined) requestOptions.plugins = plugins;

    const primary = this.primaryModel;
    try {
      await this.#validateModel(primary);
      return await this.#generateWithModel(primary, messages, requestOptions, false);
    } catch (error) {
      if (!retryable(error) || this.fallbackModel === null || this.fallbackModel === primary) throw error;
      if (!isFreeModelId(this.fallbackModel)) throw new AIError('INVALID_MODEL', 400);
      const fallback = await this.#validateModel(this.fallbackModel);
      return this.#generateWithModel(fallback, messages, requestOptions, true);
    }
  }

  async generateStructured({ messages, schema, name, validate, maxTokens, ...options } = {}) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || typeof validate !== 'function') {
      throw invalidArgument();
    }
    const result = await this.generate({
      ...options,
      messages,
      maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name, strict: true, schema },
      },
    });
    let parsed;
    try {
      if (!result.content || result.content.length > MAX_CONTENT_CHARS) throw new Error('invalid');
      parsed = JSON.parse(result.content);
    } catch {
      throw new AIError('INVALID_OUTPUT', 502);
    }
    try {
      const data = validate(parsed);
      if (data === undefined) throw new Error('validator must return sanitized data');
      // The validator may return arbitrary data, so bound the serialized shape too.
      if (safeJsonStringify(data).length > MAX_CONTENT_CHARS) throw new Error('output too large');
      return { data, model: result.model, usedFallback: result.usedFallback };
    } catch {
      throw new AIError('INVALID_OUTPUT', 502);
    }
  }

  async #validateModel(model) {
    if (!isFreeModelId(model)) throw new AIError('INVALID_MODEL', 400);
    if (!this.#apiKey) throw new AIError('API_KEY_MISSING', 503);
    const catalog = await this.#getCatalog();
    if (!catalog.has(model)) throw new AIError('INVALID_MODEL', 404);
    return model;
  }

  async #getCatalog() {
    const now = Date.now();
    if (this.catalog && now - this.catalogFetchedAt < this.catalogTtlMs) return this.catalog;
    const { response, text: bodyText } = await this.#fetchText(`${OPENROUTER_BASE_URL}/models`, { method: 'GET' });
    if (!response.ok) throw statusError(response.status);
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new AIError('INVALID_RESPONSE');
    }
    if (!Array.isArray(body?.data) || body.data.length > 100_000) throw new AIError('INVALID_RESPONSE');
    const models = new Set(body.data.filter(isFreeCatalogEntry).map((entry) => entry.id));
    this.catalog = models;
    this.catalogFetchedAt = now;
    return models;
  }

  async #generateWithModel(model, messages, options, usedFallback) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.#requestModel(model, messages, options, usedFallback);
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts || !retryable(error)) throw error;
        await this.sleepImpl(this.retryDelayMs * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async #requestModel(model, messages, options, usedFallback) {
    const payload = { ...options, model, messages, stream: false };
    const { response, text: bodyText } = await this.#fetchText(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: safeJsonStringify(payload),
    });
    if (!response.ok) throw statusError(response.status);
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new AIError('INVALID_RESPONSE');
    }
    if (body?.error) throw statusError(Number.isInteger(body.error.code) ? body.error.code : 502);
    const message = body?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') throw new AIError('INVALID_RESPONSE');
    const content = normalizeContent(message.content);
    if (content.length > MAX_CONTENT_CHARS) throw new AIError('INVALID_OUTPUT', 502);
    const toolCalls = message.tool_calls === undefined ? [] : message.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length > 100) throw new AIError('INVALID_RESPONSE');
    if (safeJsonStringify(toolCalls).length > MAX_CONTENT_CHARS) throw new AIError('INVALID_OUTPUT', 502);
    return { content, toolCalls, model, usedFallback };
  }

  async #fetchText(url, init) {
    if (typeof this.fetchImpl !== 'function') throw new AIError('NETWORK_ERROR', 503);
    const controller = new AbortController();
    let timeoutId;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new AIError('TIMEOUT', 504));
        }, this.timeoutMs);
      });
      const request = Promise.resolve().then(() => this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        redirect: 'error',
        headers: { ...(init.headers || {}), ...(init.method === 'POST' ? {Authorization: `Bearer ${this.#apiKey}`} : {}) },
      })).then(async (response) => {
        const text = await readBoundedText(response);
        return { response, text };
      });
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (error?.name === 'AbortError') throw new AIError('TIMEOUT', 504);
      throw new AIError('NETWORK_ERROR', 503);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
