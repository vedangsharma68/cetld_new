import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppInvoiceTestHandler} from '../automation/whatsapp/test-send.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const customerId = '44444444-4444-4444-8444-444444444444';
const dad = '+919818685252', vedang = '+919871367051';

function response() { return {code: null, body: null, setHeader() {}, status(code) {this.code = code; return this;}, json(body) {this.body = body; return this;}}; }
function database(phone = dad, overrides = {}) {
  const rows = {invoices: {id: invoiceId, workspace_id: workspaceId, customer_id: customerId, invoice_number: 'INV-2026-0002', status: 'sent', updated_at: '2026-09-30T10:00:00Z'},
    customers: {id: customerId, workspace_id: workspaceId, phone},
    workspace_settings: {workspace_id: workspaceId, business_name: 'QA Workspace', whatsapp_owner_attested_at: '2026-09-29T10:00:00Z'},
    whatsapp_consents: {workspace_id: workspaceId, customer_id: customerId, phone, categories: ['invoice_updates'], source: 'verbal', revoked_at: null}, ...overrides};
  let claimed = false;
  return {rows, from(table) {const filters = {}; return {select() {return this;}, eq(field, value) {filters[field] = value; return this;}, is() {return this;}, limit() {return this;},
    async maybeSingle() {const row = rows[table] || null; return {data: row && !Object.entries(filters).some(([k,v]) => row[k] !== v) ? row : null, error: null};}};},
  async rpc() {if (claimed) return {data: false, error: null}; claimed = true; return {data: true, error: null};}};
}
function makeHandler({phone = dad, rows, role = 'owner', operator = userId, outboundFactory, fetchImpl, logger} = {}) {
  const supabase = database(phone, rows);
  const env = {WHATSAPP_TEST_OPERATOR_USER_ID: operator, WHATSAPP_OUTBOUND_ENABLED: 'true', WHATSAPP_TEST_ALLOWLIST: `${vedang},${dad}`,
    WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_GRAPH_API_VERSION: 'v24.0'};
  return {supabase, handler: createWhatsAppInvoiceTestHandler({env, authorize: async () => ({workspaceId, userId, role}), loadSupabase: () => supabase, outboundFactory, fetchImpl, logger})};
}
async function preview(handler) {const res = response(); await handler({method: 'GET', query: {workspaceId, invoiceId}}, res); return res;}
async function send(handler, token) {const res = response(); await handler({method: 'POST', body: {workspaceId, invoiceId}, headers: {'x-whatsapp-test-preview': token}}, res); return res;}

test('only the exact owner/operator can review or send', async () => {
  for (const options of [{role: 'member'}, {operator: '99999999-9999-4999-8999-999999999999'}, {operator: ''}]) {
    const {handler} = makeHandler(options); assert.equal((await preview(handler)).code, 403);
  }
});

test('review derives dad recipient and fixed display values without sending or claiming', async () => {
  let sends = 0; const {handler, supabase} = makeHandler({outboundFactory: () => ({sendInvoiceUpdateTemplate() {sends++;}})});
  let claims = 0; const rpc = supabase.rpc; supabase.rpc = (...args) => {claims++; return rpc(...args);};
  const res = await preview(handler);
  assert.equal(res.code, 200); assert.equal(res.body.recipient, dad); assert.equal(res.body.sendingBot, '+917303338959');
  assert.equal(res.body.text, 'Hi, this is QA Workspace. Here is an update for invoice INV-2026-0002.');
  assert.deepEqual(res.body.estimatedBaseCost, {currency: 'INR', amount: '0.1150', beforeTax: true, asOf: '2026-09-30'});
  assert.equal(sends, 0); assert.equal(claims, 0); assert.ok(res.body.previewToken);
});

test('dad and Vedang are supported, but unrelated numbers stay blocked even when configured', async () => {
  assert.equal((await preview(makeHandler({phone: dad}).handler)).code, 200);
  assert.equal((await preview(makeHandler({phone: vedang}).handler)).code, 200);
  const unrelated = makeHandler({phone: '+919999999999'}); unrelated.handler = createWhatsAppInvoiceTestHandler({
    env: {WHATSAPP_TEST_OPERATOR_USER_ID: userId, WHATSAPP_OUTBOUND_ENABLED: 'true', WHATSAPP_TEST_ALLOWLIST: '+919999999999', WHATSAPP_ACCESS_TOKEN: 'x'},
    authorize: async () => ({workspaceId, userId, role: 'owner'}), loadSupabase: () => unrelated.supabase});
  assert.equal((await preview(unrelated.handler)).code, 409);
});

test('missing consent or owner attestation prevents review and send', async () => {
  assert.equal((await preview(makeHandler({rows: {whatsapp_consents: null}}).handler)).code, 409);
  assert.equal((await preview(makeHandler({rows: {workspace_settings: {workspace_id: workspaceId, business_name: 'QA Workspace', whatsapp_owner_attested_at: null}}}).handler)).code, 409);
});

test('send uses reviewed current rows once and rejects a stale revision', async () => {
  const sent = []; const setup = makeHandler({outboundFactory: () => ({async sendInvoiceUpdateTemplate(input) {sent.push(input); return {status: 'accepted', providerMessageId: 'wamid.test'};}})});
  const review = await preview(setup.handler); const accepted = await send(setup.handler, review.body.previewToken);
  assert.equal(accepted.code, 200); assert.equal(sent.length, 1); assert.equal(sent[0].to, dad);
  setup.supabase.rows.invoices.updated_at = '2026-09-30T10:01:00Z';
  const stale = await send(setup.handler, review.body.previewToken); assert.equal(stale.code, 409); assert.equal(stale.body.error, 'TEST_REVIEW_STALE'); assert.equal(sent.length, 1);
});

test('real outbound claims one revision once and an unknown result is not retried', async () => {
  const graph = []; const setup = makeHandler({fetchImpl: async (url, options) => {graph.push({url, body: JSON.parse(options.body)}); throw Error('uncertain network');}, logger: {error() {}, warn() {}}});
  const review = await preview(setup.handler), first = await send(setup.handler, review.body.previewToken), second = await send(setup.handler, review.body.previewToken);
  assert.equal(first.code, 202); assert.equal(first.body.status, 'unknown'); assert.equal(second.code, 409); assert.equal(graph.length, 1);
  assert.equal(graph[0].body.to, dad.slice(1)); assert.equal(graph[0].body.template.name, 'cetld_invoice_update_test');
});
