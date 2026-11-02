import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppPendingActionStore} from '../../automation/whatsapp/pending-actions.mjs';
import {extractInvoiceOffline} from '../../ai/extraction.mjs';
import {extractInvoiceFromImage} from '../../ai/image-text.mjs';
const phone='+919871367051';
const text=`Invoice No: INV-2026-0142
Bill to: Kabir Textiles
Invoice Date: 2026-10-20
Due Date: 2026-11-04
Subtotal: INR 17000
Tax: INR 3060
Total: INR 20060
Balance Due: INR 20060
Description Qty Rate Amount
Cotton 2 5000 10000
Silk 1 5000 5000
Dyes 2 1000 2000`;
export const png=Buffer.from([137,80,78,71,13,10,26,10,0]);
export const pdf=Buffer.from('%PDF-1.7\nfixture');
const env={EXTRACTION_ROUTE:'offline',WHATSAPP_APP_SECRET:'offline-test-buttons-secret'};
const logger={info(){},warn(){},error(){}};
const deny=()=>{assert.fail('No provider factory, model classifier, or external fetch may run');};

// Exercise the real image extractor with a local OCR worker fixture. The
// preprocessing/recognition boundaries are local; all downstream parsing is real.
export const imageExtractor=printed=>request=>extractInvoiceFromImage({...request,preprocessor:async bytes=>bytes,
  workerFactory:async()=>({recognize:async()=>({data:{text:printed,confidence:99}}),terminate:async()=>{}})});

export async function fixture({recording=false,providerFactory:providedFactory,navigation=false}={}){
  const f=await createOfflineSqlNetwork(),ownerId=randomUUID();
  await f.db.query('insert into auth.users(id) values($1)',[ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await f.db.query('select (public.create_workspace($1,$2)).id',['Offline Studio',randomUUID()])).rows[0].id;
  const verification=(await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
  const binding=(await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0];
  const scope={workspaceId,ownerId,customerId:binding.customer_id,phone};
  const pending=createWhatsAppPendingActionStore({supabase:f.supabase});
  let printed=text, pdfText=null;
  const providerRecord={constructions:0,calls:0,requests:[]};
  const routeEnv={...env};
  const makeHandler=()=>createOwnerMessageHandler({supabase:f.supabase,env:routeEnv,logger,providerFactory:providedFactory||(recording?()=>{providerRecord.constructions++;return {async generate(request){providerRecord.calls++;providerRecord.requests.push(JSON.parse(JSON.stringify(request)));return {content:'Summary'};}};}:deny),fetchImpl:deny,
    ...(recording||providedFactory?{}:{agentFactory:deny}),...(navigation?{}:{replyStore:null}),
    toolsFactory:options=>createOwnerWorkspaceTools({...options,extractOfflineAttachment:request=>extractInvoiceOffline({...request,
      imageExtractor:imageExtractor(printed),pdfTextExtractor:async()=>pdfText})})});
  let handler=makeHandler();
  let sequence=0;
  const turn=async(message,{media,interactionId,checkpoint}={})=>{
    const messageId='offline-'+(++sequence);
    await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,$3,$4,'processing')",[messageId,phone,media?'image':'text',message]);
    await f.db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'normal','received',$5,$5)",[workspaceId,scope.customerId,phone,message,messageId]);
    return handler({...scope,message,messageId,media,interactionId,checkpoint});
  };
  const count=async()=>Number((await f.db.query('select count(*) n from invoices')).rows[0].n);
  return {...f,scope,pending,turn,count,providerRecord,routeEnv,restart:()=>{handler=makeHandler();},setPrinted:value=>{printed=value;},setPdfText:value=>{pdfText=value;}};
}

