import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {APIError, requestBody, uuid} from '../../ai/http.mjs';
import {authorizeAIWorkspace} from '../../ai/store.mjs';
import {createWhatsAppOutbound} from './cloud-outbound.mjs';
import {getSendEligibility} from './consent.mjs';
import {createWhatsAppInvoiceUpdateStore} from './invoice-update-store.mjs';

const APPROVED_QA_RECIPIENTS = new Set(['+919871367051', '+919818685252']);
const TEMPLATE_NAME = 'cetld_invoice_update_test';
const SENDING_BOT = '+917303338959';
const TEMPLATE_COST_INR = '0.1150';

function serviceClient(env, fetchImpl) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new APIError(503, 'SUPABASE_NOT_CONFIGURED');
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false}, global: {fetch: fetchImpl},
  });
}

async function currentRow(supabase, table, fields, pairs) {
  let query = supabase.from(table).select(fields);
  for (const [field, value] of pairs) query = query.eq(field, value);
  const result = await query.maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

function allowedRecipient(env, phone) {
  const configured = typeof env.WHATSAPP_TEST_ALLOWLIST === 'string'
    ? new Set(env.WHATSAPP_TEST_ALLOWLIST.split(',').map(value => value.trim()).filter(Boolean)) : new Set();
  return APPROVED_QA_RECIPIENTS.has(phone) && configured.has(phone);
}

function templateText(businessName, invoiceNumber) {
  return `Hi, this is ${businessName}. Here is an update for invoice ${invoiceNumber}.`;
}

function tokenSecret(env) {
  if (!env.WHATSAPP_ACCESS_TOKEN) throw new APIError(503, 'WHATSAPP_TEST_DISABLED');
  return env.WHATSAPP_ACCESS_TOKEN;
}

function previewToken(env, values) {
  const payload = Buffer.from(JSON.stringify(values)).toString('base64url');
  const signature = createHmac('sha256', tokenSecret(env)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyPreviewToken(env, token, expected) {
  if (typeof token !== 'string' || token.length > 2048) throw new APIError(409, 'TEST_REVIEW_REQUIRED');
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) throw new APIError(409, 'TEST_REVIEW_REQUIRED');
  const actual = createHmac('sha256', tokenSecret(env)).update(payload).digest();
  let signature;
  try { signature = Buffer.from(supplied, 'base64url'); } catch { throw new APIError(409, 'TEST_REVIEW_REQUIRED'); }
  if (signature.length !== actual.length || !timingSafeEqual(signature, actual)) throw new APIError(409, 'TEST_REVIEW_REQUIRED');
  let reviewed;
  try { reviewed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new APIError(409, 'TEST_REVIEW_REQUIRED'); }
  if (JSON.stringify(reviewed) !== JSON.stringify(expected)) throw new APIError(409, 'TEST_REVIEW_STALE');
}

async function loadReview(supabase, env, workspaceId, invoiceId) {
  const invoice = await currentRow(supabase, 'invoices',
    'id,workspace_id,customer_id,invoice_number,status,updated_at',
    [['workspace_id', workspaceId], ['id', invoiceId]]);
  if (!invoice || invoice.id !== invoiceId || invoice.workspace_id !== workspaceId) throw new APIError(404, 'INVOICE_NOT_FOUND');
  const customer = await currentRow(supabase, 'customers', 'id,workspace_id,phone',
    [['workspace_id', workspaceId], ['id', invoice.customer_id]]);
  if (!customer || customer.id !== invoice.customer_id || customer.workspace_id !== workspaceId
    || !allowedRecipient(env, customer.phone)) throw new APIError(409, 'TEST_RECIPIENT_REQUIRED');
  const settings = await currentRow(supabase, 'workspace_settings', 'workspace_id,business_name', [['workspace_id', workspaceId]]);
  const workspace = settings?.business_name?.trim() ? null : await currentRow(supabase, 'workspaces', 'id,name', [['id', workspaceId]]);
  const businessName = settings?.business_name?.trim() || workspace?.name?.trim();
  if (!businessName) throw new APIError(409, 'BUSINESS_NAME_REQUIRED');
  const eligibility = await getSendEligibility({supabase, workspaceId, phone: customer.phone, category: 'invoice_updates'});
  if (!eligibility.allowed || eligibility.customer?.id !== customer.id) throw new APIError(409, 'TEST_RECIPIENT_INELIGIBLE');
  return {invoice, customer, businessName};
}

function reviewedValues(workspaceId, {invoice, customer, businessName}) {
  return {workspaceId, invoiceId: invoice.id, customerId: customer.id, phone: customer.phone,
    businessName, invoiceNumber: invoice.invoice_number, updatedAt: invoice.updated_at};
}

/** Authenticated, owner/operator-only review and invoice-update test entry point. */
export function createWhatsAppInvoiceTestHandler({env = process.env, fetchImpl = fetch,
  authorize = authorizeAIWorkspace, loadSupabase = serviceClient,
  outboundFactory = createWhatsAppOutbound, logger = console} = {}) {
  return async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!['GET', 'POST'].includes(req.method)) throw new APIError(405, 'METHOD_NOT_ALLOWED');
      const input = req.method === 'POST' ? requestBody(req, ['workspaceId', 'invoiceId']) : req.query || {};
      if (Object.keys(input).some(key => !['workspaceId', 'invoiceId'].includes(key))) throw new APIError(400, 'INVALID_INPUT');
      const workspaceId = uuid(input.workspaceId);
      const invoiceId = uuid(input.invoiceId);
      const user = await authorize(req, workspaceId, {env, fetchImpl});
      if (user.role !== 'owner' || !env.WHATSAPP_TEST_OPERATOR_USER_ID
        || user.userId !== env.WHATSAPP_TEST_OPERATOR_USER_ID) throw new APIError(403, 'TEST_OPERATOR_REQUIRED');
      if (env.WHATSAPP_OUTBOUND_ENABLED !== 'true') throw new APIError(503, 'WHATSAPP_TEST_DISABLED');
      const supabase = loadSupabase(env, fetchImpl);
      const review = await loadReview(supabase, env, workspaceId, invoiceId);
      const values = reviewedValues(workspaceId, review);
      if (req.method === 'GET') return res.status(200).json({
        test: true, recipient: review.customer.phone, sendingBot: SENDING_BOT,
        templateName: TEMPLATE_NAME, text: templateText(review.businessName, review.invoice.invoice_number),
        estimatedBaseCost: {currency: 'INR', amount: TEMPLATE_COST_INR, beforeTax: true, asOf: '2026-09-30'},
        previewToken: previewToken(env, values),
      });
      verifyPreviewToken(env, req.headers?.['x-whatsapp-test-preview'], values);
      const idempotencyKey = createHash('sha256').update(`whatsapp-invoice-update-v1\0${workspaceId}\0${invoiceId}\0${review.invoice.updated_at}`).digest('hex');
      const outbound = outboundFactory({env, fetchImpl, supabase, logger, ...createWhatsAppInvoiceUpdateStore({supabase})});
      const result = await outbound.sendInvoiceUpdateTemplate({workspaceId, to: review.customer.phone,
        invoiceId, customerId: review.customer.id, businessName: review.businessName,
        expectedUpdatedAt: review.invoice.updated_at, idempotencyKey});
      return res.status(result.status === 'accepted' ? 200 : result.status === 'unknown' ? 202
        : result.status === 'blocked' ? 409 : 502).json(result);
    } catch (error) {
      return res.status(error instanceof APIError ? error.status : 503)
        .json({error: error instanceof APIError ? error.code : 'WHATSAPP_UNAVAILABLE'});
    }
  };
}
