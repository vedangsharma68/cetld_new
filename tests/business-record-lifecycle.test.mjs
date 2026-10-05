import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {businessRecordsView} from '../custom-fields.mjs';

test('real SDK and SQL recoverable delete/restore agree with scoped assistant reads and dashboard',async()=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f,owner=randomUUID(),phone='+919871367051';
  try{
    await db.query('insert into auth.users(id) values($1)',[owner]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
    const workspaceId=(await db.query("select (public.create_workspace('Lifecycle fixture',$1)).id",['lifecycle-'+randomUUID()])).rows[0].id;
    const code=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0].code;
    await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) as result',[phone,code])).rows[0].result.ok,true);
    const customerId=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const scope={workspaceId,ownerId:owner,customerId,phone};
    async function tools(message,id){
      await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[id,phone,message]);
      return createOwnerWorkspaceTools({supabase,scope,message,messageId:id,authorize:async()=>true,botPreferences:{confirmationMode:'direct'},pendingStoreAvailable:false,ownerStore:{async query(){throw Error('Legacy tool must not run');}}});
    }
    const create=await tools('Add supplier John Smith','lifecycle-create');
    const created=await create.execute('workspaceData',{operation:'create',table:'business_records',values:{record_type:'supplier',name:'John Smith',custom_fields:{city:'Mumbai',check_count:3}}});
    assert.equal(created.completed,true,JSON.stringify(created));
    const target=[{column:'name',operator:'eq',value:'JohnSmith'}];
    const remove=await tools('Delete supplier JohnSmith','lifecycle-delete');
    const rpc=supabase.rpc.bind(supabase);let interrupted=false;
    supabase.rpc=async(name,args)=>{const result=await rpc(name,args);if(!interrupted&&args.p_operation==='business_record.delete'){interrupted=true;throw Error('Fixture lost response after commit');}return result;};
    const uncertain=await remove.execute('workspaceData',{operation:'delete',table:'business_records',filters:target});
    assert.equal(uncertain.completed,false);assert.equal(remove.getWriteAttempted(),true);
    const deleted=await remove.lookupCompleted();
    assert.equal(deleted.completed,true,JSON.stringify(deleted));assert.equal(deleted.action,'business_record.deleted');
    assert.equal((await remove.lookupCompleted()).completed,true);
    const read=await tools('Show suppliers','lifecycle-read');
    assert.equal((await read.execute('workspaceData',{operation:'read',table:'business_records'})).rows.length,0);
    const retained=(await db.query('select * from business_records where workspace_id=$1',[workspaceId])).rows;
    assert.equal(retained.length,1);assert.equal(retained[0].custom_fields.check_count,3);
    assert(!businessRecordsView(retained,String).includes('John Smith'));
    const restore=await tools('Restore supplier JohnSmith','lifecycle-restore');
    const restored=await restore.execute('workspaceData',{operation:'restore',table:'business_records',filters:target});
    assert.equal(restored.completed,true,JSON.stringify(restored));assert.equal(restored.action,'business_record.restored');
    const restoredRead=await read.execute('workspaceData',{operation:'read',table:'business_records'});
    assert.equal(restoredRead.rows.length,1);assert.deepEqual(restoredRead.rows[0].custom_fields,{city:'Mumbai',check_count:3});
    assert(businessRecordsView((await db.query('select * from business_records where workspace_id=$1',[workspaceId])).rows,String).includes('John Smith'));
    for(const request of f.requests.filter(request=>request.method==='GET'))assert.equal(new URL(request.url).searchParams.get('workspace_id'),'eq.'+workspaceId);
    assert.equal(f.errors.length,0,JSON.stringify(f.errors));
  }finally{await f.close();}
});
