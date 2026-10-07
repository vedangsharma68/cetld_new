import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {pendingBlocksOwnerNextActions} from '../automation/whatsapp/owner-next-actions.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';

test('native read after a canceled attachment restores signed menus without erasing reversed payment history',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367051';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Synthetic studio',$1)).id",[randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const invoice=(await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,currency,total_amount,status,issue_date,due_date,metadata)
      values($1,$2,'INV-2026-0001','USD',100,'sent','2026-10-01','2099-01-01','{"invoice_direction":"receivable"}') returning *`,[workspaceId,customerId])).rows[0];
    const inbound=async(id,message)=>db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[id,phone,message]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    await db.query('select public.record_invoice_payment($1,$2,100,$3,$4,false)',[workspaceId,invoice.id,'synthetic-original','Original receipt']);
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    await inbound('reopen-source','Mark invoice INV-2026-0001 unpaid');
    const prepared=(await db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) value",[workspaceId,ownerId,phone,'reopen-source','Mark invoice INV-2026-0001 unpaid',invoice.id])).rows[0].value;
    assert.equal(prepared.ok,true);
    const pending=(await db.query("select id,version from whatsapp_pending_actions where action->>'proposalId'=$1",[prepared.proposalId])).rows[0];
    await inbound('reopen-confirm','yes');
    const reopened=(await db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'confirm',null,$6,$7,$8,null) value",[workspaceId,ownerId,phone,'reopen-confirm','yes',prepared.proposalId,pending.id,pending.version])).rows[0].value;
    assert.equal(reopened.completed,true);
    const review=(await db.query('select * from whatsapp_begin_invoice_review($1,$2,$3)',[workspaceId,customerId,phone])).rows[0];
    await db.query("select * from whatsapp_transition_invoice_review($1,$2,$3,$4,$5,'extracting',$6)",[review.id,review.version,workspaceId,customerId,phone,JSON.stringify({...review.action,stage:'canceled',failureCode:'EXTRACTION_UNAVAILABLE'})]);
    await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 minute' where id=$1",[review.id]);
    const snapshots=async()=>Promise.all(['invoices','payments','payment_reversals','whatsapp_pending_actions','invoice_correction_audits'].map(async table=>(await db.query(`select to_jsonb(t) value from ${table} t order by id`)).rows));
    const before=await snapshots();
    assert.equal(before[1].length,1);assert.equal(before[2].length,1);
    const message='Show invoice INV-2026-0001 and its edit options. Do not change any data.';
    await inbound('menu-read',message);let calls=0;const logs=[];
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',WHATSAPP_APP_SECRET:'isolated-menu-secret',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},
      logger:{info(label,data){logs.push({label,data});},warn(){},error(){}},fetchImpl:async(url,init)=>{
        assert.equal(new URL(url).hostname,'api.cloudflare.com');const wire=JSON.parse(init.body);calls++;
        if(calls===1)assert.ok(wire.tools?.some(tool=>tool.function.name==='workspaceData'));
        const reply=calls<=2?{content:'',tool_calls:[{id:`read-${calls}`,type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices',filters:[{column:'invoice_number',operator:'eq',value:'INV-2026-0001'}]})}}]}
          :{content:"Your invoice INV-2026-0001 is for $100 USD. It's unpaid with no payment made."};
        return Response.json({choices:[{message:reply,finish_reason:reply.tool_calls?'tool_calls':'stop'}]});
      }});
    const result=await handler({workspaceId,ownerId,customerId,phone,messageId:'menu-read',message});
    assert.deepEqual(result.buttons?.map(button=>button.title),['Edit details','Record payment'],JSON.stringify({result,logs,errors:f.errors}));
    assert.ok(result.buttons.every(button=>button.id.startsWith('ons1.')));
    assert.match(result.answer,/Current paid balance: USD 0/);assert.doesNotMatch(result.answer,/no payment made|never paid/i);
    assert.equal(calls,3);assert.equal(logs.filter(row=>row.label==='WhatsApp owner tool call').length,1);
    assert.deepEqual(await snapshots(),before);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('only terminal attachment reviews cease blocking menus; uncertain saves and unknown workflows stay blocked',()=>{
  for(const stage of ['canceled','failed','saved'])assert.equal(pendingBlocksOwnerNextActions({action:{type:'invoice_review_draft',stage}}),false,stage);
  for(const stage of ['extracting','incomplete','proposal','saving',undefined,'future'])assert.equal(pendingBlocksOwnerNextActions({action:{type:'invoice_review_draft',stage}}),true,String(stage));
  assert.equal(pendingBlocksOwnerNextActions({action:{type:'invoice_review_draft',stage:'saving',failureCode:'SAVE_UNVERIFIED'}}),true);
  for(const type of ['owner_invoice_payment','owner_workspace_data_change','future'])assert.equal(pendingBlocksOwnerNextActions({action:{type,stage:'canceled'}}),true,type);
});

test('zero invoice paid balance cannot establish absence of historical payments',()=>{
  const evidence=[{ok:true,readOnly:true,table:'invoices',operation:'read',rows:[{invoice_number:'INV-1',amount_paid:0,total_amount:100}]}];
  for(const answer of ['Invoice INV-1 has no payment made.','Invoice INV-1 has never been paid.','No payments have been recorded for invoice INV-1.',
    'There is no payment history for invoice INV-1.','The payment history is empty for INV-1.','No payments are in the history for INV-1.'])
    assert.ok(['fresh_database_read_required','unverified_action_result'].includes(ownerGroundingIssue(answer,evidence,'Show invoice INV-1')),answer);
  assert.equal(ownerGroundingIssue('Invoice INV-1 currently has a paid balance of USD 0.',evidence,'Show invoice INV-1'),null);
  assert.equal(ownerGroundingIssue('No payments made this month.',[{ok:true,readOnly:true,table:'payments',rows:[]}],'Show payments this month'),null);
});
