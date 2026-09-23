import test from 'node:test';
import assert from 'node:assert/strict';
import { AIError, AIProvider, DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, isFreeModelId, isModelId, verifyModel } from '../ai/provider.mjs';

const FALLBACK_MODEL = DEFAULT_FALLBACK_MODEL;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function completion(content = 'ok', extra = {}) {
  return jsonResponse({ choices: [{ message: { content, ...extra } }] });
}

function mockedFetch(handler) {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/models') {
      return jsonResponse({ data: [{ id: DEFAULT_MODEL }, { id: FALLBACK_MODEL }] });
    }
    assert.equal(parsed.pathname, '/api/v1/chat/completions');
    return handler(url, init);
  };
}

function provider(fetchImpl, options = {}) {
  return new AIProvider({
    apiKey: 'test-secret-never-return-this',
    fetchImpl,
    primaryModel: DEFAULT_MODEL,
    fallbackModel: FALLBACK_MODEL,
    catalogTtlMs: 60_000,
    ...options,
  });
}

test('model ids accept OpenRouter slugs and reject malformed values', () => {
  assert.equal(isModelId(DEFAULT_MODEL), true);
  assert.equal(isModelId(FALLBACK_MODEL), true);
  for (const value of ['', 'qwen3', '/model', 'a/b/c', 'https://evil.example/x', 'a/b?key=secret']) {
    assert.equal(isModelId(value), false);
  }
});

test('only the verified free OpenRouter models are accepted for provider configuration', async () => {
  assert.equal(DEFAULT_MODEL, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free');
  assert.equal(DEFAULT_FALLBACK_MODEL, 'openrouter/free');
  assert.equal(isFreeModelId(DEFAULT_MODEL), true);
  assert.equal(isFreeModelId(DEFAULT_FALLBACK_MODEL), true);
  assert.equal(isFreeModelId('openai/gpt-4.1-mini'), false);
  assert.equal(isFreeModelId('google/gemini-2.5-flash'), false);
  await assert.rejects(
    () => verifyModel('openai/gpt-4.1-mini', { fetchImpl: async () => { throw new Error('must not fetch paid model'); } }),
    (error) => error.code === 'INVALID_MODEL' && error.status === 400,
  );
});

test('uses the configured primary model and returns normalized completion fields', async () => {
  let requestBody;
  const ai = provider(mockedFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer test-secret-never-return-this');
    return completion('hello', { tool_calls: [{ id: 'call-1', type: 'function' }] });
  }));
  const result = await ai.generate({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: 64 });
  assert.equal(requestBody.model, DEFAULT_MODEL);
  assert.equal(requestBody.max_tokens, 64);
  assert.equal(result.content, 'hello');
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', type: 'function' }]);
});

test('falls back once after a retryable provider status and identifies the selected model', async () => {
  const requestedModels = [];
  const ai = provider(mockedFetch(async (_url, init) => {
    const model = JSON.parse(init.body).model;
    requestedModels.push(model);
    return model === DEFAULT_MODEL ? jsonResponse({ error: 'private provider detail' }, 503) : completion('recovered');
  }));
  const result = await ai.generate({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(requestedModels, [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.equal(result.content, 'recovered');
  assert.equal(result.model, FALLBACK_MODEL);
  assert.equal(result.usedFallback, true);
});

test('retries explicit 429 responses with bounded exponential backoff before using the free fallback', async () => {
  const requestedModels = [];
  const waits = [];
  const ai = provider(mockedFetch(async (_url, init) => {
    const model = JSON.parse(init.body).model;
    requestedModels.push(model);
    return model === DEFAULT_MODEL
      ? jsonResponse({ error: 'rate limited' }, 429)
      : completion('recovered after rate limit');
  }), { sleepImpl: async ms => waits.push(ms), maxAttempts: 3, retryDelayMs: 25 });
  const result = await ai.generate({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(requestedModels, [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.deepEqual(waits, [25, 50]);
  assert.equal(result.usedFallback, true);
});

test('returns a safe temporary rate-limit error after bounded retries on both free models', async () => {
  let requests = 0;
  const ai = provider(mockedFetch(async () => {
    requests++;
    return jsonResponse({ error: 'provider detail must not escape' }, 429);
  }), { sleepImpl: async () => {}, maxAttempts: 2, retryDelayMs: 1 });
  await assert.rejects(ai.generate({ messages: [{ role: 'user', content: 'Hi' }] }), (error) => {
    assert.ok(error instanceof AIError);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.match(error.message, /temporarily rate limited/);
    assert.doesNotMatch(error.message, /provider detail/);
    return true;
  });
  assert.equal(requests, 4);
});

test('rejects paid primary and fallback models before contacting OpenRouter', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('must not fetch paid model'); };
  assert.throws(
    () => new AIProvider({ apiKey: 'test-key', fetchImpl, primaryModel: 'openai/gpt-4.1-mini' }),
    error => error.code === 'INVALID_MODEL' && error.status === 400,
  );
  assert.throws(
    () => new AIProvider({ apiKey: 'test-key', fetchImpl, primaryModel: DEFAULT_MODEL, fallbackModel: 'openai/gpt-4.1-mini' }),
    error => error.code === 'INVALID_MODEL' && error.status === 400,
  );
  assert.equal(requests, 0);
});

test('does not fall back on authentication failure and never exposes provider error bodies', async () => {
  let requests = 0;
  const ai = provider(mockedFetch(async () => {
    requests++;
    return jsonResponse({ error: 'bad key test-secret-never-return-this' }, 401);
  }));
  await assert.rejects(ai.generate({ messages: [{ role: 'user', content: 'Hi' }] }), (error) => {
    assert.ok(error instanceof AIError);
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(error.status, 401);
    assert.equal(error.message.includes('test-secret'), false);
    assert.equal(error.message.includes('bad key'), false);
    return true;
  });
  assert.equal(requests, 1);
});

test('network failures and timeouts can use the one configured fallback', async () => {
  const requestedModels = [];
  const ai = provider(mockedFetch(async (_url, init) => {
    const model = JSON.parse(init.body).model;
    requestedModels.push(model);
    if (model === DEFAULT_MODEL) throw new Error('network exposed private implementation details');
    return completion('fallback after network failure');
  }));
  const result = await ai.generate({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(requestedModels, [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.equal(result.usedFallback, true);

  let timedOutModels = [];
  const slow = provider(mockedFetch((_url, init) => {
    const model = JSON.parse(init.body).model;
    timedOutModels.push(model);
    if (model === DEFAULT_MODEL) return new Promise(() => {});
    return Promise.resolve(completion('fallback after timeout'));
  }), { timeoutMs: 10, sleepImpl: async () => {} });
  const afterTimeout = await slow.generate({ messages: [{ role: 'user', content: 'Hi' }] });
  assert.deepEqual(timedOutModels, [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, FALLBACK_MODEL]);
  assert.equal(afterTimeout.usedFallback, true);
});

test('malformed structured output is rejected without fallback; valid data is sanitized', async () => {
  let chatCount = 0;
  const ai = provider(mockedFetch(async (_url, init) => {
    chatCount++;
    const request = JSON.parse(init.body);
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    return completion('not json');
  }));
  await assert.rejects(ai.generateStructured({
    messages: [{ role: 'user', content: 'Provide data' }],
    name: 'sample',
    schema: { type: 'object' },
    validate: (value) => value,
  }), (error) => error.code === 'INVALID_OUTPUT');
  assert.equal(chatCount, 1);

  const good = provider(mockedFetch(async () => completion('{"value":"clean","extra":"discard"}')));
  const structured = await good.generateStructured({
    messages: [{ role: 'user', content: 'Provide data' }],
    name: 'sample',
    schema: { type: 'object' },
    validate: (value) => ({ value: value.value }),
  });
  assert.deepEqual(structured.data, { value: 'clean' });
  assert.equal(structured.model, DEFAULT_MODEL);
  assert.equal(structured.usedFallback, false);
});

test('catalog rejects unknown models before a completion request', async () => {
  let chatCount = 0;
  const ai = provider(async (url) => {
    if (String(url).endsWith('/models')) return jsonResponse({ data: [{ id: FALLBACK_MODEL }] });
    chatCount++;
    return completion();
  }, {fallbackModel: null});
  await assert.rejects(ai.generate({ messages: [{ role: 'user', content: 'Hi' }] }), (error) => error.code === 'INVALID_MODEL');
  assert.equal(chatCount, 0);
});

test('unavailable primary uses only the explicitly configured fallback and hides the key', async () => {
  const ai = provider(async (url, init) => {
    if (url.endsWith('/models')) return jsonResponse({data:[{id:FALLBACK_MODEL}]});
    assert.equal(JSON.parse(init.body).model, FALLBACK_MODEL);
    assert.equal(init.headers.Authorization, 'Bearer test-secret-never-return-this');
    assert.equal(init.redirect, 'error');
    return completion();
  });
  assert.equal((await ai.generate({messages:[{role:'user',content:'Hi'}]})).usedFallback,true);
  assert.ok(!JSON.stringify(ai).includes('test-secret'));
});

test('model catalog is cached for the configured TTL', async () => {
  let catalogCount = 0;
  const ai = provider(async (url) => {
    if (String(url).endsWith('/models')) {
      catalogCount++;
      return jsonResponse({ data: [{ id: DEFAULT_MODEL }, { id: FALLBACK_MODEL }] });
    }
    return completion();
  });
  await ai.generate({ messages: [{ role: 'user', content: 'one' }] });
  await ai.generate({ messages: [{ role: 'user', content: 'two' }] });
  assert.equal(catalogCount, 1);
});

test('verifyModel checks the public catalog without an Authorization header', async () => {
  let requestOptions;
  const result = await verifyModel(DEFAULT_MODEL, {
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return jsonResponse({ data: [{ id: DEFAULT_MODEL, name: 'Default model' }] });
    },
  });
  assert.deepEqual(result, { id: DEFAULT_MODEL, name: 'Default model' });
  assert.equal(requestOptions.method, 'GET');
  assert.equal('headers' in requestOptions, false);
});
