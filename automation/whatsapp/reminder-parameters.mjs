// Database facts only. Keep these deterministic formats in sync with the SQL gate.
export const DEFAULT_REMINDER_TEMPLATE='Hi {{customer_name}}, this is {{business_name}}. Invoice {{invoice_number}} has an outstanding balance of {{balance}}, due on {{due_date}}. Please arrange payment, or reply here if you have any questions.';

export function buildDefaultInvoiceReminderDraft(input){
  const [customer_name,business_name,invoice_number,balance,due_date]=buildInvoiceReminderParameters(input);
  const values={customer_name,business_name,invoice_number,balance,due_date};
  return DEFAULT_REMINDER_TEMPLATE.replace(/\{\{([^{}]+)\}\}/g,(_,name)=>values[name]);
}

const forbidden=/[{}\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
export function formatReminderAmount(invoice){
  const currency=invoice.currency??'INR';
  if(typeof currency!=='string'||! /^[A-Z]{3}$/.test(currency))throw Error('Invalid invoice currency');
  const minor=value=>{
    const text=String(value);
    if(!/^\d{1,16}(?:\.\d{1,2})?$/.test(text))throw Error('Invalid invoice amount');
    const [whole,fraction='']=text.split('.');
    return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  };
  const amount=minor(invoice.total_amount)-minor(invoice.amount_paid??0);
  if(amount<=0n)throw Error('Invalid outstanding amount');
  const whole=String(amount/100n),fraction=String(amount%100n).padStart(2,'0');
  const grouped=currency==='INR'
    ?whole.length<=3?whole:whole.slice(0,-3).replace(/\B(?=(\d{2})+(?!\d))/g,',')+','+whole.slice(-3)
    :whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  return currency==='INR'?'₹'+grouped+(fraction==='00'?'':'.'+fraction):currency+' '+grouped+'.'+fraction;
}

export function formatReminderDueDate(value,timeZone='Asia/Kolkata'){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))throw Error('Invalid invoice due date');
  const dateOnly=value.length===10,date=new Date(dateOnly?value+'T00:00:00Z':value);
  if(!Number.isFinite(date.getTime())||dateOnly&&date.toISOString().slice(0,10)!==value)throw Error('Invalid invoice due date');
  new Intl.DateTimeFormat('en-GB',{timeZone}).format(date);
  // SQL DATE values already represent a local calendar day; never shift them.
  // Intl's en-GB September is "Sept"; PostgreSQL's Mon format is "Sep".
  return new Intl.DateTimeFormat('en-GB',{timeZone:dateOnly?'UTC':timeZone,day:'2-digit',month:'short',year:'numeric'}).format(date).replace(/\bSept\b/,'Sep');
}

export function buildInvoiceReminderParameters({invoice,settings,customer}){
  const name=customer.name??'';
  if(typeof name!=='string'||forbidden.test(name))throw Error('Invalid customer name');
  const parameters=[name.trim()||'there',settings.business_name,invoice.invoice_number,
    formatReminderAmount(invoice),formatReminderDueDate(invoice.due_date,settings.default_timezone||'Asia/Kolkata')];
  if(parameters.some(v=>typeof v!=='string'||!v.trim()||v.length>256||forbidden.test(v)))throw Error('Invalid approved template facts');
  return parameters;
}
