import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {receivablesLedger} from './fixtures/receivables.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {createAssistantClient} from '../assistant-client.js';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

const logger={info(){},warn(){},error(){}};
const expected='Issued outstanding: INR 1.00, USD 255.06.\nUnissued drafts (not yet receivable): AUD 4490.00, INR 20496.00, USD 545.02.';

test('authenticated dashboard client and verified WhatsApp owner share the issued/draft contract over PostgreSQL and persist it in shared history',async()=>{
  const f=await createOfflineSqlNetwork(),{db}=f;
  try{
    const ownerId=randomUUID(),phone='+12025550108';
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    const asOwner=()=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}'`);
    const service=()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    await asOwner();
    const workspaceId=(await db.query("select (create_workspace('Receivables test business',$1)).id",[randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await service();
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const customer=(await db.query("insert into customers(workspace_id,name) values($1,'Test customer') returning id",[workspaceId])).rows[0].id;
    for(const row of receivablesLedger){const inserted=await db.query(`insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,amount_paid,status,metadata,deleted_at)
      values($1,$2,$3,'2026-10-01','2026-10-22',$4,$5,$6,$7,$8,$9) returning id`,[workspaceId,customer,row.invoice_number,row.currency,row.total_amount,row.amount_paid,row.status,row.metadata,null]);
      if(row.deleted_at){
        await db.exec('begin');
        await db.query('insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id) values(pg_backend_pid(),txid_current(),$1)',[inserted.rows[0].id]);
        await db.query('update invoices set deleted_at=$1,deleted_by=$3 where id=$2',[row.deleted_at,inserted.rows[0].id,ownerId]);
        await db.exec('commit');
      }
    }
    const before=(await db.query('select id,status,total_amount,amount_paid,deleted_at,metadata from invoices where workspace_id=$1 order by id',[workspaceId])).rows;
    let providerCalls=0;
    const provider={async generate(request){
      providerCalls++;
      if(!request.tools||request.messages.some(turn=>turn.role==='tool'))return {content:'Your outstanding balance is INR 20,497.00, USD 800.08, AUD 4,490.00.',model:'fixture'};
      const web=request.toolChoice==='required';
      return {toolCalls:[{id:'balance-'+providerCalls,type:'function',function:{name:web?'getOutstandingSummary':'workspaceData',arguments:JSON.stringify(web?{}:{operation:'read',table:'invoices',limit:50})}}],model:'fixture'};
    }};
    const fetchImpl=async(raw,init)=>{
      const url=new URL(raw);
      if(url.pathname==='/auth/v1/user')return Response.json({id:ownerId});
      if(url.searchParams.has('select'))url.searchParams.set('select',url.searchParams.get('select').replaceAll('::text',''));
      return f.fetchImpl(url,init);
    };
    const handler=createAIHandler({env:{NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'fixture'},fetchImpl,providerFactory:()=>provider,logger});
    const client=createAssistantClient({getAccessToken:async()=>'fixture-owner-token',fetchImpl:async(_url,init)=>{
      await asOwner();const body=JSON.parse(init.body);
      const res={setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
      await handler({method:'POST',headers:{authorization:init.headers.Authorization},query:{action:'assistant',workspaceId},body},res);
      assert.equal(res.code,200,JSON.stringify(res.data));
      return Response.json(res.data,{status:res.code});
    }});
    const web=await client.send({workspaceId,messages:[{role:'user',content:'How much is outstanding?'}]});
    assert.equal(web,expected);
    const planned=await client.send({workspaceId,messages:[{role:'user',content:'Please explain my outstanding balance.'}]});
    assert.equal(planned,expected,'a model cannot replace the split with the production draft-inclusive answer');
    await service();
    const messageId=randomUUID(),message='What is my total outstanding balance?';
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
    const wa=await createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},providerFactory:()=>provider,logger,replyStore:null})({workspaceId,ownerId,customerId,phone,messageId,message});
    assert.equal(wa.answer,expected,JSON.stringify(wa));
    assert.doesNotMatch(wa.answer,/20497|800\.08|workspace/i);
    assert.equal(wa.plannerFailure,undefined);
    const otherId=randomUUID(),otherMessage='Please tell me my outstanding balance.';
    await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[otherId,phone,otherMessage]);
    const plannedWa=await createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},providerFactory:()=>provider,logger,replyStore:null})({workspaceId,ownerId,customerId,phone,messageId:otherId,message:otherMessage});
    assert.equal(plannedWa.answer,expected,'planner-selected reads use the same raw-row split as bounded reads');
    await service();
    const history=(await db.query('select content from owner_assistant_turns where workspace_id=$1 and role=\'assistant\' order by id',[workspaceId])).rows;
    assert.equal(history.filter(row=>row.content===expected).length,4,'both transports store the same split in their shared conversation');
    assert.deepEqual((await db.query('select id,status,total_amount,amount_paid,deleted_at,metadata from invoices where workspace_id=$1 order by id',[workspaceId])).rows,before);
    for(const table of ['payments','whatsapp_pending_actions'])assert.equal((await db.query(`select count(*)::int n from ${table} where workspace_id=$1`,[workspaceId])).rows[0].n,0);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
