import test from 'node:test';
import assert from 'node:assert/strict';
import {AIProvider, CF_BACKUP_MODEL, CF_PRIMARY_MODEL, DEFAULT_EXTRACTION_MODEL, GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';
import {createProviderHealthStore, providerHealthIdentity} from '../ai/provider-health.mjs';

const rows = [];
const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {'content-type': 'application/json'},
});

function databaseFetch(url, init = {}) {
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/rest/v1/ai_provider_health');
  if (init.method === 'POST') {
    const incoming = JSON.parse(init.body);
    const index = rows.findIndex(row => row.provider === incoming.provider && row.model === incoming.model
      && row.account_fingerprint === incoming.account_fingerprint
      && row.credential_fingerprint === incoming.credential_fingerprint);
    if (index < 0) rows.push(incoming);
    else rows[index] = incoming;
    return Promise.resolve(response(201, []));
  }
  const match = field => String(parsed.searchParams.get(field) || '').slice(3);
  const found = rows.filter(row => row.provider === match('provider') && row.model === match('model')
    && row.account_fingerprint === match('account_fingerprint')
    && row.credential_fingerprint === match('credential_fingerprint'));
  return Promise.resolve(response(200, found.map(row => ({disabled_until: row.disabled_until}))));
}

const env = {SUPABASE_URL: 'https://health-store.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret'};
function store(now = () => Date.now(), fetchImpl = databaseFetch, logger = {warn() {}}) {
  return createProviderHealthStore({env, now, fetchImpl, timeoutMs: 250, logger});
}

function provider({healthStore, fetchImpl, account = 'account-secret', token = 'cloudflare-secret', logger = {warn() {}, info() {}}, sleepImpl = async () => {}} = {}) {
  return new AIProvider({
    primaryModel: CF_PRIMARY_MODEL,
    fallbackModel: GEMINI_FALLBACK_MODEL,
    cfAccountId: account,
    cfApiToken: token,
    geminiApiKey: 'gemini-secret',
    healthStore,
    fetchImpl,
    logger,
    maxAttempts: 2,
    retryDelayMs: 25,
    sleepImpl,
  });
}

function singleModelProvider({healthStore, fetchImpl, fallbackModel = CF_BACKUP_MODEL, logger = {warn() {}, info() {}}} = {}) {
  return new AIProvider({
    primaryModel: CF_PRIMARY_MODEL,
    cfAccountId:'account-secret',cfApiToken:'cloudflare-secret',
    fallbackModel,
    geminiApiKey: 'gemini-secret',
    healthStore,
    fetchImpl,
    logger,
    maxAttempts: 1,
  });
}

function mixedProviderFetch({cloudflare, calls = []} = {}) {
  return async url => {
    const target = String(url);
    if (target.includes('cloudflare.com')) {
      calls.push('cloudflare');
      return typeof cloudflare === 'function' ? cloudflare()
        : cloudflare || response(200, {choices: [{finish_reason: 'stop', message: {content: 'Cloudflare answer'}}]});
    }
    calls.push('google');
    return response(200, {candidates: [{content: {parts: [{text: 'Gemini answer'}]}, finishReason: 'STOP'}]});
  };
}

function quotaExceededDaily() {
  return response(429, {errors: [{code: 3036, message: 'daily free allocation exceeded'}]});
}

test('quota health persists across provider instances and skips the Cloudflare leg without retrying', async () => {
  rows.length = 0;
  const logEntries = [];
  let sleepCalls = 0;
  const firstCalls = [];
  const first = provider({
    healthStore: store(),
    fetchImpl: mixedProviderFetch({cloudflare: quotaExceededDaily, calls: firstCalls}),
    logger: {warn: (...args) => logEntries.push(args), info: (...args) => logEntries.push(args)},
    sleepImpl: async () => { sleepCalls++; },
  });
  await assert.rejects(first.generate({messages:[{role:'user',content:'lookup'}]}),e=>e.code==='RATE_LIMITED');
  assert.deepEqual(firstCalls,['cloudflare']);
  assert.equal(rows.length, 2);

  const serialized = JSON.stringify(rows);
  for (const secret of ['cloudflare-secret', 'gemini-secret', 'account-secret', 'service-role-secret']) {
    assert.equal(serialized.includes(secret), false, `provider secret ${secret} must not be persisted`);
  }
  assert.match(rows[0].account_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(rows[0].credential_fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(rows[0].disabled_until) > Date.now());

  const secondCalls = [];
  const second = provider({
    healthStore: store(),
    fetchImpl: mixedProviderFetch({calls: secondCalls}),
    logger: {warn: (...args) => logEntries.push(args), info: (...args) => logEntries.push(args)},
    sleepImpl: async () => { sleepCalls++; },
  });
  await assert.rejects(second.generate({messages:[{role:'user',content:'next message'}]}),e=>e.code==='RATE_LIMITED');
  assert.deepEqual(secondCalls,[]);
  assert.equal(sleepCalls, 0, 'a persisted quota failure must not enter the retry delay');
  const skipLog = logEntries.find(([message, fields]) => message === 'AI provider leg skipped:' && fields?.reason === 'quota_exceeded');
  assert.ok(skipLog);
  assert.equal(typeof skipLog[1].durationMs, 'number');
  assert.equal(JSON.stringify(logEntries).includes('cloudflare-secret'), false);
  assert.equal(JSON.stringify(logEntries).includes('gemini-secret'), false);
});

test('a Cloudflare daily quota leg resumes after its UTC reset time', async () => {
  rows.length = 0;
  let now = Date.now();
  const healthStore = store(() => now);
  const daily = mixedProviderFetch({cloudflare: quotaExceededDaily});
  await assert.rejects(provider({healthStore,fetchImpl:daily}).generate({messages:[{role:'user',content:'before reset'}]}),e=>e.code==='RATE_LIMITED');
  const resetAt = Date.parse(rows[0].disabled_until);
  assert.ok(resetAt > now);

  now = resetAt + 1;
  const calls = [];
  const resumed = provider({healthStore, fetchImpl: mixedProviderFetch({calls})});
  const result = await resumed.generate({messages: [{role: 'user', content: 'after reset'}]});
  assert.equal(result.model, CF_PRIMARY_MODEL);
  assert.deepEqual(calls, ['cloudflare']);
});

test('a model-scoped Cloudflare quota persists to its reset without disabling the selected backup',async()=>{
 rows.length=0;const until=new Date();until.setUTCHours(24,0,0,0);const calls=[];
 const first=singleModelProvider({healthStore:store(),fetchImpl:async(url,init)=>{
  assert.equal(new URL(url).hostname,'api.cloudflare.com');const model=JSON.parse(init.body).model;calls.push(model);
  return model===CF_PRIMARY_MODEL?new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'model quota exhausted'}}),{status:429,headers:{'x-quota-reset-at':until.toISOString()}}):response(200,{choices:[{message:{content:'Backup answer'}}]});
 }});
 assert.equal((await first.generate({messages:[{role:'user',content:'before reset'}]})).model,CF_BACKUP_MODEL);
 assert.deepEqual(calls,[CF_PRIMARY_MODEL,CF_BACKUP_MODEL]);assert.equal(rows.length,1);assert.equal(Date.parse(rows[0].disabled_until),until.getTime());
 const secondCalls=[];const second=singleModelProvider({healthStore:store(),fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,'api.cloudflare.com');secondCalls.push(JSON.parse(init.body).model);return response(200,{choices:[{message:{content:'Backup answer'}}]});}});
 assert.equal((await second.generate({messages:[{role:'user',content:'next message'}]})).model,CF_BACKUP_MODEL);assert.deepEqual(secondCalls,[CF_BACKUP_MODEL]);
});

test('retry-after-ms is persisted in milliseconds rather than seconds', async () => {
  rows.length = 0;
  const startedAt = Date.now();
  const onlyGoogle = singleModelProvider({
    healthStore: store(),
    fallbackModel: null,
    fetchImpl: async () => new Response(JSON.stringify({error: {status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded'}}), {
      status: 429, headers: {'content-type': 'application/json', 'retry-after-ms': '500'},
    }),
  });
  await assert.rejects(onlyGoogle.generate({messages: [{role: 'user', content: 'limited'}]}), error => error.providerReason === 'quota_exceeded');
  const quotaRow = rows.find(row => row.provider === 'cloudflare');
  assert.ok(quotaRow);
  const delay = Date.parse(quotaRow.disabled_until) - startedAt;
  assert.ok(delay >= 450 && delay < 3000, `expected about 500ms, got ${delay}ms`);
});

test('Cloudflare minute retryDelay is interpreted as seconds when no daily quota is present', async () => {
  rows.length = 0;
  const startedAt = Date.now();
  const onlyGoogle = singleModelProvider({
    healthStore: store(),
    fallbackModel: null,
    fetchImpl: async () => response(429, {error: {
      status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded for this minute',
      details: [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s'}],
    }}),
  });
  await assert.rejects(onlyGoogle.generate({messages: [{role: 'user', content: 'limited'}]}), error => error.providerReason === 'quota_exceeded');
  const quotaRow = rows.find(row => row.provider === 'cloudflare');
  assert.ok(quotaRow);
  const delay = Date.parse(quotaRow.disabled_until) - startedAt;
  assert.ok(delay >= 29_000 && delay < 32_000, `expected about 30s, got ${delay}ms`);
});

test('provider health is isolated by Cloudflare account and credential fingerprints', async () => {
  rows.length = 0;
  const first = provider({healthStore: store(), fetchImpl: mixedProviderFetch({cloudflare: quotaExceededDaily})});
  await assert.rejects(first.generate({messages:[{role:'user',content:'quota'}]}),e=>e.code==='RATE_LIMITED');
  const before = rows.length;

  for (const identity of [{account: 'account-secret', token: 'rotated-cloudflare-secret'}, {account: 'another-account', token: 'cloudflare-secret'}]) {
    const calls = [];
    const isolated = provider({
      ...identity,
      healthStore: store(),
      fetchImpl: mixedProviderFetch({calls}),
    });
    const result = await isolated.generate({messages: [{role: 'user', content: 'isolated account'}]});
    assert.equal(result.model, CF_PRIMARY_MODEL);
    assert.deepEqual(calls, ['cloudflare']);
  }
  assert.equal(rows.length, before);
});

test('provider health storage failure is bounded and fails open', async () => {
  rows.length = 0;
  const failures = [];
  const healthStore = store(() => Date.now(), async () => { throw new Error('network offline'); }, {warn: (...args) => failures.push(args)});
  const calls = [];
  const providerWithoutHealth = provider({
    healthStore,
    fetchImpl: mixedProviderFetch({calls}),
  });
  const result = await providerWithoutHealth.generate({messages: [{role: 'user', content: 'still works'}]});
  assert.equal(result.model, CF_PRIMARY_MODEL);
  assert.deepEqual(calls, ['cloudflare']);
  assert.equal(failures.length, 1);
  assert.equal(JSON.stringify(failures).includes('service-role-secret'), false);
});

test('provider health skips storage HTTP when Supabase is not configured', async () => {
  let calls = 0;
  const healthStore = createProviderHealthStore({env: {}, fetchImpl: async () => { calls++; throw new Error('must not call'); }});
  const identity = providerHealthIdentity({provider: 'cloudflare', model: CF_PRIMARY_MODEL,
    accountId: 'account-secret', credential: 'cloudflare-secret'});
  assert.equal(await healthStore.getUnavailableUntil(identity), null);
  assert.equal(await healthStore.markUnavailable(identity, {disabledUntil: Date.now() + 60_000}), false);
  assert.equal(calls, 0);
});

test('all persistently exhausted legs retain quota exhaustion metadata', async () => {
  rows.length = 0;
  const googleQuota = () => response(429, {
    error: {status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded', details: [{retryDelay: '60s'}]},
  });
  const makeFetch = calls => async url => {
    if (String(url).includes('cloudflare.com')) {
      calls.push('cloudflare');
      return quotaExceededDaily();
    }
    calls.push('google');
    return googleQuota();
  };
  const firstCalls = [];
  const first = provider({healthStore: store(), fetchImpl: makeFetch(firstCalls)});
  await assert.rejects(first.generate({messages: [{role: 'user', content: 'every provider is out'}]}), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.quotaExhausted, true);
    assert.deepEqual(error.quotaProviders, ['cloudflare']);
    return true;
  });
  assert.deepEqual(firstCalls, ['cloudflare']);

  const secondCalls = [];
  const second = provider({healthStore: store(), fetchImpl: makeFetch(secondCalls)});
  await assert.rejects(second.generate({messages: [{role: 'user', content: 'still exhausted'}]}), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.quotaExhausted, true);
    assert.deepEqual(error.quotaProviders, ['cloudflare']);
    return true;
  });
  assert.deepEqual(secondCalls, [], 'all exhausted model legs should be skipped before provider requests');
});

test('durable quota skips retain quota metadata even while the Cloudflare circuit is open', async () => {
  rows.length = 0;
  const warmup = new AIProvider({
    primaryModel: CF_PRIMARY_MODEL,
    fallbackModel: GEMINI_FALLBACK_MODEL,
    cfAccountId: 'account-secret',
    cfApiToken: 'cloudflare-secret',
    geminiApiKey: 'gemini-secret',
    maxAttempts: 1,
    logger: {warn() {}, info() {}},
    fetchImpl: async url => String(url).includes('cloudflare.com')
      ? response(503, {error: {message: 'temporary provider outage'}})
      : response(200, {candidates: [{content: {parts: [{text: 'Gemini answer'}]}, finishReason: 'STOP'}]}),
  });
  await assert.rejects(warmup.generate({messages:[{role:'user',content:'first transient request'}]}),e=>e.code==='PROVIDER_UNAVAILABLE');
  await assert.rejects(warmup.generate({messages:[{role:'user',content:'open the circuit'}]}),e=>e.code==='PROVIDER_UNAVAILABLE');

  const healthStore = store();
  const until = Date.now() + 60_000;
  const deadIdentities = [
    providerHealthIdentity({provider: 'cloudflare', model: '*', accountId: 'account-secret', credential: 'cloudflare-secret'}),
    providerHealthIdentity({provider: 'google', model: GEMINI_FALLBACK_MODEL, credential: 'gemini-secret'}),
    providerHealthIdentity({provider: 'google', model: DEFAULT_EXTRACTION_MODEL, credential: 'gemini-secret'}),
  ];
  for (const identity of deadIdentities) {
    assert.equal(await healthStore.markUnavailable(identity, {disabledUntil: until, reason: 'quota_exceeded'}), true);
  }
  let providerFetches = 0;
  const exhausted = provider({
    healthStore: store(),
    fetchImpl: async () => { providerFetches++; throw new Error('quota-dead legs must be skipped'); },
  });
  await assert.rejects(exhausted.generate({messages: [{role: 'user', content: 'all quota-dead'}]}), error => {
    assert.equal(error.quotaExhausted, true);
    assert.deepEqual(error.quotaProviders.sort(), ['cloudflare']);
    return true;
  });
  assert.equal(providerFetches, 0);
});
