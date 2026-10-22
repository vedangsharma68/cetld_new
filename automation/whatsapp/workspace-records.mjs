// Shared by reads, proposals and direct writes. Scope comes only from the
// verified webhook, never from model arguments.
export const normalName = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function nameParts(actual) {
  return String(actual??'').normalize('NFKC').replace(/(\p{Ll})(\p{Lu})/gu,'$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
}
function matchesName(actual,value) {
  const needle=normalName(String(value).replace(/[%_]/g,''));
  if(!needle)return false;
  const words=nameParts(actual);
  // Match whole name tokens, including their concatenation, so JohnSmith finds
  // John Smith but John does not silently target Mary Johnson.
  return words.some((_,start)=>words.slice(start).some((__,end)=>words.slice(start,start+end+1).join('')===needle));
}

// Adjacent transpositions (Jhon/John) count as one edit. Only whole name
// tokens are compared; a short substring must not suggest an unrelated name.
function nameDistance(a,b) {
  a=Array.from(a);b=Array.from(b);
  const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)d[i][0]=i;
  for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
    if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
  }
  return d[a.length][b.length];
}
function typoDistance(actual,value) {
  const needle=normalName(String(value).replace(/[%_]/g,'')),length=Array.from(needle).length;
  if(length<3||length>100)return Infinity;
  const words=nameParts(actual),max=length<8?1:2;
  let best=Infinity;
  for(let start=0;start<words.length;start++)for(let end=start+1;end<=words.length;end++){
    const candidate=words.slice(start,end).join('');
    if(Math.abs(Array.from(candidate).length-length)>max)continue;
    const distance=nameDistance(needle,candidate);
    if(distance<=max)best=Math.min(best,distance);
  }
  return best;
}
export function nameConfirmationResult(suggestions) {
  const names=[...new Set(suggestions.map(item=>item.name))].slice(0,3);
  return {ok:false,code:'NAME_CONFIRMATION_REQUIRED',requiresNameConfirmation:true,
    suggestions:names.map(name=>({name})),
    message:`Did you mean ${names.join(' or ')}? Reply with the full name to confirm.`};
}

export async function resolveWorkspaceRecord({supabase,scope,table,filters,select,operation,assertAuthorized=async()=>{},assertLive=()=>{}}) {
  const allowed=table==='invoices'?['id','invoice_number','customer_name']:table==='business_records'?['id','name','record_type']:['id','name','company_name','email','phone'];
  if(!filters.length||filters.some(f=>!allowed.includes(f.column)||!['eq','ilike'].includes(f.operator)
    ||f.operator==='ilike'&&!['name','company_name','customer_name'].includes(f.column)))return {ok:false,code:'INVALID'};
  const invoiceNumber=table==='invoices'&&filters.some(f=>f.column==='invoice_number');
  // Printed/source numbers remain server-side selectors. Resolve every exact
  // spelling, including canonical collisions, before authorizing a write.
  const numberColumns=invoiceNumber?['invoice_number','metadata->>printed_invoice_number','metadata->>source_invoice_number']:['invoice_number'];
  const queryRows=async fuzzy=>{
    const candidates=new Map();
    for(const numberColumn of numberColumns){
      for(const row of await queryNumberRows(fuzzy,numberColumn))candidates.set(row.id,row);
    }
    return [...candidates.values()];
  };
  const queryNumberRows=async(fuzzy,numberColumn)=>{
    await assertAuthorized();assertLive();
    const customer=table==='invoices'&&filters.some(f=>f.column==='customer_name');
    const fields=[...new Set(['id',...select.split(','),...(table==='customers'?['metadata']:[]),...filters.filter(f=>f.column!=='customer_name').map(f=>f.column)])].join(',');
    let q=supabase.from(table).select(fields+(customer?',customer:customers!invoices_workspace_id_customer_id_fkey!inner(name)':''))
      .eq('workspace_id',scope.workspaceId);
    if(table==='invoices'&&operation!=='restore')q=q.is('deleted_at',null);
    if(table==='business_records')q=operation==='restore'?q.gt('deleted_at','1970-01-01T00:00:00Z'):q.is('deleted_at',null);
    for(const f of filters){
      const column=f.column==='customer_name'?'customer.name':f.column==='invoice_number'?numberColumn:f.column;
      if(fuzzy&&['name','company_name','customer_name'].includes(f.column)) {
        // Bounded workspace scan supports JohnSmith as well as John Smith.
        // A truncated candidate set must never authorize a write.
        continue;
      }
      q=q[f.operator](column,f.value);
    }
    const result=await q.limit(fuzzy?501:2);
    await assertAuthorized();assertLive();
    if(result.error)throw result.error;
    return result.data||[];
  };
  let rows=await queryRows(false);
  if(filters.some(f=>f.operator==='ilike'))rows=rows.filter(row=>filters.every(f=>{
    if(f.operator!=='ilike')return true;
    const actual=f.column==='customer_name'?(row.customer?.name||row.customer?.[0]?.name):row[f.column];
    return matchesName(actual,f.value);
  }));
  if(!rows.length&&filters.some(f=>['name','company_name','customer_name'].includes(f.column))){
    rows=await queryRows(true);
    if(rows.length>500)return {ok:false,code:'AMBIGUOUS'};
    const candidates=rows;
    rows=rows.filter(row=>filters.every(f=>{
      if(!['name','company_name','customer_name'].includes(f.column))return true;
      const actual=f.column==='customer_name'?(row.customer?.name||row.customer?.[0]?.name):row[f.column];
      return matchesName(actual,f.value);
    }));
    if(!rows.length&&['customers','invoices'].includes(table)){
      const ranked=candidates.filter(row=>row.metadata?.whatsapp_owner!==true).map(row=>{
        let distance=0,name=null;
        for(const f of filters.filter(f=>['name','company_name','customer_name'].includes(f.column))){
          const actual=f.column==='customer_name'?(row.customer?.name||row.customer?.[0]?.name):row[f.column];
          if(!matchesName(actual,f.value))distance+=typoDistance(actual,f.value);
          name=actual;
        }
        return {name,distance};
      }).filter(item=>Number.isFinite(item.distance)&&typeof item.name==='string'&&item.name.trim()
        &&item.name.length<=255&&!/[\x00-\x1f\x7f]/.test(item.name))
        .sort((a,b)=>a.distance-b.distance||a.name.localeCompare(b.name));
      if(ranked.length)return nameConfirmationResult(ranked);
    }
  }
  if(invoiceNumber&&rows.length>1)return {ok:false,code:'AMBIGUOUS'};
  if(operation==='read'&&rows.length)return {ok:true,rows,row:rows.length===1?rows[0]:null};
  return rows.length===1?{ok:true,row:rows[0]}:{ok:false,code:rows.length?'AMBIGUOUS':'NOT_FOUND'};
}

const protectedKey=/^(?:id|.*_id|name|company_name|email|phone|invoice_number|issue_date|due_date|status|amount_paid|reversed_amount|net_amount|reversed_at|payment_history|cash_refund|total_amount|subtotal|tax|currency|notes|invoice_direction|business_name|default_currency|default_timezone|follow_up_preferences|owner_bot_preferences|primary_model|fallback_model|followup_state|next_follow_up_at|metadata|custom_fields|created_at|updated_at|deleted_at|deleted_by|role|permissions|whatsapp_owner|workspace|tenant|owner|user)$/i;
const secretKey=/(?:token|secret|password|api.?key|credential|authorization|cookie|storage.?path|code.?hash|private.?key)/i;
export function validateCustomFields(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>50||Buffer.byteLength(JSON.stringify(value),'utf8')>8192)
    throw new TypeError('Invalid custom fields');
  for(const [key,item] of Object.entries(value))if(!/^[a-z][a-z0-9_]{0,63}$/.test(key)||protectedKey.test(key)||secretKey.test(key)
    ||!(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)
      ||typeof item==='string'&&item.length<=1000&&!/[\x00-\x1f\x7f]/.test(item)))throw new TypeError('Invalid custom field');
  return {...value};
}

export function ownerCalendar(clock=()=>new Date(),timezone='Asia/Kolkata') {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(clock());
  const get=type=>parts.find(p=>p.type===type).value;
  const currentDate=`${get('year')}-${get('month')}-${get('day')}`;
  const shift=n=>new Date(Date.parse(currentDate+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  return {timezone,currentDate,tomorrow:shift(1),dayAfterTomorrow:shift(2),yesterday:shift(-1),nextWeek:shift(7)};
}
