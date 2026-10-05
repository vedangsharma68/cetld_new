import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const ws='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const customer='cccccccc-cccc-4ccc-8ccc-cccccccccccc',other='dddddddd-dddd-4ddd-8ddd-dddddddddddd',phone='+919871367051';
const sql=await readFile(new URL('../supabase/migrations/20261004180000_owner_invoice_review_number_override.sql',import.meta.url),'utf8');
const original={type:'invoice_review_draft',stage:'proposal',sourceMessageId:'attachment-source',missingFields:[],currencySource:'photo',
  invoice:{invoiceNumber:'INV-17',clientName:'Rob & Joe Traders',total:662.75,currency:'USD',dueDate:'2026-10-31',lineItems:[{description:'Original',amount:600}]}};
async function boot(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table public.test_owner_bindings(workspace_id uuid,owner_id uuid,customer_id uuid,phone text);
    create function public.whatsapp_resolve_verified_owner(text) returns table(workspace_id uuid,owner_id uuid,customer_id uuid)
      language sql security definer as $$select workspace_id,owner_id,customer_id from public.test_owner_bindings where phone=$1$$;
    create table public.whatsapp_pending_actions(id bigint primary key,version bigint,generation bigint,workspace_id uuid,customer_id uuid,
      phone text,action jsonb,created_at timestamptz default now()-interval '1 minute',expires_at timestamptz default now()+interval '15 minutes',consumed_at timestamptz);
    create table public.whatsapp_inbound_events(provider_message_id text primary key,sender_phone text,status text,message_text text,created_at timestamptz default now());
    create table public.invoices(id uuid default gen_random_uuid(),workspace_id uuid,invoice_number text,metadata jsonb,created_at timestamptz default now(),unique(workspace_id,invoice_number));`);
  await db.query('insert into test_owner_bindings values($1,$2,$3,$4)',[ws,owner,customer,phone]);
  await db.query('insert into whatsapp_pending_actions(id,version,generation,workspace_id,customer_id,phone,action) values(1,1,1,$1,$2,$3,$4)',[ws,customer,phone,JSON.stringify(original)]);
  await db.query("insert into whatsapp_inbound_events values('number-request',$1,'processing','Use the usual workspace numbering',now())",[phone]);
  await db.exec(sql);
  return db;
}
async function override(db,{workspace=ws,actor=owner,requestPhone=phone,id=1,version=1,messageId='number-request',quote='Use the usual workspace numbering',number='AUTO',intent='use_workspace_numbering'}={}){
  await db.exec('set role service_role');
  try{return (await db.query('select public.whatsapp_override_invoice_review_number($1,$2,$3,$4,$5,$6,$7,$8,$9) as value',
    [workspace,actor,requestPhone,id,version,messageId,quote,number,intent])).rows[0].value;}
  finally{await db.exec('reset role');}
}

test('invoice-number proposal SQL grants, tenant binding, CAS and immutable audit replay',async()=>{
  const db=await boot();try{
    for(const role of ['anon','authenticated']){
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select public.whatsapp_override_invoice_review_number($1,$2,$3,1,1,$4,$5,$6,$7)',
        [ws,owner,phone,'number-request','Use the usual workspace numbering','AUTO','use_workspace_numbering']),/permission denied/);
      await db.exec('reset role');
    }
    for(const args of [{workspace:other},{actor:other},{requestPhone:'+12025550199'},{id:2},{version:99},
      {quote:'Invented instruction'},{number:'INV-99'},{intent:'replace_extracted_number'},{number:'AUTO\n'}]){
      assert.equal((await override(db,args)).ok,false,JSON.stringify(args));
      assert.deepEqual((await db.query('select action from whatsapp_pending_actions')).rows[0].action,original);
    }
    const result=await override(db);assert.equal(result.ok,true);assert.equal(result.review.version,2);
    assert.deepEqual({...result.review.action,invoice:original.invoice,invoiceNumberOverrideAudit:undefined}, {...original,invoiceNumberOverrideAudit:undefined});
    assert.deepEqual({...result.review.action.invoice,invoiceNumber:'INV-17'},original.invoice);
    assert.equal(result.review.action.invoiceNumberOverrideAudit.originalExtractedNumber,'INV-17');
    await db.exec("update whatsapp_inbound_events set status='done'");
    const replay=await override(db);assert.equal(replay.replayed,true);assert.equal(replay.review.version,2);
    assert.equal((await override(db,{quote:'Different request'})).ok,false);
    await db.query("insert into whatsapp_inbound_events values('conflict',$1,'processing','Use the usual workspace numbering',now())",[phone]);
    assert.equal((await override(db,{messageId:'conflict',version:2})).code,'NUMBER_OVERRIDE_ALREADY_RECORDED');
    assert.equal((await db.query('select count(*)::int as count from invoices')).rows[0].count,0);
  }finally{await db.close();}
});

test('expired, consumed, wrong stage, wrong source and revoked owner cannot override extraction',async()=>{
  for(const setup of ["update whatsapp_pending_actions set expires_at=now()-interval '1 second'",
    'update whatsapp_pending_actions set consumed_at=now()',
    "update whatsapp_pending_actions set action=jsonb_set(action,'{stage}','\"saving\"')",
    "update whatsapp_pending_actions set action=action-'stage'",
    "update whatsapp_pending_actions set action=action-'sourceMessageId'",
    "update whatsapp_pending_actions set action=action||'{\"ownerProvidedFacts\":{\"invoiceNumber\":{\"value\":\"INV-17\"}}}'::jsonb",
    "update whatsapp_pending_actions set action=jsonb_set(action,'{sourceMessageId}','\"number-request\"')",
    "update whatsapp_inbound_events set created_at=now()-interval '2 minutes'",
    "update whatsapp_inbound_events set sender_phone='+12025550199'",
    "delete from test_owner_bindings"]){
    const db=await boot();try{await db.exec(setup);assert.equal((await override(db)).ok,false,setup);}finally{await db.close();}
  }
});

test('actual workspace numbering trigger persists a fresh unique label while preserving original extraction audit',async()=>{
  const db=await boot();try{
    await db.query('insert into invoices(workspace_id,invoice_number,metadata) values($1,$2,$3)',[ws,'JOHN-0041','{}']);
    await db.exec(await readFile(new URL('../supabase/migrations/20260929110000_workspace_invoice_number_inference.sql',import.meta.url),'utf8'));
    const {review}=await override(db),audit=review.action.invoiceNumberOverrideAudit;
    const metadata={assistant_idempotency_key:'isolated-number-override',printed_invoice_number:audit.originalExtractedNumber,invoice_number_override_audit:audit};
    const saved=(await db.query('insert into invoices(workspace_id,invoice_number,metadata) values($1,$2,$3) returning *',[ws,'AUTO',JSON.stringify(metadata)])).rows[0];
    assert.equal(saved.invoice_number,'JOHN-0042');assert.equal(saved.metadata.printed_invoice_number,'INV-17');
    assert.deepEqual(saved.metadata.invoice_number_override_audit,audit);
    await db.query('insert into invoices(workspace_id,invoice_number,metadata) values($1,$2,$3) on conflict(workspace_id,invoice_number) do nothing',[ws,'AUTO',JSON.stringify(metadata)]);
    assert.equal((await db.query('select count(*)::int as count from invoices')).rows[0].count,2);
    assert.equal((await db.query('select version from whatsapp_pending_actions')).rows[0].version,2);
  }finally{await db.close();}
});
