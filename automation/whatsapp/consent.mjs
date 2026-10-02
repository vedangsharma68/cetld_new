/** Workspace-scoped WhatsApp consent checks. Inject a service-role Supabase client. */

const E164 = /^\+[1-9][0-9]{7,14}$/;
const RECIPIENT_OPT_IN_SOURCES = new Set(['verbal', 'inbound_message']);

export function normalizeWhatsAppPhone(phone) {
  const value = String(phone ?? '').trim();
  if (!E164.test(value)) throw new Error('A phone in E.164 format is required');
  return value;
}

/** Record an owner's answer from the verified inbound assistant using the service-only RPC. */
export async function recordInvoiceUpdateConsent({supabase, workspaceId, customerId, phone}) {
  requireClient(supabase);
  const data = unwrap(await supabase.rpc('whatsapp_record_verbal_consent_service', {
    p_workspace_id: requireWorkspace(workspaceId), p_customer_id: customerId,
    p_phone: normalizeWhatsAppPhone(phone), p_consent_text_version: 'invoice_updates_v1',
  }));
  return Array.isArray(data) ? data[0] : data;
}

function requireClient(supabase) {
  if (!supabase?.from || !supabase?.rpc) throw new Error('Supabase client is required');
  return supabase;
}

function requireWorkspace(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required');
  return String(workspaceId);
}

function unwrap(result) {
  if (result?.error) throw result.error;
  return result?.data;
}

/**
 * Resolve inbound sender only through active consent and a customer whose
 * current phone still matches. Suppression wins even if consent is active.
 */
export async function resolveActiveBindings({ supabase, phone }) {
  requireClient(supabase);
  const normalized = normalizeWhatsAppPhone(phone);
  const globalSuppression = unwrap(await supabase.from('whatsapp_global_suppressions')
    .select('suppressed_at').eq('phone', normalized).maybeSingle());
  if (globalSuppression) return [];
  const consents = unwrap(await supabase.from('whatsapp_consents').select('*')
    .eq('phone', normalized).is('revoked_at', null)) || [];
  if (!Array.isArray(consents) || !consents.length) return [];
  const suppressions = unwrap(await supabase.from('whatsapp_suppressions')
    .select('workspace_id').eq('phone', normalized)) || [];
  const suppressedWorkspaces = new Set(suppressions.map(row => row.workspace_id));
  const candidates = consents.filter(row => RECIPIENT_OPT_IN_SOURCES.has(row.source)
    && Array.isArray(row.categories) && row.categories.includes('invoice_updates')
    && !suppressedWorkspaces.has(row.workspace_id));
  const bound = await Promise.all(candidates.map(async consent => {
    const settings = unwrap(await supabase.from('workspace_settings').select('whatsapp_owner_attested_at')
      .eq('workspace_id', consent.workspace_id).maybeSingle());
    if (!settings?.whatsapp_owner_attested_at) return null;
    const customer = unwrap(await supabase.from('customers').select('*')
      .eq('workspace_id', consent.workspace_id).eq('id', consent.customer_id)
      .eq('phone', normalized).maybeSingle());
    return customer ? { workspaceId: consent.workspace_id, customerId: customer.id, customer, consent } : null;
  }));
  return bound.filter(Boolean);
}

/** Fresh database read required immediately before every send. */
export async function getSendEligibility({ supabase, workspaceId, phone, category = 'invoice_updates' }) {
  requireClient(supabase);
  const workspace = requireWorkspace(workspaceId);
  const normalized = normalizeWhatsAppPhone(phone);
  const globalSuppression = unwrap(await supabase.from('whatsapp_global_suppressions')
    .select('suppressed_at').eq('phone', normalized).maybeSingle());
  if (globalSuppression) return { allowed: false, reason: 'globally_suppressed', consent: null, customer: null };
  const suppression = unwrap(await supabase.from('whatsapp_suppressions').select('suppressed_at')
    .eq('workspace_id', workspace).eq('phone', normalized).maybeSingle());
  if (suppression) return { allowed: false, reason: 'suppressed', consent: null, customer: null };
  const consent = unwrap(await supabase.from('whatsapp_consents').select('*')
    .eq('workspace_id', workspace).eq('phone', normalized).maybeSingle());
  if (!consent) return { allowed: false, reason: 'missing_consent', consent: null, customer: null };
  if (consent.revoked_at) return { allowed: false, reason: 'revoked', consent, customer: null };
  if (!RECIPIENT_OPT_IN_SOURCES.has(consent.source)) return { allowed: false, reason: 'missing_recipient_opt_in', consent, customer: null };
  if (!Array.isArray(consent.categories) || !consent.categories.includes(category)) {
    return { allowed: false, reason: 'category_not_consented', consent, customer: null };
  }
  const settings = unwrap(await supabase.from('workspace_settings').select('whatsapp_owner_attested_at')
    .eq('workspace_id', workspace).maybeSingle());
  if (!settings?.whatsapp_owner_attested_at) {
    return { allowed: false, reason: 'owner_attestation_missing', consent, customer: null };
  }
  const customer = unwrap(await supabase.from('customers').select('*')
    .eq('workspace_id', workspace).eq('id', consent.customer_id)
    .eq('phone', normalized).maybeSingle());
  if (!customer) return { allowed: false, reason: 'unbound', consent, customer: null };
  return { allowed: true, reason: 'active_consent', consent, customer };
}

/** Atomic, idempotent STOP/refusal; confirmationDue is true only on first claim. */
export async function revokeConsentForPhone({ supabase, workspaceId, phone, via, messageId = null }) {
  requireClient(supabase);
  const workspace = requireWorkspace(workspaceId);
  const normalized = normalizeWhatsAppPhone(phone);
  if (!['stop', 'refusal', 'manual'].includes(via)) throw new Error('Invalid revocation reason');
  const data = unwrap(await supabase.rpc('whatsapp_revoke_phone', {
    p_workspace_id: workspace, p_phone: normalized, p_via: via, p_message_id: messageId,
  }));
  const row = Array.isArray(data) ? data[0] : data;
  return { revoked: !!row?.revoked, confirmationDue: !!row?.confirmation_due };
}

/** A STOP with no known consent gets one global, durable suppression claim. */
export async function suppressUnknownPhone({ supabase, phone, messageId = null }) {
  requireClient(supabase);
  const normalized = normalizeWhatsAppPhone(phone);
  const data = unwrap(await supabase.rpc('whatsapp_suppress_unknown_phone', {
    p_phone: normalized, p_message_id: messageId,
  }));
  return { confirmationDue: !!data };
}
