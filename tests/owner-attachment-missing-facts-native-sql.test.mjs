import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {authorizeOwnerPhone} from '../automation/whatsapp/owner-binding.mjs';
import {createOwnerScopedStore} from '../ai/whatsapp-channel.mjs';

const caption='Log this invoice as a receivable draft for this disposable QA fixture. Nothing has been paid. Never send customer reminders. Ask me if any required fact is missing.';
const question='What information is missing from the invoice photo I just sent?';

test('native missing-field follow-ups read matching reviews and never invent facts or retry creation',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550186';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Synthetic intake QA',$1)).id",[randomUUID()])).rows[0].id;
    const challenge=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,challenge.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const scope={workspaceId,ownerId,customerId,phone};
    const bytes=Buffer.from([255,216,255,217,1,8,6]);
    const inbound=async(id,message,photo=false)=>{
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref,owner_job_workspace_id,owner_job_owner_id) values($1,'fixture',$2,$3,$4,'processing',$5,$6,$7)",[id,phone,photo?'image':'text',message,photo?id:null,workspaceId,ownerId]);
      await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,customerId,phone,message,id]);
      if(photo)await db.query("insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,$1,'image/jpeg',$2,$3)",[id,bytes,bytes.length]);
    };
    const facts={invoiceNumber:'SYN-JPEG-100',customerName:'Synthetic QA Buyer',invoiceDate:'2026-10-09',dueDate:'2026-11-08',
      subtotal:100,tax:0,total:100,outstandingAmount:100,currency:'USD',direction:'uncertain',clientEmail:null,clientPhone:null,clientPhoneRaw:null,
      notes:null,paymentTerms:null,currencySource:null,addressHint:null,paymentStatus:'unpaid',paymentStatusEvidence:'UNPAID',
      lineItems:[{description:'Synthetic QA service',quantity:1,unitPrice:100,amount:100,confidence:.99}]};
    const wire={...Object.fromEntries(Object.entries(facts).flatMap(([key,value])=>[[key,value],[key+'Confidence',value==null?0:.99]])),lineItemsConfidence:.99};
    let chatCalls=0,extractionCalls=0;const logs=[];
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},
      providerFactory:options=>options.requestPurpose==='extraction'?{async generateStructured(call){
        extractionCalls++;return {data:call.validate(structuredClone(wire)),model:'fixture-extraction'};
      }}:{async generate({messages}){
        chatCalls++;const tool=messages.findLast(turn=>turn.role==='tool');
        if(!tool)return {model:'fixture-chat',toolCalls:[{id:'bad-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{status:'unpaid',total_amount:1}})}}]};
        const result=JSON.parse(tool.content);
        return {model:'fixture-chat',content:result.message||'The invoice photo is missing customer, dates, currency, total and line items.'};
      }}});
    // Reproduce an orphan photo after a failed generic create. A historical
    // terminal review must not supply missing fields for this new source.
    await db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,source,action,expires_at) values($1,$2,$3,'whatsapp',$4,now()-interval '1 minute')",[workspaceId,customerId,phone,{type:'invoice_review_draft',stage:'canceled',sourceMessageId:'old-photo',missingFields:['currency'],invoice:{clientName:'Old synthetic customer'}}]);
    await inbound('orphan-photo',caption,true);
    await inbound('orphan-question',question);
    const orphan=await handler({...scope,messageId:'orphan-question',message:question});
    assert.equal(orphan.plannerFailure,undefined,JSON.stringify(orphan));
    assert.match(orphan.answer,/do not have a verified review.*cannot identify missing fields/i);
    assert.match(orphan.answer,/resend the image or PDF/i);
    assert.doesNotMatch(orphan.answer,/Old synthetic|missing customer|issue date|due date|currency|line items/i);
    assert.equal(chatCalls,0);assert.equal(extractionCalls,0);
    // The same ordinary caption now uses real extraction/review SQL. Only
    // direction is uncertain; readable printed fields are never called missing.
    await inbound('fresh-photo',caption,true);
    const intake=await handler({...scope,messageId:'fresh-photo',message:caption,media:{bytes,mimeType:'image/jpeg',fileName:'synthetic.jpg'}});
    assert.equal(intake.plannerFailure,undefined,JSON.stringify(intake));
    assert.equal(extractionCalls,1);
    assert.match(intake.answer,/business issued the invoice/i);
    const before=(await db.query("select id,version,action,consumed_at from whatsapp_pending_actions where workspace_id=$1 and action->>'sourceMessageId'='fresh-photo'",[workspaceId])).rows[0];
    assert.equal(before.action.stage,'incomplete');assert.deepEqual(before.action.missingFields,['direction']);
    assert.equal(before.action.invoice.invoiceNumber,'SYN-JPEG-100');assert.equal(before.action.invoice.total,100);
    const chatBefore=chatCalls;
    await inbound('review-question',question);
    const reviewed=await handler({...scope,messageId:'review-question',message:question});
    assert.equal(reviewed.plannerFailure,undefined,JSON.stringify(reviewed));
    assert.match(reviewed.answer,/business issued the invoice/i);assert.match(reviewed.answer,/Nothing was saved/);
    assert.doesNotMatch(reviewed.answer,/missing customer|issue date|due date|currency|line items/i);
    assert.equal(chatCalls,chatBefore);assert.equal(extractionCalls,1);
    assert.deepEqual((await db.query('select id,version,action,consumed_at from whatsapp_pending_actions where id=$1',[before.id])).rows[0],before);
    // A newer orphan image changes the contextual target. The previous active
    // review remains unchanged and must not answer for that newer source.
    await inbound('new-orphan-photo',"Just tell me this photo's total. Do not save it.",true);
    await inbound('new-orphan-question',question);
    const newer=await handler({...scope,messageId:'new-orphan-question',message:question});
    assert.match(newer.answer,/cannot identify missing fields/i);
    assert.equal(chatCalls,chatBefore);assert.equal(extractionCalls,1);
    assert.deepEqual((await db.query('select id,version,action,consumed_at from whatsapp_pending_actions where id=$1',[before.id])).rows[0],before);
    for(const table of ['invoices','invoice_files','payments','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])
      assert.equal((await db.query(`select count(*)::int n from ${table} where workspace_id=$1`,[workspaceId])).rows[0].n,0,table);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where workspace_id=$1 and audience='customer'",[workspaceId])).rows[0].n,0);
    assert.equal(logs.filter(row=>row.label==='WhatsApp owner tool call'&&row.data.operation==='pending').length,3);
    const pending=createWhatsAppPendingActionStore({supabase});
    const nativeTools=(extra={})=>createOwnerWorkspaceTools({supabase,scope,pending,pendingAtStart:before,pendingInitialState:before,
      ownerStore:createOwnerScopedStore({supabase,...scope,authorize:()=>authorizeOwnerPhone({supabase,...scope})}),
      message:question,messageId:'fault-question',ownerHistory:[{role:'user',content:caption,providerMessageId:'fresh-photo'}],
      authorize:input=>authorizeOwnerPhone({supabase,...input}),logger:{error(){}},...extra});
    const unavailable=await nativeTools({pendingStoreAvailable:false}).execute('workspaceData',{operation:'pending'});
    assert.match(unavailable.message,/cannot read the invoice review/);assert.doesNotMatch(unavailable.message,/business issued/);
    const denied=await nativeTools({scope:{...scope,ownerId:randomUUID()}}).execute('workspaceData',{operation:'pending'});
    assert.equal(denied.ok,false);assert.doesNotMatch(denied.message,/business issued|SYN-JPEG/);
    // Change the actual SQL review after its first read, while the source
    // lookup is in flight. The final read must reject the old version.
    let reads=0;
    const racingPending={...pending,async loadPendingAction(input){
      const row=await pending.loadPendingAction(input);
      if(++reads===1)await db.query('update whatsapp_pending_actions set version=version+1 where id=$1',[before.id]);
      return row;
    }};
    const stale=await nativeTools({pending:racingPending}).execute('workspaceData',{operation:'pending'});
    assert.match(stale.message,/cannot identify missing fields/);assert.doesNotMatch(stale.message,/business issued|SYN-JPEG/);
    assert.equal(reads,2);
    assert.equal((await db.query('select version from whatsapp_pending_actions where id=$1',[before.id])).rows[0].version,before.version+1);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
