import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {isExternallyManagedInvoice} from '../invoice/business-fields.mjs';
import {invoiceCorrectionFormView,correctionValues} from '../invoice/correction-form.mjs';

const invoice={id:'own-invoice',workspace_id:'own-workspace',customer_id:'own-customer',client:'John Smith',number:'QB-1',
  invoice_number:'QB-1',status:'sent',invoice_direction:'receivable',currency:'USD',total_amount:100,amount_minor:10000,paid_minor:0,
  has_payment_history:false,notes:'Original note',metadata:{invoice_direction:'receivable',subtotal:100,tax:0,line_items:[{description:'Service',amount:100}]}};
const markers=[{external_provider:'quickbooks'},{external_invoice_id:'external-id'},
  {metadata:{accounting_provider:'zoho'}},{metadata:{bookkeeping_record_id:'external-record'}},
  {accounting_provider:'tally'},{bookkeeping_record_id:'flattened-record'}];

test('external management helper reads authoritative row/nested/flattened markers and ignores custom facts',()=>{
  for(const marker of markers)assert.equal(isExternallyManagedInvoice({...invoice,...marker}),true);
  assert.equal(isExternallyManagedInvoice({...invoice,custom_fields:{accounting_provider:'quickbooks',external_invoice_id:'custom'}}),false);
  assert.equal(isExternallyManagedInvoice({external_provider:' ',external_invoice_id:null,metadata:{accounting_provider:'',bookkeeping_record_id:null}}),false);
});

test('externally managed unpaid invoices lock financial corrections while retaining benign form fields',()=>{
  for(const marker of markers){
    const managed={...invoice,...marker};
    const html=invoiceCorrectionFormView(managed,[{id:'own-customer',name:'John Smith'}],String);
    for(const name of ['invoice_number','customer_id','total_amount','currency','subtotal','tax','discount','invoice_direction'])
      assert.match(html,new RegExp(`name="${name}"[^>]*disabled`));
    assert.doesNotMatch(html,/data-add-item|data-remove-item/);
    assert.match(html,/managed by your connected accounting ledger/);
    assert.match(html,/name="notes"/);assert.doesNotMatch(html,/name="(?:notes|seller_name|buyer_name|payment_information|due_date)"[^>]*disabled/);
    const form={querySelectorAll:()=>[],querySelector:()=>null};
    assert.deepEqual(correctionValues(form,managed,new Map([['notes','Clarification']])),{notes:'Clarification'});
  }
});

test('real incoming payment action and detail drawer deny managed invoices without local payment history',async()=>{
  const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const paymentSource=app.slice(app.indexOf('function paymentForm(id){'),app.indexOf('function draftForm(id){'));
  const detailSource=app.slice(app.indexOf('function detail(id){'),app.indexOf('function invoiceDeleteStatus('));
  for(const marker of markers){
    let opened=false,detail='';const current={...invoice,...marker};
    vm.runInNewContext(paymentSource+'paymentForm("own-invoice")',{
      state:{invoices:[current]},isExternallyManagedInvoice,openDialog(){opened=true},terminalInvoice:()=>false,
    });
    assert.equal(opened,false);
    vm.runInNewContext(detailSource+'detail("own-invoice")',{
      state:{invoices:[current],demo:true},isExternallyManagedInvoice,terminalInvoice:()=>false,remaining:()=>10000,
      activeException:()=>null,followupStage:()=>['Draft',''],openDialog:(_,html)=>detail=html,escape:String,status:()=> 'Open',
      money:()=>'$100',tag:()=>'',day:()=>'',deliveryState:()=>'',invoiceBusinessDetails:()=>'',customFieldsView:()=>'',icon:()=>'',
      button:action=>`<button data-action="${action}">${action}</button>`,
    });
    assert.doesNotMatch(detail,/data-action="payment"/);assert.match(detail,/data-action="edit"/,'benign editing remains accessible');
  }
});
