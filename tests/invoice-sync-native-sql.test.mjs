import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createInvoiceReconcileStore,reconcileInvoiceSync} from '../automation/invoice-sync-reconciler.mjs';
import {retryAssistantInvoiceSync} from '../ai/invoice-ops.mjs';
import {createWhatsAppInvoiceStore} from '../automation/whatsapp/invoice-store.mjs';
import {createAccountingIntegration,createZohoBooksProvider,InMemoryAccountingStore,TokenCipher,connectionAad} from '../automation/accounting/index.mjs';

test('real SQL numbering, REST claims and WhatsApp/manual reconciliation remain unique and tenant-scoped',async()=>{
  const f=await createOfflineSqlNetwork(),owner=randomUUID();
  try {
    await f.db.query('insert into auth.users(id) values($1)',[owner]);
    const asOwner=()=>f.db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
    const asService=()=>f.db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
    await asOwner();
    const workspaces=[];
    for(const label of ['Sync A','Sync B'])workspaces.push((await f.db.query('select (public.create_workspace($1,$2)).id',[label,randomUUID()])).rows[0].id);
    await asService();
    const customers=[];
    for(const ws of workspaces)customers.push((await f.db.query("insert into customers(workspace_id,name) values($1,'Client') returning id",[ws])).rows[0].id);
    const create=async(index)=>{
      const result=await f.supabase.from('invoices').insert({workspace_id:workspaces[index],customer_id:customers[index],invoice_number:'AUTO',issue_date:'2026-10-01',due_date:'2026-10-20',currency:'INR',total_amount:118,metadata:{invoice_direction:'receivable',bookkeeping_sync_status:'pending',followup_state:'draft'}}).select('*').single();
      if(result.error)throw result.error;return result.data;
    };
    const [first,second,foreign]=await Promise.all([create(0),create(0),create(1)]);
    assert.notEqual(first.invoice_number,second.invoice_number);
    assert.notEqual(first.id,second.id);
    assert.equal(first.invoice_number,foreign.invoice_number,'numbering is intentionally independent per workspace');
    const db=createInvoiceReconcileStore({env:{SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'fixture-only'},fetchImpl:f.fetchImpl});
    const connection={workspace_id:workspaces[0],owner_id:owner},scoped=db.scoped(connection);
    assert.equal(await scoped.getAssistantInvoice(foreign.id),null);
    assert.deepEqual(await scoped.query('customers',{filters:{id:`eq.${customers[1]}`}}),[]);
    const stale=await scoped.getAssistantInvoice(first.id);
    let entered,release,calls=0;
    const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    const accounting={async syncInvoice(input){calls++;assert.equal(input.workspaceId,workspaces[0]);assert.equal(input.invoice.clientName,'Client');entered();await gate;return{provider:'zoho_books',externalId:`remote-${input.invoiceId}`}}};
    const running=reconcileInvoiceSync({store:{connections:async()=>[connection],candidates:async()=>[{id:first.id,workspace_id:workspaces[0]}],scoped:()=>scoped},accounting});
    await started;
    const whatsapp=createWhatsAppInvoiceStore({supabase:f.supabase,workspaceId:workspaces[0],customerId:customers[0],audience:'owner',authorize:async()=>true});
    assert.equal(await whatsapp.claimInvoiceSync(stale,{...stale.metadata,bookkeeping_sync_status:'not_configured'}),null,'a stale WhatsApp save cannot overwrite the durable claim');
    const manual=await retryAssistantInvoiceSync({store:scoped,invoiceId:first.id,accounting});
    assert.equal(manual.sync.status,'pending');assert.equal(calls,1);
    release();assert.equal((await running).results[0].status,'synced');
    const saved=await scoped.getAssistantInvoice(first.id);
    assert.equal(saved.metadata.bookkeeping_sync_attempts,1);assert.equal(saved.sync_status,'synced');
    assert.equal((await db.scoped({workspace_id:workspaces[1],owner_id:owner}).getAssistantInvoice(foreign.id)).metadata.bookkeeping_sync_status,'pending');
    await assert.rejects(retryAssistantInvoiceSync({store:scoped,invoiceId:foreign.id,accounting}),error=>error.code==='INVOICE_NOT_FOUND');
    // Delete through the real owner lifecycle RPC, then replay an old candidate.
    await asOwner();
    const action=async(type,proposal=null)=>(await f.db.query("select public.invoice_lifecycle_action($1,$2,$3,$4,null,null,$5,'yes',null,$6) value",[type,workspaces[0],proposal?null:second.id,proposal,`dashboard_delete_${randomUUID()}`,`delete-${randomUUID()}`])).rows[0].value;
    const proposal=await action('prepare');assert.equal(proposal.ok,true);
    const deleted=await action('confirm',proposal.proposalId);assert.equal(deleted.action,'deleted');
    await asService();
    assert.equal(await scoped.getAssistantInvoice(second.id),null);
    await assert.rejects(retryAssistantInvoiceSync({store:scoped,invoiceId:second.id,accounting}),error=>error.code==='INVOICE_NOT_FOUND');
    assert.equal(calls,1);
    // Preserve a real adapter's rejection through the integration, retry API and SQL CAS.
    const rejected=await create(0),connections=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,7));
    const token={accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600_000,apiDomain:'https://www.zohoapis.in'};
    await connections.insertConnection({userId:owner,workspaceId:workspaces[0],provider:'zoho_books',providerAccountId:'fixture-org',apiDomain:token.apiDomain,status:'connected',...cipher.encrypt(token,connectionAad('zoho_books',workspaces[0]))});
    const requests=[],providerMessage='Synthetic export rejection for SQL persistence.';
    let autoNumbering=false;
    const zoho=createZohoBooksProvider({fetchImpl:async(url,options={})=>{
      const path=new URL(url).pathname;requests.push(`${options.method || 'GET'} ${path}`);
      if(options.method==='POST') {
        if(!autoNumbering)return Response.json({code:1001,message:providerMessage},{status:400});
        if(Object.hasOwn(JSON.parse(options.body),'invoice_number'))return Response.json({code:4097,message:'Number does not match auto-generation'},{status:400});
        return Response.json({invoice:{invoice_id:'remote-auto',invoice_number:'ZOHO-0099'}});
      }
      return Response.json(path.endsWith('/contacts')?{contacts:[{contact_name:'Client',contact_id:'fixture-contact'}]}:{invoices:[]});
    }});
    const integration=createAccountingIntegration({store:connections,cipher,providers:{zoho_books:zoho,quickbooks:{}}});
    const failure=await retryAssistantInvoiceSync({store:scoped,invoiceId:rejected.id,accounting:integration});
    assert.equal(failure.sync.status,'failed');
    assert.deepEqual(requests,['GET /books/v3/invoices','GET /books/v3/invoices','GET /books/v3/contacts','POST /books/v3/invoices']);
    const persisted=(await f.db.query('select metadata,sync_status from invoices where id=$1 and workspace_id=$2',[rejected.id,workspaces[0]])).rows[0];
    assert.equal(persisted.sync_status,'failed');
    assert.equal(persisted.metadata.bookkeeping_sync_http_status,400);
    assert.equal(persisted.metadata.bookkeeping_sync_provider_code,'1001');
    assert.equal(persisted.metadata.bookkeeping_sync_provider_message,providerMessage);
    assert.equal(persisted.metadata.bookkeeping_sync_provider_operation,'POST /books/v3/invoices');
    assert.equal((await db.scoped({workspace_id:workspaces[1],owner_id:owner}).getAssistantInvoice(foreign.id)).metadata.bookkeeping_sync_provider_message,undefined);
    // A rejected number and its fallback are one claimed sync attempt.
    const auto=await create(0);autoNumbering=true;requests.length=0;
    const synced=await retryAssistantInvoiceSync({store:scoped,invoiceId:auto.id,accounting:integration});
    assert.equal(synced.sync.status,'synced');assert.equal(synced.sync.externalId,'remote-auto');
    const linked=await scoped.getAssistantInvoice(auto.id);
    assert.equal(linked.invoice_number,auto.invoice_number);assert.equal(linked.external_invoice_id,'remote-auto');
    assert.equal(linked.metadata.bookkeeping_sync_attempts,1);assert.equal(linked.sync_status,'synced');
    assert.equal(linked.metadata.bookkeeping_sync_provider_code,null);assert.equal(linked.metadata.bookkeeping_sync_provider_message,null);
    assert.equal(linked.metadata.bookkeeping_sync_http_status,null);
    assert.deepEqual(requests,['GET /books/v3/invoices','GET /books/v3/invoices','GET /books/v3/contacts','POST /books/v3/invoices','POST /books/v3/invoices']);
    const requestCount=requests.length;
    await retryAssistantInvoiceSync({store:scoped,invoiceId:auto.id,accounting:integration});
    assert.equal(requests.length,requestCount,'a synced fallback is never exported again');
  } finally {await f.close();}
});
