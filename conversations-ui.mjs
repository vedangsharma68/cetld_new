const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const labels={received:'Received',pending:'Preparing to send',accepted:'Accepted by Meta',sent:'Sent by WhatsApp',
  delivered:'Delivered',read:'Read',failed:'Failed',blocked:'Blocked',unknown:'Delivery uncertain'};

function timestampMicros(value){
  const milliseconds=Date.parse(value);
  const fraction=String(value).match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]||'';
  return BigInt(Number.isFinite(milliseconds)?milliseconds:0)*1000n+BigInt(fraction.padEnd(6,'0').slice(3,6));
}
function compareMessages(a,b){
  const leftTime=timestampMicros(a.created_at),rightTime=timestampMicros(b.created_at);
  if(leftTime!==rightTime)return leftTime<rightTime?-1:1;
  if(/^\d+$/.test(String(a.id))&&/^\d+$/.test(String(b.id))){
    const left=BigInt(a.id),right=BigInt(b.id);return left<right?-1:left>right?1:0;
  }
  return String(a.id).localeCompare(String(b.id));
}
export function mergeWhatsAppMessages(existing=[],incoming=[]){
  const rows=new Map(existing.map(row=>[String(row.id),row]));
  for(const row of incoming)rows.set(String(row.id),row);
  return [...rows.values()].sort((a,b)=>compareMessages(b,a));
}

export function whatsappInbox({messages=[],customers=[],selectedThread=null,error='',hasMore=false}={}) {
  const groups=new Map();
  for(const message of messages) {
    const key=`${message.audience||'customer'}:${message.phone}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(message);
  }
  const keys=[...groups.keys()];
  const selected=groups.has(selectedThread)?selectedThread:keys[0];
  const name=message=>message.audience==='owner'?'You · Business owner':
    customers.find(customer=>customer.id===message.customer_id)?.name||message.phone;
  const thread=groups.get(selected)||[];
  const content=thread.slice().sort(compareMessages);
  return `<section class="panel whatsapp-inbox"><div class="panel-head"><div><h2>WhatsApp messages</h2><p>Received messages, bot replies, and delivery status for this workspace.</p></div></div>
    ${error?`<p class="error" role="alert">Message history could not sync: ${escape(error)}</p>`:''}
    ${keys.length?`<div class="conversation-shell"><aside class="conversation-list" aria-label="WhatsApp conversations">
      ${keys.map(key=>{const latest=groups.get(key)[0];return `<button class="conversation-row ${key===selected?'active':''}" data-action="select-whatsapp-thread" data-thread="${escape(key)}"><span><strong>${escape(name(latest))}</strong><small>${escape(latest.phone)}</small></span></button>`;}).join('')}
      </aside><section class="conversation-thread" aria-label="WhatsApp message history"><header><h3>${escape(name(thread[0]))}</h3></header><div class="thread-body" aria-live="polite">
      ${content.map(message=>`<div class="message-bubble ${message.direction==='outbound'?'message-outbound':''}"><p>${escape(message.body).replaceAll('\n','<br>')}</p><small>${message.direction==='inbound'?'WhatsApp sender':'cetld'} · ${escape(labels[message.status]||message.status)} · ${escape(new Date(message.created_at).toLocaleString('en-IN'))}</small></div>`).join('')}
      </div></section></div>`:`<div class="panel-body"><p>${error?'Retry with Refresh to load your messages.':'No WhatsApp messages have been recorded for this workspace yet.'}</p></div>`}
    ${hasMore?'<div class="panel-body"><button class="btn ghost" data-action="older-whatsapp-messages">Load older messages</button></div>':''}
    <div class="panel-body"><small>“Accepted by Meta” means submitted. Delivery is confirmed when WhatsApp reports “Delivered” or “Read”.</small></div>
  </section>`;
}

export function followUpSummary(events,timezone='Asia/Kolkata',now=new Date()) {
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const today=date.format(now),counts={};
  const names={followup_sent:'Reminders submitted',customer_reply:'Customer replies',needs_attention:'Needs review',
    followup_paused:'Paused follow-ups',daily_summary:'Daily summaries'};
  for(const event of events||[])if(date.format(new Date(event.created_at))===today&&names[event.type])
    counts[names[event.type]]=(counts[names[event.type]]||0)+1;
  return `<section class="panel"><div class="panel-head"><div><h2>Today’s follow-up summary</h2><p>${escape(today)} · ${escape(timezone)}</p></div></div><div class="panel-body">
    ${Object.keys(counts).length?Object.entries(counts).map(([label,count])=>`<p>${escape(label)}: <strong>${count}</strong></p>`).join(''):'<p>No follow-up activity recorded today.</p>'}
  </div></section>`;
}
