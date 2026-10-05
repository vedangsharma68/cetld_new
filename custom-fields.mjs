// Render the same extension data stored by the owner assistant. Escape both
// labels and values; extension data is never executable markup.
export function customFieldsView(fields,escape,label='Custom fields') {
  if(!fields||typeof fields!=='object'||Array.isArray(fields))return '';
  const entries=Object.entries(fields).filter(([,v])=>v===null||['string','number','boolean'].includes(typeof v));
  if(!entries.length)return '';
  return `<section class="detail-note"><span class="eyebrow">${escape(label)}</span><dl class="detail-facts">${entries.map(([key,value])=>`<div><dt>${escape(key.replaceAll('_',' '))}</dt><dd>${escape(value===null?'Not set':String(value))}</dd></div>`).join('')}</dl></section>`;
}

export function businessRecordsView(records,escape,error='') {
  if(error)return `<section class="panel empty"><p>${escape(error)}</p></section>`;
  records=records?.filter(record=>!record.deleted_at);
  if(!records?.length)return '<section class="panel empty"><h3>No business records yet.</h3><p>Ask your WhatsApp assistant to add a supplier, project, inventory item or another business record.</p></section>';
  return records.map(record=>`<section class="panel"><div class="panel-head"><div><span class="eyebrow">${escape(record.record_type.replaceAll('_',' '))}</span><h2>${escape(record.name)}</h2></div></div><div class="panel-body">${customFieldsView(record.custom_fields,escape)}</div></section>`).join('');
}
