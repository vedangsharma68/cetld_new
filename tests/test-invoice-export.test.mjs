import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {syncEligibility,syncInvoiceRow} from '../automation/invoice-sync.mjs';
import {invoiceSyncPersistence} from '../automation/invoice-sync-store.mjs';
import {createInvoiceReconcileStore,reconcileInvoiceSync} from '../automation/invoice-sync-reconciler.mjs';
import {createAccountingIntegration,InMemoryAccountingStore,SupabaseAccountingStore,TokenCipher,connectionAad,createZohoBooksProvider} from '../automation/accounting/index.mjs';

const workspaceId='11111111-1111-4111-8111-111111111111';
const invoiceId='22222222-2222-4222-8222-222222222222';
const userId='33333333-3333-4333-8333-333333333333';
const invoice={direction:'receivable',invoiceNumber:'INV-1',clientName:'Client',total:1,currency:'INR',invoiceDate:'2026-10-01',dueDate:'2026-10-20'};
const ordinary={id:invoiceId,workspace_id:workspaceId,invoice_number:'INV-1',metadata:{invoice_direction:'receivable'}};
const marked=[{metadata:{test_invoice:true}},{metadata:{test_invoice:'true'}},{metadata:{source_invoice_number:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'}},{invoice_number:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'}];
const refused=error=>error.code==='INVOICE_NOT_EXPORTABLE';

test('test eligibility is excluded before every synced, backoff and exhausted state',()=>{
  for(const marker of marked) for(const state of [
    {},{external_invoice_id:'remote'},{metadata:{bookkeeping_record_id:'remote'}},
    {metadata:{bookkeeping_sync_status:'synced'}},{metadata:{bookkeeping_sync_attempts:5}},
    {metadata:{bookkeeping_sync_next_at:'2099-01-01T00:00:00Z'}},{deleted_at:'2026-10-24T00:00:00Z'},
  ]) assert.equal(syncEligibility({...ordinary,...state,...marker,metadata:{...ordinary.metadata,...state.metadata,...marker.metadata}}),'excluded');
  assert.equal(syncEligibility(ordinary),'ready');
  assert.equal(syncEligibility({...ordinary,metadata:{...ordinary.metadata,test_invoice:false}}),'ready');
});

test('inline sync and explicit retries actively refuse fixtures before any lookup, lease write or provider call',async()=>{
  for(const marker of marked) for(const manualRetry of [true,false]) {
    const row={...ordinary,...marker};
    await assert.rejects(syncInvoiceRow({store:{workspaceId,getAssistantInvoice:()=>assert.fail('fixture lookup'),claimInvoiceSync:()=>assert.fail('fixture lease'),updateAssistantInvoiceMetadata:()=>assert.fail('fixture metadata write')},row,invoice,manualRetry,accounting:{syncInvoice:()=>assert.fail('fixture export')}}),refused);
  }
});

test('the reconciler emits null-safe marker and reserved-number exclusions alongside production filters',async()=>{
  let params;
  const store=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.test',SUPABASE_SERVICE_ROLE_KEY:'fixture'},fetchImpl:async input=>{params=new URL(input).searchParams;return Response.json([])}});
  await store.candidates([{workspace_id:workspaceId}],'2026-10-24T00:00:00Z');
  assert.equal(params.get('deleted_at'),'is.null');
  assert.equal(params.get('external_invoice_id'),'is.null');
  assert.equal(params.get('status'),'not.in.(void,cancelled)');
  const filter=params.get('and');
  assert.match(filter,/or\(metadata->>test_invoice.is.null,metadata->>test_invoice.neq.true\)/);
  assert.match(filter,/or\(metadata->>source_invoice_number.is.null,metadata->>source_invoice_number.not.like.CETLD-TEST-\*\)/);
  assert.match(filter,/invoice_number.not.like.CETLD-TEST-\*/);
  assert.match(filter,/invoice_direction.neq.payable/);
  assert.match(filter,/bookkeeping_sync_exhausted.neq.true/);
  assert.equal(params.get('limit'),'25');
});

// A narrow, offline PostgREST reader for this SELECT. It compiles the actual
// emitted URL, including nested boolean groups, into parameterized PostgreSQL.
function candidateSql(params) {
  const args=[];
  const bind=value=>{args.push(value);return `$${args.length}`};
  const split=value=>{
    let depth=0,start=0;const parts=[];
    for(let index=0;index<value.length;index++) {
      if(value[index]==='(')depth++;
      if(value[index]===')')depth--;
      if(value[index]===','&&depth===0){parts.push(value.slice(start,index));start=index+1;}
      if(depth<0)throw Error('invalid filter nesting');
    }
    if(depth!==0)throw Error('invalid filter nesting');
    return [...parts,value.slice(start)];
  };
  const field=value=>{
    const match=/^([a-z_]+)(?:->>([a-z_]+))?$/.exec(value);
    if(!match)throw Error('unsupported field');
    return `"${match[1]}"${match[2]?`->>'${match[2]}'`:''}`;
  };
  const predicate=value=>{
    const group=/^(and|or)\((.*)\)$/.exec(value);
    if(group)return `(${split(group[2]).map(predicate).join(` ${group[1]} `)})`;
    const match=/^([a-z_]+(?:->>[a-z_]+)?)\.(not\.)?(is|in|like|eq|neq|lte)\.(.*)$/.exec(value);
    if(!match)throw Error(`unsupported filter ${value}`);
    const [,column,negative,operation,expected]=match,left=field(column);
    let sql;
    if(operation==='is'&&expected==='null')sql=`${left} is null`;
    else if(operation==='in'&&expected.startsWith('(')&&expected.endsWith(')'))sql=`${left} in (${split(expected.slice(1,-1)).map(bind).join(',')})`;
    else if(operation==='like')sql=`${left} like ${bind(expected.replaceAll('*','%'))}`;
    else if(['eq','neq','lte'].includes(operation))sql=`${left} ${{eq:'=',neq:'<>',lte:'<='}[operation]} ${bind(expected)}`;
    else throw Error('unsupported filter operation');
    return negative?`not (${sql})`:sql;
  };
  const clauses=[];
  for(const [key,value] of params) {
    if(['select','order','limit'].includes(key))continue;
    if(['and','or'].includes(key))clauses.push(predicate(`${key}${value}`));
    else clauses.push(predicate(`${key}.${value}`));
  }
  return {sql:`select id,workspace_id,'2026-10-01T00:00:00Z' as created_at from invoices where ${clauses.join(' and ')} order by id`,args};
}

test('the actual reconciler candidate query excludes fixtures in PostgreSQL and retains ordinary null/false markers',async()=>{
  const db=new PGlite();
  try {
    await db.exec('create table invoices(id text,workspace_id text,invoice_number text,status text,deleted_at text,external_invoice_id text,metadata jsonb)');
    const rows=[
      ['ordinary_missing',{}],['ordinary_false',{test_invoice:false}],['ordinary_string_false',{test_invoice:'false'}],
      ['test_true',{test_invoice:true}],['test_string_true',{test_invoice:'true'}],
      ['test_source_prefix',{source_invoice_number:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'}],
      ['test_visible_prefix',{},'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'],
      ['test_deleted',{test_invoice:true},null,'2026-10-24T00:00:00Z'],
      ['deleted_real',{},null,'2026-10-24T00:00:00Z'],['payable',{invoice_direction:'payable'}],
      ['exhausted',{bookkeeping_sync_exhausted:true}],['future',{bookkeeping_sync_next_at:'2099-01-01T00:00:00Z'}],
    ];
    for(const [id,metadata,number='INV-1',deleted=null] of rows)await db.query('insert into invoices values($1,$2,$3,$4,$5,null,$6)',[id,workspaceId,number||'INV-1','sent',deleted,JSON.stringify(metadata)]);
    const store=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.test',SUPABASE_SERVICE_ROLE_KEY:'fixture'},fetchImpl:async input=>{
      const query=candidateSql(new URL(input).searchParams);
      return Response.json((await db.query(query.sql,query.args)).rows);
    }});
    const rowsFound=await store.candidates([{workspace_id:workspaceId}],'2026-10-24T00:00:00Z');
    assert.deepEqual(rowsFound.map(row=>row.id),['ordinary_false','ordinary_missing','ordinary_string_false']);
  } finally {await db.close();}
});

test('a stale reconciler candidate still cannot export a fixture',async()=>{
  const row={...ordinary,metadata:{...ordinary.metadata,test_invoice:true}};
  const result=await reconcileInvoiceSync({store:{connections:async()=>[{workspace_id:workspaceId,owner_id:userId}],candidates:async()=>[{id:invoiceId,workspace_id:workspaceId}],scoped:()=>({workspaceId,userId,getAssistantInvoice:async()=>row,query:()=>assert.fail('fixture customer lookup')})},accounting:{syncInvoice:()=>assert.fail('fixture export')}});
  assert.deepEqual(result.results,[{invoiceId,status:'error'}]);
});

test('direct accounting prepare/sync re-read the saved marker even when the caller omits it',async()=>{
  const store=new InMemoryAccountingStore();
  store.getInvoiceExportState=async(ws,id)=>{assert.equal(ws,workspaceId);assert.equal(id,invoiceId);return{...ordinary,metadata:{test_invoice:true}}};
  store.getConnection=()=>assert.fail('no fixture connection or credential lookup');
  const accounting=createAccountingIntegration({store,cipher:new TokenCipher(Buffer.alloc(32,7)),providers:{zoho_books:{},quickbooks:{}}});
  for(const method of ['prepareInvoiceSync','syncInvoice']) await assert.rejects(accounting[method]({userId,workspaceId,provider:'zoho_books',invoiceId,invoice}),refused);
});

test('prepared dispatch rechecks durable exportability before contacting the provider',async()=>{
  const store=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,7));
  let saved=ordinary,calls=0;
  store.getInvoiceExportState=async()=>saved;
  const token={accessToken:'fixture',refreshToken:'fixture',expiresAt:Date.now()+3600_000};
  await store.insertConnection({userId,workspaceId,provider:'zoho_books',providerAccountId:'org',apiDomain:'https://www.zohoapis.com',status:'connected',...cipher.encrypt(token,connectionAad('zoho_books',workspaceId))});
  const accounting=createAccountingIntegration({store,cipher,providers:{zoho_books:{createInvoice:async()=>{calls++;return{externalId:'remote'}}},quickbooks:{}}});
  const dispatch=await accounting.prepareInvoiceSync({userId,workspaceId,provider:'zoho_books',invoiceId,invoice});
  saved={...ordinary,metadata:{test_invoice:true}};
  await assert.rejects(dispatch(),refused);assert.equal(calls,0);
  saved=ordinary;
  assert.equal((await accounting.syncInvoice({userId,workspaceId,provider:'zoho_books',invoiceId,invoice})).externalId,'remote');assert.equal(calls,1);
});

test('provider adapter and inbound provider linkage both refuse marked or visibly reserved invoices',async()=>{
  const adapter=createZohoBooksProvider({fetchImpl:()=>assert.fail('fixture provider request')});
  for(const marker of [...marked,{invoiceNumber:'CETLD-TEST-fixture-NO-PAYMENT-REQUIRED'}]) for(const method of ['createInvoice','updateInvoice']) {
    await assert.rejects(adapter[method]({token:{accessToken:'fixture'},accountId:'org',invoiceId:'remote',invoice:{...invoice,...marker}}),refused);
  }
  const store=new SupabaseAccountingStore({url:'https://fixture.test',serviceRoleKey:'fixture',fetchImpl:()=>assert.fail('fixture linkage write')});
  for(const marker of marked) await assert.rejects(store.patchActiveInvoice(invoiceId,workspaceId,{external_provider:'zoho_books',external_invoice_id:'remote'}, {...ordinary,...marker}),refused);
});

test('sync completion cannot attach provider identifiers after the saved row is marked',async()=>{
  const claimed={...ordinary,metadata:{bookkeeping_sync_attempted_at:'2026-10-24T00:00:00Z',bookkeeping_sync_attempts:1}};
  const persistence=invoiceSyncPersistence({read:async()=>({...claimed,metadata:{...claimed.metadata,test_invoice:true}}),patch:()=>assert.fail('fixture linkage patch')});
  await assert.rejects(persistence.finishInvoiceSync(claimed,{bookkeeping_record_id:'remote'},{external_provider:'zoho_books',external_invoice_id:'remote'}),refused);
  assert.throws(()=>persistence.claimInvoiceSync({...ordinary,metadata:{test_invoice:true}},{}),refused);
});
