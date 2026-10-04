import {invoiceBusinessFields} from '../invoice/business-fields.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('dashboard invoice contact follows the saved customer after rename, phone edit and clearing',async()=>{
  const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
  const declaration=source.slice(source.indexOf('const invoiceFromRow='),source.indexOf('\n',source.indexOf('const invoiceFromRow=')));
  const context={invoiceBusinessFields,terminalInvoice:()=>false,toMinor:value=>Math.round(Number(value)*100)};
  runInNewContext(declaration+';this.mapInvoice=invoiceFromRow;',context);
  const invoice={customer_id:'own-customer',invoice_number:'INV-OWN',total_amount:100,amount_paid:0,metadata:{client_name:'Extracted old name',client:'Old cached client',email:'old@example.test',debtor_phone:'+12025550001'}};
  const customer={id:'own-customer',name:'John Smith edited',company_name:'Original company',email:'john@example.test',phone:'+919818685252',custom_fields:{city:'Delhi'}};
  let view=context.mapInvoice(invoice,[customer]);
  assert.equal(view.client,customer.name);assert.equal(view.email,customer.email);assert.equal(view.debtor_phone,customer.phone);assert.equal(view.customer_custom_fields.city,'Delhi');
  customer.phone=null;customer.email=null;view=context.mapInvoice(invoice,[customer]);
  assert.equal(view.debtor_phone,'');assert.equal(view.email,'');
  assert.equal(invoice.metadata.client_name,'Extracted old name');assert.equal(invoice.metadata.debtor_phone,'+12025550001');
  invoice.id='own-invoice';invoice.metadata.amount_minor=999999;invoice.metadata.paid_minor=999999;invoice.metadata.customer_id='foreign-customer';
  view=context.mapInvoice(invoice,[customer],[{invoice_id:'own-invoice',amount:100,reversed_amount:100}]);
  assert.equal(view.customer_id,'own-customer');assert.equal(view.amount_minor,10000);assert.equal(view.paid_minor,0);
  assert.equal(view.has_payment_history,true,'a fully reversed payment still locks financial correction controls');
});
