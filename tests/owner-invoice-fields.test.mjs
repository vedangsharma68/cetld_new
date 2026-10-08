import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import {validateInvoiceCorrection} from '../automation/whatsapp/invoice-corrections.mjs';
import {AIProvider} from '../ai/provider.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const logger={info(){},warn(){},error(){}};
test('typed correction preflight rejects security fields and malformed dates, money and item arithmetic',()=>{
 for(const patch of [{metadata:{}},{amount_paid:0},{customer_id:'other'},{total_amount:0},{tax:null},{discount:-1},{currency:'JPY'},
  {issue_date:'2026-02-31'},{issue_date:'2026-10-04',due_date:'2026-10-03'},
  {line_items:[{description:'Service',quantity:2,unitPrice:20,amount:41}]},
  {line_items:[{description:'Service',amount:20,credentials:'secret'}]},
  {custom_fields:{owner_id:randomUUID()}}])assert.throws(()=>validateInvoiceCorrection(patch));
 assert.deepEqual(validateInvoiceCorrection({tax:'1.25',notes:null,line_items:[{description:'Service',quantity:2.5,unitPrice:2,amount:5}]}),
  {tax:1.25,notes:null,line_items:[{description:'Service',amount:5,quantity:2.5,unitPrice:2}]});
});

test('serialized Gemini, real SDK and SQL persist invoice corrections, resolve JohnSmith and recover interrupted replies',async()=>{
 const f=await createOfflineSqlNetwork(),{db,supabase}=f,ownerId=randomUUID(),phone='+919871367051';
 try{
  await db.query('insert into auth.users(id) values($1)',[ownerId]);
  await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId=(await db.query("select (public.create_workspace('Invoice correction fixture',$1)).id",['correction-'+randomUUID()])).rows[0].id;
  const code=(await db.query('select * from public.owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0].code;
  await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub='';set role service_role");
  assert.equal((await db.query('select public.whatsapp_verify_owner_code($1,$2) as result',[phone,code])).rows[0].result.ok,true);
  const customerId=(await db.query('select customer_id from public.whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
  const scope={workspaceId,ownerId,customerId,phone};
  async function tools(message,id){
   await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'123456',$2,'text',$3,'processing')",[id,phone,message]);
   return createOwnerWorkspaceTools({supabase,scope,message,messageId:id,authorize:async()=>true,clock:()=>new Date('2026-10-04T22:00:00Z'),timezone:'Asia/Kolkata',
    botPreferences:{confirmationMode:'direct'},pendingStoreAvailable:false,ownerStore:{async query(){throw Error('Legacy tool must not run');}}});
  }
  const create=await tools('Create invoice for Jane','fields-create');
  const created=await create.execute('workspaceData',{operation:'create',table:'invoices',values:{invoice_number:'FIELD-1',customer_name:'Jane',issue_date:'2026-10-01',due_date:'2026-10-05',currency:'USD',total_amount:100}});
  assert.equal(created.completed,true,JSON.stringify(created));
  const invoice=(await db.query('select * from invoices where workspace_id=$1',[workspaceId])).rows[0];
  const john=(await db.query("insert into customers(workspace_id,name,phone) values($1,'John Smith','+919822222222') returning id",[workspaceId])).rows[0];
  const target=[{column:'invoice_number',operator:'eq',value:invoice.invoice_number}];
  const message='Assign FIELD-1 to JohnSmith, set its line items and tax, and make its due date tomorrow.';
  const change=await tools(message,'fields-change');let calls=0,evidence,wireEvidence;
  const values={customer_name:'JohnSmith',line_items:[{description:'Service',quantity:2,unitPrice:40,amount:80}],subtotal:80,tax:25,discount:5,total_amount:100,
   due_date:'tomorrow',notes:'Corrected',invoice_direction:'receivable',seller_name:'Our company',buyer_name:'John Smith',payment_information:'Pay by bank transfer',custom_fields:{purchase_order:'PO-1'}};
  const provider=new AIProvider({primaryModel:'gemini-3.5-flash-lite',fallbackModel:null,geminiApiKey:'isolated',maxAttempts:1,logger,
   fetchImpl:async(_url,init)=>{calls++;const body=JSON.parse(init.body);
    if(calls===1)return Response.json({candidates:[{content:{parts:[{functionCall:{name:'workspaceData',args:{operation:'update',table:'invoices',filters:target,values}}}]},finishReason:'STOP'}]});
    wireEvidence=body;
    evidence=body.contents.flatMap(row=>row.parts).flatMap(part=>{try{return [JSON.parse(part.text)];}catch{return [];}}).find(row=>row.action==='invoice.updated');
    return Response.json({candidates:[{content:{parts:[{text:'Updated FIELD-1.'}]},finishReason:'STOP'}]});
   }});
  const result=await runOwnerAgent({provider,message,tools:change,timezone:'Asia/Kolkata',clock:()=>new Date('2026-10-04T22:00:00Z')});
  assert.equal(evidence?.completed,true,JSON.stringify(wireEvidence));
  assert(!Object.hasOwn(evidence.record,'metadata'));assert(!Object.hasOwn(evidence,'correctionAuditId'));
  assert.equal(result.plannerFailure,undefined,JSON.stringify(result));assert.equal(result.invoiceCorrectionFallback,true);
  assert.equal(result.answer.split('\n')[0],'Invoice '+invoice.invoice_number);assert.match(result.answer,/Customer changed/);
  assert.match(result.answer,/Due date: 2026-10-06/);assert.match(result.answer,/Tax: USD 25/);
  assert.equal((await db.query('select customer_id from invoices where workspace_id=$1 and id=$2',[workspaceId,invoice.id])).rows[0].customer_id,john.id);assert.equal(evidence.record.due_date,'2026-10-06');
  assert.equal((await db.query('select count(*)::int n from invoice_correction_audits where invoice_id=$1',[invoice.id])).rows[0].n,1);
  const read=await tools('Show invoice fields','fields-read');
  const viewed=await read.execute('workspaceData',{operation:'read',table:'invoices',filters:target,columns:['subtotal','tax','discount','line_items','invoice_direction','seller_name','buyer_name','payment_information','custom_fields']});
  assert.equal(viewed.ok,true,JSON.stringify(viewed));assert.equal(Number(viewed.rows[0].tax),25);
  assert.equal(viewed.rows[0].custom_fields.purchase_order,'PO-1');assert.equal(viewed.rows[0].line_items[0].amount,80);assert(!Object.hasOwn(viewed.rows[0],'metadata'));
  const instructionsMessage='Set FIELD-1 payment instructions to use bank transfer reference FIELD-1.';
  const instructions=await tools(instructionsMessage,'fields-payment-information');let instructionCalls=0;
  const instructionProvider=new AIProvider({primaryModel:'gemini-3.5-flash-lite',fallbackModel:null,geminiApiKey:'isolated-fixture',maxAttempts:1,logger,
   fetchImpl:async()=>Response.json({candidates:[{content:{parts:++instructionCalls===1
    ?[{functionCall:{name:'workspaceData',args:{operation:'update',table:'invoices',filters:target,values:{payment_information:'Use bank transfer reference FIELD-1'}}}}]
    :[{text:'Updated FIELD-1 payment instructions.'}]},finishReason:'STOP'}]})});
  const instructionAnswer=await runOwnerAgent({provider:instructionProvider,message:instructionsMessage,tools:instructions,history:[],logger});
  assert.equal(instructionAnswer.answer,'Updated FIELD-1 payment instructions.');assert.equal(instructionCalls,2);
  assert.equal((await db.query('select metadata->>\'payment_information\' value from invoices where id=$1',[invoice.id])).rows[0].value,'Use bank transfer reference FIELD-1');
  assert.equal((await db.query('select count(*)::int n from payments where workspace_id=$1',[workspaceId])).rows[0].n,0);
  const edit=await tools('Set FIELD-1 notes to persisted before interruption','fields-interrupted'),rpc=supabase.rpc.bind(supabase);let writes=0;
  supabase.rpc=async(name,args)=>{const outcome=await rpc(name,args);if(name==='whatsapp_correct_owner_invoice'){writes++;throw Error('Isolated lost response after commit');}return outcome;};
  const interrupted=await edit.execute('workspaceData',{operation:'update',table:'invoices',filters:target,values:{notes:'Persisted before interruption'}});
  assert.equal(interrupted.completed,false);assert.equal(interrupted.code,'WRITE_UNCONFIRMED');
  assert.equal((await edit.lookupCompleted()).completed,true);assert.equal((await edit.lookupCompleted()).completed,true);assert.equal(writes,1);
  supabase.rpc=rpc;
  await db.query("insert into customers(workspace_id,name) values($1,'John Jones')",[workspaceId]);
  const ambiguous=await tools('Assign FIELD-1 to John','fields-ambiguous');
  assert.equal((await ambiguous.execute('workspaceData',{operation:'update',table:'invoices',filters:target,values:{customer_name:'John'}})).code,'AMBIGUOUS');
  assert.equal(ambiguous.getWriteAttempted(),false);
  await db.query("update invoice_correction_audits set after_snapshot=after_snapshot where invoice_id=$1",[invoice.id]).then(()=>assert.fail('Audit mutation must fail'),()=>{});
  for(const request of f.requests.filter(request=>request.method==='GET'))assert.equal(new URL(request.url).searchParams.get('workspace_id'),'eq.'+workspaceId);
  assert.equal(f.errors.length,0,JSON.stringify(f.errors));
 }finally{await f.close();}
});
