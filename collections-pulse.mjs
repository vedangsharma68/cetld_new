import {remaining,localDate} from './core.mjs';

const amount=value=>Number.isSafeInteger(value)&&value>0?value:0;
const currencyOf=(value,fallback)=>String(value||fallback||'INR').toUpperCase();
const dateInZone=(value,timeZone)=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
  const part=type=>parts.find(item=>item.type===type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const addDays=(date,days)=>{
  const value=new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate()+days);
  return value.toISOString().slice(0,10);
};

/** Calculate workspace collections without combining unlike currencies. */
export function collectionsPulse(invoices=[],payments=[],{today=localDate(),defaultCurrency='INR',timeZone='UTC'}={}){
  const through=addDays(today,7);
  const month=today.slice(0,7);
  const byCurrency=new Map();
  const bucket=code=>{
    const currency=currencyOf(code,defaultCurrency);
    if(!byCurrency.has(currency))byCurrency.set(currency,{currency,outstanding:0,overdue:0,dueNext7Days:0,collectedThisMonth:0});
    return byCurrency.get(currency);
  };
  const invoiceById=new Map(invoices.map(invoice=>[invoice.id,invoice]));
  for(const invoice of invoices){
    const balance=remaining(invoice);
    if(!balance||['cancelled','canceled','void'].includes(String(invoice.status||'').toLowerCase()))continue;
    const row=bucket(invoice.currency);
    row.outstanding+=balance;
    if(invoice.due_date<today)row.overdue+=balance;
    else if(invoice.due_date<=through)row.dueNext7Days+=balance;
  }
  for(const payment of payments){
    const paidAt=payment.paid_at||payment.created_at;
    if(!paidAt||dateInZone(new Date(paidAt),timeZone).slice(0,7)!==month)continue;
    const invoice=invoiceById.get(payment.invoice_id);
    const paymentCurrency=payment.currency||invoice?.currency;
    if(!paymentCurrency)continue;
    const row=bucket(paymentCurrency);
    row.collectedThisMonth+=amount(payment.amount_minor);
  }
  if(!byCurrency.size)bucket(defaultCurrency);
  return [...byCurrency.values()].sort((a,b)=>a.currency.localeCompare(b.currency));
}
