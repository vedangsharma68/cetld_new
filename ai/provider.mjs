const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const ZEN_CHAT_COMPLETIONS_URL = 'https://opencode.ai/zen/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 16_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_CHARS = 256 * 1024;

function assertServerRuntime() {
  if (typeof globalThis.window !== 'undefined') throw new AIError('INVALID_ARGUMENT', 400);
}

export const ZEN_PRIMARY_MODEL = globalThis.process?.env?.ZEN_PRIMARY_MODEL || 'space-bunny-free';
export const ZEN_FALLBACK_MODEL = globalThis.process?.env?.ZEN_FALLBACK_MODEL || 'longcat-2.5-preview-free';
export const GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash';
export const DEFAULT_MODEL = ZEN_PRIMARY_MODEL;
export const DEFAULT_FALLBACK_MODEL = ZEN_FALLBACK_MODEL;
export const DEFAULT_EXTRACTION_MODEL = 'gemini-3.5-flash-lite';
export const CF_PRIMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CF_BACKUP_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const CF_MISTRAL_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const CF_GPT_OSS_MODEL = '@cf/openai/gpt-oss-20b';
export const CF_QWEN_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const CF_GLM_MODEL = '@cf/zai-org/glm-4.7-flash';
export const CLOUDFLARE_MODEL_IDS = Object.freeze([
  CF_PRIMARY_MODEL, CF_BACKUP_MODEL, CF_MISTRAL_MODEL, CF_GPT_OSS_MODEL, CF_QWEN_MODEL, CF_GLM_MODEL,
]);
export const GEMINI_MODEL_IDS = Object.freeze([GEMINI_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL]);
export const isCloudflareModelId = value => CLOUDFLARE_MODEL_IDS.includes(value);
const isCfModel = isCloudflareModelId;
const cfBreaker = {failures: 0, openUntil: 0};
export function cloudflareBreakerState() { return {...cfBreaker, open: Date.now() < cfBreaker.openUntil}; }
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export const DEFAULT_EXTRACTION_FALLBACK_MODEL = GEMINI_FALLBACK_MODEL;
const BOTH_MODEL_ROLES = Object.freeze(['primary','fallback']);
const catalogEntry = (id,label,provider,roles=BOTH_MODEL_ROLES,supportsTools=true) =>
  Object.freeze({id,label,provider,roles:Object.freeze([...roles]),supportsTools});
export const VERIFIED_MODEL_CATALOG = Object.freeze([
  catalogEntry(ZEN_PRIMARY_MODEL,'Space Bunny Free','opencode-zen',['primary']),
  catalogEntry(ZEN_FALLBACK_MODEL,'LongCat 2.5 Preview Free','opencode-zen',['fallback']),
  catalogEntry(CF_PRIMARY_MODEL,'Llama 3.3 70B Instruct (Cloudflare)','cloudflare'),
  catalogEntry(CF_BACKUP_MODEL,'Llama 4 Scout (Cloudflare)','cloudflare'),
  catalogEntry(CF_MISTRAL_MODEL,'Mistral Small 3.1 24B (Cloudflare)','cloudflare'),
  catalogEntry(CF_GPT_OSS_MODEL,'GPT OSS 20B (Cloudflare)','cloudflare'),
  catalogEntry(CF_QWEN_MODEL,'Qwen3 30B A3B (Cloudflare)','cloudflare'),
  catalogEntry(CF_GLM_MODEL,'GLM 4.7 Flash (Cloudflare)','cloudflare'),
  catalogEntry(GEMINI_FALLBACK_MODEL,'Gemini 3.5 Flash','google'),
  catalogEntry(DEFAULT_EXTRACTION_MODEL,'Gemini 3.5 Flash Lite','google'),
]);
export const VERIFIED_MODELS = Object.freeze([...new Set(VERIFIED_MODEL_CATALOG.map(entry=>entry.id))]);
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
  return typeof value === 'string' && /^gemini-[a-zA-Z0-9.-]{1,100}$/.test(value) && GEMINI_MODEL_IDS.includes(value);
}
function catalogRoles(value) { return VERIFIED_MODEL_CATALOG.find(entry=>entry.id===value)?.roles || []; }
export function isPrimaryModelId(value) { return catalogRoles(value).includes('primary'); }
export function isFallbackModelId(value) { return catalogRoles(value).includes('fallback'); }
function isZenModelId(value) { return value === ZEN_PRIMARY_MODEL || value === ZEN_FALLBACK_MODEL; }
export function isModelId(value) {
  return value === OPENROUTER_FREE_MODEL || isPrimaryModelId(value) || isFallbackModelId(value);
}
export const isFreeModelId = isModelId;

function defaultFallbackFor(primary) {
  if (primary === CF_PRIMARY_MODEL) return CF_BACKUP_MODEL;
  if (primary === ZEN_PRIMARY_MODEL) return ZEN_FALLBACK_MODEL;
  if (primary === GEMINI_FALLBACK_MODEL) return DEFAULT_EXTRACTION_MODEL;
  if (primary === DEFAULT_EXTRACTION_MODEL) return GEMINI_FALLBACK_MODEL;
  return GEMINI_FALLBACK_MODEL;
}

export function sanitizeModelSettings({primaryModel, fallbackModel} = {}) {
  const primary = isPrimaryModelId(primaryModel) ? primaryModel : DEFAULT_MODEL;
  if (fallbackModel === null) return {primaryModel: primary, fallbackModel: null};
  const preferredFallback = fallbackModel === undefined ? defaultFallbackFor(primary) : fallbackModel;
  let fallback = isFallbackModelId(preferredFallback) && preferredFallback !== primary
    ? preferredFallback : defaultFallbackFor(primary);
  if (fallback === primary) fallback = DEFAULT_FALLBACK_MODEL === primary ? GEMINI_FALLBACK_MODEL : DEFAULT_FALLBACK_MODEL;
  return {primaryModel: primary, fallbackModel: fallback};
}

function invalidArgument() { return new AIError('INVALID_ARGUMENT', 400); }
function statusError(status, reason = 'unknown') {
  if (reason === 'model_unavailable' || status === 404) return Object.assign(new AIError('INVALID_MODEL', status), {providerReason: reason});
  if (status === 401 || status === 403) return Object.assign(new AIError('AUTH_FAILED', status), {providerReason: reason});
  if (status === 429) return Object.assign(new AIError('RATE_LIMITED', status), {providerReason: reason});
  if (status === 408) return Object.assign(new AIError('TIMEOUT', status), {providerReason: reason});
  if (status >= 500) return Object.assign(new AIError('PROVIDER_UNAVAILABLE', status), {providerReason: reason});
  return Object.assign(new AIError('PROVIDER_ERROR', status), {providerReason: reason});
}
const PROVIDER_REASONS = new Set(['schema_complexity','unsupported_schema_keyword','invalid_generation_config','unsupported_modality','model_unavailable','permission_denied','quota_exceeded','unknown']);
function classifyProviderError(body, status) {
  const code = typeof body?.error?.code === 'string' ? body.error.code.toLowerCase() : '';
  const text = [body?.error?.message, body?.error?.status, body?.error?.reason,
    ...(Array.isArray(body?.error?.details) ? body.error.details.map(item => item?.reason || item?.message) : [])]
    .filter(value => typeof value === 'string').join(' ').toLowerCase();
  let reason = 'unknown';
  if (/schema.{0,40}(too complex|complexity|nesting|depth|size|limit)/.test(text)) reason = 'schema_complexity';
  else if (/(unsupported|unknown|not supported).{0,40}(schema|keyword)|(schema|keyword).{0,40}(unsupported|not supported)/.test(text)) reason = 'unsupported_schema_keyword';
  else if (/generation.?config|generation configuration/.test(text)) reason = 'invalid_generation_config';
  else if (/unsupported.{0,30}(modality|image|document|mime)|modality.{0,30}(unsupported|not supported)/.test(text)) reason = 'unsupported_modality';
  else if (/model.{0,40}(not found|unavailable|not supported|does not exist)|model_not_found/.test(`${code} ${text}`)) reason = 'model_unavailable';
  else if (status === 401 || status === 403 || /permission_denied|permission denied/.test(`${code} ${text}`)) reason = 'permission_denied';
  else if (status === 429 || /quota_exceeded|quota exceeded|resource_exhausted/.test(`${code} ${text}`)) reason = 'quota_exceeded';
  return PROVIDER_REASONS.has(reason) ? reason : 'unknown';
}
function remainingMs(deadlineAt, fallback) {
  return Number.isFinite(deadlineAt) ? Math.max(0, Math.min(fallback, deadlineAt - Date.now())) : fallback;
}
function assertActive(signal, deadlineAt) {
  if (signal?.aborted || remainingMs(deadlineAt, 1) <= 0) throw new AIError('TIMEOUT', 504);
}
function retryable(error) {
  return error instanceof AIError && ['TIMEOUT','NETWORK_ERROR','RATE_LIMITED','PROVIDER_UNAVAILABLE'].includes(error.code);
}
function fallbackEligible(error) {
  return retryable(error) || error instanceof AIError && ['INVALID_MODEL','API_KEY_MISSING','AUTH_FAILED','PROVIDER_ERROR','INVALID_RESPONSE'].includes(error.code);
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
async function readBoundedJson(response) {
  try { return JSON.parse(await readBoundedText(response)); }
  catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('INVALID_RESPONSE');
  }
}
function stripJsonFence(content) {
  const text = String(content || '').trim();
  const match = text.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
  return match ? match[1].trim() : text;
}
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 200 || safeJsonStringify(messages).length > 15 * 1024 * 1024) throw invalidArgument();
}

export async function verifyModel(modelId, {fetchImpl = globalThis.fetch, timeoutMs = 10_000, geminiApiKey = globalThis.process?.env?.GEMINI_API_KEY, openRouterApiKey = globalThis.process?.env?.OPENROUTER_API_KEY, zenApiKey = globalThis.process?.env?.OPENCODE_ZEN_API_KEY, cfAccountId = globalThis.process?.env?.CLOUDFLARE_ACCOUNT_ID, cfApiToken = globalThis.process?.env?.CLOUDFLARE_API_TOKEN} = {}) {
  assertServerRuntime();
  if (!isModelId(modelId)) throw new AIError('INVALID_MODEL', 400);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (isZenModelId(modelId)) {
      if (!zenApiKey) throw new AIError('API_KEY_MISSING', 503);
      return {id: modelId, provider: 'opencode-zen'};
    }
    if (modelId === OPENROUTER_FREE_MODEL) {
      if (!openRouterApiKey) throw new AIError('API_KEY_MISSING', 503);
      const response = await fetchImpl(OPENROUTER_BASE_URL + '/models', {signal: controller.signal});
      if (!response.ok) throw statusError(response.status);
      const body = JSON.parse(await readBoundedText(response));
      if (!body?.data?.some(entry => entry?.id === OPENROUTER_FREE_MODEL)) throw new AIError('INVALID_MODEL', 404);
      return {id: modelId, provider: 'openrouter'};
    }
    if (isCfModel(modelId)) {
      if (!cfAccountId || !cfApiToken) throw new AIError('API_KEY_MISSING', 503);
      const search = modelId.split('/').at(-1);
      const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccountId)}/ai/models/search?search=${encodeURIComponent(search)}&per_page=100`;
      const response = await fetchImpl(url, {method: 'GET', headers: {Authorization: `Bearer ${cfApiToken}`}, signal: controller.signal});
      if (!response.ok) throw statusError(response.status);
      const body = await readBoundedJson(response);
      const listed = Array.isArray(body?.result) ? body.result : Array.isArray(body?.data) ? body.data : [];
      const shortName = modelId.split('/').at(-1);
      if (!body?.success || !listed.some(entry => entry?.id === modelId || entry?.model_id === modelId || entry?.model === modelId || entry?.name === modelId || entry?.name === shortName)) throw new AIError('INVALID_MODEL', 404);
      return {id: modelId, provider: 'cloudflare'};
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
  #zenApiKey;
  #cfAccountId;
  #cfApiToken;
  constructor({
    primaryModel = DEFAULT_MODEL,
    fallbackModel = DEFAULT_FALLBACK_MODEL,
    geminiApiKey = globalThis.process?.env?.GEMINI_API_KEY,
    openRouterApiKey = globalThis.process?.env?.OPENROUTER_API_KEY,
    zenApiKey = globalThis.process?.env?.OPENCODE_ZEN_API_KEY,
    cfAccountId = globalThis.process?.env?.CLOUDFLARE_ACCOUNT_ID,
    cfApiToken = globalThis.process?.env?.CLOUDFLARE_API_TOKEN,
    apiKey,
    fetchImpl = globalThis.fetch,
    requestPurpose = 'chat',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = 2,
    retryDelayMs = 120,
    sleepImpl = delay => new Promise(resolve => setTimeout(resolve, delay)),
    logger = console,
  } = {}) {
    assertServerRuntime();
    if (!['chat', 'extraction'].includes(requestPurpose)) throw invalidArgument();
    if (!isPrimaryModelId(primaryModel) || (fallbackModel !== null && (!isFallbackModelId(fallbackModel) || fallbackModel === primaryModel))) throw new AIError('INVALID_MODEL', 400);
    this.requestPurpose = requestPurpose;
    this.primaryModel = primaryModel;
    this.fallbackModel = fallbackModel;
    this.#geminiApiKey = typeof geminiApiKey === 'string' ? geminiApiKey : '';
    this.#openRouterApiKey = typeof openRouterApiKey === 'string' ? openRouterApiKey : (typeof apiKey === 'string' ? apiKey : '');
    this.#zenApiKey = typeof zenApiKey === 'string' ? zenApiKey : '';
    this.#cfAccountId = typeof cfAccountId === 'string' ? cfAccountId : '';
    this.#cfApiToken = typeof cfApiToken === 'string' ? cfApiToken : '';
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.maxAttempts = requestPurpose === 'extraction' ? 1 : Math.min(2, Math.max(1, Number(maxAttempts) || 2));
    this.retryDelayMs = Math.min(500, Math.max(0, Number(retryDelayMs) || 0));
    this.sleepImpl = sleepImpl;
    this.logger = logger;
  }

  async generate({messages, maxTokens, tools, toolChoice, ...options} = {}) {
    validateMessages(messages);
    const requestOptions = {...options};
    if (maxTokens !== undefined) requestOptions.max_tokens = maxTokens;
    if (Array.isArray(tools) && tools.length) {
      requestOptions.tools = tools;
      if (toolChoice !== undefined) requestOptions.tool_choice = toolChoice;
    } else if (tools !== undefined && !Array.isArray(tools)) throw invalidArgument();
    const candidates = this.#candidates();
    let lastError;
    for (const model of candidates) {
      if (isCfModel(model) && Date.now() < cfBreaker.openUntil) continue;
      assertActive(options.signal, options.deadlineAt);
      try { return await this.#generateWithModel(model, messages, requestOptions, model !== this.primaryModel); }
      catch (error) {
        lastError = error;
        this.#logLegFailure(model, error);
        if (!fallbackEligible(error)) throw error;
      }
    }
    throw lastError || new AIError('PROVIDER_UNAVAILABLE', 503);
  }

  #candidates() {
    let candidates = [this.primaryModel];
    if (this.requestPurpose === 'extraction') {
      if (this.fallbackModel) {
        candidates.push(this.fallbackModel);
        candidates.push(GEMINI_FALLBACK_MODEL, ZEN_PRIMARY_MODEL, ZEN_FALLBACK_MODEL);
      }
    } else if (this.primaryModel === CF_PRIMARY_MODEL) {
      const defaultCfFallback = this.fallbackModel === null || this.fallbackModel === CF_BACKUP_MODEL || this.fallbackModel === GEMINI_FALLBACK_MODEL;
      if (defaultCfFallback) candidates.push(CF_BACKUP_MODEL);
      if (this.fallbackModel) candidates.push(this.fallbackModel);
      if (!defaultCfFallback) candidates.push(CF_BACKUP_MODEL);
      candidates.push(GEMINI_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL);
    } else if (isCfModel(this.primaryModel)) {
      if(this.fallbackModel){
        candidates.push(this.fallbackModel, GEMINI_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL);
      }
    } else if (!this.fallbackModel) {
      return candidates;
    } else if (this.primaryModel === ZEN_PRIMARY_MODEL) {
      candidates.push(this.fallbackModel);
      candidates.push(GEMINI_FALLBACK_MODEL);
    } else {
      candidates.push(this.fallbackModel);
      candidates.push(GEMINI_FALLBACK_MODEL, DEFAULT_EXTRACTION_MODEL);
    }
    return [...new Set(candidates)].filter(model=>!isCfModel(model)||Date.now()>=cfBreaker.openUntil);
  }

  async generateStructured({messages, schema, name, validate, maxTokens, ...options} = {}) {
    if (!schema || typeof schema !== 'object' || typeof name !== 'string' || typeof validate !== 'function') throw invalidArgument();
    const requestOptions = {
      ...options, messages, maxTokens,
      response_format: {type: 'json_schema', json_schema: {name, strict: true, schema}},
      temperature: 0,
    };
    const decode = result => {
      assertActive(options.signal, options.deadlineAt);
      const finishReason = String(result.finishReason || '').toLowerCase();
      if (['max_tokens','max_output_tokens','length'].includes(finishReason)) throw new AIError('INVALID_OUTPUT', 502);
      let parsed;
      try { parsed = JSON.parse(stripJsonFence(result.content)); }
      catch { throw new AIError('INVALID_OUTPUT', 502); }
      try {
        const data = validate(parsed);
        if (data === undefined || safeJsonStringify(data).length > MAX_CONTENT_CHARS) throw new Error();
        return {data, model: result.model, usedFallback: result.usedFallback};
      } catch { throw new AIError('INVALID_OUTPUT', 502); }
    };
    const result = await this.generate(requestOptions);
    try { return decode(result); }
    catch (error) {
      if (!(error instanceof AIError) || error.code !== 'INVALID_OUTPUT' || result.usedFallback || !this.fallbackModel) throw error;
      // The general generate path only fails over for transport/provider errors. A
      // structured response can still be unusable despite a successful HTTP call,
      // so make bounded attempts through the configured fallback chain.
      const {messages: _messages, maxTokens: _maxTokens, ...providerOptions} = requestOptions;
      let lastError = error;
      for (const fallbackModel of this.#candidates().slice(1)) {
        if (isCfModel(fallbackModel) && Date.now() < cfBreaker.openUntil) continue;
        try {
          const fallback = await this.#generateWithModel(fallbackModel, messages, {
            ...providerOptions,
            ...(Number.isInteger(maxTokens) ? {max_tokens: maxTokens} : {}),
          }, true);
          return decode(fallback);
        } catch (fallbackError) {
          lastError = fallbackError;
          this.#logLegFailure(fallbackModel, fallbackError);
          if (!fallbackEligible(fallbackError)) throw fallbackError;
        }
      }
      throw lastError;
    }
  }

  async #generateWithModel(model, messages, options, usedFallback) {
    let lastError;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      assertActive(options.signal, options.deadlineAt);
      try {
        const result = await this.#request(model, messages, options, usedFallback);
        this.#logLegServed(model);
        return result;
      }
      catch (error) {
        lastError = error;
        if (!retryable(error) || attempt + 1 >= this.maxAttempts) throw error;
        const delay = Math.min(this.retryDelayMs * (2 ** attempt), remainingMs(options.deadlineAt, Infinity));
        if (delay <= 0) throw new AIError('TIMEOUT', 504);
        await this.sleepImpl(delay);
      }
    }
    throw lastError;
  }

  #logLegFailure(model, error) {
    const provider = this.#providerName(model);
    this.logger?.warn?.('AI provider leg failed:', {provider, model, status: error instanceof AIError ? error.status : 502,
      reason: PROVIDER_REASONS.has(error?.providerReason) ? error.providerReason : 'unknown'});
  }

  #logLegServed(model) {
    this.logger?.info?.('AI provider request served:', {provider: this.#providerName(model), model});
  }

  #providerName(model) {
    return isCfModel(model) ? 'cloudflare' : isZenModelId(model) ? 'opencode-zen' : model === OPENROUTER_FREE_MODEL ? 'openrouter' : 'google';
  }

  async #request(model, messages, options, usedFallback) {
    const {signal, deadlineAt, ...wireOptions} = options;
    if (isCfModel(model)) {
      if (!this.#cfApiToken || !this.#cfAccountId) throw new AIError('API_KEY_MISSING', 503);
      const cfWireOptions = {...wireOptions};
      if (Array.isArray(cfWireOptions.tools) && cfWireOptions.tools.length === 0) {
        delete cfWireOptions.tools;
        delete cfWireOptions.tool_choice;
      }
      try {
        const result = await this.#fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.#cfAccountId)}/ai/v1/chat/completions`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.#cfApiToken}`},
          body: safeJsonStringify({...cfWireOptions, model, messages, stream: false}),
        }, async response => {
          const body = await readBoundedJson(response);
          if (!response.ok || body?.error || body?.success === false) throw statusError(response.status || 502, classifyProviderError(body, response.status));
          const choice = body?.choices?.[0];
          const message = choice?.message;
          if (!message) throw new AIError('INVALID_RESPONSE');
          const content = typeof message.content === 'string' ? message.content : '';
          const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          if (!content && !toolCalls.length) throw new AIError('INVALID_RESPONSE');
          return {content, finishReason: choice.finish_reason || null, toolCalls, model, usedFallback};
        }, {signal, deadlineAt});
        cfBreaker.failures = 0;
        cfBreaker.openUntil = 0;
        return result;
      } catch (error) {
        // Only repeated transport, rate-limit, timeout, or 5xx failures bench Cloudflare.
        if (retryable(error) && (cfBreaker.failures += 1) >= 3) { cfBreaker.openUntil = Date.now() + 10 * 60 * 1000; cfBreaker.failures = 0; }
        throw error;
      }
    }
    if (isZenModelId(model)) {
      if (!this.#zenApiKey) throw new AIError('API_KEY_MISSING', 503);
      return this.#fetch(ZEN_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.#zenApiKey}`},
        body: safeJsonStringify({...wireOptions, model, messages, stream: false}),
      }, async response => {
        const body = await readBoundedJson(response);
        if (!response.ok || body?.error) throw statusError(response.status || Number(body?.error?.code) || 502, classifyProviderError(body, response.status));
        const choice = body?.choices?.[0];
        const message = choice?.message;
        if (!message) throw new AIError('INVALID_RESPONSE');
        const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part?.text || '').join('') : '';
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (!content && !toolCalls.length) throw new AIError('INVALID_RESPONSE');
        return {content, finishReason: choice.finish_reason || null, toolCalls, model, usedFallback};
      }, {signal, deadlineAt});
    }
    if (model === OPENROUTER_FREE_MODEL) {
      if (!this.#openRouterApiKey) throw new AIError('API_KEY_MISSING', 503);
      return this.#fetch(OPENROUTER_BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.#openRouterApiKey}`},
        body: safeJsonStringify(openRouterRequest(messages, wireOptions)),
      }, async response => {
        const body = await readBoundedJson(response);
        if (!response.ok || body?.error) throw statusError(response.status || Number(body?.error?.code) || 502, classifyProviderError(body, response.status));
        const choice = body?.choices?.[0];
        const message = choice?.message;
        if (!message) throw new AIError('INVALID_RESPONSE');
        const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map(part => part?.text || '').join('') : '';
        return {content, finishReason: choice.finish_reason || null, toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [], model, usedFallback};
      }, {signal, deadlineAt});
    }
    if (!this.#geminiApiKey) throw new AIError('API_KEY_MISSING', 503);
    return this.#fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.#geminiApiKey)}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: safeJsonStringify(geminiRequest(messages, wireOptions)),
    }, async response => {
      const body = await readBoundedJson(response);
      if (!response.ok || body?.error) throw statusError(response.status || Number(body?.error?.code) || 502, classifyProviderError(body, response.status));
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
    }, {signal, deadlineAt});
  }

  async #fetch(url, init, consumeResponse = response => response, {signal, deadlineAt} = {}) {
    if (typeof this.fetchImpl !== 'function') throw new AIError('NETWORK_ERROR', 503);
    assertActive(signal, deadlineAt);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    let timer;
    const request = (async () => consumeResponse(await this.fetchImpl(url, {...init, signal: controller.signal, redirect: 'error'})))();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AIError('TIMEOUT', 504));
      }, remainingMs(deadlineAt, this.timeoutMs));
    });
    try { return await Promise.race([request, timeout]); }
    catch (error) {
      if (error instanceof AIError) throw error;
      if (error?.name === 'AbortError') throw new AIError('TIMEOUT', 504);
      throw new AIError('NETWORK_ERROR', 503);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
