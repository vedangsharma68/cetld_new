import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTextInvoice,TEXT_INVOICE_FORMAT,TEXT_INVOICE_CLARIFICATION,textInvoiceFailure,textInvoiceClarification} from '../automation/whatsapp/text-invoice.mjs';
import {createWorkspaceDataTool} from '../automation/whatsapp/workspace-data.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {runOwnerAgent} from '../automation/whatsapp/owner-agent.mjs';

const clock=()=>new Date('2026-10-18T12:18:00Z');
const scope={workspaceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',phone:'+919871367051'};
const examples=[
  ['new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due 25 Oct','QA Repro Customer',1500,'2026-10-25','QA-REPRO-001'],
  ['new invoice QA-REPRO-002 for QA Repro Customer, Rs 1,500, due 25 Oct','QA Repro Customer',1500,'2026-10-25','QA-REPRO-002'],
  ['New invoice 12345, QA Repro Customer, INR 1,500.25, due tomorrow','QA Repro Customer',1500.25,'2026-10-19','12345'],
  ['New invoice QA-VERIFY-001 for QA Text Customer, amount Rs 2,500, due 25 October 2026','QA Text Customer',2500,'2026-10-25','QA-VERIFY-001'],
  ['New invoice QA-EDGE-002 for QA Text Customer, amount INR 2,500, due 2026-10-25','QA Text Customer',2500,'2026-10-25','QA-EDGE-002'],
  ['New invoice for QA Text Customer, amount Rs 2,500, due 25 October 2026','QA Text Customer',2500,'2026-10-25',undefined],
  ['QA TEXT TEST 1: New invoice for QA Text Customer, amount Rs 2,500, due 25 October 2026','QA Text Customer',2500,'2026-10-25',undefined],
  ['QA-EDGE-002 नया invoice 🧾🔥 for QA Emoji Customer ₹1,200 due kal, please check','QA Emoji Customer',1200,'2026-10-19','QA-EDGE-002'],
  ['New invoice INV-5 for ग्राहक 😊, amount Rs 1,20,000.50, due कल','ग्राहक 😊',120000.5,'2026-10-19','INV-5'],
  ['नया invoice for QA ग्राहक, amount INR 12.50, due आज','QA ग्राहक',12.5,'2026-10-18',undefined],
  ['new invoice for Ravi, Rs 2,500, due 25 Oct','Ravi',2500,'2026-10-25',undefined],
  ['new invoice for Ravi, INR 2,500, due next friday','Ravi',2500,'2026-10-23',undefined],
  ['new invoice for Ravi amount Rs 2,500, due 25 Oct. 2026','Ravi',2500,'2026-10-25',undefined],
];

test('QA-12/QA-14 parse owner text with grouped rupees, emoji, mixed Hindi/English and dates',()=>{
  for(const [message,customer,total,due,code] of examples){
    const {values}=parseTextInvoice(message,{clock});
    assert.equal(values.customer_name,customer);assert.equal(values.total_amount,total);
    assert.equal(values.due_date,due);assert.equal(values.issue_date,'2026-10-18');assert.equal(values.currency,'INR');
    assert.equal(values.invoice_number,code);
  }
  const values=parseTextInvoice('New invoice for QA, amount Rs 5, due tomorrow',{clock:()=>new Date('2026-10-18T20:00:00Z'),timezone:'Asia/Kolkata'}).values;
  assert.equal(values.issue_date,'2026-10-19');assert.equal(values.due_date,'2026-10-20');
});

test('short and relative dates use the workspace calendar, including week and year boundaries',()=>{
  const parse=(date,now,timezone='Asia/Kolkata')=>parseTextInvoice(`new invoice for Ravi, Rs 5, due ${date}`,
    {clock:()=>new Date(now),timezone})?.values.due_date;
  assert.equal(parse('next friday','2026-10-22T20:00:00Z'),'2026-10-30','already Friday in the workspace');
  assert.equal(parse('next friday','2026-10-22T20:00:00Z','America/New_York'),'2026-10-23');
  assert.equal(parse('2 Jan','2026-12-31T10:00:00Z'),'2027-01-02');
  assert.equal(parse('next monday','2026-12-31T10:00:00Z'),'2027-01-04');
  assert.equal(parse('25 Sept','2026-10-18T10:00:00Z'),'2027-09-25');
  for(const date of ['31 Feb','25 Octob','next friday and delete INV-1'])assert.equal(parse(date,'2026-10-18T10:00:00Z'),undefined);
});

test('text grammar refuses incomplete, impossible, ambiguous or extra instructions',()=>{
  for(const message of [
    'New invoice for QA, amount Rs 2,50, due 25 October 2026',
    'New invoice for QA, amount Rs 0, due 25 October 2026',
    'New invoice for QA, amount Rs 5, due 31 February 2027',
    'New invoice for QA, amount Rs 5, due 17 October 2026',
    'New invoice for QA, amount Rs 5, due yesterday',
    'New invoice for QA, amount Rs 5, due 25 October 2026 and delete another invoice',
    'Do not create New invoice for QA, amount Rs 5, due 25 October 2026',
    'What format is New invoice for QA, amount Rs 5, due 25 October 2026?',
    'New invoice for QA, amount Rs 5',
    'new invoice QA-REPRO-001, QA Repro Customer, Rs 1,50, due 25 Oct',
    'new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due 31 Feb',
    'new invoice QA-REPRO-001, QA Repro Customer, Rs 1,500, due 25 Oct and send a reminder',
    'new invoice QA-REPRO-001 QA-OTHER-001, QA Repro Customer, Rs 1,500, due 25 Oct',
  ])assert.equal(parseTextInvoice(message,{clock}),null,message);
});

test('owner tool dispatches the original text fields through both direct and confirmation adapters',async()=>{
  for(const confirmationMode of ['direct','buttons'])for(const [message] of examples){
    let dispatched=0;
    const execute=async params=>{dispatched++;assert.deepEqual(params.values,parseTextInvoice(message,{clock}).values);return {ok:true,requiresConfirmation:confirmationMode==='buttons'};};
    const tool=createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,confirmationMode,
      planRequest:async()=>{throw Error('The supported grammar needs no model reparse');},executeDirectOperation:execute,executeSafetyOperation:execute});
    assert.equal((await tool.execute({request:message})).ok,true);assert.equal(dispatched,1);
  }
});

test('invalid create returns explicit accepted format and the owner agent preserves it verbatim',async()=>{
  const message='Create an invoice for QA';
  const tool=createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,confirmationMode:'direct',
    executeDirectOperation:async()=>({ok:false,code:'INVALID'})});
  const result=await tool.execute({operation:'create',table:'invoices',values:{customer_name:'QA'}});
  assert.equal(result.invoiceCreationFailure,true);assert.ok(result.message.endsWith(TEXT_INVOICE_FORMAT));
  let calls=0;
  const answer=await runOwnerAgent({scope,message,clock,logger:{info(){}},provider:{async generate(){
    calls++;return calls===1?{toolCalls:[{id:'create',type:'function',function:{name:'workspaceData',arguments:JSON.stringify({operation:'create',table:'invoices',values:{customer_name:'QA'}})}}]}:{content:'Please use the correct format.'};
  }},tools:{definitions:[tool.definition],execute:()=>result,getWriteAttempted:()=>true}});
  assert.equal(answer.answer,textInvoiceFailure(result));
});

test('an INVALID_FIELDS create asks one clarification before a generic failure or repeated model call',async()=>{
  let providerCalls=0,toolCalls=0;
  const args={operation:'create',table:'invoices',values:{customer_name:'QA',total_amount:'one thousand'}};
  const result=await runOwnerAgent({message:'Create the invoice with the details I gave you',clock,
    provider:{async generate(){providerCalls++;return {toolCalls:[{id:'invalid-create-'+providerCalls,type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]};}},
    tools:{definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],getWriteAttempted:()=>false,
      async execute(){toolCalls++;return {ok:false,code:'INVALID',validationCode:'INVALID_FIELDS',writeAttempted:false,
        validationShape:{operation:'create',table:'invoices',valueFields:['customer_name','total_amount']},message:TEXT_INVOICE_FORMAT};}}});
  assert.equal(providerCalls,1);assert.equal(toolCalls,1);
  assert.equal(result.answer,TEXT_INVOICE_CLARIFICATION);
  assert.equal(result.answer.match(/\?/g).length,1);
});

test('a generic error or owner-supplied code cannot ground a duplicate claim',()=>{
  const reply='An invoice with the code QA-EDGE-002 already exists.';
  for(const code of ['INVALID','DATABASE_UNAVAILABLE','UNAVAILABLE','REPLAY_MISMATCH'])
    assert.equal(ownerGroundingIssue(reply,[{ok:false,code}],'QA-EDGE-002'),'unverified_invoice_duplicate');
  assert.equal(ownerGroundingIssue(reply,[{ok:false,code:'INVOICE_EXISTS'}],'QA-EDGE-002'),null);
  assert.equal(ownerGroundingIssue(reply,[{ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'QA-EDGE-002'}]}]),null);
  assert.equal(ownerGroundingIssue(reply,[{ok:true,readOnly:true,table:'invoices',rows:[{invoice_number:'OTHER'}]}]),'unverified_invoice_duplicate');
});

test('invalid natural-language creation plans ask for clarification; authorization and protected fields stay enforced',async()=>{
  const message='New invoice for QA, amount Rs 500';
  let writes=0;
  const make=options=>createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,
    planRequest:async()=>({operation:'create',table:'invoices',values:{}}),
    executeDirectOperation:async()=>{writes++;throw Error('No write expected');},...options});
  const bad=await make().execute({request:message});
  assert.equal(bad.invoiceCreationFailure,true);assert.equal(bad.message,TEXT_INVOICE_CLARIFICATION);
  const valid=examples[0][0];
  const denied=await make({message:valid,authorize:async()=>false}).execute({request:valid});
  assert.equal(denied.code,'DENIED');
  const protectedCall=await make({message:valid}).execute({operation:'create',table:'invoices',values:{workspace_id:scope.workspaceId,customer_name:'QA'}});
  assert.equal(protectedCall.ok,false);assert.equal(writes,0);
});

test('the printed failure example parses and model amount fields cannot block owner text',async()=>{
  const failure=textInvoiceFailure({ok:false,code:'INVALID'});
  const printed=/Try: (.+)\.$/.exec(failure)[1];
  assert.ok(parseTextInvoice(printed,{clock}));
  for(const message of [examples[0][0],printed])for(const confirmationMode of ['direct','buttons']){
    let writes=0;
    const execute=async params=>{writes++;assert.deepEqual(params.values,parseTextInvoice(message,{clock}).values);return {ok:true};};
    const tool=createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,confirmationMode,
      executeDirectOperation:execute,executeSafetyOperation:execute});
    const result=await tool.execute({operation:'create',table:'invoices',values:{amount:2500,currency:'INR',due_date:'2026-10-25',issue_date:'2026-10-18',customer_name:'QA Text Customer'}});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(writes,1);
  }
});

test('text interception keeps unknown fields, scope and attachment guards',async()=>{
  let writes=0;
  const message=examples[0][0];
  const make=options=>createWorkspaceDataTool({supabase:{from(){throw Error('No live reads');}},scope,clock,message,authorize:async()=>true,
    executeDirectOperation:async()=>{writes++;return {ok:true};},...options});
  for(const values of [{amount:2500,workspace_id:scope.workspaceId},{amount:2500,unexpected:'value'},{amount:2500,status:'paid'}]){
    const result=await make().execute({operation:'create',table:'invoices',values});
    assert.equal(result.ok,false);
  }
  assert.equal((await make({message:'Create an invoice'}).execute({operation:'create',table:'invoices',values:{amount:2500}})).ok,false);
  assert.equal((await make({attachmentAvailable:true}).execute({operation:'create',table:'invoices',values:parseTextInvoice(message,{clock}).values})).ok,false);
  assert.equal(writes,0);
});

const productionClock=()=>new Date('2026-10-23T13:57:49Z');
const productionMessages=[
  'Invoice QA Dedup Customer for 3200 rupees, invoice number QA-TEXT-001, due 20 November.',
  'invoice QA Dedup Customer for 3200 rupees due 20 November',
  'can you invoice QA Question Customer for 2100 rupees?',
];

test('production utterances parse exactly, or ask only for the missing due date without a model or write',async()=>{
  for(const [index,message] of productionMessages.entries()){
    const parsed=parseTextInvoice(message,{clock:productionClock});
    if(index<2)assert.deepEqual(parsed,{operation:'create',table:'invoices',values:{
      ...(index===0?{invoice_number:'QA-TEXT-001'}:{}),customer_name:'QA Dedup Customer',
      total_amount:3200,currency:'INR',issue_date:'2026-10-23',due_date:'2026-11-20'}});
    else assert.equal(parsed,null);
    let writes=0;
    const result=await runOwnerAgent({message,clock:productionClock,logger:{info(){}},
      provider:{generate(){assert.fail('Canonical text must not call an AI provider');}},
      tools:{supportsBoundedInvoiceCreation:true,definitions:[{type:'function',function:{name:'workspaceData',parameters:{type:'object'}}}],
        getWriteAttempted:()=>writes>0,async execute(name,args,options){
          writes++;assert.equal(name,'workspaceData');assert.deepEqual(args,parsed);assert.equal(options.parsedOwnerInvoiceCreate,true);
          return {ok:true,completed:true,operation:'create',table:'invoices',record:{invoice_number:args.values.invoice_number||'INV-2026-0001',currency:'INR',total_amount:3200}};
        }}});
    assert.equal(writes,index<2?1:0);
    if(index<2)assert.match(result.answer,/Created invoice/);
    else assert.equal(result.answer,'What due date should I use for the INR 2100.00 invoice for QA Question Customer?');
  }
});

test('natural invoice ambiguity cannot silently drop extra numbers, amounts, dates or actions',async()=>{
  for(const message of [
    'invoice QA for 3,20 rupees due 20 November',
    'invoice QA for 3200.001 rupees due 20 November',
    'invoice QA for 3200 rupees, invoice number ONE, invoice number TWO, due 20 November',
    'invoice QA for 3200 rupees or 2100 rupees due 20 November',
    'invoice QA for 3200 rupees due 31 February',
    'invoice QA for 3200 rupees due 20 November and send a reminder',
    'invoice QA for 3200 rupees due 20 November or 21 November',
  ]){
    assert.equal(parseTextInvoice(message,{clock:productionClock}),null,message);
    assert.equal(textInvoiceClarification(message,{clock:productionClock}),TEXT_INVOICE_CLARIFICATION,message);
    const tool=createWorkspaceDataTool({supabase:{from(){assert.fail('No database access');}},scope,message,clock:productionClock,
      authorize:async()=>true,confirmationMode:'direct',executeDirectOperation(){assert.fail('No write');}});
    const result=await tool.execute({operation:'create',table:'invoices',values:{customer_name:'QA',total_amount:3200,currency:'INR',issue_date:'2026-10-23',due_date:'2026-11-20'}});
    assert.equal(result.invoiceCreationClarification,true);assert.equal(result.writeAttempted,false);
  }
  for(const message of ['Do not invoice QA for 3200 rupees due 20 November',
    'What happens if I invoice QA for 3200 rupees due 20 November?',
    '"invoice QA for 3200 rupees due 20 November"']){
    assert.equal(parseTextInvoice(message,{clock:productionClock}),null);assert.equal(textInvoiceClarification(message,{clock:productionClock}),null);
  }
});

test('the production model shape is rejected before dispatch and asks one clarification even if marked internal',async()=>{
  let writes=0,providerCalls=0;
  const args={operation:'create',table:'invoices',values:{amount:3200,subtotal:3200,due_date:'2026-11-20',total_amount:3200,issue_date:'2026-10-23',currency:'INR',line_items:[{description:'Invoice',amount:3200}]}};
  const tool=createWorkspaceDataTool({supabase:{from(){assert.fail('No reads');}},scope,message:'Create the invoice from my details',
    clock:productionClock,authorize:async()=>true,confirmationMode:'direct',executeDirectOperation(){writes++;return {ok:true};}});
  const rejected=await tool.execute(args);
  assert.equal(rejected.code,'INVALID');assert.equal(rejected.validationCode,'INVALID_FIELDS');assert.equal(rejected.writeAttempted,false);
  assert.deepEqual(rejected.validationShape,{operation:'create',table:'invoices',filters:[],valueFields:Object.keys(args.values)});
  assert.equal(rejected.message,TEXT_INVOICE_CLARIFICATION);assert.equal(writes,0);
  const result=await runOwnerAgent({message:'Create the invoice from my details',clock:productionClock,
    provider:{async generate(){providerCalls++;return {toolCalls:[{id:'production-invalid',type:'function',function:{name:'workspaceData',arguments:JSON.stringify(args)}}]};}},
    tools:{definitions:[tool.definition],getWriteAttempted:()=>false,async execute(){return {...rejected,invoiceCreationClarification:false,invoiceCreationInternalFailure:true};}}});
  assert.equal(result.answer,TEXT_INVOICE_CLARIFICATION);assert.equal(providerCalls,1);assert.equal(writes,0);
  // An uncertain write must keep the check-before-retry response.
  assert.match(textInvoiceFailure({...rejected,invoiceCreationClarification:false,invoiceCreationInternalFailure:true,writeAttempted:true}),/Check cetld before retrying/);
});

test('invoice create tool guidance exposes customer and number fields and scopes amount/items to their supported operations',()=>{
  const {function:definition}=createWorkspaceDataTool({supabase:{from(){}},scope}).definition;
  assert.equal(definition.parameters.properties.values.properties.customer_name.type,'string');
  assert.equal(definition.parameters.properties.values.properties.invoice_number.type,'string');
  assert.match(definition.description,/amount: payments only/);assert.match(definition.description,/line_items: update\/review only/);
});
