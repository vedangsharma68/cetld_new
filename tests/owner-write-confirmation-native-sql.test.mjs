import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';

test('owner customer confirmations match committed SQL rows and never request a model echo',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+15555550124';
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query('select (public.create_workspace($1,$2)).id',['Confirmation fixture',randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
    let proposed,providerCalls=0,echoCalls=0;
    const handler=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test',CLOUDFLARE_ACCOUNT_ID:'isolated',CLOUDFLARE_API_TOKEN:'isolated'},logger:{info(){},warn(){},error(){}},fetchImpl:async(url,init)=>{
      providerCalls++;assert.equal(new URL(url).hostname,'api.cloudflare.com');
      const body=JSON.parse(init.body);
      if(body.messages.some(item=>item.role==='tool')){
        echoCalls++;
        return Response.json({choices:[{finish_reason:'stop',message:{content:'Customer Pappa was added with phone 981868685252.'}}]});
      }
      // Even content accompanying the write call is untrusted model prose.
      return Response.json({choices:[{finish_reason:'tool_calls',message:{content:'Saved Wrong Name with phone 981868685252.',tool_calls:[{id:'customer-write',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(proposed)}}]}}]});
    }});
    const scope={workspaceId,ownerId,customerId,phone};
    const turn=async(id,message,args)=>{
      proposed=args;
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[id,phone,message]);
      return handler({...scope,messageId:id,message});
    };
    const assertRow=(reply,row,verb)=>{
      assert.equal(reply.answer,`${verb} customer.\nName: ${row.name}\nCompany: ${row.company_name??'none'}\nPhone: ${row.phone??'none'}\nEmail: ${row.email??'none'}\nCustom fields: ${JSON.stringify(row.custom_fields)}`);
      assert.doesNotMatch(reply.answer,/981868685252|Wrong Name|workspace_id|updated_at/);
    };
    const message='Add customer Pappa with phone 9818685252';
    const created=await turn('customer-create',message,{operation:'create',table:'customers',values:{name:'Pappa',phone:'9818685252'}});
    let row=(await db.query("select * from customers where workspace_id=$1 and name='Pappa'",[workspaceId])).rows[0];
    assert.ok(row,JSON.stringify(created));assert.equal(row.phone,'+919818685252');assertRow(created,row,'Created');
    assert.equal(providerCalls,1);assert.equal(echoCalls,0);
    const firstRow=structuredClone(row);
    const replay=await handler({...scope,messageId:'customer-create',message});
    assert.equal(replay.answer,created.answer);assert.equal(replay.replayed,true);assert.equal(providerCalls,1);
    assert.deepEqual((await db.query('select * from customers where id=$1',[row.id])).rows[0],firstRow);
    const updateMessage='Update Pappa: name Pappa — Sons, phone 9876543210, email pappa@example.test, company Pappa – Trading, credit limit 1234.5';
    const edited=await turn('customer-update',updateMessage,{
      operation:'update',table:'customers',filters:[{column:'name',operator:'eq',value:'Pappa'}],
      values:{name:'Pappa — Sons',phone:'9876543210',email:'pappa@example.test',company_name:'Pappa – Trading',custom_fields:{credit_limit:1234.5}},
    });
    row=(await db.query('select * from customers where id=$1',[row.id])).rows[0];
    assert.equal(row.name,'Pappa — Sons');assert.equal(row.phone,'+919876543210');assertRow(edited,row,'Updated');
    assert.equal(providerCalls,2);assert.equal(echoCalls,0);
    // Simulate recovery after commit but before the owner reply was persisted.
    await db.query("delete from whatsapp_messages where workspace_id=$1 and audience='owner' and idempotency_key='reply:customer-update'",[workspaceId]);
    const recovered=await handler({...scope,messageId:'customer-update',message:updateMessage});
    assertRow(recovered,row,'Previously updated');assert.equal(providerCalls,2);
    assert.deepEqual((await db.query('select * from customers where id=$1',[row.id])).rows[0],row);
    assert.equal((await db.query('select count(*)::int n from whatsapp_direct_write_receipts where workspace_id=$1',[workspaceId])).rows[0].n,2);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
