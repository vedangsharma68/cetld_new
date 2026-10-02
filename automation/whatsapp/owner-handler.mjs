import {AIProvider,sanitizeModelSettings} from '../../ai/provider.mjs';
import {answerWorkspaceQuestion} from '../../ai/assistant.mjs';
import {createOwnerScopedStore} from '../../ai/whatsapp-channel.mjs';
import {authorizeOwnerPhone} from './owner-binding.mjs';
import {createWhatsAppInvoiceStore} from './invoice-store.mjs';
import {createWhatsAppPendingActionStore} from './pending-actions.mjs';
import {createWhatsAppBoundMessageHandler,parseInvoiceCorrection,matchInvoicesByHint,contactAnswer} from './assistant-handler.mjs';
import {isSupportedCurrency,CURRENCY_SUPPORT_MESSAGE} from '../../currency-contract.mjs';

const YES=/^\s*(?:yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve)\s*[.!]?\s*$/i;
const CANCEL=/^\s*(?:no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$/i;
const money=(currency,amount)=>new Intl.NumberFormat('en-US',{style:'currency',currency}).format(amount);
const ids=invoice=>[invoice.invoiceNumber,invoice.printedInvoiceNumber].filter(Boolean);
const label=invoice=>`${invoice.printedInvoiceNumber||invoice.invoiceNumber} — ${invoice.clientName||'Unnamed customer'}`;
const escapeRegex=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function mentioned(invoices,text){return invoices.filter(i=>ids(i).some(id=>new RegExp('(^|[^a-z0-9_-])'+escapeRegex(id)+'(?=$|[^a-z0-9_-])','i').test(text)));}
function contextualInvoice(invoices,history){
 for(const turn of [...history].reverse()){
  if(turn.role!=='assistant')continue;
  const found=mentioned(invoices,turn.content||'');
  if(found.length===1)return found;
  if(found.length>1)return [];
 }
 return [];
}
function details(i){
 return `Invoice ${label(i)}\nTotal: ${money(i.currency,i.total)}\nPaid: ${money(i.currency,i.amountPaid||0)}\nBalance: ${money(i.currency,Math.max(0,i.total-(i.amountPaid||0)))}\nStatus: ${i.status}\nIssue date: ${i.invoiceDate||'not recorded'}\nDue date: ${i.dueDate||'not recorded'}${i.notes?'\nNotes: '+i.notes:''}`;
}
function validDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const d=new Date(value+'T00:00:00.000Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
}
function correction(message,clock){
 if(/\b(?:run|execute|sql|delete|drop|script)\b/i.test(message))return null;
 if(/\b(?:mark|make|set)\b.{0,100}\bpaid\b/i.test(message))return {changes:{status:'paid'}};
 for(const [pattern,field] of [
  [/\b(?:due\s+date)\s+(?:to|as|=)\s*(.+)$/i,'dueDate'],
  [/\b(?:issue|invoice)\s+date\s+(?:to|as|=)\s*(.+)$/i,'invoiceDate'],
  [/\b(?:customer|client)(?:\s+name)?\s+(?:to|as|=)\s*(.+)$/i,'clientName'],
  [/\bnotes?\s+(?:to|as|=)\s*(.+)$/i,'notes'],
  [/\binvoice\s+number\s+(?:to|as|=)\s*(.+)$/i,'invoiceNumber']
 ]){
  const m=message.match(pattern);
  if(m&&/\b(?:change|make|set|update|edit|fix)\b/i.test(message)){
   const value=m[1].trim();
   if(field.endsWith('Date')){
    const parsed=parseInvoiceCorrection('change the '+(field==='dueDate'?'due':'invoice')+' date to '+value,clock);
    return {changes:{[field]:parsed?.changes[field]}};
   }
   return {changes:{[field]:value}};
  }
 }
 return parseInvoiceCorrection(message,clock);
}
function invalidChange(changes,target){
 if(changes.total!==undefined&&(!Number.isFinite(changes.total)||changes.total<=0||changes.total>999999999999.99||Math.abs(changes.total*100-Math.round(changes.total*100))>1e-6))return 'Use a positive amount with at most two decimal places.';
 if(changes.currency&&!isSupportedCurrency(changes.currency))return CURRENCY_SUPPORT_MESSAGE;
 if(changes.currency&&changes.currency!==target.currency&&(target.amountPaid||0)>0)return 'This invoice already has payments. Its currency cannot be changed.';
 if(['dueDate','invoiceDate'].some(k=>k in changes&&!validDate(changes[k])))return 'Please provide a valid date, such as 2026-10-15.';
 if(changes.total!==undefined&&changes.total<Number(target.metadata?.tax_minor!=null?target.metadata.tax_minor/100:target.metadata?.tax||0))return 'The total cannot be lower than the tax already recorded.';
 if(changes.total!==undefined&&changes.total<(target.amountPaid||0))return 'The total cannot be lower than payments already recorded.';
 if(changes.invoiceNumber&&!/^[A-Za-z0-9][A-Za-z0-9 _./-]{0,99}$/.test(changes.invoiceNumber))return 'Use an invoice number up to 100 characters, containing letters, numbers, spaces, or . / _ -.';
 if(changes.clientName!==undefined&&(!changes.clientName||changes.clientName.length>200))return 'Use a customer name between 1 and 200 characters.';
 if(changes.notes!==undefined&&changes.notes.length>4000)return 'Keep the notes under 4,000 characters.';
 if(['paid','void','cancelled'].includes(target.status)||target.amountPaid>=target.total)return 'This invoice is already paid or settled. Its recorded details cannot be changed here.';
 return null;
}
async function permanentHistory({supabase,workspaceId,phone}){
 const result=await supabase.from('whatsapp_messages').select('direction,body,status,created_at,id').eq('workspace_id',workspaceId)
  .eq('phone',phone).eq('audience','owner').in('status',['received','accepted','sent','delivered','read'])
  .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(20);
 if(result.error)throw result.error;
 return (result.data||[]).reverse().map(r=>({role:r.direction==='inbound'?'user':'assistant',content:r.body}));
}
export function createOwnerMessageHandler({supabase,env=process.env,fetchImpl=fetch,
 providerFactory=options=>new AIProvider(options),answer=answerWorkspaceQuestion,
 authorize=scope=>authorizeOwnerPhone({supabase,...scope}),
 invoiceStoreFactory=scope=>createWhatsAppInvoiceStore({supabase,...scope,audience:'owner',authorize:()=>authorize(scope)}),
 pendingActionStoreFactory=createWhatsAppPendingActionStore,readHistory=permanentHistory,
 clock=()=>new Date(),logger=console}={}){
 return async scope=>{
  const {workspaceId,ownerId,customerId,phone,messageId,media,mediaError,signal,deadlineAt}=scope;
  if(!await authorize(scope))return '';
  let message=String(scope.message||'').trim();
  const pending=pendingActionStoreFactory({supabase});
  const current=await pending.loadPendingAction({workspaceId,customerId,phone});
  let reviewReceipt=null;
  if(YES.test(message)||CANCEL.test(message)){
   const result=await supabase.rpc('whatsapp_confirm_owner_invoice_action',{
    p_workspace_id:workspaceId,p_owner_id:ownerId,p_phone:phone,p_action_id:current?.id??null,p_version:current?.version??null,
    p_confirmation_message_id:messageId,p_confirm:!CANCEL.test(message)});
   if(result.error){logger?.error?.('Owner confirmation failed',{workspaceId,code:result.error.code});return 'I could not confirm that change. Check the invoice in your dashboard before trying again.';}
   const value=Array.isArray(result.data)?result.data[0]:result.data;
   if(!value?.ok){
    if(value?.reason==='stale')return 'This invoice changed since your request. Please ask again so I can show its current details.';
    if(value?.reason==='expired')return 'That confirmation expired. Please ask for the change again.';
    if(value?.reason==='stale_confirmation')return 'That reply came before this proposal. Please review the latest proposal and send a new yes to confirm it.';
    if(value?.reason==='no_action')return 'There is no invoice change waiting for confirmation. Tell me which invoice you want to change.';
    if(value?.reason==='in_progress')return 'That invoice is already being saved. Please wait for it to finish.';
    if(value?.reason==='already_saved')return 'That invoice was already saved. Cancel cannot undo it.';
    if(value?.reason==='already_consumed')return 'That confirmation was already handled. Check your dashboard for the latest invoice.';
    return 'I could not apply that change. Please check the invoice in your dashboard.';
   }
   if(value.actionType==='canceled')return 'Canceled. Nothing was changed.';
   if(value.actionType==='owner_invoice_review')reviewReceipt=value;
   else return `${value.actionType==='owner_invoice_payment'?'Recorded payment for':'Updated'} invoice ${value.invoiceNumber}. Your dashboard shows the same change.`;
  }
  // Reuse the existing durable attachment review, with verified owner authorization
  // and real customer lookup instead of assigning new invoices to an owner placeholder.
  if(media||mediaError||current?.action?.type==='invoice_review_draft'&&['extracting','incomplete','proposal','saving','failed'].includes(current.action.stage)
    &&(YES.test(message)||CANCEL.test(message)||/^\s*[a-z]{3}\s*$/i.test(message))
    ||current?.action?.type==='invoice_debtor_phone'&&(/\+[\d\s().-]{7,24}\d/.test(message)||CANCEL.test(message))){
   const boundedPending=reviewReceipt?()=>({...pending,
    loadInvoiceReview:async input=>{const row=await pending.loadInvoiceReview(input);return String(row?.id)===String(reviewReceipt.reviewActionId)?row:null},
    loadPendingAction:async input=>{const row=await pending.loadPendingAction(input);return String(row?.id)===String(reviewReceipt.reviewActionId)?row:null},
   }):pendingActionStoreFactory;
   if(reviewReceipt&&String(current?.id)!==String(reviewReceipt.reviewActionId))return 'That invoice review was replaced. Please continue with the latest request.';
   const delegate=createWhatsAppBoundMessageHandler({supabase,env,fetchImpl,providerFactory,pendingActionStoreFactory:boundedPending,clock,logger,
    authorizeScope:()=>authorize(scope),invoiceStoreFactory:()=>invoiceStoreFactory(scope),audience:'owner'});
   return delegate(scope);
  }
  const history=await readHistory({supabase,workspaceId,phone});
  const store=invoiceStoreFactory(scope);
  const invoices=await store.findInvoices({limit:1000});
  let edit=correction(message,clock);
  if(current?.action?.type==='owner_invoice_request'&&!edit&&(mentioned(invoices,message).length===1
    ||invoices.filter(i=>i.clientName?.toLowerCase()===message.toLowerCase()).length===1)){
   edit={changes:current.action.changes};message=message+' '+current.action.message;
  }
  if(/^\s*(?:hi|hello|hey)[!?.\s]*$/i.test(message))return 'You are connected as the business owner. Ask me to list your invoices, check a balance, retrieve an invoice file, or change an invoice.';
  const listRequest=/\b(?:invoices|bills)\b/i.test(message)&&/\b(?:list|which|what|show|logged|uploaded|have|all)\b/i.test(message)&&!edit;
  if(listRequest){
   let list=invoices;
   if(/\b(?:unpaid|outstanding|due|overdue)\b/i.test(message))list=list.filter(i=>!['void','cancelled'].includes(i.status)&&i.total>(i.amountPaid||0));
   else if(/\bpaid\b/i.test(message))list=list.filter(i=>i.status==='paid'||i.total<=(i.amountPaid||0));
   if(!list.length)return 'There are no invoices matching that request in your workspace.';
   const shown=list.slice(0,20);
   return `${list.length} invoice${list.length===1?'':'s'} in your workspace:\n${shown.map(i=>'• '+label(i)+' · '+i.status+' · '+money(i.currency,i.total)).join('\n')}${list.length>20?'\nShowing the first 20. Ask for a specific invoice or use the dashboard for the full list.':''}`;
  }
  const fileRequest=/\b(?:send|show|give|download)\b.{0,70}\b(?:file|pdf|photo|document)\b/i.test(message);
  const contactRequest=/\b(?:contact|phone|mobile|email|e-mail|whatsapp number)\b/i.test(message)&&!edit;
  // The value after "to" is the proposed replacement, never the target invoice.
  const targetText=edit?message.split(/\b(?:amount|amt|amnt|total|price|value|due\s+date|issue\s+date|invoice\s+date|customer|client|currency|notes?|invoice\s+number|paid)\b/i)[0]:message;
  const explicit=mentioned(invoices,targetText);
  let candidates=explicit;
  if(!candidates.length){
   const named=invoices.filter(i=>i.clientName&&targetText.toLowerCase().includes(i.clientName.toLowerCase()));
   if(named.length)candidates=named;
   else if(edit?.hint)candidates=matchInvoicesByHint(invoices,edit.hint);
   else if(/\b(?:it|its|this|that|the invoice|them|him|her)\b/i.test(targetText))candidates=contextualInvoice(invoices,history);
  }
  if((edit||fileRequest||contactRequest)&&candidates.length!==1){
   if(edit){
    const expectedState=await pending.loadPendingActionState({workspaceId,customerId,phone});
    await pending.storePendingAction({workspaceId,customerId,phone,expectedState,source:'whatsapp',action:{type:'owner_invoice_request',changes:edit.changes,message}});
   }
   return 'Which invoice should I use? Reply with its invoice number or customer name.';
  }
  const target=candidates[0];
  if(edit){
   const invalid=invalidChange(edit.changes,target);
   if(invalid)return invalid;
   const expectedState=await pending.loadPendingActionState({workspaceId,customerId,phone});
   const action={type:edit.changes.status==='paid'?'owner_invoice_payment':'owner_invoice_update',
    invoiceId:target.id,invoiceNumber:target.invoiceNumber,expectedUpdatedAt:target.updatedAt,changes:edit.changes,
    requestedAt:clock().toISOString(),expiresAt:new Date(clock().getTime()+10*60*1000).toISOString(),sourceMessageId:messageId};
   const saved=await pending.storePendingAction({workspaceId,customerId,phone,expectedState,action,source:'whatsapp'});
   if(!saved)return 'Another request is in progress. Please finish or cancel it, then ask again.';
   const labels={total:'Total',currency:'Currency',dueDate:'Due date',invoiceDate:'Issue date',notes:'Notes',clientName:'Customer',invoiceNumber:'Invoice number'};
   const changes=action.type==='owner_invoice_payment'
    ?'Record a payment of '+money(target.currency,target.total-(target.amountPaid||0))+' and mark this invoice paid.'
    :Object.entries(edit.changes).map(([k,v])=>`${labels[k]}: ${target[k]??'not recorded'} → ${v}`).join('\n');
   return `Confirm change to invoice ${label(target)}:\n${changes}\nReply yes to confirm, or cancel. This request expires in 10 minutes.`;
  }
  if(fileRequest){const file=await store.latestInvoiceFile(target.id);return file?{answer:'Here is invoice '+label(target)+'.',media:file}:'No file is stored for invoice '+label(target)+'.';}
  if(contactRequest)return contactAnswer(target,{wantPhone:/phone|mobile|contact|whatsapp/i.test(message),wantEmail:/email|e-mail|contact/i.test(message)});
  if(target&&/\b(?:invoice|bill|show|details|balance|due|total|amount|tell|what|when)\b/i.test(message))return details(target);
  if(YES.test(message))return 'There is no invoice change waiting for confirmation. Tell me which invoice you want to change.';
  const {data:settings,error}=await supabase.from('workspace_ai_settings').select('primary_model,fallback_model').eq('workspace_id',workspaceId).maybeSingle();
  if(error)throw error;
  const models=sanitizeModelSettings({primaryModel:settings?.primary_model,fallbackModel:settings?.fallback_model});
  const provider=providerFactory({...models,geminiApiKey:env.GEMINI_API_KEY,openRouterApiKey:env.OPENROUTER_API_KEY,zenApiKey:env.OPENCODE_ZEN_API_KEY,fetchImpl,timeoutMs:8000,maxAttempts:1});
  const ledger=createOwnerScopedStore({supabase,workspaceId,ownerId,phone,authorize:()=>authorize(scope)});
  const response=await answer({provider,store:ledger,message,history,accounting:null,signal,deadlineAt});
  if(response?.pendingAction)return 'Tell me the invoice number and the exact change, for example “change invoice 1001 due date to 2026-10-15”. I will ask you to confirm it.';
  if(!await authorize(scope))return '';
  return response?.answer||'I could not answer that right now. Try asking for an invoice number or a list of invoices.';
 };
}
