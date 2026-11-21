// Extend legacy transport-only unit stores with the real new SQL dependency.
// No fabricated empty snapshot: every snapshot contains a foreign canary ledger.
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './offline-sql-network.mjs';
import {after} from 'node:test';
import {createWhatsAppOutbound as outbound} from '../../automation/whatsapp/cloud-outbound.mjs';
import {createApprovedReminderProvider as approved} from '../../automation/whatsapp/approved-reminders.mjs';
import {createFirstPartyReminderProvider as firstParty} from '../../automation/whatsapp/cloud-reminders.mjs';
import {approvedReminderProof as proof} from '../../automation/whatsapp/reminder-proof.mjs';
import {createWhatsAppInvoiceTestHandler as invoiceTest} from '../../automation/whatsapp/test-send.mjs';
let network;const scopes=new Map();let queue=Promise.resolve();
after(async()=>{if(network)await(await network).close();});
async function sqlSnapshot(workspace,phone){
 network??=(async()=>{const f=await createOfflineSqlNetwork();const actor=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[actor]);await f.db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[actor]);const w=(await f.db.query('select (create_workspace($1,$2)).id',['Foreign canary tenant',randomUUID()])).rows[0].id;await f.db.query('select app.retain_private_invoice_terms($1,$2)',[w,{total:846219,partyNames:['SecludedVerdantCanary'],dueDate:'2029-06-14'}]);return f;})();const f=await network;const key=JSON.stringify([workspace,phone]);let id=scopes.get(key);
 if(!id&&workspace){const owner=randomUUID();await f.db.query('insert into auth.users(id) values($1)',[owner]);await f.db.query("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)",[owner]);id=(await f.db.query('select (create_workspace($1,$2)).id',['Fixture tenant',randomUUID()])).rows[0].id;scopes.set(key,id);await f.db.query('insert into customers(workspace_id,name,phone) values($1,$2,$3)',[id,'Fixture recipient',phone]);await f.db.query('select app.retain_private_invoice_terms($1,$2)',[id,{total:846219,partyNames:['SecludedVerdantCanary'],dueDate:'2029-06-14'}]);}
 const result=(await f.db.query('select whatsapp_dispatch_privacy_snapshot($1,$2) value',[id??null,phone])).rows[0].value;if(!result.terms.includes('number:846219'))throw Error('Foreign SQL canary missing from privacy snapshot');return {data:result};
}
// Legacy transport-only tests inject their own claim authority. Mirror that
// approved claim into a disposable SQL inbox so the NEW handoff fence is real,
// independent per adapter instance, without fabricating privacy admission.
async function sqlReplyControl(name,input,namespace){
 await sqlSnapshot(input.p_workspace_id,input.p_phone);const f=await network;
 const workspace=input.p_workspace_id?scopes.get(JSON.stringify([input.p_workspace_id,input.p_phone])):null;
 const id=namespace+':'+input.p_message_id,phase=input.p_phase||'answer',key=(phase==='ack'?'ack:':'reply:')+id;
 const args={...input,p_workspace_id:workspace,p_message_id:id};
 await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values($1,'1234567890',$2,'text','Fixture inbound',now(),'processing') on conflict do nothing",[id,input.p_phone]);
 if(workspace)await f.db.query("insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,'outbound',$3,'Fixture approved intent',$4,'pending',$5) on conflict do nothing",[workspace,input.p_phone,phase==='ack'?'owner':'customer',input.p_kind,key]);
 if(name==='whatsapp_begin_reply_dispatch'){
  const event=(await f.db.query('select reply_reservation_nonce,ack_reservation_nonce from whatsapp_inbound_events where provider_message_id=$1',[id])).rows[0];
  await f.db.query("select set_config('app.whatsapp_claim_nonce',$1,false)",[phase==='ack'?event.ack_reservation_nonce:event.reply_reservation_nonce]);
  await f.db.query('update whatsapp_inbound_events set '+(phase==='ack'?'owner_ack_claimed_at':'reply_claimed_at')+'=coalesce('+(phase==='ack'?'owner_ack_claimed_at':'reply_claimed_at')+',now()) where provider_message_id=$1',[id]);
 }
 const keys=Object.keys(args),r=await f.db.query('select public.'+name+'('+keys.map((k,i)=>k+'=>$'+(i+1)).join(',')+') value',keys.map(k=>args[k]));return {data:r.rows[0].value};
}
function options(o){if(!o?.supabase||o.supabase.auth)return o;const namespace=randomUUID();const supabase=new Proxy(o.supabase,{get(t,key){if(key==='rpc')return(name,args)=>{
 const control=['whatsapp_prepare_reply_reservation','whatsapp_rearm_unsent_reply','whatsapp_begin_reply_dispatch','whatsapp_release_reply_dispatch'].includes(name);
 if(name!=='whatsapp_dispatch_privacy_snapshot'&&!control)return t.rpc?.call(t,name,args);
 const task=queue.then(()=>control?sqlReplyControl(name,args,namespace):sqlSnapshot(args.p_workspace_id,args.p_phone));queue=task.catch(()=>{});return task;
 };const v=t[key];return typeof v==='function'?v.bind(t):v;}});return {...o,supabase};}
export const createWhatsAppOutbound=o=>outbound(options(o));
export const createApprovedReminderProvider=o=>approved(options(o));
export const createFirstPartyReminderProvider=o=>firstParty(options(o));
export const approvedReminderProof=o=>proof(options(o));
export const createWhatsAppInvoiceTestHandler=o=>invoiceTest(o?.loadSupabase?{...o,loadSupabase:(...args)=>options({supabase:o.loadSupabase(...args)}).supabase}:o);
