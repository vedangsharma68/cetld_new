import test from 'node:test';
import assert from 'node:assert/strict';
import {createZohoBooksProvider,AccountingProviderError,createAccountingIntegration,InMemoryAccountingStore,TokenCipher,connectionAad} from '../automation/accounting/index.mjs';

const invoice={localInvoiceId:'22222222-2222-4222-8222-222222222222',direction:'receivable',invoiceNumber:'INV-2026-0011',clientName:'Client',currency:'INR',total:118,invoiceDate:'2026-10-01',dueDate:'2026-10-20',notes:'Original notes'};
const token={accessToken:'fixture-access',apiDomain:'https://www.zohoapis.in'};
const reference=`cetld:${invoice.localInvoiceId}`;
const rejection=code=>Response.json({code,message:'Number entered does not match the auto-generated number. Disable auto-generation and continue.'},{status:400});
const remote=(patch={})=>({invoice_id:'remote-auto',invoice_number:'ZOHO-0099',reference_number:reference,customer_name:invoice.clientName,currency_code:'INR',total:118,balance:118,date:invoice.invoiceDate,due_date:invoice.dueDate,...patch});

function fixture({post=()=>Response.json({invoice:{invoice_id:'created'}}),referenceRows=[],numberRows=[],contacts=[{contact_id:'contact',contact_name:'Client'}]}={}) {
  const requests=[],posts=[];
  const adapter=createZohoBooksProvider({fetchImpl:async(url,options={})=>{
    const parsed=new URL(url),method=options.method || 'GET';
    assert.equal(parsed.origin,token.apiDomain);assert.equal(parsed.searchParams.get('organization_id'),'fixture-org');
    assert.equal(options.headers.Authorization,`Zoho-oauthtoken ${token.accessToken}`);
    requests.push({url:parsed,method});
    if(method==='POST') {
      const body=JSON.parse(options.body);posts.push({path:parsed.pathname,body});
      return post(body,parsed.pathname,posts.length);
    }
    if(parsed.pathname.endsWith('/contacts'))return Response.json({contacts});
    return Response.json({invoices:parsed.searchParams.has('reference_number')?referenceRows:numberRows});
  }});
  return {requests,posts,run:()=>adapter.createInvoice({token,accountId:'fixture-org',invoice})};
}

for(const code of [4097,'4097'])test(`Zoho ${typeof code} 4097 retries once without invoice_number and preserves all other facts`,async()=>{
  const f=fixture({post:(_body,_path,count)=>count===1?rejection(code):Response.json({invoice:{invoice_id:'auto-created',invoice_number:'ZOHO-0099'}})});
  assert.deepEqual(await f.run(),{externalId:'auto-created',duplicate:false});
  assert.equal(f.posts.length,2);assert.equal(f.posts[0].body.invoice_number,invoice.invoiceNumber);
  const {invoice_number,...expected}=f.posts[0].body;
  assert.deepEqual(f.posts[1].body,expected);assert.equal(Object.hasOwn(f.posts[1].body,'invoice_number'),false);
  assert.equal(f.posts[1].body.reference_number,reference);assert.equal(f.posts[1].body.line_items[0].rate,118);
  assert.equal(f.requests.filter(r=>r.url.pathname.endsWith('/contacts')).length,1);
  assert.equal(invoice.invoiceNumber,'INV-2026-0011');
});

test('an organization accepting the supplied invoice number still creates once with that number',async()=>{
  const f=fixture();assert.deepEqual(await f.run(),{externalId:'created',duplicate:false});
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.invoice_number,invoice.invoiceNumber);
});

test('fallback failure is final for this attempt and retains its own provider diagnostics',async()=>{
  for(const code of [4097,1001]) {
    const f=fixture({post:(_body,_path,count)=>count===1?rejection(4097):Response.json({code,message:'Final rejection'},{status:400})});
    await assert.rejects(f.run(),error=>error instanceof AccountingProviderError&&error.providerCode===String(code)&&error.providerMessage==='Final rejection'&&error.providerOperation==='POST /books/v3/invoices');
    assert.equal(f.posts.length,2);
  }
});

test('other errors and uncertain writes never trigger the numbering fallback',async()=>{
  for(const post of [()=>rejection(1001),()=>Response.json({code:4097,message:'Unavailable'},{status:500}),()=>{throw Error('uncertain transport')},()=>new Response('invalid JSON',{status:400})]) {
    const f=fixture({post});await assert.rejects(f.run());assert.equal(f.posts.length,1);
  }
});

test('4097 from contact creation does not retry invoice creation',async()=>{
  const f=fixture({contacts:[],post:()=>rejection(4097)});
  await assert.rejects(f.run(),error=>error.providerCode==='4097');
  assert.deepEqual(f.posts.map(p=>p.path),['/books/v3/contacts']);
});

test('a fallback response missing the remote ID cannot report success or cause another POST',async()=>{
  const f=fixture({post:(_body,_path,count)=>count===1?rejection(4097):Response.json({code:0,invoice:{}})});
  await assert.rejects(f.run(),/did not return an invoice ID/);assert.equal(f.posts.length,2);
});

test('reference lookup recovers the auto-numbered invoice before number collisions and makes no writes',async()=>{
  const f=fixture({referenceRows:[remote()],numberRows:[remote({invoice_id:'foreign',invoice_number:invoice.invoiceNumber,reference_number:'cetld:other-workspace'})]});
  assert.deepEqual(await f.run(),{externalId:'remote-auto',duplicate:true});
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url.searchParams.get('reference_number'),reference);
  assert.equal(f.requests[0].url.searchParams.has('invoice_number'),false);assert.equal(f.posts.length,0);
});

test('reference recovery refuses changed financial facts and ambiguous or invalid matches',async()=>{
  const variants=[{total:119},{currency_code:'USD'},{customer_name:'Other client'},{date:'2026-10-02'},{due_date:'2026-10-21'}];
  for(const rows of [...variants.map(patch=>[remote(patch)]),[remote(),remote({invoice_id:'duplicate'})],[remote({invoice_id:null})]]) {
    const f=fixture({referenceRows:rows});await assert.rejects(f.run(),error=>error.code==='ACCOUNTING_INVOICE_CONFLICT');
    assert.equal(f.requests.length,1);assert.equal(f.posts.length,0);
  }
});

test('a broad reference result cannot adopt another workspace invoice',async()=>{
  const f=fixture({referenceRows:[remote({reference_number:`${reference}-other`})]});
  assert.deepEqual(await f.run(),{externalId:'created',duplicate:false});assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].body.reference_number,reference);
});

test('an uncertain auto-numbered POST recovers by reference on the next attempt without a second accepted write',async()=>{
  let saved=null,posts=0;
  const adapter=createZohoBooksProvider({fetchImpl:async(url,options={})=>{
    const parsed=new URL(url);assert.equal(parsed.searchParams.get('organization_id'),'fixture-org');
    if(options.method==='POST') {
      posts++;const body=JSON.parse(options.body);
      if(Object.hasOwn(body,'invoice_number'))return rejection(4097);
      saved=remote();throw Error('connection lost after acceptance');
    }
    if(parsed.pathname.endsWith('/contacts'))return Response.json({contacts:[{contact_name:'Client',contact_id:'contact'}]});
    return Response.json({invoices:saved&&parsed.searchParams.get('reference_number')===reference?[saved]:[]});
  }});
  const run=()=>adapter.createInvoice({token,accountId:'fixture-org',invoice});
  await assert.rejects(run(),error=>error.providerCode==='network_error');
  assert.deepEqual(await run(),{externalId:'remote-auto',duplicate:true});assert.equal(posts,2);
});

test('token expiry during the fallback uses the existing single refresh and preserves the reference and organization',async()=>{
  const store=new InMemoryAccountingStore(),cipher=new TokenCipher(Buffer.alloc(32,7));
  const context={userId:'fixture-owner',workspaceId:'fixture-workspace',provider:'zoho_books'};
  await store.insertConnection({...context,status:'connected',providerAccountId:'fixture-org',apiDomain:token.apiDomain,...cipher.encrypt({...token,refreshToken:'fixture-refresh',expiresAt:Date.now()+3600_000},connectionAad(context.provider,context.workspaceId))});
  const posts=[];let refreshes=0;
  const adapter=createZohoBooksProvider({fetchImpl:async(url,options={})=>{
    const parsed=new URL(url);assert.equal(parsed.searchParams.get('organization_id'),'fixture-org');
    if(options.method==='POST') {
      const body=JSON.parse(options.body);posts.push({body,authorization:options.headers.Authorization});
      assert.equal(body.reference_number,reference);
      if(Object.hasOwn(body,'invoice_number'))return rejection(4097);
      if(options.headers.Authorization.endsWith('fixture-access'))return Response.json({code:57,message:'Expired token'},{status:401});
      return Response.json({invoice:{invoice_id:'after-refresh'}});
    }
    return Response.json(parsed.pathname.endsWith('/contacts')?{contacts:[{contact_name:'Client',contact_id:'contact'}]}:{invoices:[]});
  }});
  adapter.refreshToken=async()=>{refreshes++;return{accessToken:'rotated-access',expiresAt:Date.now()+3600_000}};
  const accounting=createAccountingIntegration({store,cipher,providers:{zoho_books:adapter,quickbooks:{}}});
  const result=await accounting.syncInvoice({...context,invoice,invoiceId:invoice.localInvoiceId});
  assert.equal(result.externalId,'after-refresh');assert.equal(refreshes,1);assert.equal(posts.length,4);
  assert.deepEqual(posts.map(p=>Object.hasOwn(p.body,'invoice_number')),[true,false,true,false]);
  assert.deepEqual(posts.map(p=>p.authorization),['Zoho-oauthtoken fixture-access','Zoho-oauthtoken fixture-access','Zoho-oauthtoken rotated-access','Zoho-oauthtoken rotated-access']);
});
