import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {resolveWorkspaceRecord} from './workspace-records.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions=new Set(['select','view_file','edit_details','record_payment','unpaid_invoices','recent_invoices','find_invoice']);
const recordActions=new Set(['select','view_file','edit_details','record_payment']);
const now=clock=>new Date(clock()).getTime();
const secret=env=>{const value=env?.WHATSAPP_APP_SECRET||env?.CRON_SECRET;return typeof value==='string'&&value.length?value:null;};
const cleanLabel=value=>Array.from(String(value||'').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim()).slice(0,20).join('');
const data=result=>{if(result?.error)throw result.error;return result?.data;};
const scopeValid=scope=>typeof scope?.workspaceId==='string'&&scope.workspaceId.length>0&&scope.workspaceId.length<=128&&/^\+[1-9]\d{6,14}$/.test(scope?.phone||'');

// Stored server-side, separate from pending approval capabilities. Tokens contain
// only a random receipt key and choice index, never record IDs or commands.
export function normalizeOwnerNextActionRef(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['v','key','expiresAt','choices'].includes(k))
    ||value.v!==1||!UUID.test(value.key||'')||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))
    ||!Array.isArray(value.choices)||value.choices.length<1||value.choices.length>3)return null;
  const choices=[];
  for(const c of value.choices) {
    if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['action','title','table','id','updatedAt'].includes(k))
      ||!actions.has(c.action)||typeof c.title!=='string'||!c.title||c.title!==cleanLabel(c.title))return null;
    if(recordActions.has(c.action)) {
      if(!['customers','invoices'].includes(c.table)||!UUID.test(c.id||'')||typeof c.updatedAt!=='string'||!Number.isFinite(Date.parse(c.updatedAt)))return null;
      if(['view_file','record_payment'].includes(c.action)&&c.table!=='invoices')return null;
    }else if(c.table!==undefined||c.id!==undefined||c.updatedAt!==undefined)return null;
    choices.push({action:c.action,title:c.title,...(recordActions.has(c.action)?{table:c.table,id:c.id,updatedAt:c.updatedAt}:{})});
  }
  if(new Set(choices.map(c=>c.title)).size!==choices.length)return null;
  return {v:1,key:value.key,expiresAt:value.expiresAt,choices};
}
function signature(scope,ref,index,env) {
  return createHmac('sha256',secret(env)).update(JSON.stringify(['ons1',scope.workspaceId,scope.phone,ref,index])).digest();
}
export function createOwnerNextButtons({scope,reference,env=process.env,clock=()=>new Date()}={}) {
  const ref=normalizeOwnerNextActionRef(reference);
  if(!ref||!scopeValid(scope)||!secret(env)||!Number.isFinite(now(clock))||Date.parse(ref.expiresAt)<=now(clock))return [];
  return ref.choices.map((c,index)=>({title:c.title,id:`ons1.${ref.key}.${index}.${signature(scope,ref,index,env).toString('base64url')}`}));
}
export function verifyOwnerNextButton({id,scope,reference,env=process.env,clock=()=>new Date()}={}) {
  const ref=normalizeOwnerNextActionRef(reference);
  if(!ref||!scopeValid(scope)||!secret(env)||!Number.isFinite(now(clock))||Date.parse(ref.expiresAt)<=now(clock)||typeof id!=='string')return null;
  const match=id.match(/^ons1\.([0-9a-f-]{36})\.([0-2])\.([A-Za-z0-9_-]{43})$/);
  if(!match||match[1]!==ref.key||!ref.choices[Number(match[2])])return null;
  const actual=Buffer.from(match[3],'base64url'),expected=signature(scope,ref,Number(match[2]),env);
  return actual.length===expected.length&&actual.toString('base64url')===match[3]&&timingSafeEqual(actual,expected)?ref.choices[Number(match[2])]:null;
}
export const isOwnerNextButton=id=>typeof id==='string'&&id.startsWith('ons1.');
// This historical request type has no executable/confirmation path. Retain its
// stored row and all mutation guards, but do not let it disable safe shortcuts.
// Unknown types fail closed, as do every supported approval and draft workflow.
export const pendingBlocksOwnerNextActions=record=>Boolean(record&&!record.consumed_at&&record.action?.type!=='owner_invoice_request');
export const NEXT_ACTION_STALE_REPLY='That next action has expired or its details changed. Ask again so I can check the current record.';

async function currentRecord({supabase,scope,choice,authorize}) {
  if(!await authorize(scope))return null;
  let query=supabase.from(choice.table).select(choice.table==='invoices'?'id,invoice_number,updated_at,status,total_amount,amount_paid':'id,name,updated_at,metadata')
    .eq('workspace_id',scope.workspaceId).eq('id',choice.id);
  if(choice.table==='invoices')query=query.is('deleted_at',null);
  const row=data(await query.maybeSingle());
  if(!await authorize(scope)||!row||new Date(row.updated_at).getTime()!==Date.parse(choice.updatedAt))return null;
  return row;
}
function refFor(choices,clock) {
  return normalizeOwnerNextActionRef({v:1,key:randomUUID(),expiresAt:new Date(now(clock)+30*60*1000).toISOString(),choices});
}
function explicitlyMentionedRecords(records,table,message){
  const words=value=>String(value||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  const request=words(message);
  // Compare whole token spans, including compact names such as JohnSmith.
  // The owner message supplies the target; a model's answer cannot choose it.
  return records.filter(row=>{
    const label=words(table==='invoices'?row.invoice_number:row.name).join('');
    if(!label)return false;
    for(let start=0;start<request.length;start++){
      let span='';
      for(let end=start;end<request.length;end++){
        span+=request[end];
        if(span===label)return true;
        if(span.length>=label.length)break;
      }
    }
    return false;
  });
}
export async function planOwnerNextActions({supabase,scope,context,pending=false,authorize,clock=()=>new Date()}={}) {
  if(pending||!context||!await authorize(scope))return null;
  const {params,result}=context;
  if(!params||!result||result.pending||result.proposal||result.requiresConfirmation||(!result.ok&&result.code!=='AMBIGUOUS'))return null;
  const table=params.table||result.table;
  if(table==='workspace_settings'&&result.readOnly&&result.rows?.length)return refFor([
    {action:'unpaid_invoices',title:'Unpaid invoices'},{action:'recent_invoices',title:'Recent invoices'},{action:'find_invoice',title:'Find invoice'}],clock);
  if(!['invoices','customers'].includes(table)||!['read','update','delete'].includes(params.operation))return null;
  let filters=params.filters||[];
  const mentioned=!filters.length&&params.operation==='read'&&result.readOnly&&result.truncated!==true&&Array.isArray(context.records)
    ?explicitlyMentionedRecords(context.records,table,scope.message):[];
  if(result.rows?.length===1) {
    const row=result.rows[0];
    const label=table==='invoices'?row.invoice_number:row.name;
    if(label)filters=[{column:table==='invoices'?'invoice_number':'name',operator:'eq',value:label}];
  }
  if(!filters.length&&!mentioned.length)return table==='invoices'&&result.readOnly?refFor([
    {action:'unpaid_invoices',title:'Unpaid invoices'},{action:'recent_invoices',title:'Recent invoices'},{action:'find_invoice',title:'Find invoice'}],clock):null;
  const found=Array.isArray(context.records)?{ok:true,rows:mentioned.length?mentioned:context.records}:await resolveWorkspaceRecord({supabase,scope,table,filters,operation:'read',select:table==='invoices'?'id,invoice_number,updated_at,status,total_amount,amount_paid':'id,name,updated_at,metadata',assertAuthorized:async()=>{if(!await authorize(scope))throw Error('DENIED');}});
  if(!found.ok||!found.rows?.length||!await authorize(scope))return null;
  const rows=found.rows.filter(r=>UUID.test(r.id||'')&&Number.isFinite(new Date(r.updated_at).getTime()));
  if(rows.length!==found.rows.length)return null;
  const choice=(row,action,title)=>({action,title,table,id:row.id,updatedAt:new Date(row.updated_at).toISOString()});
  if(rows.length>1)return refFor(rows.slice(0,3).map((r,i)=>choice(r,'select',cleanLabel(`${i+1}. ${table==='invoices'?r.invoice_number:r.name}`))),clock);
  const row=rows[0],choices=[];
  if(table==='invoices') {
    const file=data(await supabase.from('invoice_files').select('id').eq('workspace_id',scope.workspaceId).eq('invoice_id',row.id).limit(1).maybeSingle());
    if(file)choices.push(choice(row,'view_file',cleanLabel('View '+row.invoice_number)));
  }
  if(table==='customers'&&row.id!==scope.customerId&&row.metadata?.whatsapp_owner!==true||table==='invoices'&&['draft','sent','overdue'].includes(row.status)&&Number(row.total_amount)>Number(row.amount_paid))choices.push(choice(row,'edit_details','Edit details'));
  if(table==='invoices'&&['draft','sent','overdue'].includes(row.status)&&Number(row.total_amount)>Number(row.amount_paid))choices.push(choice(row,'record_payment','Record payment'));
  return await authorize(scope)&&choices.length?refFor(choices,clock):null;
}

// No model call and no write. A selected record starts a fresh scoped read or
// asks for the missing edit/payment information; it cannot approve anything.
export async function runOwnerNextAction({supabase,scope,env=process.env,clock=()=>new Date(),authorize,tools,pending=false}={}) {
  if(!isOwnerNextButton(scope.interactionId)||!await authorize(scope))return {answer:NEXT_ACTION_STALE_REPLY};
  const match=scope.interactionId.match(/^ons1\.([0-9a-f-]{36})\.[0-2]\.[A-Za-z0-9_-]{43}$/);
  if(!match||pending)return {answer:pending?'Please finish or cancel the current approval before starting another action.':NEXT_ACTION_STALE_REPLY};
  const row=data(await supabase.from('whatsapp_messages').select('owner_next_action_ref')
    .eq('workspace_id',scope.workspaceId).eq('phone',scope.phone).eq('audience','owner').eq('direction','outbound').eq('kind','normal')
    .eq('owner_next_action_ref->>key',match[1]).maybeSingle());
  const choice=verifyOwnerNextButton({id:scope.interactionId,scope,reference:row?.owner_next_action_ref,env,clock});
  if(!choice||!await authorize(scope))return {answer:NEXT_ACTION_STALE_REPLY};
  let record=null;
  if(recordActions.has(choice.action))record=await currentRecord({supabase,scope,choice,authorize});
  if(recordActions.has(choice.action)&&!record)return {answer:NEXT_ACTION_STALE_REPLY};
  const label=choice.table==='invoices'?record?.invoice_number:record?.name;
  if(choice.action==='edit_details'){
    if(choice.table==='customers'&&(record.id===scope.customerId||record.metadata?.whatsapp_owner===true))return {answer:NEXT_ACTION_STALE_REPLY};
    return {answer:`What details should I change for ${label}? Tell me the field and new value. Nothing has changed yet.`};
  }
  if(choice.action==='record_payment') {
    if(!['draft','sent','overdue'].includes(record.status)||Number(record.total_amount)<=Number(record.amount_paid))return {answer:NEXT_ACTION_STALE_REPLY};
    return {answer:`For invoice ${label}, what payment did you receive? To settle the remaining balance, send "mark invoice ${label} paid". I will check the current balance and your confirmation preference. Nothing has been recorded by this tap.`};
  }
  if(choice.action==='find_invoice')return {answer:'Which invoice should I find? Send its invoice number or customer name.'};
  const params=choice.action==='select'?{operation:'read',table:choice.table,filters:[{column:'id',operator:'eq',value:choice.id}]}:
    choice.action==='view_file'?{operation:'sendFile',table:'invoices',filters:[{column:'id',operator:'eq',value:choice.id}]}:
    {operation:'read',table:'invoices',limit:10,...(choice.action==='unpaid_invoices'?{filters:[{column:'status',operator:'in',value:['draft','sent','overdue']},{column:'total_amount',operator:'gt',value:0}]}:{order:{column:'created_at',direction:'desc'}})};
  const result=await tools.execute('workspaceData',params);
  if(!await authorize(scope))return {answer:NEXT_ACTION_STALE_REPLY};
  if(!result?.ok)return {answer:'I could not read those details. Please ask again.'};
  if(choice.action==='view_file'){
    const media=tools.getMedia?.();
    return result.available&&media?.bytes?.length&&UUID.test(media.id||'')?{
      answer:`File for invoice ${result.invoiceNumber}.`,media,
      ownerReplyMediaRef:{invoiceId:choice.id,invoiceUpdatedAt:choice.updatedAt,fileId:media.id},
    }:{answer:`No stored file is available for invoice ${label}.`};
  }
  const rows=(result.rows||[]).filter(r=>choice.action!=='unpaid_invoices'||Number(r.total_amount)>Number(r.amount_paid));
  return {answer:rows.length?rows.map(r=>Object.entries(r).map(([k,v])=>`${k.replaceAll('_',' ')}: ${typeof v==='object'?JSON.stringify(v):v??'Not set'}`).join('\n')).join('\n\n').slice(0,3600)+(result.truncated?'\n\nShowing a limited page. Ask for more invoices to continue.':''):'No matching records were found on this page.'};
}
