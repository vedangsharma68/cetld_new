import test from 'node:test';
import assert from 'node:assert/strict';
import {createZohoBooksProvider,consumeFreshZohoCreateReceipt} from '../automation/accounting/providers.mjs';
import {boundedZohoRequest,validateFreshZohoPost} from '../automation/accounting/zoho-create-receipt.mjs';

const token={accessToken:'fixture-secret',region:'in',apiDomain:'https://www.zohoapis.in',accountsDomain:'https://accounts.zoho.in'};
const invoice={localInvoiceId:'10000000-0000-0000-0000-000000000001',invoiceNumber:'FIXTURE-1',direction:'receivable',clientName:'Fresh client',
 clientEmail:'offline@example.test',clientPhone:'+15550001111',total:5,currency:'USD',invoiceDate:'2026-10-01',dueDate:'2026-10-20'};
const capture={localCustomerId:'10000000-0000-0000-0000-000000000002',name:invoice.clientName,email:invoice.clientEmail,phone:invoice.clientPhone,
 total:'5.00',currency:'USD',status:'draft',invoiceDate:invoice.invoiceDate,dueDate:invoice.dueDate};
const contact={contact_id:'30001',contact_name:invoice.clientName,email:invoice.clientEmail,phone:invoice.clientPhone};
const remote=()=>({invoice_id:'40001',invoice_number:invoice.invoiceNumber,customer_id:contact.contact_id,customer_name:invoice.clientName,
 currency_code:'USD',total:5,balance:5,payment_made:0,status:'draft',date:invoice.invoiceDate,due_date:invoice.dueDate,reference_number:`cetld:${invoice.localInvoiceId}`});
const expected={accountId:'90001',region:'in',localInvoiceId:invoice.localInvoiceId,localCustomerId:capture.localCustomerId,externalId:'40001'};
function fixture({patch={},existing=false,ambiguous=false,dedup=false,retry=false,network=false,malformed=false,redirect=false,oversize=false}={}){
 const calls=[];let invoicePosts=0;
 const adapter=createZohoBooksProvider({fetchImpl:async(input,options={})=>{
  const url=new URL(String(input));assert.equal(url.origin,token.apiDomain);assert.equal(url.searchParams.get('organization_id'),'90001');
  assert.equal(options.redirect,'error');assert.ok(options.signal);calls.push({path:url.pathname,method:options.method||'GET'});
  if(redirect){const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;}
  if(oversize)return new Response('x',{headers:{'content-length':'262145'}});
  if(malformed)return new Response('{');
  if(options.method==='POST'&&url.pathname.endsWith('/invoices')){
   invoicePosts++;if(network)throw Error('offline transport uncertainty');
   const body=JSON.parse(options.body);assert.equal(body.customer_id,contact.contact_id);assert.equal(body.reference_number,`cetld:${invoice.localInvoiceId}`);
   if(retry&&invoicePosts===1)return Response.json({code:4097},{status:400});
   return Response.json({code:0,invoice:{...remote(),...patch}});
  }
  if(options.method==='POST')return Response.json({code:0,contact});
  if(url.pathname.endsWith('/contacts'))return Response.json({code:0,contacts:existing?[contact,...(ambiguous?[{...contact,contact_id:'30002'}]:[])]:[],page_context:{has_more_page:false}});
  return Response.json({code:0,invoices:dedup?[{...remote(),total:5,balance:5}]:[],page_context:{has_more_page:false}});
 }});
 return {calls,run:override=>adapter.createInvoice({token,accountId:'90001',invoice,capture:{...capture,...override}}),posts:()=>invoicePosts};
}

test('only actual fresh POST results carry a one-use internal receipt; clones, forged JSON and pure validation cannot grant it',async()=>{
 const f=fixture(),result=await f.run();
 assert.equal(consumeFreshZohoCreateReceipt(JSON.parse(JSON.stringify(result)),expected),null);
 const receipt=consumeFreshZohoCreateReceipt(result,expected);assert.equal(receipt.externalCustomerId,'30001');assert.equal(receipt.paid,'0.00');
 assert.equal(consumeFreshZohoCreateReceipt(result,expected),null);
 assert.doesNotMatch(JSON.stringify(receipt),/Fresh client|offline@example|15550001111|fixture-secret/);
 assert.equal(consumeFreshZohoCreateReceipt({externalId:'40001',duplicate:false,receipt:{verified:true,...receipt}},expected),null);
 const facts=validateFreshZohoPost({externalId:'40001'},{capture,token,accountId:'90001',invoice,body:{code:0,invoice:remote()},contact,
  contactBody:{code:0,contact},exactContacts:0,contactLookupComplete:true,freshSearches:true,postCount:1});
 assert.ok(facts);assert.equal(consumeFreshZohoCreateReceipt(facts,expected),null,'validated JSON facts are not the adapter capability');
 assert.equal(f.posts(),1);
});

test('strict receipt rejects exact identity, money, status, dates, reference and malformed/missing facts without inventing provenance',async()=>{
 for(const patch of [{organization_id:'90002'},{invoice_id:40001},{customer_id:'99999'},{customer_name:'Different'},
  {currency_code:'INR'},{total:5.001},{total:'5e0'},{balance:4},{payment_made:1},{payment_made:null},{status:'unknown'},
  {status:'sent'},{date:'2026-10-02'},{date:'2026-02-30'},{due_date:'2026-10-21'},{reference_number:'wrong'},
  {invoice_number:'OTHER'},{invoice_id:'not-an-id'}]){
  const f=fixture({patch});
  if(Object.hasOwn(patch,'organization_id')||Object.hasOwn(patch,'customer_id')||Object.hasOwn(patch,'invoice_id')||Object.hasOwn(patch,'reference_number'))await assert.rejects(f.run(),/conflicts with the pinned request/);
  else {const result=await f.run();assert.equal(consumeFreshZohoCreateReceipt(result,{...expected,externalId:result.externalId}),null,JSON.stringify(patch));}
  assert.equal(f.posts(),1);
 }
 const f=fixture(),result=await f.run();result.externalId='999';assert.equal(consumeFreshZohoCreateReceipt(result,{...expected,externalId:'999'}),null);
});

test('dedup, ambiguous/unbound same-name contacts, and 4097 recovery remain unverified; protected unique customer reuse can capture',async()=>{
 for(const options of [{dedup:true},{existing:true},{retry:true}]){
  const f=fixture(options),result=await f.run();assert.equal(consumeFreshZohoCreateReceipt(result,expected),null);
  assert.equal(f.posts(),options.dedup?0:options.retry?2:1);
 }
 const f=fixture({existing:true}),result=await f.run({expectedExternalCustomerId:'30001'});
 assert.equal(consumeFreshZohoCreateReceipt(result,expected).externalCustomerId,'30001');
 const a=fixture({existing:true,ambiguous:true});await assert.rejects(a.run({expectedExternalCustomerId:'30001'}),/ambiguous/);assert.equal(a.posts(),0);
 const unbound=fixture({existing:true,ambiguous:true});await assert.rejects(unbound.run(),/ambiguous/);assert.equal(unbound.posts(),0);
 const wrong=fixture({existing:true});await assert.rejects(wrong.run({expectedExternalCustomerId:'30002'}),/conflicts with saved identity/);assert.equal(wrong.posts(),0);
});

test('transport rejects redirects, malformed/oversized bodies and uncertainty without POST retries; fetch/body timeout is bounded',async()=>{
 for(const options of [{redirect:true},{malformed:true},{oversize:true},{network:true}]){
  const f=fixture(options);await assert.rejects(f.run());assert.ok(f.posts()<=1);
 }
 await assert.rejects(boundedZohoRequest(async()=>new Promise(()=>{}),'https://fixture.test',{},AbortSignal.timeout(20)),error=>error.status===504);
 const stream=new ReadableStream({start(){}});
 await assert.rejects(boundedZohoRequest(async()=>new Response(stream,{headers:{'content-type':'application/json'}}),'https://fixture.test',{},AbortSignal.timeout(20)));
 const big=new ReadableStream({start(c){c.enqueue(new Uint8Array(262145));c.close();}});
 await assert.rejects(boundedZohoRequest(async()=>new Response(big,{headers:{'content-type':'application/json'}}),'https://fixture.test',{},AbortSignal.timeout(100)));
 await assert.rejects(boundedZohoRequest(async()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),'https://fixture.test',{},AbortSignal.timeout(100)));
 await assert.rejects(boundedZohoRequest(async()=>Response.json({code:0},{status:202}),'https://fixture.test',{},AbortSignal.timeout(100)));
 const adapter=createZohoBooksProvider({fetchImpl:()=>assert.fail('invalid endpoint must fail before credentials leave the server')});
 await assert.rejects(adapter.createInvoice({token:{...token,apiDomain:'https://attacker.test'},accountId:'90001',invoice,capture}),/Verified Zoho regional endpoint/);
 await assert.rejects(adapter.createInvoice({token,accountId:'not-an-account',invoice,capture}),/Verified Zoho regional endpoint/);
});
