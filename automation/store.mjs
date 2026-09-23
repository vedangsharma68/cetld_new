/**
 * Durable automation persistence.
 *
 * The worker must call authorizeDelivery immediately before the provider request.
 * A claim is only an intent; authorizeDelivery rechecks the current invoice row and
 * atomically moves the claim to `sending`. Payment/pause updates increment the
 * invoice automation_version, invalidating every older claim.
 */

const ACTIVE_STATES = new Set(["approved", "active", "scheduled"]);
const TERMINAL_STATES = new Set(["paused", "cancelled", "paid", "completed"]);

function requiredScope(input) {
  const ownerId = input?.ownerId ?? input?.owner_id;
  const workspaceId = input?.workspaceId ?? input?.workspace_id;
  if (!ownerId || !workspaceId) throw new Error("ownerId and workspaceId are required");
  return { ownerId: String(ownerId), workspaceId: String(workspaceId) };
}

function iso(value, fallback = new Date()) {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date.toISOString();
}

function idempotency(input) {
  const value = input?.idempotencyKey ?? input?.idempotency_key;
  if (!value) throw new Error("idempotencyKey is required");
  return String(value).slice(0, 250);
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeInvoice(input) {
  const scope = requiredScope(input);
  const amountMinor = Number(input.amountMinor ?? input.amount_minor ?? 0);
  const paidMinor = Number(input.paidMinor ?? input.paid_minor ?? 0);
  const settled = amountMinor > 0 && paidMinor >= amountMinor;
  const followupState = settled ? "cancelled" : String(input.followupState ?? input.followup_state ?? "approved");
  const nextFollowUpAt = settled ? null : input.nextFollowUpAt ?? input.next_follow_up_at ?? null;
  return {
    ...copy(input),
    id: String(input.id ?? input.invoiceId ?? input.invoice_id),
    ...scope,
    amountMinor,
    paidMinor,
    followupState,
    nextFollowUpAt,
    automationVersion: Number(input.automationVersion ?? input.automation_version ?? 0),
    owner_id: scope.ownerId, workspace_id: scope.workspaceId, amount_minor: amountMinor, paid_minor: paidMinor,
    followup_state: followupState,
    next_follow_up_at: nextFollowUpAt,
    automation_version: Number(input.automationVersion ?? input.automation_version ?? 0),
  };
}

function claimView(claim) {
  if (!claim) return null;
  return copy({ ...claim, claimId: claim.id, claim_id: claim.id, claimKey: claim.claimKey, claim_key: claim.claimKey, invoiceId: claim.invoiceId, invoice_id: claim.invoiceId, invoiceVersion: claim.invoiceVersion, invoice_version: claim.invoiceVersion, paidMinor: claim.paidMinor, paid_minor: claim.paidMinor, amount_minor: claim.amountMinor, scheduled_for: claim.scheduledFor, lease_until: claim.leaseUntil });
}

export class MemoryAutomationStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.invoices = new Map();
    this.claims = new Map();
    this.messages = new Map();
    this.events = new Map();
    this.replies = new Map();
  }

  seedInvoice(input) {
    const invoice = normalizeInvoice(input);
    if (!invoice.id || invoice.id === "undefined") throw new Error("invoice id is required");
    this.invoices.set(invoice.id, invoice);
    return copy(invoice);
  }

  getInvoice({ invoiceId, ...scope }) {
    const { ownerId, workspaceId } = requiredScope(scope);
    const invoice = this.invoices.get(String(invoiceId));
    return invoice && invoice.ownerId === ownerId && invoice.workspaceId === workspaceId ? copy(invoice) : null;
  }

  updateInvoice(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const id = String(input.invoiceId ?? input.invoice_id ?? input.id);
    const invoice = this.invoices.get(id);
    if (!invoice || invoice.ownerId !== ownerId || invoice.workspaceId !== workspaceId) return null;
    if (input.expectedVersion !== undefined && invoice.automationVersion !== input.expectedVersion) return null;
    const fields = { paidMinor: 'paid_minor', followupState: 'followup_state', nextFollowUpAt: 'next_follow_up_at', reminderCount: 'reminder_count', lastFollowUpAt: 'last_follow_up_at', customerPhone: 'customer_phone', followUpSettings: 'follow_up_settings' };
    let changed = false;
    for (const [camel, snake] of Object.entries(fields)) {
      if (!Object.hasOwn(input, camel) && !Object.hasOwn(input, snake)) continue;
      const value = Object.hasOwn(input, camel) ? input[camel] : input[snake];
      if (JSON.stringify(invoice[camel] ?? invoice[snake]) !== JSON.stringify(value)) changed = true;
      invoice[camel] = value; invoice[snake] = value;
    }
    if (changed) invoice.automationVersion += 1;
    invoice.automation_version = invoice.automationVersion;
    return copy(invoice);
  }

  markInvoicePaid(input) {
    const invoice = this.getInvoice(input);
    if (!invoice) return null;
    const current = this.invoices.get(invoice.id);
    return this.updateInvoice({ ...input, paidMinor: current.amountMinor, followupState: "cancelled", nextFollowUpAt: null });
  }

  pauseInvoice(input) {
    return this.updateInvoice({ ...input, followupState: "paused", nextFollowUpAt: null });
  }

  claimDueFollowups(input = {}) {
    const { ownerId, workspaceId } = requiredScope(input);
    const now = new Date(iso(input.now, this.now()));
    const limit = Math.max(1, Math.min(100, Number(input.limit ?? 25)));
    const result = [];
    const invoices = [...this.invoices.values()]
      .filter((invoice) => invoice.ownerId === ownerId && invoice.workspaceId === workspaceId)
      .filter((invoice) => !input.invoiceId || invoice.id === String(input.invoiceId))
      .filter((invoice) => invoice.nextFollowUpAt && new Date(invoice.nextFollowUpAt) <= now)
      .filter((invoice) => invoice.paidMinor < invoice.amountMinor && ACTIVE_STATES.has(invoice.followupState))
      .sort((a, b) => new Date(a.nextFollowUpAt) - new Date(b.nextFollowUpAt) || a.id.localeCompare(b.id));
    for (const invoice of invoices) {
      if (result.length >= limit) break;
      const key = `${workspaceId}:${invoice.id}:${iso(invoice.nextFollowUpAt)}`;
      const existing = this.claims.get(key);
      if (existing?.status === 'sending' && new Date(existing.leaseUntil) < now) existing.status = 'quarantined';
      if (existing?.status === 'claimed' && new Date(existing.leaseUntil) < now) existing.status = 'expired';
      if (existing && !["failed", "expired", "cancelled"].includes(existing.status)) continue;
      if (existing?.attempts >= 3) continue;
      const claim = existing ?? {
        id: crypto.randomUUID(), claimKey: key, ownerId, workspaceId, invoiceId: invoice.id,
        scheduledFor: iso(invoice.nextFollowUpAt), attempts: 0,
      };
      claim.status = "claimed";
      claim.invoiceVersion = invoice.automationVersion;
      claim.paidMinor = invoice.paidMinor;
      claim.amountMinor = invoice.amountMinor;
      claim.attempts += 1;
      claim.claimedAt = iso(now);
      claim.leaseUntil = iso(new Date(now.getTime() + Number(input.leaseMs ?? 120000)));
      claim.lastError = null;
      this.claims.set(key, claim);
      result.push(claimView(claim));
    }
    return result;
  }

  authorizeDelivery(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const claimId = String(input.claimId ?? input.claim_id);
    const claim = [...this.claims.values()].find((item) => item.id === claimId);
    if (!claim || claim.ownerId !== ownerId || claim.workspaceId !== workspaceId) return { authorized: false, reason: "not_found" };
    const invoice = this.invoices.get(claim.invoiceId);
    if (!invoice || invoice.ownerId !== ownerId || invoice.workspaceId !== workspaceId) return this.revoke(claim, "not_found");
    if (claim.status !== "claimed") return {authorized:false,reason:"not_claimed"};
    if (claim.invoiceVersion !== invoice.automationVersion) return this.revoke(claim, "stale_claim");
    if (invoice.paidMinor >= invoice.amountMinor) return this.revoke(claim, "paid");
    if (TERMINAL_STATES.has(invoice.followupState) || !ACTIVE_STATES.has(invoice.followupState)) return this.revoke(claim, "paused");
    if (new Date(claim.leaseUntil) <= this.now()) return this.revoke(claim, "expired");
    claim.status = "sending";
    claim.authorizedAt = iso(this.now());
    claim.deliveryToken = crypto.randomUUID();
    return { authorized: true, token: claim.deliveryToken, claim: claimView(claim), invoice: copy(invoice) };
  }

  revoke(claim, reason) {
    claim.status = "cancelled";
    claim.lastError = reason;
    return { authorized: false, reason };
  }

  markDeliverySent(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const claim = [...this.claims.values()].find((item) => item.id === String(input.claimId ?? input.claim_id));
    if (!claim || claim.ownerId !== ownerId || claim.workspaceId !== workspaceId) return { ok: false, reason: "not_found" };
    if (claim.status !== "sending" || claim.deliveryToken !== input.token) return { ok: false, reason: "not_authorized" };
    claim.status = "sent";
    claim.sentAt = iso(this.now());
    claim.providerMessageId = input.providerMessageId ?? input.provider_message_id ?? null;
    for (const message of this.messages.values()) if (message.payload?.claimId === claim.id) { message.status = 'sent'; message.providerMessageId = claim.providerMessageId; }
    return { ok: true, claim: claimView(claim) };
  }

  markDeliveryFailed(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const claim = [...this.claims.values()].find((item) => item.id === String(input.claimId ?? input.claim_id));
    if (!claim || claim.ownerId !== ownerId || claim.workspaceId !== workspaceId) return { ok: false, reason: "not_found" };
    if (!["sending", "claimed"].includes(claim.status) || (claim.status === "sending" && claim.deliveryToken !== input.token)) return { ok: false, reason: "not_retryable" };
    claim.status = input.unknown ? "quarantined" : "failed";
    claim.lastError = String(input.error ?? "delivery failed").slice(0, 1000);
    for (const message of this.messages.values()) if (message.payload?.claimId === claim.id) message.status = claim.status;
    return { ok: true, retryable: claim.status === "failed", claim: claimView(claim) };
  }

  recordMessage(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const key = `${workspaceId}:${idempotency(input)}`;
    const existing = this.messages.get(key);
    if (existing) return { inserted: false, message: copy(existing) };
    const message = { id: crypto.randomUUID(), ownerId, workspaceId, invoiceId: input.invoiceId ?? input.invoice_id ?? null,
      direction: input.direction ?? "inbound", kind: input.kind ?? "message", status: input.status ?? "received",
      idempotencyKey: idempotency(input), providerMessageId: input.providerMessageId ?? input.provider_message_id ?? null,
      payload: copy(input.payload ?? {}), createdAt: iso(input.createdAt ?? input.created_at, this.now()) };
    this.messages.set(key, message);
    return { inserted: true, message: copy(message) };
  }

  recordEvent(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const key = `${workspaceId}:${idempotency(input)}`;
    const existing = this.events.get(key);
    if (existing) return { inserted: false, event: copy(existing) };
    const event = { id: crypto.randomUUID(), ownerId, workspaceId, invoiceId: input.invoiceId ?? input.invoice_id ?? null,
      type: String(input.type), source: input.source ?? "automation", idempotencyKey: idempotency(input), metadata: copy(input.payload ?? input.metadata ?? {}), payload: copy(input.payload ?? input.metadata ?? {}), createdAt: iso(input.createdAt ?? input.created_at, this.now()) };
    this.events.set(key, event);
    return { inserted: true, event: copy(event) };
  }

  saveReply(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const key = `${workspaceId}:${idempotency(input)}`;
    const existing = this.replies.get(key);
    if (existing) return { inserted: false, reply: copy(existing) };
    const reply = { id: crypto.randomUUID(), ownerId, workspaceId, messageId: input.messageId ?? input.message_id ?? null,
      idempotencyKey: idempotency(input), status: input.status ?? "pending", body: input.body ?? input.payload ?? "",
      providerMessageId: input.providerMessageId ?? input.provider_message_id ?? null, createdAt: iso(input.createdAt ?? input.created_at, this.now()) };
    this.replies.set(key, reply);
    return { inserted: true, reply: copy(reply) };
  }

  recordDelivery(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const claimId = input.claimId ?? input.claim_id;
    const claim = claimId && [...this.claims.values()].find((item) => item.id === String(claimId));
    if (!claim || claim.ownerId !== ownerId || claim.workspaceId !== workspaceId) {
      const result = this.recordMessage({ ...input, direction: "delivery", kind: "delivery", status: "quarantined", idempotencyKey: input.idempotencyKey ?? `delivery:${input.providerMessageId ?? input.provider_message_id ?? crypto.randomUUID()}` });
      this.recordEvent({ ...input, type: "delivery_quarantined", idempotencyKey: `quarantine:${input.idempotencyKey ?? input.providerMessageId ?? crypto.randomUUID()}`, payload: { reason: "unknown_claim", delivery: input.payload ?? {} } });
      return { quarantined: true, retry: false, ...result };
    }
    claim.status = input.status === "delivered" ? "delivered" : "sent";
    claim.providerMessageId = input.providerMessageId ?? input.provider_message_id ?? claim.providerMessageId;
    return { quarantined: false, retry: false, claim: claimView(claim) };
  }
}

function restUrl(base, path) { return `${String(base).replace(/\/$/, "")}/rest/v1/${path}`; }

export class SupabaseAutomationStore {
  constructor({ url, key, fetchImpl = globalThis.fetch, now = () => new Date(), headers = {} } = {}) {
    if (!url || !key || typeof fetchImpl !== "function") throw new Error("url, key and fetch are required");
    this.url = url; this.key = key; this.fetch = fetchImpl; this.now = now; this.headers = headers;
  }
  async request(path, { method = "GET", body, query = {}, prefer } = {}) {
    const qs = Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
    const response = await this.fetch(restUrl(this.url, path) + (qs ? `?${qs}` : ""), { method, signal: AbortSignal.timeout(10000), headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}), ...this.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) { const error = new Error(data?.message ?? data?.hint ?? `Supabase request failed (${response.status})`); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  scopeQuery(scope) { const { ownerId, workspaceId } = requiredScope(scope); return { owner_id: `eq.${ownerId}`, workspace_id: `eq.${workspaceId}` }; }
  async getInvoice(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("cetld_invoices", { query: { select: "*", id: `eq.${input.invoiceId ?? input.invoice_id}`, owner_id: `eq.${ownerId}`, workspace_id: `eq.${workspaceId}`, limit: 1 } });
    return Array.isArray(data) ? (data[0] ?? null) : data ?? null;
  }
  async updateInvoice(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const patch = {};
    for (const [camel,snake] of Object.entries({ reminderCount:'reminder_count',lastFollowUpAt:'last_follow_up_at',customerPhone:'customer_phone',followUpSettings:'follow_up_settings' })) {
      if (Object.hasOwn(input,camel)) patch[snake]=input[camel];
      else if (Object.hasOwn(input,snake)) patch[snake]=input[snake];
    }
    if (Object.hasOwn(input, "paidMinor") || Object.hasOwn(input, "paid_minor")) patch.paid_minor = input.paidMinor ?? input.paid_minor;
    if (Object.hasOwn(input, "followupState") || Object.hasOwn(input, "followup_state")) patch.followup_state = input.followupState ?? input.followup_state;
    if (Object.hasOwn(input, "nextFollowUpAt") || Object.hasOwn(input, "next_follow_up_at")) patch.next_follow_up_at = Object.hasOwn(input,"nextFollowUpAt") ? input.nextFollowUpAt : input.next_follow_up_at;
    const query = { id: `eq.${input.invoiceId ?? input.invoice_id ?? input.id}`, owner_id: `eq.${ownerId}`, workspace_id: `eq.${workspaceId}` };
    if (input.expectedVersion !== undefined || input.expected_version !== undefined) query.automation_version = `eq.${input.expectedVersion ?? input.expected_version}`;
    const data = await this.request("cetld_invoices", { method: "PATCH", query, body: patch, prefer: "return=representation" });
    return Array.isArray(data) ? (data[0] ?? null) : data ?? null;
  }
  async markInvoicePaid(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("rpc/cetld_mark_invoice_paid", { method: "POST", body: { p_invoice_id: input.invoiceId ?? input.invoice_id, p_reference: input.reference ?? "Marked paid in Cetld" } });
    const row = Array.isArray(data) ? (data[0] ?? null) : data;
    if (row && row.workspace_id === undefined) row.workspace_id = workspaceId;
    if (row && row.owner_id === undefined) row.owner_id = ownerId;
    return row;
  }
  async pauseInvoice(input) {
    return this.updateInvoice({ ...input, followupState: "paused", nextFollowUpAt: null });
  }
  async claimDueFollowups(input = {}) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("rpc/cetld_claim_due_followups", { method: "POST", body: { p_owner_id: ownerId, p_workspace_id: workspaceId, p_now: iso(input.now, this.now()), p_limit: Number(input.limit ?? 25), p_invoice_id: input.invoiceId ?? input.invoice_id ?? null, p_lease_seconds: Math.ceil(Number(input.leaseMs ?? 120000) / 1000) } });
    return (Array.isArray(data) ? data : data ? [data] : []).map(row => ({...row,id:row.claim_id,invoiceId:row.invoice_id,invoiceVersion:Number(row.invoice_version)}));
  }
  async authorizeDelivery(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("rpc/cetld_authorize_follow_up_delivery", { method: "POST", body: { p_claim_id: input.claimId ?? input.claim_id, p_owner_id: ownerId, p_workspace_id: workspaceId } });
    return Array.isArray(data) ? (data[0] ?? { authorized: false, reason: "not_found" }) : data ?? { authorized: false, reason: "not_found" };
  }
  async markDeliverySent(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("rpc/cetld_mark_follow_up_sent", { method: "POST", body: { p_claim_id: input.claimId ?? input.claim_id, p_owner_id: ownerId, p_workspace_id: workspaceId, p_token: input.token, p_provider_message_id: input.providerMessageId ?? input.provider_message_id } });
    return Array.isArray(data) ? (data[0] ?? { ok: false }) : data ?? { ok: false };
  }
  async markDeliveryFailed(input) {
    const { ownerId, workspaceId } = requiredScope(input);
    const data = await this.request("rpc/cetld_mark_follow_up_failed", { method: "POST", body: { p_claim_id: input.claimId ?? input.claim_id, p_owner_id: ownerId, p_workspace_id: workspaceId, p_error: input.error, p_unknown: Boolean(input.unknown), p_token: input.token ?? null } });
    return Array.isArray(data) ? (data[0] ?? { ok: false }) : data ?? { ok: false };
  }
  async recordMessage(input) {
    const scope = requiredScope(input); const key = idempotency(input);
    const data = await this.request("cetld_automation_messages", { query: {on_conflict:"workspace_id,idempotency_key"}, method: "POST", body: { owner_id: scope.ownerId, workspace_id: scope.workspaceId, invoice_id: input.invoiceId ?? input.invoice_id ?? null, direction: input.direction ?? "inbound", kind: input.kind ?? "message", status: input.status ?? "received", idempotency_key: key, provider_message_id: input.providerMessageId ?? input.provider_message_id ?? null, payload: input.payload ?? {}, created_at: input.createdAt ?? input.created_at }, prefer: "resolution=ignore-duplicates,return=representation" });
    return { inserted: Array.isArray(data) ? data.length > 0 : Boolean(data), message: Array.isArray(data) ? data[0] : data };
  }
  async recordEvent(input) {
    const scope = requiredScope(input); const key = idempotency(input);
    const data = await this.request("cetld_automation_events", { query: {on_conflict:"workspace_id,idempotency_key"}, method: "POST", body: { owner_id: scope.ownerId, workspace_id: scope.workspaceId, invoice_id: input.invoiceId ?? input.invoice_id ?? null, type: input.type, source: input.source ?? "automation", idempotency_key: key, metadata: input.payload ?? input.metadata ?? {}, created_at: input.createdAt ?? input.created_at }, prefer: "resolution=ignore-duplicates,return=representation" });
    return { inserted: Array.isArray(data) ? data.length > 0 : Boolean(data), event: Array.isArray(data) ? data[0] : data };
  }
  async saveReply(input) {
    const scope = requiredScope(input); const key = idempotency(input);
    const data = await this.request("cetld_automation_replies", { query: {on_conflict:"workspace_id,idempotency_key"}, method: "POST", body: { owner_id: scope.ownerId, workspace_id: scope.workspaceId, message_id: input.messageId ?? input.message_id ?? null, idempotency_key: key, status: input.status ?? "pending", body: input.body ?? input.payload ?? "", provider_message_id: input.providerMessageId ?? input.provider_message_id ?? null, created_at: input.createdAt ?? input.created_at }, prefer: "resolution=ignore-duplicates,return=representation" });
    return { inserted: Array.isArray(data) ? data.length > 0 : Boolean(data), reply: Array.isArray(data) ? data[0] : data };
  }
  async recordDelivery(input) {
    const scope = requiredScope(input); const claimId = input.claimId ?? input.claim_id;
    if (!claimId) return this.quarantineDelivery(input, "unknown_claim");
    try {
      const data = await this.request("rpc/cetld_record_follow_up_delivery", { method: "POST", body: { p_claim_id: claimId, p_owner_id: scope.ownerId, p_workspace_id: scope.workspaceId, p_provider_message_id: input.providerMessageId ?? input.provider_message_id, p_status: input.status ?? "delivered", p_payload: input.payload ?? {} } });
      return Array.isArray(data) ? data[0] : data;
    } catch (error) {
      if (error.status === 404 || error.status === 400 || error.status === 401 || error.status === 403) return this.quarantineDelivery(input, "unknown_claim");
      throw error;
    }
  }
  async quarantineDelivery(input, reason = "unknown_claim") {
    const key = input.idempotencyKey ?? `delivery:${input.providerMessageId ?? input.provider_message_id ?? crypto.randomUUID()}`;
    await this.recordMessage({ ...input, direction: "delivery", kind: "delivery", status: "quarantined", idempotencyKey: key });
    await this.recordEvent({ ...input, type: "delivery_quarantined", idempotencyKey: `quarantine:${key}`, payload: { reason, delivery: input.payload ?? {} } });
    return { quarantined: true, retry: false };
  }
}

export function createMemoryStore(options) { return new MemoryAutomationStore(options); }
export function createSupabaseStore(options) { return new SupabaseAutomationStore(options); }
export { ACTIVE_STATES, TERMINAL_STATES, requiredScope };
