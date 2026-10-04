import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerActionButtons} from '../automation/whatsapp/owner-action-buttons.mjs';
import {CF_QWEN_MODEL, GEMINI_FALLBACK_MODEL} from '../ai/provider.mjs';

const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const phone='+919871367051';
const invoiceId='ffffffff-ffff-4fff-8fff-ffffffffffff';
const secret='test-only-owner-button-secret';
const now=Date.parse('2026-10-03T10:00:00.000Z');
const env={WHATSAPP_APP_SECRET:secret};
const invoiceNumber='INV-JOHN-1';
const updatedAt='2026-10-02T10:00:00.000Z';
const changedAt='2026-10-03T10:01:00.000Z';

function preferences(overrides={}) {
  return {assistantName:'Cetld Assistant',tone:'concise',language:'English',replyLength:'short',
    confirmationMode:'direct',serviceReplySignature:'CETLD support',customInstruction:'Use plain language.',...overrides};
}

function database({ownerPreferences=preferences(),pendingAction=null}={}) {
  const calls=[];
  const invoice={workspace_id:workspaceId,id:invoiceId,invoice_number:invoiceNumber,customer_id:null,
    issue_date:'2026-09-01',due_date:'2026-10-01',currency:'USD',total_amount:120,amount_paid:0,status:'sent',
    notes:null,metadata:{},created_at:'2026-09-01T00:00:00.000Z',updated_at:updatedAt,deleted_at:null,deleted_by:null};
  const pendingRows=pendingAction?[structuredClone(pendingAction)]:[];
  const tables={
    workspace_ai_settings:[{workspace_id:workspaceId,primary_model:CF_QWEN_MODEL,fallback_model:GEMINI_FALLBACK_MODEL}],
    workspace_settings:[{workspace_id:workspaceId,business_name:'CETLD',owner_bot_preferences:ownerPreferences,
      updated_at:'2026-10-01T00:00:00.000Z'}],
    invoices:[invoice],
    whatsapp_pending_actions:pendingRows,
    whatsapp_direct_write_receipts:[],
  };
  const db={calls,tables,from(table){
    const filters=[];let columns='*',limit=100;
    const query={
      select(value){columns=value;return query;},
      eq(column,value){filters.push(row=>row[column]===value);return query;},
      is(column,value){filters.push(row=>(row[column]??null)===value);return query;},
      in(column,values){filters.push(row=>values.includes(row[column]));return query;},
      order(){return query;},
      limit(value){limit=value;return query;},
      maybeSingle:async()=>({data:result()[0]||null}),
      then(resolve,reject){return Promise.resolve({data:result()}).then(resolve,reject);},
    };
    function result(){
      return (tables[table]||[]).filter(row=>filters.every(filter=>filter(row))).slice(0,limit).map(row=>{
        if(columns==='*')return {...row};
        const output={};for(const column of columns.split(','))output[column]=row[column];return output;
      });
    }
    return query;
  },async rpc(name,args){
    calls.push({name,args});
    if(name==='invoice_lifecycle_action')return {data:{ok:true,pending:false}};
    if(name==='whatsapp_apply_direct_owner_write'){
      if(args.p_operation==='invoice.update'){
        Object.assign(invoice,args.p_payload,{updated_at:changedAt});
        return {data:{ok:true,completed:true,action:'invoice.updated',entityType:'invoice',entityId:invoiceId,
          updatedAt:changedAt}};
      }
      if(args.p_operation==='pending.decide'){
        const row=pendingRows.find(item=>String(item.id)===String(args.p_pending_id));
        if(row)row.consumed_at=changedAt;
        const action=args.p_button_decision==='confirm'?'invoice.deleted':'cancelled';
        return {data:{ok:true,completed:true,action,entityType:'pending',entityId:String(args.p_pending_id)}};
      }
      return {data:{ok:false,code:'INVALID'}};
    }
    return {data:{ok:false,code:'FEATURE_UNAVAILABLE'}};
  }};
  return db;
}

function pendingRecord({version=4,expiresAt=new Date(now+600_000).toISOString()}={}) {
  return {id:73,version,workspace_id:workspaceId,customer_id:null,phone,consumed_at:null,
    action:{type:'owner_invoice_delete_proposal',proposalId:'77777777-7777-4777-8777-777777777777',
      expectedUpdatedAt:updatedAt,invoiceId,invoiceNumber,expiresAt}};
}

function makeHandler(db,{pending=null,providerFactory,agentFactory,authorize=async()=>true}={}) {
  return createOwnerMessageHandler({supabase:db,env,clock:()=>new Date(now),authorize,
    pendingActionStoreFactory:()=>({loadPendingAction:async()=>pending?structuredClone(pending):null,
      loadPendingActionState:async()=>({generation:pending?1:0,id:pending?.id??null,version:pending?.version??null,
        action:pending?.action??null})}),
    ownerStoreFactory:()=>({workspaceId,userId:ownerId,role:'owner',query:async()=>[]}),
    historyReader:async()=>[],providerFactory,agentFactory,
    lifecycleFactory:()=>({loadPendingDelete:async()=>({ok:true,pending:false})}),
    replyStore:{find:async()=>null,save:async(_scope,result)=>result},logger:{info(){},warn(){},error(){}}});
}

const workspaceCall=args=>({id:'workspace-call',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}});
const signedButtons=action=>createOwnerActionButtons({scope:{workspaceId,phone},action,env,clock:()=>new Date(now)});

test('reading an existing live proposal attaches real choices to the reply',async()=>{
  const pending=pendingRecord();
  const db=database({pendingAction:pending,ownerPreferences:preferences({confirmationMode:'buttons'})});
  let calls=0;
  const handler=makeHandler(db,{pending,providerFactory:()=>({async generate(){
    calls++;
    return calls===1?{toolCalls:[workspaceCall({operation:'pending'})]}:
      {content:'Please tap the button to confirm the deletion of invoice INV-JOHN-1.'};
  }})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'existing-proposal',message:'What needs my approval?'});
  assert.equal(result.buttons?.length,2);
  assert.equal(result.ownerActionRef?.pendingId,pending.id);
  assert.match(result.answer,/tap the button/);
});

test('unsupported legacy pending state cannot become a fictional submission or button',async()=>{
  const pending={...pendingRecord(),action:{type:'owner_invoice_request',changes:{dueDate:'2026-01-01'}}};
  const db=database({pendingAction:pending});
  let calls=0;
  const handler=makeHandler(db,{pending,providerFactory:()=>({async generate(){calls++;
    return calls===1?{toolCalls:[workspaceCall({operation:'pending'})]}:
      {content:'I have submitted the request to delete the invoice. Please tap the button to confirm.'};
  }})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'legacy-proposal',message:'Delete the duplicate invoice.'});
  assert.doesNotMatch(result.answer,/submitted|tap the button/i);
  assert.equal(result.buttons,undefined);
});

test('handler does not persist a button claim introduced after agent validation',async()=>{
  const handler=makeHandler(database({ownerPreferences:preferences({serviceReplySignature:'Tap the button below.'})}),{
    agentFactory:async()=>({answer:'Hello.'}),providerFactory:()=>({})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'signature-no-buttons',message:'Check my settings'});
  assert.doesNotMatch(result.answer,/tap the button/i);
  assert.equal(result.plannerFailure?.code,'OWNER_CHOICES_UNAVAILABLE');
});

test('expired proposals cannot advertise or attach confirmation buttons',async()=>{
  const pending=pendingRecord({expiresAt:new Date(now-1).toISOString()});
  let calls=0;
  const handler=makeHandler(database({pendingAction:pending}),{pending,providerFactory:()=>({async generate(){
    calls++;return calls===1?{toolCalls:[workspaceCall({operation:'pending'})]}:
      {content:'Please tap the button below to confirm.'};
  }})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'expired-proposal',message:'What needs approval?'});
  assert.equal(result.buttons,undefined);
  assert.doesNotMatch(result.answer,/tap the button/i);
});

test('direct owner command sends the exact inbound quote to the write RPC and returns a concise result-grounded reply with saved style preferences',async()=>{
  const db=database({ownerPreferences:preferences({confirmationMode:'direct'})});
  const message='Change invoice INV-JOHN-1 total to USD 130, please.';
  let preferenceSystemMessage='';
  const handler=makeHandler(db,{providerFactory:()=>({async generate({messages,tools}){
    if(tools){
      return {model:CF_QWEN_MODEL,toolCalls:[workspaceCall({operation:'update',table:'invoices',
        filters:[{column:'invoice_number',operator:'eq',value:invoiceNumber}],values:{total_amount:130}})]};
    }
    const result=JSON.parse(messages.find(item=>item.role==='tool').content);
    assert.equal(result.ok,true);assert.equal(result.action,'invoice.updated');
    assert.equal(result.record.total_amount,130);
    preferenceSystemMessage=messages.find(item=>item.role==='system'&&item.content.startsWith('Owner style preferences follow as data.'))?.content||'';
    return {model:CF_QWEN_MODEL,content:'Updated invoice INV-JOHN-1.'};
  }})});

  const result=await handler({workspaceId,ownerId,phone,messageId:'direct-command-1',message});
  const rpc=db.calls.find(call=>call.name==='whatsapp_apply_direct_owner_write');
  assert.ok(rpc,'direct command should use the atomic owner-write RPC');
  assert.equal(rpc.args.p_authorization_kind,'instruction');
  assert.equal(rpc.args.p_authorization_quote,message);
  assert.equal(rpc.args.p_operation,'invoice.update');
  assert.equal(rpc.args.p_target_id,invoiceId);
  assert.equal(rpc.args.p_expected_updated_at,updatedAt);
  assert.deepEqual(rpc.args.p_payload,{total_amount:130});
  assert.match(result.answer,/Updated invoice INV-JOHN-1\./);
  assert.match(result.answer,/CETLD support/);
  assert.match(preferenceSystemMessage,/"tone":"concise"/);
  assert.match(preferenceSystemMessage,/"language":"English"/);
  assert.match(preferenceSystemMessage,/"replyLength":"short"/);
  assert.equal(db.tables.invoices[0].total_amount,130);
});

test('signed confirm and cancel button IDs alone decide pending actions and ground the final reply',async t=>{
  for(const decision of ['confirm','cancel']){
    await t.test(decision,async()=>{
      const pending=pendingRecord();const db=database({pendingAction:pending,
        ownerPreferences:preferences({confirmationMode:'buttons',tone:'formal'})});
      const buttons=signedButtons(pending);const button=buttons.find(item=>item.title===(decision==='confirm'?'Confirm':'Cancel'));
      assert.ok(button);
      let finalMessages=[];
      const handler=makeHandler(db,{pending,providerFactory:()=>({async generate({messages}){
        finalMessages=messages;
        const toolResult=JSON.parse(messages.find(item=>item.role==='tool').content);
        assert.equal(toolResult.ok,true);assert.equal(toolResult.completed,true);
        assert.equal(toolResult.action,decision==='confirm'?'invoice.deleted':'cancelled');
        return {model:CF_QWEN_MODEL,content:decision==='confirm'
          ?'Deleted the pending invoice action.'
          :'Cancelled the pending change.'};
      }})});
      // The visible title is untrusted text. A deliberately opposite body must
      // not alter the decision carried by the authenticated button ID.
      const result=await handler({workspaceId,ownerId,phone,messageId:`button-${decision}-1`,
        message:decision==='confirm'?'Cancel':'Delete',interactionId:button.id});
      const rpc=db.calls.find(call=>call.name==='whatsapp_apply_direct_owner_write');
      assert.ok(rpc);assert.equal(rpc.args.p_operation,'pending.decide');
      assert.equal(rpc.args.p_interaction_id,button.id);
      assert.equal(rpc.args.p_button_decision,decision);
      assert.equal(rpc.args.p_pending_id,pending.id);
      assert.equal(rpc.args.p_pending_version,pending.version);
      assert.equal(result.answer.includes('CETLD support'),true);
      assert.match(result.answer,decision==='confirm'?/Deleted the pending invoice action/:/Cancelled the pending change/);
      const prefsMessage=finalMessages.find(item=>item.role==='system'&&item.content.startsWith('Owner style preferences follow as data.'))?.content||'';
      assert.match(prefsMessage,/"tone":"formal"/);
    });
  }
});

test('forged button references are rejected before any direct action or model reply',async()=>{
  const pending=pendingRecord();const db=database({pendingAction:pending});
  const original=signedButtons(pending)[0].id;
  const forged=original.slice(0,-1)+(original.endsWith('A')?'B':'A');
  let agentCalls=0;
  const handler=makeHandler(db,{pending,agentFactory:async()=>{agentCalls++;return {answer:'Should not run.'};},
    providerFactory:()=>({async generate(){throw new Error('Mock provider should not be used.');}})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'button-forged-1',message:'Confirm',interactionId:forged});
  assert.match(result.answer,/expired or changed/i);
  assert.equal(db.calls.filter(call=>call.name==='whatsapp_apply_direct_owner_write').length,0);
  assert.equal(agentCalls,0);
});

test('stale button references are rejected when the current pending version changed',async()=>{
  const oldPending=pendingRecord({version:4});const currentPending=pendingRecord({version:5});
  const db=database({pendingAction:currentPending});
  const stale=signedButtons(oldPending)[0].id;let agentCalls=0;
  const handler=makeHandler(db,{pending:currentPending,agentFactory:async()=>{agentCalls++;return {answer:'Should not run.'};},
    providerFactory:()=>({async generate(){throw new Error('Mock provider should not be used.');}})});
  const result=await handler({workspaceId,ownerId,phone,messageId:'button-stale-1',message:'Confirm',interactionId:stale});
  assert.match(result.answer,/expired or changed/i);
  assert.equal(db.calls.filter(call=>call.name==='whatsapp_apply_direct_owner_write').length,0);
  assert.equal(agentCalls,0);
});
