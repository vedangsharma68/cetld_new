import { SupabaseAutomationStore } from './store.mjs';
import { localDateTimeToDate, addLocalDays } from './cadence.mjs';
import {createDeletedAtCompatibility} from '../invoice/deleted-at-compat.mjs';

function minor(value) {
  const match = String(value ?? '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Invalid invoice amount');
  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Invoice amount exceeds safe range');
  return amount;
}

export class CoreAutomationStore extends SupabaseAutomationStore {
  constructor(options={}) { super(options); this.deletedAtCompatibility=createDeletedAtCompatibility(); }
  async getWorkspacePreferences({ownerId,workspaceId}) {
    const rows=await this.request('workspace_settings',{query:{select:'business_name,default_timezone,follow_up_preferences,updated_at',workspace_id:`eq.${workspaceId}`,limit:1}});
    return rows?.[0] ?? null;
  }
  async getInvoice(input) {
    const read=includeDeletedAt=>this.request('invoices',{query:{select:'*',id:`eq.${input.invoiceId}`,workspace_id:`eq.${input.workspaceId}`,...(includeDeletedAt?{deleted_at:'is.null'}:{}),limit:1}});
    const rows=await this.deletedAtCompatibility.read({withDeletedAt:()=>read(true),legacy:()=>read(false)});
    const row=rows?.[0];
    if (!row||row.deleted_at) return null;
    const contacts=await this.request('customers',{query:{select:'phone',id:`eq.${row.customer_id}`,workspace_id:`eq.${input.workspaceId}`,limit:1}});
    const amountMinor=minor(row.total_amount), paidMinor=minor(row.amount_paid);
    return {...row,ownerId:input.ownerId,workspaceId:input.workspaceId,amountMinor,paidMinor,followupState:row.followup_state,nextFollowUpAt:row.next_follow_up_at,automationVersion:Number(row.automation_version),customerPhone:row.customer_phone || contacts?.[0]?.phone || row.metadata?.debtor_phone || null,number:row.invoice_number};
  }
  async updateInvoice(input) {
    const patch={};
    for (const [camel,snake] of Object.entries({reminderCount:'reminder_count',lastFollowUpAt:'last_follow_up_at',customerPhone:'customer_phone',followUpSettings:'follow_up_settings',followupState:'followup_state',nextFollowUpAt:'next_follow_up_at'})) {
      if (Object.hasOwn(input,camel)) patch[snake]=input[camel];
      else if (Object.hasOwn(input,snake)) patch[snake]=input[snake];
    }
    if (Object.hasOwn(input,'paidMinor')) patch.amount_paid=(input.paidMinor/100).toFixed(2);
    const query={id:`eq.${input.invoiceId}`,workspace_id:`eq.${input.workspaceId}`};
    if (input.expectedVersion !== undefined) query.automation_version=`eq.${input.expectedVersion}`;
    const data=await this.request('invoices',{method:'PATCH',query,body:patch,prefer:'return=representation'});
    return data?.[0] ?? null;
  }
  async listDueInvoices({workspaceId,now,limit=25}) {
    const read=includeDeletedAt=>this.request('invoices',{query:{select:'id',workspace_id:`eq.${workspaceId}`,followup_state:'in.(approved,active,scheduled)',next_follow_up_at:`lte.${now}`,...(includeDeletedAt?{deleted_at:'is.null'}:{}),order:'next_follow_up_at.asc',limit}});
    return this.deletedAtCompatibility.read({withDeletedAt:()=>read(true),legacy:()=>read(false)});
  }
  async claimDueFollowups(input) {
    const data=await this.request('rpc/cetld_core_claim_due_followups',{method:'POST',body:{p_owner_id:input.ownerId,p_workspace_id:input.workspaceId,p_now:input.now,p_limit:input.limit??25,p_invoice_id:input.invoiceId??null}});
    return (Array.isArray(data)?data:data?[data]:[]).map(row=>({...row,id:row.claim_id,invoiceId:row.invoice_id,invoiceVersion:Number(row.invoice_version)}));
  }
  async authorizeDelivery(input) {
    const data=await this.request('rpc/cetld_core_authorize_delivery',{method:'POST',body:{p_claim_id:input.claimId,p_owner_id:input.ownerId,p_workspace_id:input.workspaceId,p_preferences_version:input.preferencesVersion}});
    return Array.isArray(data)?data[0]:data;
  }
  async markDeliverySent(input) {
    const data=await this.request('rpc/cetld_core_mark_sent',{method:'POST',body:{p_claim_id:input.claimId,p_owner_id:input.ownerId,p_workspace_id:input.workspaceId,p_token:input.token,p_provider_message_id:input.providerMessageId}});
    return Array.isArray(data)?data[0]:data;
  }
  async markDeliveryFailed(input) {
    const data=await this.request('rpc/cetld_core_mark_failed',{method:'POST',body:{p_claim_id:input.claimId,p_owner_id:input.ownerId,p_workspace_id:input.workspaceId,p_token:input.token??null,p_error:input.error,p_unknown:Boolean(input.unknown)}});
    return Array.isArray(data)?data[0]:data;
  }
  async recordMessage(input) {
    const data=await this.request('cetld_core_automation_messages',{method:'POST',query:{on_conflict:'workspace_id,idempotency_key'},body:{workspace_id:input.workspaceId,invoice_id:input.invoiceId,direction:input.direction,kind:input.kind,status:input.status,idempotency_key:input.idempotencyKey,provider_message_id:input.providerMessageId??null,payload:input.payload??{}},prefer:'resolution=ignore-duplicates,return=representation'});
    return {inserted:Boolean(data?.length),message:data?.[0]};
  }
  async recordEvent(input) {
    const data=await this.request('cetld_core_automation_events',{method:'POST',query:{on_conflict:'workspace_id,idempotency_key'},body:{workspace_id:input.workspaceId,invoice_id:input.invoiceId??null,type:input.type,idempotency_key:input.idempotencyKey,metadata:input.payload??{}},prefer:'resolution=ignore-duplicates,return=representation'});
    return {inserted:Boolean(data?.length),event:data?.[0]};
  }
  async dailySummary({workspaceId,day,timezone='UTC'}) {
    const [year,month,date]=day.split('-').map(Number);
    const start=localDateTimeToDate({year,month,day:date,hour:0,minute:0,second:0},timezone);
    const end=localDateTimeToDate(addLocalDays({year,month,day:date,hour:0,minute:0,second:0},1),timezone);
    const rows=await this.request('cetld_core_automation_events',{query:{select:'type,metadata,created_at',workspace_id:`eq.${workspaceId}`,created_at:`gte.${start.toISOString()}`,order:'created_at.asc',limit:500}});
    return rows.filter(row=>new Date(row.created_at)<end);
  }
}
