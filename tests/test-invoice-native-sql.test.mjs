import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {syncEligibility} from '../automation/invoice-sync.mjs';
import {createInvoiceReconcileStore} from '../automation/invoice-sync-reconciler.mjs';

async function fixture(){
  const f=await createOfflineSqlNetwork(),owner=randomUUID(),member=randomUUID(),stranger=randomUUID();
  await f.db.query('insert into auth.users(id) values($1),($2),($3)',[owner,member,stranger]);
  const identity=async(actor=owner,role='authenticated')=>{
    await f.db.exec('reset role');
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[actor||'',role]);
    await f.db.exec(`set role ${role}`);
  };
  await identity();
  const ws=(await f.db.query('select (public.create_workspace($1,$2)).id',['Supported test invoices',randomUUID()])).rows[0].id;
  await f.db.query("insert into workspace_members(workspace_id,user_id,role) values($1,$2,'member')",[ws,member]);
  const customer=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Pappa','+919818685252') returning id",[ws])).rows[0].id;
  const other=(await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Unrelated customer','+12025550129') returning id",[ws])).rows[0].id;
  const create=async(request=randomUUID())=>(await f.db.query('select to_jsonb(public.create_test_invoice($1,$2)) row',[ws,request])).rows[0].row;
  const read=async id=>(await f.db.query('select to_jsonb(i) row from invoices i where id=$1',[id])).rows[0]?.row;
  return {...f,owner,member,stranger,ws,customer,other,identity,create,read};
}

test('supported test-invoice RPC authenticates the owner, fixes recipient and amount, and replays without granting consent',async()=>{
  const f=await fixture();try{
    const counts=async()=>(await f.db.query('select (select count(*) from whatsapp_consents)::int consents,(select count(*) from whatsapp_suppressions)::int suppressions,(select count(*) from customers where workspace_id=$1)::int customers',[f.ws])).rows[0];
    const before=await counts(),request=randomUUID();
    const row=await f.create(request);
    assert.equal(row.customer_id,f.customer);assert.equal(row.customer_phone,'+919818685252');
    assert.equal(row.currency,'INR');assert.equal(Number(row.total_amount),1);assert.equal(Number(row.amount_paid),0);
    assert.equal(row.metadata.test_invoice,true);assert.equal(row.metadata.invoice_direction,'receivable');
    assert.equal(row.invoice_number,`CETLD-TEST-${request}-NO-PAYMENT-REQUIRED`);
    assert.equal(row.metadata.source_invoice_number,row.invoice_number);
    assert.equal(row.status,'sent');assert.equal(row.followup_state,'draft');assert.equal(row.next_follow_up_at,null);
    assert.equal(row.external_provider,null);assert.equal(row.external_invoice_id,null);assert.equal(row.sync_status,'local');
    assert.equal(syncEligibility(row),'excluded');
    assert.equal((await f.create(request)).id,row.id);
    assert.deepEqual(await counts(),before);
    for(const actor of [f.member,f.stranger]){
      await f.identity(actor);
      await assert.rejects(f.create(),{code:'42501'});
    }
    await f.identity(null,'service_role');
    await assert.rejects(f.create(),{code:'42501'});
    await assert.rejects(f.db.query('select * from app.test_invoice_creations'),{code:'42501'});
    await f.identity();
    assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,1);
    // An ordinary contact edit cannot retarget this fixture or its later reminders.
    await assert.rejects(f.db.query("update customers set phone='+12025550128' where id=$1",[f.customer]),{code:'42501',message:'TEST_INVOICE_RECIPIENT_LOCKED'});
    await assert.rejects(f.db.query("update customers set name='Unrelated customer' where id=$1",[f.customer]),{code:'42501',message:'TEST_INVOICE_RECIPIENT_LOCKED'});
    // The route must not create or repurpose a near-match contact.
    const emptyWs=(await f.db.query('select (public.create_workspace($1,$2)).id',['No authorized test contact',randomUUID()])).rows[0].id;
    await f.db.query("insert into customers(workspace_id,name,phone) values($1,'Pappa','+12025550128')",[emptyWs]);
    await assert.rejects(f.db.query('select public.create_test_invoice($1,$2)',[emptyWs,randomUUID()]));
    assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[emptyWs])).rows[0].n,0);
    await f.identity();
    const forgedKey=randomUUID();
    await assert.rejects(f.db.query('select public.create_paid_assistant_invoice($1,$2,$3,current_date,current_date,$4,1,null,$5,$6,null)',[
      f.ws,f.customer,'AUTO','INR',{invoice_direction:'receivable',assistant_idempotency_key:forgedKey,test_invoice:true},forgedKey,
    ]),{code:'42501'});
    assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,1);
  }finally{await f.close();}
});

test('all raw owner/member/service updates refuse test marker stripping, retrofits, recipient changes and provider links',async()=>{
  const f=await fixture();try{
    const row=await f.create();
    const real=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'AUTO',12,'{\"invoice_direction\":\"receivable\"}') returning id",[f.ws,f.other])).rows[0];
    const original=await f.read(row.id);
    const patch=async(id,key,value)=>f.db.query(`update invoices set ${key}=$1 where id=$2`,[value,id]);
    for(const [actor,role] of [[f.owner,'authenticated'],[f.member,'authenticated'],[null,'service_role']]){
      await f.identity(actor,role);
      for(const value of [false,null,'true',{},undefined]){
        const metadata={...original.metadata};
        if(value===undefined)delete metadata.test_invoice;else metadata.test_invoice=value;
        await assert.rejects(patch(row.id,'metadata',metadata),{code:'42501'});
      }
      for(const metadata of [{}, {...original.metadata,source_invoice_number:'REAL-123'}, {...original.metadata,client_phone:'+12025550127'}, {...original.metadata,debtor_phone:'+12025550127'}])
        await assert.rejects(patch(row.id,'metadata',metadata),{code:'42501'});
      for(const [key,value] of [['invoice_number','REAL-123'],['total_amount',2],['currency','USD'],['customer_id',f.other],['customer_phone','+12025550127']])
        await assert.rejects(patch(row.id,key,value),{code:'42501'});
      const realBefore=await f.read(real.id);
      for(const metadata of [{...realBefore.metadata,test_invoice:true},{...realBefore.metadata,source_invoice_number:row.metadata.source_invoice_number}])
        await assert.rejects(patch(real.id,'metadata',metadata),{code:'42501'});
      await assert.rejects(patch(real.id,'invoice_number',row.invoice_number),{code:'42501'});
      for(const [number,metadata] of [
        ['AUTO',{test_invoice:true}],['AUTO',{test_invoice:'true'}],
        ['AUTO',{source_invoice_number:original.invoice_number}],[`CETLD-TEST-${randomUUID()}`,{}],
      ])await assert.rejects(f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,currency,total_amount,metadata) values($1,$2,$3,'INR',1,$4)",[f.ws,f.customer,number,{invoice_direction:'receivable',...metadata}]),{code:'42501'});
      assert.deepEqual(await f.read(row.id),original);
    }
    await f.identity(null,'service_role');
    for(const [key,value] of [['external_provider','zoho_books'],['external_invoice_id','provider-id'],['last_synced_at','2026-10-24T00:00:00Z'],['sync_status','synced']])
      await assert.rejects(patch(row.id,key,value),{code:'42501',message:'INVOICE_NOT_EXPORTABLE'});
    for(const metadata of [
      {...original.metadata,accounting_provider:'quickbooks'},
      {...original.metadata,accounting_external_invoice_id:'provider-id'},
      {...original.metadata,bookkeeping_provider:'zoho_books'},
      {...original.metadata,bookkeeping_record_id:'provider-id'},
      {...original.metadata,bookkeeping_sync_status:'synced'},
    ])await assert.rejects(patch(row.id,'metadata',metadata),{code:'42501',message:'INVOICE_NOT_EXPORTABLE'});
    assert.deepEqual(await f.read(row.id),original);
    // Ordinary receivables keep their existing write and export behavior.
    await patch(real.id,'metadata',{...(await f.read(real.id)).metadata,bookkeeping_record_id:'ordinary-provider-id',bookkeeping_provider:'zoho_books',bookkeeping_sync_status:'synced'});
    await patch(real.id,'external_provider','zoho_books');await patch(real.id,'external_invoice_id','ordinary-provider-id');
    assert.equal(syncEligibility(await f.read(real.id)),'synced');
    // A future metadata-writing BEFORE trigger also cannot erase the marker
    // after the normal input guard has run: the final persisted-row check wins.
    await f.db.exec(`reset role;
      create function app.fixture_late_strip_test_invoice() returns trigger language plpgsql as $$
        begin new.metadata:=new.metadata-'test_invoice';return new;end $$;
      create trigger zzzzzzzzzzzzzzzzzzzzzzzz_fixture_late_test_strip before update on public.invoices
        for each row execute function app.fixture_late_strip_test_invoice();`);
    await f.identity(null,'service_role');
    await assert.rejects(patch(row.id,'notes','A future trigger must not strip this marker.'),{code:'42501'});
    assert.deepEqual(await f.read(row.id),original);
    // Even stripping all markers during creation cannot escape enrollment.
    await f.db.exec(`reset role;
      drop trigger zzzzzzzzzzzzzzzzzzzzzzzz_fixture_late_test_strip on public.invoices;
      create function app.fixture_late_erase_test_identity() returns trigger language plpgsql as $$
        begin new.metadata:=new.metadata-'test_invoice'-'source_invoice_number';new.invoice_number:='REAL-ERASED';return new;end $$;
      create trigger zzzzzzzzzzzzzzzzzzzzzzzz_fixture_late_test_erase before insert on public.invoices
        for each row execute function app.fixture_late_erase_test_identity();`);
    await f.identity();
    await assert.rejects(f.create(),{code:'42501'});
    assert.equal((await f.db.query('select count(*)::int n from invoices where workspace_id=$1',[f.ws])).rows[0].n,2);
  }finally{await f.close();}
});

test('creating test invoices does not change the next real invoice number inferred from business history',async()=>{
  const f=await fixture();try{
    await f.identity(null,'service_role');
    const real=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,'REAL-0041',12,$3) returning invoice_number",[
      f.ws,f.other,{invoice_direction:'receivable',source_owner_invoice_number:'REAL-0041'},
    ])).rows[0];
    assert.equal(real.invoice_number,'REAL-0041');
    await f.identity();
    for(let i=0;i<4;i++)await f.create();
    // Ordinary owner/bot creation leaves this NULL for the numbering trigger.
    // The early test guard must not mistake SQL NULL for reserved test mode.
    const next=(await f.db.query("insert into invoices(workspace_id,customer_id,invoice_number,total_amount,metadata) values($1,$2,null,12,'{\"invoice_direction\":\"receivable\"}') returning invoice_number",[f.ws,f.other])).rows[0];
    assert.equal(next.invoice_number,'REAL-0042');
  }finally{await f.close();}
});

test('owner correction, soft deletion and restore preserve permanent exclusion and test naming',async()=>{
  const f=await fixture();try{
    const row=await f.create();
    const correct=async values=>{
      const current=await f.read(row.id);
      return (await f.db.query('select public.owner_correct_invoice($1,$2,$3,$4,$5) result',[f.ws,row.id,current.updated_at,randomUUID(),values])).rows[0].result;
    };
    for(const values of [{invoice_number:'REAL-123'},{total_amount:2},{customer_id:f.other},{currency:'USD'},{invoice_direction:'payable'},{test_invoice:false},{metadata:{test_invoice:false}}]){
      assert.equal((await correct(values)).ok,false,JSON.stringify(values));
      assert.equal((await f.read(row.id)).metadata.test_invoice,true);
    }
    const currentYear=new Date().getUTCFullYear();
    const due=`${currentYear+1}-12-31`;
    const benign=await correct({due_date:due,notes:'Still a test; no payment required.'});
    assert.equal(benign.ok,true,JSON.stringify(benign));
    const changed=await f.read(row.id);
    assert.equal(changed.due_date,due);assert.equal(changed.invoice_number,row.invoice_number);
    assert.equal(changed.metadata.test_invoice,true);assert.equal(changed.metadata.source_invoice_number,row.metadata.source_invoice_number);
    assert.equal(syncEligibility(changed),'excluded');
    const lifecycle=async(action,fields={})=>(await f.db.query('select public.invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,$6,null,$7) result',[
      action,f.ws,fields.invoiceId||null,fields.proposalId||null,fields.idempotencyKey||null,fields.message||null,fields.confirmationMessageId||null,
    ])).rows[0].result;
    const proposal=await lifecycle('prepare',{invoiceId:row.id,idempotencyKey:`test_delete_${randomUUID()}`});
    assert.equal(proposal.ok,true,JSON.stringify(proposal));
    const deleted=await lifecycle('confirm',{proposalId:proposal.proposalId,message:'yes',confirmationMessageId:`test_delete_confirm_${randomUUID()}`});
    assert.equal(deleted.ok,true,JSON.stringify(deleted));
    await f.identity(null,'service_role');
    const tombstone=await f.read(row.id);assert.ok(tombstone.deleted_at);assert.equal(tombstone.metadata.test_invoice,true);assert.equal(syncEligibility(tombstone),'excluded');
    await f.identity();
    const restored=await lifecycle('undo',{invoiceId:row.id,idempotencyKey:`test_restore_${randomUUID()}`});
    assert.equal(restored.ok,true,JSON.stringify(restored));
    const active=await f.read(row.id);assert.equal(active.deleted_at,null);assert.equal(active.metadata.test_invoice,true);
    assert.equal(active.invoice_number,row.invoice_number);assert.equal(syncEligibility(active),'excluded');
    assert.equal(active.followup_state,'paused','restore still requires the existing reminder review path');
  }finally{await f.close();}
});

test('the reconciler exclusion predicate executes with PostgreSQL null semantics and retains ordinary invoices',async()=>{
  const f=await fixture();try{
    let predicate;
    const store=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'offline-only'},fetchImpl:async url=>{
      predicate=new URL(url).searchParams.get('and');return Response.json([]);
    }});
    await store.candidates([{workspace_id:f.ws,owner_id:f.owner}],new Date().toISOString());
    const facts=[
      ['real-missing',{}],['real-false',{test_invoice:false}],
      ['flag-true',{test_invoice:true}],['flag-string',{test_invoice:'true'}],
      ['source-only',{source_invoice_number:'CETLD-TEST-source'}],['CETLD-TEST-number-only',{}],
      ['payable',{invoice_direction:'payable'}],['exhausted',{bookkeeping_sync_exhausted:true}],
    ];
    const args=facts.flatMap(([number,metadata])=>[number,JSON.stringify(metadata)]);
    const bind=value=>{args.push(value);return '$'+args.length;};
    const split=value=>{
      const parts=[];let start=0,depth=0;
      for(let i=0;i<value.length;i++){
        if(value[i]==='(')depth++;else if(value[i]===')')depth--;
        else if(value[i]===','&&depth===0){parts.push(value.slice(start,i));start=i+1;}
      }
      parts.push(value.slice(start));return parts;
    };
    // Execute the actual generated PostgREST conjunction, translating only
    // its small documented grammar to SQL. This checks NULL/false behavior,
    // not just the presence of exclusion text in a URL.
    const sql=expression=>{
      const group=/^(or|and)\((.*)\)$/.exec(expression);
      if(group)return '('+split(group[2]).map(sql).join(group[1]==='or'?' or ':' and ')+')';
      const leaf=/^(metadata->>[a-z_]+|invoice_number)\.(.*)$/.exec(expression);assert.ok(leaf,expression);
      const field=leaf[1].startsWith('metadata->>')?`metadata->>'${leaf[1].slice(11)}'`:'invoice_number',filter=leaf[2];
      if(filter==='is.null')return `${field} is null`;
      if(filter.startsWith('neq.'))return `${field}<>${bind(filter.slice(4))}`;
      if(filter.startsWith('not.like.'))return `${field} not like ${bind(filter.slice(9).replaceAll('*','%'))}`;
      if(filter.startsWith('in.(')&&filter.endsWith(')'))return `${field} in (${filter.slice(4,-1).split(',').map(bind).join(',')})`;
      assert.fail('Unexpected candidate predicate '+filter);
    };
    const where='('+split(predicate.slice(1,-1)).map(sql).join(' and ')+')';
    const values=facts.map((_,index)=>`($${index*2+1}::text,$${index*2+2}::jsonb)`).join(',');
    const rows=(await f.db.query(`with candidate_facts(invoice_number,metadata) as (values ${values}) select invoice_number from candidate_facts where ${where} order by invoice_number`,args)).rows;
    assert.deepEqual(rows.map(row=>row.invoice_number),['real-false','real-missing']);
  }finally{await f.close();}
});

test('the verified-owner reopening SQL preserves test identity and export exclusion after an actual payment reversal',async()=>{
  const f=await fixture();try{
    const row=await f.create(),ownerPhone='+12025550130';
    const verification=(await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[f.ws,ownerPhone])).rows[0];
    await f.identity(null,'service_role');
    const verified=(await f.db.query('select public.whatsapp_verify_owner_code($1,$2) result',[ownerPhone,verification.code])).rows[0].result;
    assert.equal(verified.ok,true,JSON.stringify(verified));
    await f.identity();
    await f.db.query('select public.record_invoice_payment($1,$2,null,$3,$4,true)',[f.ws,row.id,`test_fixture_payment_${randomUUID()}`,'Offline fixture settlement; no real money']);
    const paid=await f.read(row.id);
    assert.equal(paid.status,'paid');assert.equal(Number(paid.amount_paid),1);assert.equal(paid.metadata.test_invoice,true);
    await f.identity(null,'service_role');
    const prepareMessage=`Mark test invoice ${row.invoice_number} unpaid`,prepareId=`test_reopen_prepare_${randomUUID()}`;
    const inbound=async(id,message)=>f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'offline-fixture',$2,'text',$3,'processing')",[id,ownerPhone,message]);
    await inbound(prepareId,prepareMessage);
    const prepared=(await f.db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,$5,'prepare',$6) result",[
      f.ws,f.owner,ownerPhone,prepareId,prepareMessage,row.id,
    ])).rows[0].result;
    assert.equal(prepared.ok,true,JSON.stringify(prepared));assert.equal(prepared.requiresConfirmation,true);
    const pending=(await f.db.query("select id,version from whatsapp_pending_actions where workspace_id=$1 and action->>'proposalId'=$2 and consumed_at is null",[f.ws,prepared.proposalId])).rows[0];
    assert.ok(pending);
    const confirmId=`test_reopen_confirm_${randomUUID()}`;
    await inbound(confirmId,'yes');
    const reopened=(await f.db.query("select public.whatsapp_invoice_reopening($1,$2,$3,$4,'yes','confirm',null,$5,$6,$7,null) result",[
      f.ws,f.owner,ownerPhone,confirmId,prepared.proposalId,pending.id,pending.version,
    ])).rows[0].result;
    assert.equal(reopened.ok,true,JSON.stringify(reopened));assert.equal(reopened.action,'invoice.reopened');
    const after=await f.read(row.id);
    assert.equal(Number(after.amount_paid),0);assert.equal(after.followup_state,'paused');assert.equal(after.next_follow_up_at,null);
    assert.equal(after.invoice_number,row.invoice_number);assert.equal(after.metadata.source_invoice_number,row.metadata.source_invoice_number);
    assert.equal(after.metadata.test_invoice,true);assert.equal(after.metadata.approved_reminder_text??null,null);
    assert.equal(after.external_provider,null);assert.equal(after.external_invoice_id,null);assert.equal(syncEligibility(after),'excluded');
    assert.equal((await f.db.query('select count(*)::int n from payment_reversals where workspace_id=$1 and invoice_id=$2',[f.ws,row.id])).rows[0].n,1);
  }finally{await f.close();}
});
