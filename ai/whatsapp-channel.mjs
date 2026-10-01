import {answerWorkspaceQuestion} from './assistant.mjs';
import {createHash} from 'node:crypto';
import {saveAssistantInvoice} from './invoice-ops.mjs';

const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRMATION = /^(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve|send it|create it|update it)[.!\s]*$/i;
const PROGRESS_LABEL = /^(?:thinking|looking up|searching|checking|reviewing|retrieving|processing|one moment)(?:\s*[.…!]+)?$/i;
const EMPTY_REPLY = 'I couldn’t prepare a reply just now. Please try again.';
const WHATSAPP_REPLY_GUIDANCE = 'WhatsApp reply guidance: Lead with the answer in one line, then give details as short, scannable bullets. Use a friendly, crisp, energetic tone—never boring or robotic. A few relevant emojis such as 💰, 🧾, and ✅ are good, but do not overdo them. For invoice, payment, or balance answers, format a mini dashboard: a bold summary line with count and total, then one bullet per item with identifier, customer, amount, status, and due date when known. Use no slug prefixes, internal tool names, or technical jargon. Keep replies under about 120 words unless the user asks for detail. For unknowns, say plainly what could not be checked and suggest a retry or narrower question. Include only requested facts and necessary caveats; preserve exact values, currencies, dates, and uncertainty from supplied records. Do not dump records, add broad context, or include transient progress/status text such as “Thinking…” or “Looking up…”. Return only the final user-facing answer.';
const TABLE_FIELDS = {
  invoices: new Set(['id','workspace_id','customer_id','invoice_number','issue_date','due_date','currency','total_amount','amount_paid','status','notes','metadata','created_at','updated_at']),
  customers: new Set(['id','workspace_id','name','company_name','email','phone','created_at','updated_at']),
  payments: new Set(['id','workspace_id','invoice_id','amount','paid_at','method','reference','created_at','updated_at']),
  invoice_files: new Set(['id','workspace_id','invoice_id','file_name','mime_type','size_bytes','created_at','updated_at']),
};

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function withWhatsAppReplyGuidance(provider) {
  if (!provider || typeof provider.generate !== 'function') return provider;
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== 'generate' || typeof value !== 'function') return value;
      return (request, ...args) => {
        if (!Array.isArray(request?.messages) || request.tools || request.toolChoice !== undefined) {
          return Reflect.apply(value, target, [request, ...args]);
        }
        const systemIndex = request.messages.findIndex(message => message?.role === 'system' && typeof message.content === 'string');
        if (systemIndex < 0) return Reflect.apply(value, target, [request, ...args]);
        const messages = [...request.messages];
        messages[systemIndex] = {
          ...messages[systemIndex],
          content: `${messages[systemIndex].content}\n\n${WHATSAPP_REPLY_GUIDANCE}`,
        };
        return Reflect.apply(value, target, [{...request, messages}, ...args]);
      };
    },
  });
}

function formatWhatsAppReply(response) {
  if (typeof response?.answer !== 'string') return response;
  const lines = response.answer.split(/\r?\n/);
  while (lines.length && (!lines[0].trim() || PROGRESS_LABEL.test(lines[0].trim()))) lines.shift();
  const answer = lines.join('\n').trim();
  return {...response, answer: answer || EMPTY_REPLY};
}

function checkedSelect(table, select) {
  if (typeof select !== 'string' || !select.trim()) throw new TypeError('select is required');
  const fields = select.split(',').map(item => item.trim());
  if (fields.some(field => !TABLE_FIELDS[table].has(field))) throw new TypeError('unsupported selected field');
  if (!fields.includes('workspace_id')) fields.push('workspace_id');
  if (table === 'invoices' && !fields.includes('customer_id')) fields.push('customer_id');
  if ((table === 'payments' || table === 'invoice_files') && !fields.includes('invoice_id')) fields.push('invoice_id');
  return fields.join(',');
}

function applyFilters(query, table, filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new TypeError('invalid filters');
  for (const [field, expression] of Object.entries(filters)) {
    if (!TABLE_FIELDS[table].has(field) || field === 'workspace_id' || typeof expression !== 'string') throw new TypeError('unsupported filter');
    if (expression.startsWith('eq.')) query = query.eq(field, expression.slice(3));
    else if (expression.startsWith('ilike.') && ['invoice_number','name','company_name'].includes(field)) query = query.ilike(field, expression.slice(6));
    else if (expression.startsWith('in.(') && expression.endsWith(')')) {
      const values = expression.slice(4, -1).split(',');
      if (!values.length || values.length > 100 || values.some(value => !UUID.test(value))) throw new TypeError('unsupported in filter');
      query = query.in(field, values);
    } else throw new TypeError('unsupported filter');
  }
  return query;
}

function applyOrder(query, table, order) {
  if (typeof order !== 'string') throw new TypeError('invalid order');
  for (const item of order.split(',')) {
    const [field, direction] = item.trim().split('.');
    if (!TABLE_FIELDS[table].has(field) || !['asc','desc'].includes(direction)) throw new TypeError('unsupported order');
    query = query.order(field, {ascending: direction === 'asc'});
  }
  return query;
}

function checkedRows(result, table, workspaceId, customerId, invoiceIds) {
  if (result?.error) throw result.error;
  if (!Array.isArray(result?.data)) throw new TypeError('scoped query returned invalid rows');
  for (const row of result.data) {
    if (row.workspace_id !== workspaceId) throw new TypeError('workspace scope violation');
    if (table === 'customers' && row.id !== customerId) throw new TypeError('customer scope violation');
    if (table === 'invoices' && row.customer_id !== customerId) throw new TypeError('invoice scope violation');
    if ((table === 'payments' || table === 'invoice_files') && !invoiceIds.has(row.invoice_id)) throw new TypeError('related row scope violation');
  }
  return result.data;
}

/**
 * Supabase service-role adapter for WhatsApp customers. Every query is
 * constrained independently of assistant tool arguments; payments and files
 * are limited to the customer's currently owned invoice IDs.
 */
export function createCustomerScopedStore({supabase, workspaceId, customerId} = {}) {
  if (!supabase?.from || !UUID.test(workspaceId) || !UUID.test(customerId)) throw new TypeError('verified Supabase scope is required');
  return Object.freeze({
    workspaceId,
    customerId,
    async query(table, {select, filters = {}, order = 'id.asc', limit = 100, offset = 0} = {}) {
      if (!Object.hasOwn(TABLE_FIELDS, table)) throw new TypeError('unsupported table');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new TypeError('invalid pagination');
      const projection = checkedSelect(table, select);
      let invoiceIds = new Set();
      if (table === 'payments' || table === 'invoice_files') {
        const owned = await supabase.from('invoices').select('id,workspace_id,customer_id', {count: 'exact'})
          .eq('workspace_id', workspaceId).eq('customer_id', customerId).limit(1001);
        if (owned?.error) throw owned.error;
        // Supabase projects can cap rows below a requested limit. Fail closed
        // if the exact count does not match the returned set.
        if (!Array.isArray(owned?.data) || !Number.isSafeInteger(owned.count)
          || owned.count !== owned.data.length || owned.count > 1000
          || owned.data.some(row => row.workspace_id !== workspaceId || row.customer_id !== customerId || !UUID.test(row.id))) {
          throw new TypeError('cannot verify invoice ownership');
        }
        invoiceIds = new Set(owned.data.map(row => row.id));
        if (!invoiceIds.size) return [];
      }
      let query = supabase.from(table).select(projection).eq('workspace_id', workspaceId);
      if (table === 'invoices') query = query.eq('customer_id', customerId);
      if (table === 'customers') query = query.eq('id', customerId);
      if (table === 'payments' || table === 'invoice_files') query = query.in('invoice_id', [...invoiceIds]);
      query = applyFilters(query, table, filters);
      query = applyOrder(query, table, order).range(offset, offset + limit - 1);
      return checkedRows(await query, table, workspaceId, customerId, invoiceIds);
    },
  });
}

/**
 * Only a trusted server can construct this channel. `authorizeChannel` must
 * recheck the active phone/customer binding, and `createCustomerScopedStore`
 * must permit reads for that customer alone. A raw workspace store is never
 * accepted from the WhatsApp request.
 */
export function createWhatsAppAssistantChannel({
  authorizeChannel,
  createCustomerScopedStore: scopedStoreFactory,
  supabase,
  provider,
  answer = answerWorkspaceQuestion,
  storePendingAction,
  loadPendingActionState,
  loadPendingAction,
  consumePendingAction,
  loadInvoiceReview,
  transitionInvoiceReview,
  createInvoiceStore,
  saveInvoice = saveAssistantInvoice,
  clock = () => new Date(),
} = {}) {
  const makeStore = scopedStoreFactory || (scope => createCustomerScopedStore({supabase, ...scope}));
  if (typeof authorizeChannel !== 'function' || (typeof scopedStoreFactory !== 'function' && !supabase?.from)) {
    throw new TypeError('WhatsApp channel requires authorization and a customer-scoped store factory');
  }
  if (typeof answer !== 'function') throw new TypeError('answer must be a function');
  const replyProvider = withWhatsAppReplyGuidance(provider);

  async function ask({workspaceId, customerId, phone, message, history = []} = {}) {
    const scope = {workspaceId: required(workspaceId, 'workspaceId'), customerId: required(customerId, 'customerId'), phone: required(phone, 'phone')};
    if (!E164.test(scope.phone)) throw new TypeError('phone must be E.164');
    const text = required(message, 'message');
    if (text.length > 4000) throw new RangeError('message is too long');
    const authorized = await authorizeChannel(scope);
    if (authorized?.allowed !== true || authorized.workspaceId !== scope.workspaceId
      || authorized.customerId !== scope.customerId || authorized.phone !== scope.phone) {
      return {answer: 'Please verify your number in cetld before discussing account details.', pendingAction: null, denied: true};
    }
    if (CONFIRMATION.test(text) && typeof loadInvoiceReview === 'function'
      && typeof transitionInvoiceReview === 'function') {
      const review = await loadInvoiceReview(scope);
      if (review?.action?.type === 'invoice_review_draft') {
        if (review.action.stage === 'incomplete' || review.action.stage === 'extracting') {
          return {answer: 'I can’t confirm an incomplete invoice review. Please provide the requested details or send a clearer photo.', pendingAction: null};
        }
        if (review.action.stage === 'saved') {
          return {answer: `✅ *Invoice already saved*\n• ${review.action.invoice.invoiceNumber} — ${review.action.invoice.clientName}\n• ${review.action.invoice.currency} ${review.action.invoice.total.toLocaleString('en-IN')}`,
            pendingAction: null, saved: true, idempotent: true};
        }
        if (review.action.stage === 'saving') {
          return {answer: 'That exact invoice proposal is already being saved. Please wait a moment.', pendingAction: null};
        }
        if (review.action.stage !== 'proposal') {
          return {answer: 'There is no complete invoice proposal to confirm. Please resend the photo.', pendingAction: null};
        }
        const claimed = await transitionInvoiceReview({...review, ...scope, fromStage: 'proposal',
          action: {...review.action, stage: 'saving'}});
        if (!claimed) {
          const latest = await loadInvoiceReview(scope);
          if (latest?.action?.stage === 'saved') return {answer: '✅ That invoice was already saved.', pendingAction: null, saved: true, idempotent: true};
          return {answer: 'That proposal was replaced or is already being saved. Nothing else was saved.', pendingAction: null};
        }
        const key = `wa_invoice_${createHash('sha256').update(`${scope.workspaceId}:${scope.customerId}:${scope.phone}:${review.id}`).digest('hex').slice(0, 32)}`;
        try {
          const saved = await saveInvoice({store: await createInvoiceStore(scope), invoice: review.action.invoice,
            confirmed: true, idempotencyKey: key, accounting: null});
          if (saved?.needsInput) throw new TypeError('review proposal became incomplete');
          const invoice = {...saved.invoice, clientName: saved.invoice?.clientName || review.action.invoice.clientName};
          await transitionInvoiceReview({...claimed, ...scope, fromStage: 'saving',
            action: {...review.action, stage: 'saved'}});
          return {answer: `✅ *Invoice saved*\n• ${invoice.invoiceNumber} — ${invoice.clientName || 'Customer'}\n• ${invoice.currency} ${invoice.total.toLocaleString('en-IN')}\n• Due: ${invoice.dueDate || 'not set'}`,
            pendingAction: null, saved: true, idempotent: saved.idempotent === true};
        } catch (error) {
          await transitionInvoiceReview({...claimed, ...scope, fromStage: 'saving', action: review.action});
          throw error;
        }
      }
    }
    if (CONFIRMATION.test(text) && typeof loadPendingAction === 'function') {
      const pending = await loadPendingAction(scope);
      if (pending) {
        const age = clock().getTime() - new Date(pending.created_at).getTime();
        if (!Number.isFinite(age) || age < 0 || age > 60 * 60 * 1000) {
          if (typeof consumePendingAction === 'function') await consumePendingAction({...scope, id: pending.id});
          return {answer: 'That invoice proposal expired. Please resend the photo and I’ll read it again.', pendingAction: null, expired: true};
        }
        if (pending.action?.type !== 'create_invoice' || typeof createInvoiceStore !== 'function') {
          return {answer: 'I can only confirm a proposed invoice from this chat.', pendingAction: null};
        }
        if (typeof consumePendingAction === 'function') {
          const claimed = await consumePendingAction({...scope, id: pending.id});
          if (!claimed) return {answer: 'That proposal was replaced by a newer request. Nothing was saved.', pendingAction: null, stale: true};
        }
        const key = `wa_invoice_${createHash('sha256').update(`${scope.workspaceId}:${scope.customerId}:${scope.phone}:${pending.id}`).digest('hex').slice(0, 32)}`;
        const saved = await saveInvoice({store: await createInvoiceStore(scope), invoice: pending.action.payload?.invoice,
          confirmed: true, idempotencyKey: key, accounting: null});
        if (saved?.needsInput) return {answer: saved.question, pendingAction: null};
        const invoice = {...saved.invoice, clientName: saved.invoice?.clientName || pending.action.payload?.invoice?.clientName};
        return {answer: `✅ *Invoice saved*\n• ${invoice.invoiceNumber} — ${invoice.clientName || 'Customer'}\n• ${invoice.currency} ${invoice.total.toLocaleString('en-IN')}\n• Due: ${invoice.dueDate || 'not set'}`,
          pendingAction: null, saved: true};
      }
    }
    // Snapshot before planner work. Persistence later compares this exact
    // durable scope generation under the same database lock used by photos.
    const expectedState = typeof loadPendingActionState === 'function'
      ? await loadPendingActionState(scope) : null;
    const scopedStore = await makeStore(scope);
    if (!scopedStore || typeof scopedStore.query !== 'function') throw new TypeError('customer-scoped store is unavailable');
    // A workspace-wide accounting connector would bypass the customer store.
    // Customer-channel reads use the scoped store only. Writes require a
    // separately stored proposal and a fresh confirmation from this scope.
    const response = await answer({provider: replyProvider, store: scopedStore, message: text, history, accounting: null, clock});
    if (!response?.pendingAction) return {...formatWhatsAppReply(response), pendingAction: null};
    if (typeof storePendingAction !== 'function') return {
      answer: 'Please open cetld while signed in to prepare and confirm this change.',
      pendingAction: null,
      requiresInAppConfirmation: true,
    };
    const stored = await storePendingAction({workspaceId: scope.workspaceId, customerId: scope.customerId,
      phone: scope.phone, action: response.pendingAction, source: 'whatsapp', expectedState});
    if (!stored) return {
      answer: 'That request became stale because a newer invoice review or request arrived. Nothing was replaced; please review the newer request.',
      pendingAction: null,
      stale: true,
    };
    return {
      answer: `${response.answer}\n\nSave it? Reply yes to confirm.`,
      pendingAction: null,
      requiresInChatConfirmation: true,
      asOf: response.asOf,
      timezone: response.timezone,
    };
  }

  function confirmFromWhatsApp() {
    return {executed: false, requiresInAppConfirmation: true, answer: 'Open cetld while signed in to review and confirm this action.'};
  }

  return Object.freeze({ask, confirmFromWhatsApp});
}
