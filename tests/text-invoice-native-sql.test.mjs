import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {CF_PRIMARY_MODEL} from '../ai/provider.mjs';

test('owner text -> workspace tool -> Supabase SDK -> SQL -> verified reply, without outbound delivery',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367051';
  const clock=()=>new Date('2026-10-18T12:18:00Z');
  try{
    await db.query('insert into auth.users(id) values($1)',[ownerId]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Disposable QA','text-qa')).id")).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
    assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
    let current,providerCalls=0;
    const handler=createOwnerMessageHandler({supabase,clock,env:{NODE_ENV:'test'},logger:{info(){},warn(){},error(){}},
      providerFactory:()=>({async generate({messages}){
        providerCalls++;
        if(messages.some(item=>item.role==='tool'))return {model:CF_PRIMARY_MODEL,content:'Created invoice.'};
        return {model:CF_PRIMARY_MODEL,toolCalls:[{id:'text-create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({request:current})}}]};
      }})});
    const turn=async(messageId,message)=>{
      current=message;
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline',$2,'text',$3,'processing')",[messageId,phone,message]);
      return handler({workspaceId,ownerId,customerId,phone,messageId,message});
    };
    for(const [index,message] of [
      'QA TEXT TEST 1: New invoice for QA Text Customer, amount Rs 2,500, due 25 October 2026',
      'QA-EDGE-002 नया invoice 🧾🔥 for QA Emoji Customer ₹1,200 due kal, please check',
    ].entries()){
      const reply=await turn(`qa-native-${index}`,message);
      assert.match(reply.answer,/Created invoice/);
      const saved=(await db.query('select result from whatsapp_direct_write_receipts where provider_message_id=$1',[`qa-native-${index}`])).rows[0].result;
      assert.equal(saved.ok,true);assert.equal(Number(saved.record.total_amount),index?1200:2500);
      assert.equal(saved.record.due_date,index?'2026-10-19':'2026-10-25');
      const calls=providerCalls;
      const replay=await handler({workspaceId,ownerId,customerId,phone,messageId:`qa-native-${index}`,message});
      assert.equal(replay.replayed,true);assert.equal(replay.answer,reply.answer);assert.equal(providerCalls,calls);
    }
    const duplicate=await turn('qa-native-duplicate','New invoice QA-EDGE-002 for QA Emoji Customer, amount Rs 1,200, due 25 October 2026');
    assert.match(duplicate.answer,/already exists/);
    assert.equal((await db.query('select count(*)::int n from invoices')).rows[0].n,2);
    assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  }finally{await db.close();}
});
