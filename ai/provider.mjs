const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 16_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_CHARS = 256 * 1024;

function assertServerRuntime() {
  if (typeof globalThis.window !== 'undefined') throw new AIError('INVALID_ARGUMENT', 400);
}

export const DEFAULT_MODEL = 'gemini-3.5-flash';
export const DEFAULT_FALLBACK_MODEL = 'openrouter/free';
export const DEFAULT_EXTRACTION_MODEL = 'gemini-3.5-flash-lite';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export const DEFAULT_EXTRACTION_FALLBACK_MODEL = OPENROUTER_FREE_MODEL;
export const VERIFIED_MODELS = Object.freeze([
  DEFAULT_MODEL,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_EXTRACTION_MODEL,
  DEFAULT_EXTRACTION_FALLBACK_MODEL,
  OPENROUTER_FREE_MODEL,
]);
export const VERIFIED_FREE_MODELS = VERIFIED_MODELS;

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

export function isGeminiModelId(value) {
  return typeof value === 'string' && /^gemini-[a-zA-Z0-9.-]{1,100}$/.test(value) && VERIFIED_MODELS.includes(value);
}
export function isPrimaryModelId(value) {
  return value === DEFAULT_MODEL;
}
export function isFallbackModelId(value) {
  return value === OPENROUTER_FREE_MODEL;
}
export function isModelId(value) {
  return value === OPENROUTER_FREE_MODEL || isGeminiModelId(value);
}
export const isFreeModelId = isModelId;

export function sanitizeModelSettings({primaryModel, fallbackModel} = {}) {
  const primary = isPrimaryModelId(primaryModel) ? primaryModel : DEFAULT_MODEL;
  if (fallbackModel === null) return {primaryModel: primary, fallbackModel: null};
  const fallback = isFallbackModelId(fallbackModel) ? fallbackModel : DEFAULT_FALLBACK_MODEL;
  return {primaryModel: primary, fallbackModel: fallback};
}

function invalidArgument() { return new AIError('INVALID_ARGUMENT', 400); }
function statusError(status) {
  if (status === 400 || status === 404) return new AIError('INVALID_MODEL', status);
  if (status === 401 || status === 403) return new AIError('AUTH_FAILED', status);
  if (status === 429) return new AIError('RATE_LIMITED', status);
  if (status === 408) return new AIError('TIMEOUT', status);
  if (status >= 500) return new AIError('PROVIDER_UNAVAILABLE', status);
  return new AIError('PROVIDER_ERROR', status);
}
function retryable(error) {
  return error instanceof AIError && ['INVALID_MODEL','TIMEOUT','NETWORK_ERROR','RATE_LIMITED','PROVIDER_UNAVAILABLE','API_KEY_MISSING'].includes(error.code);
}
function safeJsonStringify(value) {
  try { return JSON.stringify(value); } catch { throw invalidArgument(); }
}
async function readBoundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AIError('INVALID_RESPONSE');
  const text = await response.text();
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > maxBytes) throw new AIError('INVALID_RESPONSE');
  return text;
}
function stripJsonFence(content) {
  const text = String(content || '').trim();
  const match = text.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
  return match ? match[1].trim() : text;
}
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200 || safeJsonStringify(messages).length > 15 * 1024 * 1024) throw invalidArgument();
}

export async function verifyModel(modelId, {fetchImpl = globalThis.fetch, timeoutMs = 10_000, geminiApiKey = globalThis.process?.env?.GEMINI_API_KEY, openRouterApiKey = globalThis.process?.env?.OPENROUTER_API_KEY} = {}) {
  assertServerRuntime();
  if (!isModelId(modelId)) throw new AIError('INVALID_MODEL', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (modelId === OPENROUTER_FREE_MODEL) {
      if (!openRouterApiKey) throw new AIError('API_KEY_MISSING', 503);
      const response = await fetchImpl(OPENROUTER_BASE_URL + '/models', {signal: controller.signal});
      if (!response.ok) throw statusError(response.status);
      const body = JSON.parse(await readBoundedText(response));
      if (!body?.data?.some(entry => entry?.id === OPENROUTER_FREE_MODEL)) throw new AIError('INVALID_MODEL', 404);
      return {id: modelId, provider: 'openrouter'};
    }
    if (!geminiApiKey) throw new AIError('API_KEY_MISSING', 503);
    const response = await fetchImpl(`${GEMINI_BASE_URL}/models/${encodeURIComponent(modelId)}?key=${encodeURIComponent(geminiApiKey)}`, {signal: controller.signal});
    if (!response.ok) throw statusError(response.status);
    const body = JSON.parse(await readBoundedText(response));
    if (!Array.isArray(body?.supportedGenerationMethods) || !body.supportedGenerationMethods.includes('generateContent')) throw new AIError('INVALID_MODEL', 400);
    return {id: modelId, provider: 'google'};
  } catch (error) {
    if (error instanceof AIError) throw error;
    if (error?.name === 'AbortError') throw new AIError('TIMEOUT', 504);
    throw new AIError('NETWORK_ERROR', 503);
  } finally { clearTimeout(timer); }
}

function parseDataUrl(url) {
  const match = typeof url === 'string' && url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw invalidArgument();
  return {mimeType: match[1], data: match[2]};
}
function geminiRequest(messages, {tools, tool_choice: toolChoice, response_format: responseFormat, max_tokens: maxTokens, temperature} = {}) {
  const system = [];
  const contents = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') throw invalidArgument();
    if (message.role === 'system') { system.push(String(message.content || '')); continue; }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof message.content === 'string') parts.push({text: message.content});
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text') parts.push({text: String(part.text || '')});
        else if (part?.type === 'image_url') parts.push({inlineData: parseDataUrl(part.image_url?.url)});
        else if (part?.type === 'file') parts.push({inlineData: parseDataUrl(part.file?.file_data)});
        else throw invalidArgument();
      }
    } else throw invalidArgument();
    contents.push({role, parts});
  }
  const generationConfig = {};
  if (Number.isInteger(maxTokens)) generationConfig.maxOutputTokens = maxTokens;
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  if (responseFormat?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = responseFormat.json_schema?.schema;
  }
  const body = {contents, generationConfig};
  if (system.length) body.systemInstruction = {parts: [{text: system.join('\n\n')}]};
  if (Array.isArray(tools) && tools.length) {
    body.tools = [{functionDeclarations: tools.map(tool => ({
      name: tool.function?.name,
      description: tool.function?.description,
      parametersJsonSchema: tool.function?.parameters,
    }))}];
    if (toolChoice === 'required') body.toolConfig = {functionCallingConfig: {mode: 'ANY'}};
  }
  return body;
}
function openRouterRequest(messages, options) {
  return {...options, model: OPENROUTER_FREE_MODEL, messages, stream: false};
}

export class AIProvider {
  #geminiApiKey;
  #openRouterApiKey;
  constructor({
    primaryModel = DEFAULT_MODEL,
    fallbackModel = DEFAULT_FALLBACK_MODEL,
    geminiApiKey = globalThis.process?.env?.GEMINI_API_KEY,
    openRouterApiKey = globalThis.process?.env?.OPENROUTER_API_KEY,
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = 2,
    retryDelayMs = 120,
    sleepImpl = delay => new Promise(resolve => setTimeout(resolve, delay)),
  } = {}) {
    assertServerRuntime();
    const extractionPrimary = primaryModel === DEFAULT_EXTRACTION_MODEL;
    if ((!isPrimaryModelId(primaryModel) && !extractionPrimary) || (fallbackModel !== null && !isFallbackModelId(fallbackModel))) throw new AIError('INVALID_MODEL', 400);
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.#geminiApiKey = typeof geminiApiKey === 'string' ? geminiApiKey : '';
    this.#openRouterApiKey = typeof openRouterApiKey === 'string' ? openRouterApiKey : (typeof apiKey === 'string' ? apiKey : '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.min(2, Math.max(1, Number(maxAttempts) || 2));
    this.retryDelayMs = Math.min(500, Math.max(0, Number(retryDelayMs) || 0));
    this.sleepImpl = sleepImpl;
  }

  async generate({messages, maxTokens, tools, toolChoice, ...options} = {}) {
    validateMessages(messages);
    const requestOptions = {...options};
    if (maxTokens !== undefined) requestOptions.max_tokens = maxTokens;
    if (tools !== undefined) requestOptions.tools = tools;
    if (toolChoice !== undefined) requestOptions.tool_choice = toolChoice;
    const candidates = [this.primaryModel, this.fallbackModel].filter(Boolean);
    let lastError;
    for (const model of candidates) {
      try { return await this.#generateWithModel(model, messages, requestOptions, model !== this.primaryModel); }
      catch (error) {
        lastError = error;
        if (!retryable(error)) throw error;
      }
    }
    throw lastError || new AIError('PROVIDER_UNAVAILABLE', 503);
  }

  async generateStructured({messages, schema, name, validate, maxTokens, ...options} = {}) {
    if (!schema || typeof schema !== 'object' || typeof name !== 'string' || typeof validate !== 'function') throw invalidArgument();
    const result = await this.generate({
      ...options, messages, maxTokens,
      response_format: {type: 'json_schema', json_schema: {name, strict: true, schema}},
      temperature: 0,
    });
    let parsed;
    try { parsed = JSON.parse(stripJsonFence(result.content)); }
    catch { throw new AIError('INVALID_OUTPUT', 502); }
    try {
      const data = validate(parsed);
      if (data === undefined || safeJsonStringify(data).length > MAX_CONTENT_CHARS) throw new Error();
      return {data, model: result.model, usedFallback: result.usedFallback};
    } catch { throw new AIError('INVALID_OUTPUT', 502); }
  }

  async #generateWithModel(model, messages, options, usedFallback) {
    let lastError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try { return await this.#request(model, messages, options, usedFallback); }
      catch (error) {
        lastError = error;
        if (!retryable(error) || attempt + 1 >= this.maxAttempts) throw error;
        await this.sleepImpl(this.retryDelayMs * (2 ** attempt));
      }
    }
    throw lastError;
  }

  async #request(model, messages, options, usedFallback) {
    if (model === OPENROUTER_FREE_MODEL) {
      if (!this.#openRouterApiKey) throw new AIError('API_KEY_MISSING', 503);
      const response = await this.#fetch(OPENROUTER_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.#openRouterApiKey}`},
        body: safeJsonStringify(openRouterRequest(messages, options)),
      });
      const body = JSON.parse(await readBoundedText(response));
      if (!response.ok || body?.error) throw statusError(response.status || body?.error?.code || 502);
      const choice = body?.choices?.[0];
      const message = choice?.message;
      if (!message) throw new AIError('INVALID_RESPONSE');
      const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part?.text || '').join('') : '';
      return {content, finishReason: choice.finish_reason || null, toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], model, usedFallback};
    }
    if (!this.#geminiApiKey) throw new AIError('API_KEY_MISSING', 503);
    const response = await this.#fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.#geminiApiKey)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: safeJsonStringify(geminiRequest(messages, options)),
    });
    const text = await readBoundedText(response);
    let body;
    try { body = JSON.parse(text); } catch { throw new AIError('INVALID_RESPONSE'); }
    if (!response.ok || body?.error) throw statusError(response.status || body?.error?.code || 502);
    const parts = body?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) throw new AIError('INVALID_RESPONSE');
    const content = parts.filter(part => typeof part?.text === 'string').map(part => part.text).join('');
    const finishReason = body?.candidates?.[0]?.finishReason || null;
    const toolCalls = parts.filter(part => part?.functionCall?.name).map((part, index) => ({
      id: `gemini-call-${index}`,
      type: 'function',
      function: {name: part.functionCall.name, arguments: safeJsonStringify(part.functionCall.args || {})},
    }));
    if (!content && !toolCalls.length) throw new AIError('INVALID_RESPONSE');
    return {content, finishReason, toolCalls, model, usedFallback};
  }

  async #fetch(url, init) {
    if (typeof this.fetchImpl !== 'function') throw new AIError('NETWORK_ERROR', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await this.fetchImpl(url, {...init, signal: controller.signal, redirect: 'error'}); }
    catch (error) {
      if (error?.name === 'AbortError') throw new AIError('TIMEOUT', 504);
      throw new AIError('NETWORK_ERROR', 503);
    } finally { clearTimeout(timer); }
  }
}

