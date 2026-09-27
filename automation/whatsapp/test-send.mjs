import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {APIError, requestBody, uuid} from '../../ai/http.mjs';
import {authorizeAIWorkspace} from '../../ai/store.mjs';
import {createWhatsAppOutbound} from './cloud-outbound.mjs';
import {createWhatsAppInvoiceUpdateStore} from './invoice-update-store.mjs';

const TEST_RECIPIENT = '+919871367051';

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

/** Authenticated, operator-only neutral invoice-update test entry point. */
export function createWhatsAppInvoiceTestHandler({env = process.env, fetchImpl = fetch,
  authorize = authorizeAIWorkspace, loadSupabase = serviceClient,
  outboundFactory = createWhatsAppOutbound, logger = console} = {}) {
  return async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') throw new APIError(405, 'METHOD_NOT_ALLOWED');
      const body = requestBody(req, ['workspaceId', 'invoiceId']);
      const workspaceId = uuid(body.workspaceId);
      const invoiceId = uuid(body.invoiceId);
      const user = await authorize(req, workspaceId, {env, fetchImpl});
      if (user.role !== 'owner' || !env.WHATSAPP_TEST_OPERATOR_USER_ID
        || user.userId !== env.WHATSAPP_TEST_OPERATOR_USER_ID) {
        throw new APIError(403, 'TEST_OPERATOR_REQUIRED');
      }
      if (env.WHATSAPP_OUTBOUND_ENABLED !== 'true') throw new APIError(503, 'WHATSAPP_TEST_DISABLED');
      const supabase = loadSupabase(env, fetchImpl);
      const invoice = await currentRow(supabase, 'invoices',
        'id,workspace_id,customer_id,invoice_number,status,updated_at',
        [['workspace_id', workspaceId], ['id', invoiceId]]);
      if (!invoice || invoice.id !== invoiceId || invoice.workspace_id !== workspaceId) throw new APIError(404, 'INVOICE_NOT_FOUND');
      const customer = await currentRow(supabase, 'customers', 'id,workspace_id,phone',
        [['workspace_id', workspaceId], ['id', invoice.customer_id]]);
      if (!customer || customer.id !== invoice.customer_id || customer.workspace_id !== workspaceId
        || customer.phone !== TEST_RECIPIENT) throw new APIError(409, 'TEST_RECIPIENT_REQUIRED');
      const settings = await currentRow(supabase, 'workspace_settings', 'workspace_id,business_name', [['workspace_id', workspaceId]]);
      const workspace = settings?.business_name?.trim() ? null : await currentRow(supabase, 'workspaces', 'id,name', [['id', workspaceId]]);
      const businessName = settings?.business_name?.trim() || workspace?.name?.trim();
      if (!businessName) throw new APIError(409, 'BUSINESS_NAME_REQUIRED');
      const idempotencyKey = createHash('sha256').update(`whatsapp-invoice-update-v1\0${workspaceId}\0${invoiceId}\0${invoice.updated_at}`).digest('hex');
      const outbound = outboundFactory({env, fetchImpl, supabase, logger, ...createWhatsAppInvoiceUpdateStore({supabase})});
      const result = await outbound.sendInvoiceUpdateTemplate({workspaceId, to: TEST_RECIPIENT,
        invoiceId, customerId: customer.id, businessName, expectedUpdatedAt: invoice.updated_at, idempotencyKey});
      return res.status(result.status === 'accepted' ? 200 : result.status === 'unknown' ? 202
        : result.status === 'blocked' ? 409 : 502).json(result);
    } catch (error) {
      return res.status(error instanceof APIError ? error.status : 503)
        .json({error: error instanceof APIError ? error.code : 'WHATSAPP_UNAVAILABLE'});
    }
  };
}
