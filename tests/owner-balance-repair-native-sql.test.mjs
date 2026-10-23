import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';

test('owner outstanding read returns scoped per-currency totals and verified history, without sends or writes',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550342';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Balance fixture','balance-fixture')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    for(const [index,total]of [1500,2500,750].entries())await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,total_amount,amount_paid,currency,status,created_at,metadata)
      values($1,$2,'AUTO',$3,0,'INR','draft',$4,'{"invoice_direction":"receivable"}')`,[workspaceId,customerId,total,index===2?'2026-10-23T09:00:00Z':'2026-10-20T09:00:00Z']);
    const results=[];let calls=0;
    const handler=createOwnerMessageHandler({supabase,clock:()=>new Date('2026-10-23T09:48:00Z'),env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      toolsFactory:options=>{const tool=createOwnerWorkspaceTools(options);return {...tool,async execute(...args){const result=await tool.execute(...args);results.push(result);return result;}};},
      providerFactory:()=>({async generate({messages}){
        calls++;
        if(!messages.some(row=>row.role==='tool'))return {toolCalls:[{id:'read-balances',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'read',table:'invoices'})}}]};
        return {content:'Your total outstanding is INR 4,750.00. There is no payment history.'};
      }})});
    const turn=async id=>{
      const message='Please tell me my total outstanding balance?';
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
      return handler({workspaceId,ownerId,customerId,phone,messageId:id,message});
    };
    const before=(await db.query('select jsonb_agg(to_jsonb(i) order by id) value from invoices i')).rows[0].value;
    const response=await turn('balance-live-shape');
    assert.equal(response.plannerFailure,undefined);assert.equal(response.answer,'Issued outstanding: none.\nUnissued drafts (not yet receivable): INR 4750.00.');
    assert.equal(calls,1);assert.equal(results.length,1);
    const evidence=results[0];assert.equal(evidence.ok,true,JSON.stringify(evidence));
    assert.deepEqual(evidence.outstandingTotals,[]);
    assert.equal(evidence.balanceSummary.draftBalancesByCurrency.INR.outstandingAmount,'4750.00');
    assert.equal(evidence.paymentHistory.ok,true);assert.equal(evidence.paymentHistory.truncated,false);assert.deepEqual(evidence.paymentHistory.rows,[]);
    assert.equal(ownerGroundingIssue(response.answer,[evidence]),null);
    assert.equal(ownerGroundingIssue('Outstanding: Rs 4,751.00.',[evidence]),'fresh_database_read_required');
    assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(i) order by id) value from invoices i')).rows[0].value,before);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
