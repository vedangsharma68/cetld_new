import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {authorizeAIWorkspace} from '../ai/store.mjs';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';
import {createAssistantTools} from '../ai/tools.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {saveAssistantInvoice, validateAssistantInvoice} from '../ai/invoice-ops.mjs';
import {extractInvoice, validateInvoiceExtractionResponse} from '../ai/extraction.mjs';
import {parsePdfInvoiceText} from '../ai/pdf-invoice-parser.mjs';
import {parseOfflineInvoiceText} from '../ai/image-text.mjs';
import {renderReminderTemplate, reminderBody} from '../automation/preferences.mjs';
import {canApprove, totals} from '../core.mjs';
import {deriveInvoiceReadAnalysis,ownerInvoiceReadAnalysis,invoiceReadAnalysisReply,invoiceReadAnalysisArgs} from '../automation/whatsapp/owner-invoice-read-analysis.mjs';
import {ownerCalendar} from '../automation/whatsapp/workspace-records.mjs';
import {calendarDay, shiftDay} from '../invoice/date-context.mjs';

const workspaceId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const customerId='cccccccc-cccc-4ccc-8ccc-cccccccccccc', invoiceId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const base={id:invoiceId,workspace_id:workspaceId,customer_id:customerId,invoice_number:'INV-42',issue_date:'2026-10-01',due_date:'2026-10-18',currency:'INR',total_amount:'118.00',amount_paid:'0.00',status:'sent',metadata:{invoice_direction:'receivable',subtotal:100,tax:18}};
const clock=()=>new Date('2026-10-18T20:00:00Z'); // Oct 19 in IST, Oct 18 in UTC.
const noProvider={generate:async()=>{throw Error('A deterministic answer must not spend a provider call');}};

// Exercise the production authenticated REST adapter. Never connect to Supabase
// or a messaging provider; inspect the actual scoped HTTP requests it emits.
async function productionStore({timezone='Asia/Kolkata',invoices=[base]}={}) {
  const calls=[], saved=[];
  const fetchImpl=async(raw,options={})=>{
    const url=new URL(raw),method=options.method||'GET'; calls.push({url,method,options});
    if(url.pathname==='/auth/v1/user')return Response.json({id:userId});
    if(url.pathname==='/rest/v1/workspace_members')return Response.json([{workspace_id:workspaceId,user_id:userId,role:'owner'}]);
    if(method==='POST')assert.equal(JSON.parse(options.body).workspace_id,workspaceId);
    else assert.equal(url.searchParams.get('workspace_id'),`eq.${workspaceId}`);
    if(url.pathname==='/rest/v1/workspace_settings')return Response.json([{workspace_id:workspaceId,default_timezone:timezone,business_name:'Cedar Studio'}]);
    if(url.pathname==='/rest/v1/customers')return Response.json([{id:customerId,workspace_id:workspaceId,name:'Buyer'}]);
    if(url.pathname==='/rest/v1/invoices'){
      if(method==='POST'){
        const payload=JSON.parse(options.body);
        const row={...base,...payload,id:invoiceId,status:'draft'}; saved.push(row);return Response.json([row]);
      }
      if(method==='PATCH'){
        Object.assign(saved.at(-1),JSON.parse(options.body));return Response.json([saved.at(-1)]);
      }
      if(url.searchParams.has('metadata->>assistant_idempotency_key'))return Response.json([]);
      return Response.json(invoices.slice(Number(url.searchParams.get('offset')||0),Number(url.searchParams.get('offset')||0)+Number(url.searchParams.get('limit')||100)));
    }
    if(['/rest/v1/payments','/rest/v1/invoice_files'].includes(url.pathname))return Response.json([]);
    throw Error(`Unexpected production request ${method} ${url.pathname}`);
  };
  const store=await authorizeAIWorkspace({headers:{authorization:'Bearer fixture-owner-token'}},workspaceId,{env:{SUPABASE_URL:'https://db.example.test',SUPABASE_PUBLISHABLE_KEY:'fixture',NODE_ENV:'test'},fetchImpl});
  return {store,calls,saved};
}

test('production timezone setting anchors next-seven-day queries and overdue cutoff across IST midnight',async()=>{
  const f=await productionStore();
  const result=await answerWorkspaceQuestion({provider:noProvider,store:f.store,clock,message:'Which invoices are due within the next week?'});
  assert.match(result.answer,/2026-10-19 through 2026-10-26/);assert.equal(result.timezone,'Asia/Kolkata');
  const overdue=await createAssistantTools({store:f.store,clock}).execute('getOverdueInvoices',{});
  assert.equal(overdue.count,1);assert.equal(overdue.asOfDate,'2026-10-19');assert.equal(overdue.timezone,'Asia/Kolkata');
  const settings=f.calls.filter(c=>c.url.pathname==='/rest/v1/workspace_settings');
  assert.ok(settings.every(c=>c.url.searchParams.get('select').includes('default_timezone')));
  for(const timezone of ['America/Los_Angeles','UTC',null,'Invalid/Zone']){
    const scoped=await productionStore({timezone});
    const answer=await answerWorkspaceQuestion({provider:noProvider,store:scoped.store,clock,message:'Invoices due within the next week?'});
    assert.match(answer.answer,timezone==='UTC'||timezone==='America/Los_Angeles'?/2026-10-18 through 2026-10-25/:/2026-10-19 through 2026-10-26/);
  }
});

test('provider-planned relative dates receive the workspace calendar, including day after tomorrow',async()=>{
  for(const [timezone,wanted] of [['Asia/Kolkata','2026-10-21'],['America/Los_Angeles','2026-10-20']]){
    const f=await productionStore({timezone,invoices:[{...base,due_date:wanted}]});let planned=false;
    const provider={generate:async request=>{
      if(request.tools){planned=true;assert.ok(request.messages[0].content.includes(`Today is ${timezone==='Asia/Kolkata'?'2026-10-19':'2026-10-18'} in ${timezone}`));
        return {toolCalls:[{function:{name:'getDueInvoices',arguments:JSON.stringify({dueDateFrom:wanted,dueDateTo:wanted})}}]};}
      return {content:'INR 118.00 outstanding',model:'fixture'};
    }};
    const result=await answerWorkspaceQuestion({provider,store:f.store,clock,message:'Which invoices are due the day after tomorrow?'});
    assert.equal(planned,true);assert.match(result.answer,new RegExp(wanted));
  }
  const owner=ownerCalendar(clock);assert.equal(owner.currentDate,'2026-10-19');assert.equal(owner.dayAfterTomorrow,'2026-10-21');assert.equal(owner.nextWeek,'2026-10-26');
  assert.equal(shiftDay(calendarDay(()=>new Date('2026-03-08T07:30:00Z'),'America/New_York'),1),'2026-03-09');
});

test('how-many intent leads with a count, keeps currencies separate, and excludes vendor bills',async()=>{
  for(const invoices of [[base,{...base,id:userId,invoice_number:'BILL-9',total_amount:'9999.00',metadata:{invoice_direction:'payable'}},{...base,id:customerId,currency:'USD'}],[]]){
    const f=await productionStore({invoices});
    const result=await answerWorkspaceQuestion({provider:noProvider,store:f.store,clock,message:'How many invoices are outstanding?'});
    assert.match(result.answer,invoices.length?/^2 outstanding invoices\. Total outstanding: INR 118\.00, USD 118\.00\./:/^0 outstanding invoices\./);
    assert.doesNotMatch(result.answer,/9999/);
  }
  const ownerAnalysis=deriveInvoiceReadAnalysis(ownerInvoiceReadAnalysis('How many invoices are outstanding?'),[base,{...base,metadata:{invoice_direction:'payable'}}]);
  assert.equal(invoiceReadAnalysisReply({ok:true,readOnly:true,operation:'read',table:'invoices',invoiceReadAnalysis:ownerAnalysis}),'1 outstanding invoice. Total outstanding: INR 118.00.');
  const f=await productionStore();const result=await answerWorkspaceQuestion({provider:noProvider,store:f.store,clock,message:'How much is outstanding?'});
  assert.match(result.answer,/^Unpaid balances total INR 118\.00/);
});

test('PDF and image directions survive the real upload-confirm save and metadata update paths',async()=>{
  const fields={direction:{value:'payable',confidence:.99},invoiceNumber:{value:'VENDOR-1',confidence:.99},customerName:{value:'Vendor',confidence:.99},invoiceDate:{value:'2026-10-01',confidence:.99},dueDate:{value:'2026-10-30',confidence:.99},subtotal:{value:100,confidence:.99},tax:{value:18,confidence:.99},total:{value:118,confidence:.99},outstandingAmount:{value:118,confidence:.99},currency:{value:'INR',confidence:.99},clientPhone:{value:null,confidence:0},clientPhoneRaw:{value:null,confidence:0},clientEmail:{value:null,confidence:0},notes:{value:null,confidence:0},lineItems:{value:[],confidence:1}};
  const wire=Object.fromEntries(Object.entries(fields).filter(([k])=>k!=='lineItems').flatMap(([k,v])=>[[k,v.value],[k+'Confidence',v.confidence]]));Object.assign(wire,{lineItems:[],lineItemsConfidence:1});
  const provider={generateStructured:async options=>({data:options.validate({...wire,...(options.schema.properties.imageContent?{imageContent:'single_invoice'}:{})}),model:'fixture'})};
  for(const [mimeType,bytes] of [['application/pdf',Buffer.from('%PDF-1.7\ninvalid')],['image/png',Buffer.from([137,80,78,71,13,10,26,10,0])]]){
    const extracted=await extractInvoice({provider,bytes,mimeType,imageExtractor:async()=>null,logger:{info(){}}});
    assert.equal(extracted.direction.value,'payable');
    const f=await productionStore({invoices:[]});let salesSyncs=0;
    const result=await saveAssistantInvoice({store:f.store,confirmed:true,idempotencyKey:'payable-confirm-fixture',accounting:{syncInvoice:async()=>{salesSyncs++;throw Error('must not sync vendor bill as a sale');}},invoice:{direction:extracted.direction.value,invoiceNumber:'VENDOR-1',clientName:'Vendor',invoiceDate:'2026-10-01',dueDate:'2026-10-30',currency:'INR',subtotal:100,tax:18,total:118,outstanding:118}});
    assert.equal(result.saved,true);assert.equal(f.saved[0].metadata.invoice_direction,'payable');assert.equal(result.invoice.metadata.invoice_direction,'payable');assert.equal(salesSyncs,0);
  }
  const f=await productionStore({invoices:[]});await f.store.createAssistantInvoice({customerId,invoice:{invoiceNumber:'LEGACY-1',currency:'INR',total:1}});assert.equal(f.saved[0].metadata.invoice_direction,'receivable');
});

test('all collection reads and reminder eligibility exclude payable metadata',async()=>{
  const payable={...base,id:userId,invoice_number:'BILL-9',metadata:{invoice_direction:'payable'}};
  const f=await productionStore({invoices:[base,payable]});const tools=createAssistantTools({store:f.store,clock});
  for(const [name,args] of [['getOverdueInvoices',{}],['getDueInvoices',{dueDateFrom:'2026-10-01',dueDateTo:'2026-10-30'}]]){
    const result=await tools.execute(name,args);assert.equal(result.count,1);assert.equal(result.invoices[0].invoiceNumber,'INV-42');
  }
  const summary=await tools.execute('getOutstandingSummary',{});assert.equal(summary.currencies.INR.invoiceCount,1);assert.equal(summary.payablesByCurrency.INR.invoiceCount,1);
  assert.equal(canApprove({invoice_direction:'payable',due_date:'2026-10-30',amount_minor:11800,paid_minor:0,followup_state:'draft'}),false);
  assert.equal(totals([{metadata:payable.metadata,amount_minor:11800,paid_minor:0,due_date:'2026-10-01'}]).outstanding,0);
  const analysis=deriveInvoiceReadAnalysis({kind:'unpaidInvoices'},[base,payable]);assert.equal(analysis.invoices.length,1);assert.equal(analysis.invoices[0].invoiceNumber,'INV-42');
});

const zeroText='INVOICE\nINVOICE # TRIAL-1\nDATE: 2026-10-01\nFROM:\nVendor Ltd\nBILL TO:\nCedar Studio\nCURRENCY: INR\nTOTAL 0.00\n';
function textPdf(text){
  const stream='BT /F1 12 Tf 50 750 Td '+text.trim().split('\n').map((line,i)=>`${i?'0 -18 Td ':''}(${line}) Tj`).join('\n')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf='%PDF-1.4\n',offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf);
}

test('a real zero-total trial PDF returns structured extraction without calling a provider',async()=>{
  const bytes=textPdf(zeroText);let providerCalls=0;
  const result=await extractInvoice({provider:{generateStructured:async()=>{providerCalls++;throw Error('INVALID_OUTPUT');}},bytes,mimeType:'application/pdf',businessName:'Cedar Studio'});
  assert.equal(providerCalls,0);assert.equal(result.model,'verified-pdf-text');assert.equal(result.total.value,0);assert.equal(result.direction.value,'payable');assert.equal(result.customerName.value,'Vendor Ltd');assert.equal(result.reviewRequired,true);assert.equal(result.subtotal.value,null);
  assert.equal(parsePdfInvoiceText(zeroText.replace('TOTAL 0.00','TOTAL 118.00\nBALANCE DUE 0.00')),null,'a zero balance cannot erase a positive invoice total');
});

test('extraction API converts unusable provider output to a safe structured review error',async()=>{
  const response={status(code){this.code=code;return this;},json(body){this.body=body;return this;},setHeader(){}};
  const handler=createAIHandler({authorize:async()=>({getSettings:async()=>({}),getBusinessName:async()=>''}),providerFactory:()=>({generateStructured:async()=>{throw Object.assign(Error('raw INVALID_OUTPUT'),{code:'INVALID_OUTPUT',status:502,name:'AIError'});}})});
  await handler({method:'POST',query:{action:'extract'},body:{workspaceId,file:{base64:Buffer.from('%PDF-1.7\ninvalid').toString('base64'),mimeType:'application/pdf',fileName:'trial.pdf'}}},response);
  assert.equal(response.code,502);assert.equal(response.body.error,'INVOICE_EXTRACTION_UNAVAILABLE');assert.match(response.body.message,/enter its details manually/);assert.doesNotMatch(JSON.stringify(response.body),/INVALID_OUTPUT/);
});

test('missing due dates read naturally in reminder templates, drafts, and invoice answers',async()=>{
  for(const missing of [null,'','Not provided','not recorded','no due date set']){
    const text=renderReminderTemplate('Invoice {{invoice_number}} due on {{due_date}}.',{invoice_number:'INV-42',due_date:missing});
    assert.match(text,/with no due date set/);assert.doesNotMatch(text,/due on (?:Not provided|no due date)/i);
    const draft=reminderBody({invoice_number:'INV-42',due_date:null},{businessName:'Cedar',dueDate:missing,reminderTemplate:'Invoice {{invoice_number}} due on {{due_date}}.'});assert.match(draft,/no due date set/);
  }
  const f=await productionStore({invoices:[{...base,due_date:null}]});
  const result=await answerWorkspaceQuestion({provider:{generate:async()=>({content:'118 outstanding'})},store:f.store,message:'Tell me about INV-42'});
  assert.match(result.answer,/no due date set/);assert.doesNotMatch(result.answer,/Not provided/);
});

test('breakdown answers preserve stored aggregate and named tax components',async()=>{
  for(const taxMetadata of [{tax_minor:1800,tax_components:[{name:'IGST',amount:18}]},{tax:18,tax_components:{IGST:'18.00'}},{igst:18}]){
    const f=await productionStore({invoices:[{...base,metadata:{invoice_direction:'receivable',subtotal:100,...taxMetadata}}]});
    const result=await answerWorkspaceQuestion({provider:noProvider,store:f.store,message:'Give me the breakdown of INV-42'});
    assert.match(result.answer,/subtotal INR 100\.00/);assert.match(result.answer,/IGST INR 18\.00/);assert.match(result.answer,/Total INR 118\.00/);
  }
});

test('rounding up to one currency unit passes extraction, OCR and confirmation; larger errors remain blocked',()=>{
  const make=adjustment=>parsePdfInvoiceText(`INVOICE # ROUND-1\nCURRENCY: INR\nQTY DESCRIPTION UNIT PRICE AMOUNT\n1 Service 100.00 100.00\nSUBTOTAL 100.00\nTAX 18.00\nTOTAL ${(118+adjustment).toFixed(2)}\n`);
  for(const adjustment of [-1,-.18,0,.18,1]){
    const parsed=make(adjustment);assert.ok(parsed);
    const result=validateInvoiceExtractionResponse(parsed);assert.equal(result.warnings.some(w=>/does not match total/.test(w)),false);assert.equal(result.uncertainFields.includes('total'),false);
    const invoice=validateAssistantInvoice({direction:'receivable',invoiceNumber:'ROUND-1',clientName:'Buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-30',subtotal:100,tax:18,total:118+adjustment,currency:'INR'});assert.equal(invoice.total,118+adjustment);
    const ocr=parseOfflineInvoiceText(`Subtotal 100.00\nIGST 18.00\nTotal ${(118+adjustment).toFixed(2)}`,{ocrConfidence:99});assert.equal(ocr.warnings.some(w=>/does not match total/.test(w)),false);
  }
  for(const adjustment of [-1.01,1.01]){
    assert.equal(make(adjustment),null);
    assert.throws(()=>validateAssistantInvoice({direction:'receivable',invoiceNumber:'ROUND-1',clientName:'Buyer',invoiceDate:'2026-10-01',dueDate:'2026-10-30',subtotal:100,tax:18,total:118+adjustment,currency:'INR'}),error=>error.code==='INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX');
  }
});

test('New Invoice extraction pre-fills payable direction while preserving a reviewed choice',()=>{
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8'),start=app.indexOf('function applyInvoiceExtraction('),end=app.indexOf('async function ingestFile(',start);
  const input={value:'',dataset:{},tagName:'SELECT',options:[{value:'payable'},{value:'receivable'}]};
  const apply=vm.runInNewContext(`${app.slice(start,end)};applyInvoiceExtraction`,{setIngestionState(){}});
  const form={dataset:{},elements:{namedItem:name=>name==='direction'?input:null}};
  apply(form,{reviewRequired:true,direction:{value:'payable'}});assert.equal(input.value,'payable');
  input.value='receivable';input.dataset.userEdited='true';apply(form,{reviewRequired:true,direction:{value:'payable'}});assert.equal(input.value,'receivable');
});

test('WhatsApp owner workspace reads include stored tax in breakdowns and omit payable collection rows',async()=>{
  const {createWorkspaceDataTool}=await import('../automation/whatsapp/workspace-data.mjs');
  const current={...base,updated_at:'2026-10-18T12:00:00Z',metadata:{...base.metadata,tax_components:{IGST:18}}};
  let data=[current],selected=[];
  const supabase={from(table){assert.equal(table,'invoices');const q={select(value){selected.push(value);return this;},eq(){return this;},is(){return this;},order(){return this;},range(){return this;},limit(){return this;},in(column,values){if(column==='id')this.ids=values;return this;},then(resolve){return Promise.resolve({data:this.ids?data.filter(row=>this.ids.includes(row.id)):data}).then(resolve);}};return q;}};
  const make=message=>createWorkspaceDataTool({supabase,scope:{workspaceId,ownerId:userId,phone:'+12025550101'},authorize:async()=>true,message});
  const result=await make('Give me the invoice breakdown').execute({operation:'read',table:'invoices',columns:['invoice_number','total_amount']});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.rows[0].tax,'18');assert.deepEqual(result.rows[0].tax_components,[{name:'IGST',amount:'18.00'}]);assert.ok(selected.some(s=>s.includes('metadata')));
  data=[current,{...current,id:userId,invoice_number:'BILL-9',metadata:{invoice_direction:'payable'}}];
  const count=await make('How many invoices are outstanding?').execute(invoiceReadAnalysisArgs(ownerInvoiceReadAnalysis('How many invoices are outstanding?')));
  assert.equal(count.ok,true,JSON.stringify(count));assert.equal(count.rows.length,1);assert.equal(count.invoiceReadAnalysis.invoices.length,1);
});

test('customer and owner WhatsApp store adapters read the scoped configured timezone',async()=>{
  const {createCustomerScopedStore,createOwnerScopedStore}=await import('../ai/whatsapp-channel.mjs');
  const calls=[];
  const supabase={from(table){assert.equal(table,'workspace_settings');return {select(fields){assert.match(fields,/default_timezone/);return this;},eq(key,value){calls.push([key,value]);return this;},async maybeSingle(){return {data:{workspace_id:workspaceId,default_timezone:'America/Los_Angeles'}};}};}};
  const customer=createCustomerScopedStore({supabase,workspaceId,customerId});assert.equal(await customer.getWorkspaceTimezone(),'America/Los_Angeles');
  let authorized=true;const owner=createOwnerScopedStore({supabase,workspaceId,ownerId:userId,phone:'+12025550101',authorize:async()=>authorized});
  assert.equal(await owner.getWorkspaceTimezone(),'America/Los_Angeles');authorized=false;await assert.rejects(owner.getWorkspaceTimezone(),/owner binding changed/);
  assert.deepEqual(calls,[['workspace_id',workspaceId],['workspace_id',workspaceId]]);
});
