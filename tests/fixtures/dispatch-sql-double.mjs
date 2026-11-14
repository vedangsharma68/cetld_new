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
function options(o){if(!o?.supabase||o.supabase.auth)return o;const supabase=new Proxy(o.supabase,{get(t,key){if(key==='rpc')return(name,args)=>{if(name!=='whatsapp_dispatch_privacy_snapshot')return t.rpc?.call(t,name,args);const task=queue.then(()=>sqlSnapshot(args.p_workspace_id,args.p_phone));queue=task.catch(()=>{});return task;};const v=t[key];return typeof v==='function'?v.bind(t):v;}});return {...o,supabase};}
export const createWhatsAppOutbound=o=>outbound(options(o));
export const createApprovedReminderProvider=o=>approved(options(o));
export const createFirstPartyReminderProvider=o=>firstParty(options(o));
export const approvedReminderProof=o=>proof(options(o));
export const createWhatsAppInvoiceTestHandler=o=>invoiceTest(o?.loadSupabase?{...o,loadSupabase:(...args)=>options({supabase:o.loadSupabase(...args)}).supabase}:o);
