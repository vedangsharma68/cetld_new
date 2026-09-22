import { cadenceSettings, isWithinContactHours, nextContactTime, scheduleNextFollowUp } from './cadence.mjs';
import { createHash } from 'node:crypto';
const value = (row, camel, snake) => row[camel] ?? row[snake];
const version = row => Number(value(row,'automationVersion','automation_version'));
const state = row => value(row,'followupState','followup_state');
const paid = row => Number(value(row,'paidMinor','paid_minor'));
const total = row => Number(value(row,'amountMinor','amount_minor'));
const active = row => ['approved','active','scheduled'].includes(state(row));
export const isPaid = row => total(row) > 0 && paid(row) >= total(row);
export const isPaused = row => state(row) === 'paused';
const eventKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export class FollowUpEngine {
  constructor({store, provider, paymentChecker, settings = {}, clock = () => new Date()}) {
    if (!store || !provider?.sendReminder || typeof paymentChecker !== 'function') throw new TypeError('Store, provider and payment checker required');
    Object.assign(this,{store,provider,paymentChecker,settings,clock});
  }
  async event(scope,type,payload={}) {
    await this.store.recordEvent({...scope,type,idempotencyKey:eventKey(scope,type,payload),payload});
  }
  settingsFor(invoice) { return cadenceSettings({...this.settings,...(value(invoice,'followUpSettings','follow_up_settings') || {})}); }
  async run(scope) {
    const {ownerId,workspaceId,invoiceId}=scope;
    if (!ownerId || !workspaceId || !invoiceId) throw new TypeError('Invoice scope required');
    let invoice=await this.store.getInvoice(scope);
    if (!invoice) throw new Error('Invoice not found');
    if (isPaid(invoice)) {
      await this.store.updateInvoice({...scope,expectedVersion:version(invoice),followupState:'cancelled',nextFollowUpAt:null});
      return {status:'skipped',reason:'paid'};
    }
    if (!active(invoice)) return {status:'skipped',reason:state(invoice)};
    const now=this.clock(), settings=this.settingsFor(invoice), timezone=invoice.debtor_timezone || settings.timezone || 'UTC';
    const due=value(invoice,'nextFollowUpAt','next_follow_up_at');
    if (!due || new Date(due)>now) return {status:'waiting'};
    if (!isWithinContactHours(now,settings,timezone)) {
      const next=nextContactTime(now,settings,timezone).toISOString();
      await this.store.updateInvoice({...scope,expectedVersion:version(invoice),nextFollowUpAt:next});
      return {status:'waiting',reason:'contact_hours'};
    }
    const count=Number(value(invoice,'reminderCount','reminder_count') || 0);
    if (count>=settings.escalationAfter) {
      await this.store.updateInvoice({...scope,expectedVersion:version(invoice),followupState:'paused',nextFollowUpAt:null});
      await this.event(scope,'needs_attention',{reason:'cadence_exhausted',count});
      return {status:'needs_attention'};
    }
    const to=value(invoice,'customerPhone','customer_phone');
    if (!/^\+[1-9]\d{7,14}$/.test(to || '')) return {status:'skipped',reason:'missing_contact'};
    const [claim]=await this.store.claimDueFollowups({...scope,now:now.toISOString(),limit:1});
    if (!claim) return {status:'waiting',reason:'not_claimed'};
    const key=`reminder:${workspaceId}:${claim.id}`;
    const body=settings.reminderMessage || `A reminder that invoice ${invoice.number || invoiceId} remains outstanding. Please let us know if you have already paid.`;
    // Persist intent BEFORE checking payment and obtaining final authorization.
    await this.store.recordMessage({...scope,direction:'outbound',kind:'reminder',status:'pending',idempotencyKey:key,payload:{to,body,claimId:claim.id}});
    let refreshed;
    try {
      refreshed=await this.paymentChecker({...scope,invoice});
      if (!refreshed || !Number.isSafeInteger(refreshed.paidMinor) || refreshed.paidMinor<0 || refreshed.paidMinor>total(invoice)) throw new Error('Invalid payment result');
      if (refreshed.paidMinor !== paid(invoice)) {
        // Never overwrite a payment or pause written while checking accounting.
        const updated=await this.store.updateInvoice({...scope,expectedVersion:version(invoice),paidMinor:Math.max(paid(invoice),refreshed.paidMinor)});
        if (!updated) throw new Error('Invoice changed during payment check');
      }
      invoice=await this.store.getInvoice(scope);
      if (!invoice) throw new Error('Invoice disappeared');
    } catch {
      await this.store.markDeliveryFailed({...scope,claimId:claim.id,unknown:true,error:'payment_check_failed'});
      await this.event(scope,'needs_attention',{reason:'payment_check_failed',claimId:claim.id});
      return {status:'quarantined',reason:'payment_check_failed'};
    }
    if (isPaid(invoice) || !active(invoice)) {
      if (isPaid(invoice)) await this.store.updateInvoice({...scope,expectedVersion:version(invoice),followupState:'cancelled',nextFollowUpAt:null});
      await this.store.markDeliveryFailed({...scope,claimId:claim.id,unknown:true,error:'payment_or_pause'});
      return {status:'skipped',reason:isPaid(invoice)?'paid':'paused'};
    }
    if (!isWithinContactHours(this.clock(),this.settingsFor(invoice),invoice.debtor_timezone || settings.timezone || 'UTC')) {
      await this.store.markDeliveryFailed({...scope,claimId:claim.id,unknown:false,error:'contact_hours'});
      return {status:'waiting',reason:'contact_hours'};
    }
    const authorization=await this.store.authorizeDelivery({...scope,claimId:claim.id});
    if (!authorization.authorized) return {status:'skipped',reason:authorization.reason};
    // No asynchronous work may be inserted between this gate and provider dispatch.
    let result;
    try { result=await this.provider.sendReminder({workspaceId,invoiceId,customerId:invoice.customer_contact_id || invoiceId,to,body,idempotencyKey:key}); }
    catch { result={status:'unknown'}; }
    if (result?.status !== 'accepted' || !result.providerMessageId) {
      const unknown=result?.status !== 'failed';
      await this.store.markDeliveryFailed({...scope,claimId:claim.id,token:authorization.token,unknown,error:unknown?'delivery_uncertain':'provider_rejected'});
      await this.event(scope,'needs_attention',{reason:unknown?'delivery_uncertain':'provider_rejected',claimId:claim.id});
      return {status:unknown?'quarantined':'failed'};
    }
    const recorded=await this.store.markDeliverySent({...scope,claimId:claim.id,token:authorization.token,providerMessageId:result.providerMessageId});
    if (!recorded.ok) return {status:'quarantined',reason:'receipt_not_committed'};
    const needsAttention=count+1>=settings.escalationAfter;
    // CAS preserves a pause/payment/reply that arrived while provider HTTP was in flight.
    await this.store.updateInvoice({...scope,expectedVersion:version(invoice),reminderCount:count+1,lastFollowUpAt:this.clock().toISOString(),followupState:needsAttention?'paused':'approved',nextFollowUpAt:needsAttention?null:scheduleNextFollowUp(this.clock(),settings,timezone).toISOString()});
    await this.event(scope,needsAttention?'needs_attention':'followup_sent',{claimId:claim.id,providerMessageId:result.providerMessageId,reason:needsAttention?'cadence_exhausted':undefined});
    return {status:'sent',providerMessageId:result.providerMessageId};
  }
  runInvoice(input) { return this.run(input); }
  async processReply({ownerId,workspaceId,invoiceId,body,from,messageId}) {
    const scope={ownerId,workspaceId,invoiceId};
    const invoice=await this.store.getInvoice(scope);
    if (!invoice || !messageId || !body || from!==value(invoice,'customerPhone','customer_phone')) throw new Error('Unmatched reply');
    const key=`reply:${workspaceId}:${messageId}`;
    // Stop first: failure persisting the reply must never allow another reminder.
    if (!isPaid(invoice)) await this.store.updateInvoice({...scope,followupState:'paused',nextFollowUpAt:null});
    const saved=await this.store.recordMessage({...scope,direction:'inbound',kind:'reply',status:'received',providerMessageId:messageId,idempotencyKey:key,payload:{body,from}});
    await this.event(scope,'needs_attention',{reason:'customer_reply',messageId});
    return {status:isPaid(invoice)?'paid':'paused',duplicate:!saved.inserted};
  }
  handleReply(input) { return this.processReply(input); }
}
export const createFollowUpEngine = options => new FollowUpEngine(options);
