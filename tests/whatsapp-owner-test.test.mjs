import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createWhatsAppInvoiceTestHandler} from '../automation/whatsapp/test-send.mjs';
import {OWNER_TEST_SCOPE as scope,ownerTestKey,claimOwnerTest} from '../automation/whatsapp/owner-test.mjs';
import {REMINDER_TEMPLATES} from '../automation/whatsapp/reminder-templates.mjs';
import {APIError} from '../ai/http.mjs';

const customerId='11111111-1111-4111-8111-111111111111';
const env={WHATSAPP_OUTBOUND_ENABLED:'true',WHATSAPP_TEST_OPERATOR_USER_ID:scope.ownerId,
  WHATSAPP_TEST_ALLOWLIST:scope.phone,WHATSAPP_WABA_ID:'1734116767674237',
  WHATSAPP_ACCESS_TOKEN:'fixture-secret-token',WHATSAPP_PHONE_NUMBER_ID:'1234567890',WHATSAPP_GRAPH_API_VERSION:'v24.0'};
const input={workspaceId:scope.workspaceId,invoiceId:scope.invoiceId,action:'owner-template-test'};
function setup({environment={},role='owner',userId=scope.ownerId,unauthenticated=false,onClaim=()=>{},graphResult='accepted',templateStatus='APPROVED',footer=null}={}){
  const business={invoices:[{id:scope.invoiceId,workspace_id:scope.workspaceId,invoice_number:scope.invoiceNumber,
    customer_id:'22222222-2222-4222-8222-222222222222',status:'sent',updated_at:'2026-10-14T02:59:38.207081Z',deleted_at:null}],
    customers:[{id:customerId,workspace_id:scope.workspaceId,phone:scope.phone,name:'Fixture owner'}],
    workspace_settings:[{workspace_id:scope.workspaceId,business_name:'CETLD test',whatsapp_owner_phone:scope.phone}],
    whatsapp_consents:[{workspace_id:scope.workspaceId,customer_id:customerId,phone:scope.phone,source:'inbound_message',categories:['invoice_updates'],revoked_at:null}],
    whatsapp_suppressions:[],whatsapp_global_suppressions:[]};
  const before=structuredClone(business),messages=[],writes=[],network=[],claims=[];
  let verified=true;
  const supabase={async rpc(name,args){assert.equal(name,'whatsapp_resolve_verified_owner');assert.equal(args.p_phone,scope.phone);
    return {data:verified?[{workspace_id:scope.workspaceId,owner_id:scope.ownerId,customer_id:customerId,business_name:business.workspace_settings[0].business_name}]:[]};},
    from(table){assert.ok(table==='whatsapp_messages'||Object.hasOwn(business,table),`unexpected table ${table}`);
      const filters=[];let mutation=null,values,ignoreDuplicates=false,pendingFilter=false;
      const rows=()=> (table==='whatsapp_messages'?messages:business[table]).filter(row=>filters.every(fn=>fn(row)));
      function execute(){
        if(mutation){assert.equal(table,'whatsapp_messages','no business writes');writes.push(mutation);
          if(mutation==='upsert'){
            if(!messages.some(row=>row.workspace_id===values.workspace_id&&row.idempotency_key===values.idempotency_key))messages.push({id:'message-1',...structuredClone(values)});
            assert.equal(ignoreDuplicates,true);return {data:null};
          }
          const changed=rows();for(const row of changed)Object.assign(row,values);
          if(values.status==='unknown'&&pendingFilter&&changed.length){claims.push(true);onClaim({business,messages,setVerified:value=>{verified=value;}});}
          return {data:structuredClone(changed)};
        }return {data:structuredClone(rows())};
      }
      const q={select(){return q;},eq(k,v){if(k==='status'&&v==='pending')pendingFilter=true;filters.push(row=>row[k]===v);return q;},is(k,v){filters.push(row=>(row[k]??null)===v);return q;},
        in(k,vs){filters.push(row=>vs.includes(row[k]));return q;},
        upsert(v,options){mutation='upsert';values=v;ignoreDuplicates=options.ignoreDuplicates;return q;},
        update(v){mutation='update';values=v;return q;},
        async maybeSingle(){const r=execute();return {...r,data:Array.isArray(r.data)?r.data[0]||null:r.data};},
        then(resolve,reject){return Promise.resolve().then(execute).then(resolve,reject);}};
      return q;
    }};
  const handler=createWhatsAppInvoiceTestHandler({env:{...env,...environment},loadSupabase:()=>supabase,
    authorize:async()=>{if(unauthenticated)throw new APIError(401,'SIGN_IN_REQUIRED');return {workspaceId:scope.workspaceId,userId,role};},
    logger:{warn(){},error(){}},fetchImpl:async(url,options)=>{
      const u=new URL(url);network.push({method:options.method,url,body:options.body?JSON.parse(options.body):null});
      if(u.pathname.endsWith('/messages')){
        if(graphResult==='unknown')throw Error('fixture transport interruption');
        if(graphResult==='failed')return Response.json({error:'fixture'},{status:400});
        return Response.json({messages:[{id:'wamid.owner-fixture'}]});
      }
      assert.equal(options.method,'GET');
      if(u.pathname.endsWith('/phone_numbers'))return Response.json({data:[{id:env.WHATSAPP_PHONE_NUMBER_ID,display_phone_number:'+917303338959'}]});
      const entry=REMINDER_TEMPLATES.find(t=>t.name===u.searchParams.get('name'));
      return Response.json({data:[{id:'1234567',name:entry.name,language:'en',status:templateStatus,category:'UTILITY',components:[{type:'BODY',text:entry.body},...(footer?[{type:'FOOTER',text:footer}]:[])]}]});
    }});
  async function run(method='GET',values=input,token){
    const res={code:null,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method,query:values,body:values,headers:{'x-whatsapp-test-preview':token}},res);return res;
  }
  return {business,before,messages,writes,claims,network,run,setVerified:value=>{verified=value;},supabase};
}
const sends=f=>f.network.filter(row=>row.method==='POST');
const receipt=(status,patch={})=>({workspace_id:scope.workspaceId,idempotency_key:ownerTestKey,invoice_id:scope.invoiceId,
  phone:scope.phone,audience:'owner',direction:'outbound',kind:'invoice_update',status,...patch});

for(const status of ['accepted','sent','delivered','read','unknown','failed','blocked','unexpected'])
test(`existing ${status} owner dispatch returns only its saved status without review, writes or transport`,async()=>{
  const f=setup({templateStatus:'PAUSED'});
  f.messages.push(receipt(status,{body:'Private stored body',provider_message_id:'private-provider-id'}));
  // A revised invoice or stale/missing browser preview must not turn an old
  // receipt into a second send or obscure the recorded delivery status.
  f.business.invoices[0].updated_at='2026-10-16';
  const businessBefore=structuredClone(f.business),messagesBefore=structuredClone(f.messages);
  for(const method of ['GET','POST']){
    const r=await f.run(method,input,'stale-preview');
    assert.equal(r.code,200);assert.equal(r.body.status,'existing');
    assert.equal(r.body.deliveryStatus,status==='unexpected'?'unknown':status);
    assert.equal(r.body.invoiceId,scope.invoiceId);assert.equal(r.body.recipient,scope.phone);
    assert.ok(!JSON.stringify(r.body).includes('Private stored body'));
    assert.ok(!JSON.stringify(r.body).includes('private-provider-id'));
    assert.ok(!Object.hasOwn(r.body,'previewToken'));
  }
  assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.messages,messagesBefore);
  assert.deepEqual(f.business,businessBefore);
});

for(const patch of [{workspace_id:'other'},{idempotency_key:'other'},{invoice_id:'other'},{phone:'+919818685252'},
  {audience:'customer'},{direction:'inbound'},{kind:'normal'}])
test(`existing receipt read excludes mismatched scope ${Object.keys(patch)}`,async()=>{
  const f=setup();f.messages.push(receipt('delivered',patch));
  const r=await f.run();assert.equal(r.code,200);assert.ok(r.body.previewToken);
  assert.ok(!r.body.deliveryStatus);assert.equal(sends(f).length,0);assert.deepEqual(f.writes,[]);
});

test('an unclaimed pending intent still requires the original reviewed dispatch and cannot report delivery',async()=>{
  const f=setup();f.messages.push(receipt('pending'));
  const r=await f.run();assert.equal(r.code,200);assert.ok(r.body.previewToken);assert.ok(!r.body.deliveryStatus);
  assert.equal((await f.run('POST',input,'invalid')).code,409);assert.equal(sends(f).length,0);
});

for(const options of [{unauthenticated:true},{role:'member'},{role:'admin'},{userId:'33333333-3333-4333-8333-333333333333'}])
test(`saved delivery cannot bypass owner/operator authorization ${JSON.stringify(options)}`,async()=>{
  const f=setup(options);f.messages.push(receipt('delivered'));
  for(const method of ['GET','POST']){
    const r=await f.run(method);assert.ok(r.code>=400);assert.ok(!r.body.deliveryStatus);
  }
  assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);
});

test('receipt read failure fails closed without transport, mutations or raw database errors',async()=>{
  const f=setup(),original=f.supabase.from;
  f.supabase.from=table=>{
    if(table!=='whatsapp_messages')return original(table);
    const q={select(){return q;},eq(){return q;},async maybeSingle(){return {error:Error('private fixture database detail')};}};
    return q;
  };
  const r=await f.run('POST');assert.equal(r.code,503);assert.deepEqual(r.body,{error:'WHATSAPP_UNAVAILABLE'});
  assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);assert.deepEqual(f.business,f.before);
});

test('approved Meta opt-out footer is accepted and appears in the owner preview',async()=>{
  const f=setup({footer:'Reply STOP to opt out'}),r=await f.run();
  assert.equal(r.code,200);assert.equal(r.body.footer,'Reply STOP to opt out');
  assert.equal(sends(f).length,0);
});

test('unreviewed Meta footer still fails closed before dispatch',async()=>{
  const f=setup({footer:'Visit a new payment link'}),r=await f.run();
  assert.equal(r.code,409);assert.equal(r.body.error,'APPROVED_TEST_TEMPLATE_MISMATCH');
  assert.equal(sends(f).length,0);
});

test('owner review shows exact test wording/recipient and has no message or business writes',async()=>{
  const f=setup(),r=await f.run();assert.equal(r.code,200);
  assert.equal(r.body.recipient,scope.phone);assert.equal(r.body.audience,'owner');assert.equal(r.body.invoiceId,scope.invoiceId);
  assert.equal(r.body.text,'Hi, this is CETLD test. Invoice TEST ONLY - INV-2026-6771 for owner test only has an update.');
  assert.equal(r.body.idempotencyKey,ownerTestKey);assert.ok(r.body.previewToken);assert.deepEqual(f.writes,[]);
  assert.equal(sends(f).length,0);assert.deepEqual(f.business,f.before);
  assert.ok(!JSON.stringify(r.body).includes(env.WHATSAPP_ACCESS_TOKEN));
});

for(const options of [{unauthenticated:true},{role:'member'},{role:'admin'},{userId:'33333333-3333-4333-8333-333333333333'},
  {environment:{WHATSAPP_TEST_OPERATOR_USER_ID:''}},{environment:{WHATSAPP_OUTBOUND_ENABLED:'false'}},
  {environment:{WHATSAPP_TEST_ALLOWLIST:'+919818685252'}},{environment:{WHATSAPP_WABA_ID:'99999999'}}])
test(`owner test authorization fails closed ${JSON.stringify(options)}`,async()=>{
  const f=setup(options);assert.ok((await f.run()).code>=400);assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);
});

for(const values of [{...input,workspaceId:'33333333-3333-4333-8333-333333333333'},
  {...input,invoiceId:'33333333-3333-4333-8333-333333333333'}, {...input,recipient:'+919818685252'},
  {...input,to:scope.phone},{...input,text:'send anything'},{...input,idempotencyKey:'new-key'}])
test(`owner test rejects arbitrary scope or send controls ${Object.keys(values).join(',')}`,async()=>{
  const f=setup();for(const method of ['GET','POST'])assert.ok((await f.run(method,values)).code>=400);
  assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);
});

for(const change of ['unverified','foreign-invoice','deleted','real-invoice-number','owner-phone','revoked','suppressed','wrong-owner-consent'])
test(`owner test rejects ${change} before provider metadata or dispatch`,async()=>{
  const f=setup();
  if(change==='unverified')f.setVerified(false);
  if(change==='foreign-invoice')f.business.invoices[0].workspace_id='other';
  if(change==='deleted')f.business.invoices[0].deleted_at='2026-10-15';
  if(change==='real-invoice-number')f.business.invoices[0].invoice_number='REAL-1';
  if(change==='owner-phone')f.business.workspace_settings[0].whatsapp_owner_phone='+919818685252';
  if(change==='revoked')f.business.whatsapp_consents[0].revoked_at='2026-10-15';
  if(change==='suppressed')f.business.whatsapp_global_suppressions.push({phone:scope.phone});
  if(change==='wrong-owner-consent')f.business.whatsapp_consents[0].customer_id='other';
  assert.ok((await f.run()).code>=400);assert.equal(f.network.length,0);assert.deepEqual(f.writes,[]);
});

test('send requires exact preview, never accepts caller-supplied recipient or a stale invoice',async()=>{
  const f=setup();assert.equal((await f.run('POST')).code,409);assert.equal(sends(f).length,0);
  const preview=await f.run();assert.equal((await f.run('POST',input,preview.body.previewToken+'x')).code,409);
  f.business.invoices[0].updated_at='2026-10-16T00:00:00Z';
  assert.equal((await f.run('POST',input,preview.body.previewToken)).code,409);assert.equal(sends(f).length,0);
  assert.deepEqual(f.writes,[]);
});

for(const graphResult of ['accepted','failed','unknown'])test(`one durable owner dispatch only after ${graphResult}, including concurrent/revised retries`,async()=>{
  const f=setup({graphResult}),preview=await f.run();
  const results=await Promise.all([f.run('POST',input,preview.body.previewToken),f.run('POST',input,preview.body.previewToken)]);
  assert.ok(results.some(r=>r.body.status===graphResult));assert.equal(f.claims.length,1);assert.equal(sends(f).length,1);
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].audience,'owner');
  const sent=sends(f)[0].body;assert.equal(sent.to,scope.phone.slice(1));assert.equal(sent.type,'template');
  assert.equal(sent.template.name,'cetld_invoice_update_v2');assert.equal(sent.biz_opaque_callback_data.length,64);
  assert.ok(!ownerTestKey.includes('approved-template-proof'));assert.ok(!f.messages[0].idempotency_key.startsWith('reply:'));
  f.business.invoices[0].updated_at='2026-10-16T00:00:00Z';const revised=await f.run();
  const duplicate=await f.run('POST',input,revised.body.previewToken);
  assert.equal(duplicate.code,200);assert.equal(duplicate.body.status,'existing');assert.equal(duplicate.body.deliveryStatus,graphResult);
  assert.equal(sends(f).length,1);
  // The only business fixture change here was our test's revision update.
  f.business.invoices[0].updated_at=f.before.invoices[0].updated_at;assert.deepEqual(f.business,f.before);
});

for(const change of ['revoke','unverify','invoice-change'])test(`post-claim ${change} blocks send without releasing dispatch`,async()=>{
  const f=setup({onClaim:({business,setVerified})=>{
    if(change==='revoke')business.whatsapp_consents[0].revoked_at='2026-10-16';
    if(change==='unverify')setVerified(false);
    if(change==='invoice-change')business.invoices[0].updated_at='2026-10-16';
  }}),preview=await f.run();
  assert.equal((await f.run('POST',input,preview.body.previewToken)).code,409);
  assert.equal(sends(f).length,0);assert.equal(f.messages[0].status,'blocked');assert.equal(f.claims.length,1);
});

test('unapproved provider template cannot be reviewed or sent',async()=>{
  const f=setup({templateStatus:'PAUSED'});assert.equal((await f.run()).code,409);assert.deepEqual(f.writes,[]);assert.equal(sends(f).length,0);
});

test('native Postgres conditional claim survives concurrency and process restart; no failed/unknown retry',async()=>{
  const db=new PGlite();await db.exec('create table whatsapp_messages(id text,workspace_id text,idempotency_key text,status text,audience text,direction text,phone text,invoice_id text,updated_at text,unique(workspace_id,idempotency_key))');
  await db.query('insert into whatsapp_messages values ($1,$2,$3,$4,$5,$6,$7,$8,null)',
    ['fixture',scope.workspaceId,ownerTestKey,'pending','owner','outbound',scope.phone,scope.invoiceId]);
  const client=()=>({from(table){assert.equal(table,'whatsapp_messages');const filters=[];let update;
    const q={update(values){update=values;return q;},eq(key,value){filters.push([key,value]);return q;},async select(){
      const values=[update.status,update.updated_at,...filters.map(([,v])=>v)];
      const result=await db.query('update whatsapp_messages set status=$1,updated_at=$2 where '+filters.map(([k],i)=>`${k}=$${i+3}`).join(' and ')+' returning id',values);
      return {data:result.rows};}};return q;}});
  try{
    const results=await Promise.all(Array.from({length:5},()=>claimOwnerTest({supabase:client(),workspaceId:scope.workspaceId,key:ownerTestKey})));
    assert.equal(results.filter(Boolean).length,1);
    for(const status of ['unknown','failed','accepted','sent','delivered','read','blocked']){
      await db.query('update whatsapp_messages set status=$1',[status]);
      assert.equal(await claimOwnerTest({supabase:client(),workspaceId:scope.workspaceId,key:ownerTestKey}),false);
    }
    await assert.rejects(db.query('insert into whatsapp_messages(id,workspace_id,idempotency_key) values($1,$2,$3)',['another',scope.workspaceId,ownerTestKey]),/duplicate key/);
  }finally{await db.close();}
});
