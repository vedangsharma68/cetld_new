import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {correctionValues,invoiceCorrectionFormView} from '../invoice/correction-form.mjs';
import {createInvoiceCorrectionClient} from '../invoice/correction-client.mjs';

const original={id:'legacy-invoice',customer_id:'customer-a',updated_at:'2026-10-04T18:00:00Z',currency:'USD',total_amount:'1234567890123.45',
  notes:'  Original note  ',issue_date:'2026-10-01',due_date:'2026-10-31',metadata:{subtotal:'1234567890123.45',seller_name:'  Original seller  ',
    line_items:[{description:'  Unclear printed service  ',quantity:0,unitPrice:null,amount:null,confidence:null}]}};
function row(item){return {dataset:item.confidence==null?{}:{confidence:String(item.confidence)},querySelector:selector=>({value:item[selector.match(/"(\w+)"/)[1]]??''})};}
function fixture(invoice=original){
  const entries=new Map([['total_amount',invoice.total_amount],['subtotal',invoice.metadata.subtotal],['notes',invoice.notes],['issue_date',invoice.issue_date],['due_date',invoice.due_date],['seller_name',invoice.metadata.seller_name]]);
  let items=invoice.metadata.line_items.map(item=>structuredClone(item));
  const form={dataset:{},querySelector:()=>({}),querySelectorAll:()=>items.map(row)};
  return {form,entries,setItems:next=>items=next};
}

test('unchanged oversized amounts and incomplete legacy extraction do not enter benign correction payloads or change source',()=>{
  const f=fixture(),snapshot=structuredClone(original);
  assert.deepEqual(correctionValues(f.form,original,f.entries),{});
  f.entries.set('notes','Corrected note');f.entries.set('due_date','2026-11-02');
  assert.deepEqual(correctionValues(f.form,original,f.entries),{notes:'Corrected note',due_date:'2026-11-02'});
  assert.deepEqual(original,snapshot);
  assert.match(invoiceCorrectionFormView(original,[],String),/value="1234567890123\.45"/,'existing amount remains exact in the rendered input');
});

test('changed money/items still validate strict limits and clearing all items emits only the empty replacement',()=>{
  const f=fixture();
  f.entries.set('total_amount','1234567890124.45');
  assert.throws(()=>correctionValues(f.form,original,f.entries),/twelve whole/);
  f.entries.set('total_amount',original.total_amount);
  f.setItems([{description:'Changed description',quantity:null,unitPrice:null,amount:null}]);
  assert.throws(()=>correctionValues(f.form,original,f.entries),/two decimal/);
  f.setItems([{description:'Changed service',quantity:1.00001,unitPrice:1,amount:1}]);
  assert.throws(()=>correctionValues(f.form,original,f.entries),/four decimal/);
  f.setItems([]);
  assert.deepEqual(correctionValues(f.form,original,f.entries),{line_items:[]});
  f.entries.set('notes','');f.entries.set('seller_name','');
  assert.deepEqual(correctionValues(f.form,original,f.entries),{notes:null,seller_name:null,line_items:[]});
});

test('equivalent safe decimal formatting stays absent from financial payload',()=>{
  const invoice={...original,total_amount:'100.00',metadata:{subtotal:'100.00',line_items:[]}};
  const f=fixture(invoice);f.entries.set('total_amount','100');f.entries.set('subtotal','100.0');f.entries.set('notes','Updated');
  assert.deepEqual(correctionValues(f.form,invoice,f.entries),{notes:'Updated'});
});

test('actual dashboard submit callback saves legacy notes through the real form reader without a financial patch',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('function invoiceCorrectionForm(invoice){'),source.indexOf('async function saveInvoice(e,x){'));
  const f=fixture();f.entries.set('notes','Owner clarified note');
  const handlers={},button={disabled:false},calls=[],messages=[];
  const form={...f.form,addEventListener:(name,handler)=>handlers[name]=handler,querySelector:selector=>selector==='[type=submit]'?button:{}};
  class Values {constructor(){return f.entries;}}
  const context=vm.createContext({invoice:original,state:{workspace:{id:'workspace-a'},customers:[]},invoiceCorrectionFormView:()=>'',
    correctionValues:(form,invoice)=>correctionValues(form,invoice,new Values()),createInvoiceCorrectionClient,
    db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true,completed:true,record:{...original,notes:args.p_values.notes}}};}},
    escape:String,crypto:{randomUUID:()=> 'isolated-request-id'},openDialog(){},toast:message=>messages.push(message),
    loadData:async()=>true,showError:(_,error)=>assert.fail(error.message),$:selector=>selector==='#dialog'?{close(){}}:form});
  vm.runInContext(body+'invoiceCorrectionForm(invoice)',context);
  await handlers.submit({preventDefault(){}});
  assert.deepEqual(calls[0].args.p_values,{notes:'Owner clarified note'});
  assert.equal(messages[0],'Invoice corrections saved.');assert.equal(button.disabled,false);
});
