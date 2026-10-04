import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceBusinessFields,invoiceBusinessDetails} from '../invoice/business-fields.mjs';
import {correctionValues,invoiceCorrectionFormView,readCorrectionLineItems} from '../invoice/correction-form.mjs';
import {createInvoiceCorrectionClient} from '../invoice/correction-client.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const invoice={id:'invoice-a',workspace_id:'workspace-a',customer_id:'customer-a',currency:'USD',total_amount:'110.00',amount_minor:11000,paid_minor:0,updated_at:'2026-10-04T18:00:00Z',issue_date:'2026-10-01',due_date:'2026-10-15',notes:'Original',metadata:{subtotal:'100.00',tax_minor:1000,line_items:[{description:'Service',quantity:null,unitPrice:null,amount:100,confidence:.9}],printed_invoice_number:'PRINT-1',secret_token:'private'}};
const escape=value=>String(value??'').replace(/[<>&"]/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[char]));

test('business display reads legacy tax minor units and prefers canonical corrected values without changing ledger facts',()=>{
  const before=structuredClone(invoice);
  assert.equal(invoiceBusinessFields(invoice).tax,'10.00');
  const corrected={...invoice,metadata:{...invoice.metadata,tax:'12.00',discount:'2.00',invoice_direction:'payable',seller_name:'Seller <script>',buyer_name:'Buyer',payment_information:'Transfer'}};
  const fields=invoiceBusinessFields(corrected);
  assert.equal(fields.tax,'12.00');assert.equal(fields.discount,'2.00');
  const rendered=invoiceBusinessDetails(corrected,escape,(minor,currency)=>`${currency} ${minor/100}`);
  assert.match(rendered,/USD 12/);assert.match(rendered,/Seller &lt;script&gt;/);assert.match(rendered,/PRINT-1/);
  assert.doesNotMatch(rendered,/secret_token|private/);assert.deepEqual(invoice,before);
});

test('correction form uses explicit customer binding and locks financial fields after any payment history',()=>{
  const html=invoiceCorrectionFormView({...invoice,has_payment_history:true},[{id:'customer-a',name:'John Smith'},{id:'customer-b',name:'Other customer'}],escape);
  assert.match(html,/name="customer_id" required disabled/);
  assert.match(html,/name="total_amount"[^>]*disabled/);
  assert.match(html,/name="notes"/);assert.doesNotMatch(html,/data-add-item|name="email"|name="debtor_phone"/);
  assert.match(html,/audit history/);assert.match(html,/Original document number: PRINT-1/);
});

function row(item){return {dataset:item.confidence==null?{}:{confidence:String(item.confidence)},querySelector:selector=>({value:item[selector.match(/"(\w+)"/)[1]]??''})};}
test('form sends only actual typed changes and preserves nullable quantity legacy itemization',()=>{
  const form={querySelectorAll:()=>invoice.metadata.line_items.map(row),querySelector:()=>({})};
  const unchanged=new Map([['customer_id','customer-a'],['total_amount','110'],['subtotal','100'],['tax','10'],['discount',''],['issue_date','2026-10-01'],['due_date','2026-10-15'],['notes','Original']]);
  assert.deepEqual(correctionValues(form,invoice,unchanged),{});
  unchanged.set('notes','Corrected');unchanged.set('due_date','');
  assert.deepEqual(correctionValues(form,invoice,unchanged),{due_date:null,notes:'Corrected'});
  assert.deepEqual(readCorrectionLineItems([row({description:'Service',quantity:'',unitPrice:'',amount:'100'})]),[{description:'Service',quantity:null,unitPrice:null,amount:100}]);
  assert.throws(()=>readCorrectionLineItems([row({description:'Service',amount:'1.001'})]),/two decimal/);
});

test('authenticated correction client sends exact scope/CAS/idempotency payload and requires persisted success',async()=>{
  const calls=[];
  const db={async rpc(name,args){calls.push({name,args});return {data:{ok:true,completed:true,record:{...invoice,notes:'Corrected'}}};}};
  const input={workspaceId:invoice.workspace_id,invoiceId:invoice.id,expectedUpdatedAt:invoice.updated_at,requestId:'request-id',values:{notes:'Corrected'}};
  const result=await createInvoiceCorrectionClient(db)(input);
  assert.equal(result.record.notes,'Corrected');assert.equal(calls[0].name,'owner_correct_invoice');
  assert.deepEqual(calls[0].args,{p_workspace_id:'workspace-a',p_invoice_id:'invoice-a',p_expected_updated_at:invoice.updated_at,p_request_id:'request-id',p_values:{notes:'Corrected'}});
  await assert.rejects(createInvoiceCorrectionClient({rpc:async()=>({data:{ok:true}})})(input),/not confirmed/);
  await assert.rejects(createInvoiceCorrectionClient({rpc:async()=>({data:{ok:true,record:{id:'other-invoice'}}})})(input),/not confirmed/);
});

test('real dashboard submit keeps request identity after interruption and reports saved only from confirmed receipt',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const body=app.slice(app.indexOf('function invoiceCorrectionForm(invoice){'),app.indexOf('async function saveInvoice(e,x){'));
  const listeners={},submit={disabled:false},form={dataset:{},addEventListener:(name,handler)=>listeners[name]=handler,querySelector:()=>submit};
  const calls=[],messages=[],errors=[];let fail=true,uuid=0,closed=0,currentValues={notes:'Corrected'};
  const db={async rpc(name,args){calls.push({name,args});if(fail)throw new Error('Interrupted response');return {data:{ok:true,completed:true,record:{...invoice,notes:'Corrected'}}};}};
  const context=vm.createContext({state:{workspace:{id:'workspace-a'},customers:[]},db,createInvoiceCorrectionClient,
    invoiceCorrectionFormView:()=>'',correctionValues:()=>currentValues,correctionLineItemRow:()=>'',escape,
    crypto:{randomUUID:()=>`request-${++uuid}`},openDialog(){},showError:(_,error)=>errors.push(error.message),
    toast:message=>messages.push(message),loadData:async()=>true,$:selector=>selector==='#dialog'?{close:()=>closed++}:form});
  vm.runInContext(body+'invoiceCorrectionForm(invoice)',vm.createContext({...context,invoice}));
  await listeners.submit({preventDefault(){}});
  assert.deepEqual(messages,[]);assert.deepEqual(errors,['Interrupted response']);assert.equal(closed,0);assert.equal(submit.disabled,false);
  fail=false;await listeners.submit({preventDefault(){}});
  assert.equal(calls[0].args.p_request_id,calls[1].args.p_request_id);assert.equal(calls[1].args.p_expected_updated_at,invoice.updated_at);
  assert.deepEqual(messages,['Invoice corrections saved.']);assert.equal(closed,1);
  currentValues={notes:'Different correction'};await listeners.submit({preventDefault(){}});
  assert.notEqual(calls[2].args.p_request_id,calls[1].args.p_request_id);
});

test('payable and unknown-direction invoices cannot open incoming-payment or collection controls',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const body=app.slice(app.indexOf('function paymentForm(id){'),app.indexOf('function draftForm(id){'));
  for(const direction of ['payable',null]){
    let opened=false;
    const context=vm.createContext({state:{invoices:[{...invoice,invoice_direction:direction}]},openDialog(){opened=true},terminalInvoice:()=>false});
    vm.runInContext(body+'paymentForm("invoice-a")',context);
    assert.equal(opened,false);
  }
  assert.match(app,/const canAct=x\.invoice_direction==='receivable'/);
  assert.match(app,/state\.invoices\.filter\(x=>x\.invoice_direction==='receivable'&&/);
});
