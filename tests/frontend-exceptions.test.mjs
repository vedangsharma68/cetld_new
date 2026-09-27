import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const app=await readFile(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end,sandbox,name)=>{
  const first=app.indexOf(start),last=app.indexOf(end,first);
  assert.ok(first>=0&&last>first,`Could not find ${name}`);
  return vm.runInNewContext(`${app.slice(first,last)}; ${name}`,sandbox);
};
const activeException=extract('function activeException(x){','function followupStage(x)',{},'activeException');
const terminalInvoice=x=>['paid','void','cancelled'].includes(String(x?.status||'').toLowerCase());
const remaining=x=>Math.max(0,x.amount_minor-x.paid_minor);

test('paid claim pauses only follow-up and keeps the ledger amount untouched',async()=>{
  const invoice={id:'invoice-1',status:'sent',amount_minor:10000,paid_minor:0,followup_state:'approved',metadata:{reminder_text:'Saved copy',bookkeeping_sync_status:'synced'}};
  const state={demo:true,invoices:[invoice]};
  const updateInvoice=extract('async function updateInvoice(x,patch){','function exportInvoices()',{
    state,terminalInvoice,remaining,activeException,Object,Date,Number,Error,
  },'updateInvoice');
  const report={type:'paid_claim',note:'Customer says bank transfer was made; awaiting reference.',recorded_at:'2026-09-27T10:00:00.000Z'};
  await updateInvoice(invoice,{followup_exception:report,followup_state:'paused',next_follow_up_at:null});
  assert.equal(invoice.paid_minor,0);
  assert.equal(invoice.status,'sent');
  assert.equal(invoice.followup_state,'paused');
  assert.equal(invoice.metadata.next_follow_up_at,null);
  assert.equal(invoice.metadata.bookkeeping_sync_status,'synced');
  assert.equal(invoice.metadata.followup_exception.type,'paid_claim');
  await assert.rejects(updateInvoice(invoice,{followup_state:'approved'}),/Resolve the invoice exception/);
  invoice.paid_minor=invoice.amount_minor;
  await assert.rejects(updateInvoice(invoice,{followup_state:'draft'}),/Paid, void, or cancelled/);
});

test('dispute can return to draft review; STOP cannot be silently changed or approved',async()=>{
  const invoice={id:'invoice-2',status:'sent',amount_minor:10000,paid_minor:0,followup_state:'draft',metadata:{}};
  const updateInvoice=extract('async function updateInvoice(x,patch){','function exportInvoices()',{
    state:{demo:true,invoices:[invoice]},terminalInvoice,remaining,activeException,Object,Date,Number,Error,
  },'updateInvoice');
  const recorded_at='2026-09-27T10:00:00.000Z';
  await updateInvoice(invoice,{followup_exception:{type:'dispute',note:'Amount disputed',recorded_at},followup_state:'paused',next_follow_up_at:null});
  assert.equal(invoice.followup_state,'paused');
  await updateInvoice(invoice,{followup_exception:{...invoice.followup_exception,resolved_at:'2026-09-27T11:00:00.000Z',resolution_note:'Corrected invoice accepted'},followup_state:'draft'});
  assert.equal(activeException(invoice),null);
  assert.equal(invoice.followup_state,'draft');
  await updateInvoice(invoice,{followup_exception:{type:'stop',note:'Customer requested no contact',recorded_at},followup_state:'paused',next_follow_up_at:null});
  await assert.rejects(updateInvoice(invoice,{followup_state:'approved'}),/Resolve the invoice exception/);
  await assert.rejects(updateInvoice(invoice,{followup_exception:{type:'dispute',note:'Changed',recorded_at},followup_state:'draft'}),/STOP report requires separate consent review/);
  assert.equal(invoice.followup_exception.type,'stop');
});

test('live metadata write preserves existing fields and stores the invoice exception',async()=>{
  const invoice={id:'invoice-3',status:'sent',amount_minor:10000,paid_minor:0,updated_at:'version-1',followup_state:'approved',reminder_text:'Original reminder',metadata:{bookkeeping_sync_status:'synced',private_reference:'keep'}};
  let written;
  const db={from(table){assert.equal(table,'invoices');return {update(payload){written=payload.metadata;return {eq(){return this},select(){return this},async single(){return {data:{...invoice,metadata:written},error:null}}}}}}};
  const state={demo:false,workspace:{id:'workspace-1'},customers:[],invoices:[invoice]};
  const updateInvoice=extract('async function updateInvoice(x,patch){','function exportInvoices()',{
    state,db,terminalInvoice,remaining,activeException,invoiceFromRow:row=>({...row,...row.metadata}),Object,Date,Number,Error,
  },'updateInvoice');
  await updateInvoice(invoice,{followup_exception:{type:'dispute',note:'Owner received a dispute call',recorded_at:'2026-09-27T10:00:00.000Z'},followup_state:'paused',next_follow_up_at:null});
  assert.equal(written.private_reference,'keep');
  assert.equal(written.reminder_text,'Original reminder');
  assert.equal(written.followup_state,'paused');
  assert.equal(written.followup_exception.type,'dispute');
  assert.equal(state.invoices[0].followup_exception.type,'dispute');
});

test('invoice detail date uses the stored issue date even with stale metadata',()=>{
  const fromRow=extract('const invoiceFromRow=(row,customers)=>','const paymentFromRow=',{
    terminalInvoice,toMinor:value=>Math.round(Number(value)*100),
  },'invoiceFromRow');
  const invoice=fromRow({
    id:'invoice-4',customer_id:'customer-1',invoice_number:'INV-4',issue_date:'2026-09-15',
    total_amount:'100.00',amount_paid:'0.00',status:'sent',
    metadata:{invoice_date:null,followup_state:'draft'},
  },[{id:'customer-1',name:'Client'}]);
  assert.equal(invoice.invoice_date,'2026-09-15');
});
