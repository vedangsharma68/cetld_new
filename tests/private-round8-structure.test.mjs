import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/private-invoice.mjs';
import {createPrivateValueMatcher,privateNumberKeys,privateFieldKeys,privateOriginKeys,privateOriginStart,privatePartyKeys,ordinaryPart} from '../ai/private-value-matcher.mjs';

test('numeric run representation grows linearly and retains grouped interpretations in both directions',()=>{
 for(const separator of [',',' '])for(const count of [33,100,500,900]){
  const source=Array.from({length:count},(_,i)=>String(101+i)).join(separator),keys=privateNumberKeys(source);
  assert.ok(keys.length<=3,'A whole parse plus one compact graph, without per-position windows');
  const match=createPrivateValueMatcher(keys);
  for(const index of [0,Math.floor(count/2),count-1])assert.equal(match('send '+(101+index)+' today'),true);
  assert.equal(match('send 987654321 today'),false);
 }
 const capture=createPrivateValueMatcher(privateNumberKeys('12,34,567,77',true));
 for(const value of ['12','34','567','77','1234567','1234567.77'])assert.equal(capture('send '+value+' today'),true,value);
 assert.equal(capture('send 123456777 today'),false);
 const retained=createPrivateValueMatcher(['number:1234567']);
 assert.equal(retained('The figures = (12,34,567,77)'),true);
 assert.equal(retained('The figures = (12,34,568,77)'),false);
});

test('list structure is independent of label vocabulary and decoration; decimal and singular-verb uses stay ordinary',()=>{
 const match=createPrivateValueMatcher(['number:1250']);
 for(const label of ['prices','options','measurements','candidates'])for(const decoration of [' = ',' — ',' are respectively ',' are (',' are [']){
  assert.equal(match('The '+label+decoration+'1250,77'),true,label+decoration);
  assert.equal(match('The '+label+decoration+'1251,77'),false,label+decoration);
 }
 for(const input of ['It costs 1250,77','The price comes to 1250,77','Put 1250,77 on a shopping list'])assert.equal(match(input),false,input);
});

test('grammatical homographs use nominal roles and script-aware exact names',()=>{
 const match=createPrivateValueMatcher(['Van Harper','An Harper','The Cedar Studio','李王'].flatMap(privatePartyKeys));
 for(const input of ["An's advice helped",'I met An yesterday','Van arrived yesterday','I met Van last week','请联系李王','能给李王发个消息吗？'])assert.equal(match.ordinary(input),true,input);
 for(const input of ['Explain the prices','The prices are high','The birds','An actress','An iris','An email arrived','An email is useful','The call from the office','An updated report','The invited guests arrived','Ask an expert for advice','Travel by van','We hired a new delivery van','Van Gogh painted sunflowers','请联系王李','今天谈谈天气'])assert.equal(match.ordinary(input),false,input);
 for(const name of ['Will','May','Can','Do']){
  const named=createPrivateValueMatcher(privatePartyKeys(name+' Harper'));
  assert.equal(named.ordinary('Ask '+name+' for advice'),true);
  assert.equal(named.ordinary(name+' called me'),true);
  assert.equal(named.ordinary(name+' you explain photosynthesis?'),false);
 }

});

test('typed source projections are order independent and public operational symbols do not become private identifiers',async()=>{
 const f=await fixture();try{
  for(const question of ['Explain invoice number formats','What is an invoice number format?','Tell me about invoice numbers']){
   assert.equal(privateOriginStart(question),null);
   assert.equal((await f.db.query('select app.private_invoice_has_origin($1) value',[question])).rows[0].value,false);
  }
  for(const source of ['I billed Mark Harper 45678','I billed Harbor Rowan 45678','I sent Harbor Rowan an invoice for 45678','Invoice: 45678 for Harbor Rowan','Invoice #CD-987\nDate: 12 March 2028\nHarbor Rowan\nAmount 45678']){
   const js=[...new Set(privateOriginKeys(source))].sort(),sql=(await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k);
   assert.deepEqual(sql,js);assert.ok(js.includes('number:45678'));assert.ok(js.includes(source.includes('Mark')?'party:mark':'party:harbor'));assert.ok(js.includes(source.includes('Mark')?'party:harper':'party:rowan'));
   if(source.includes('12 March'))assert.ok(js.includes('date:2028-03-12'));
  }
  for(const prefix of ['Tell me a joke; ','Tell me a joke. ','Tell me a joke.\n']){
   const source=prefix+'I billed Harbor Rowan 45678',keys=privateOriginKeys(source),match=createPrivateValueMatcher(keys);
   assert.deepEqual((await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k),[...new Set(keys)].sort());
   assert.equal(ordinaryPart(source,match,match.spans).text,'Tell me a joke');
  }

  for(const prefix of ['', 'Notes: ', 'Forwarded message: '])for(const separator of [', ','; ','\n']){
   const source=prefix+'Invoice to Mark Harper for one thousand two hundred and fifty'+separator+'due 31 Oct 2026',keys=privateOriginKeys(source);
   assert.ok(keys.includes('number:1250'));assert.ok(keys.includes('party:mark'));assert.ok(keys.includes('date:2026-10-31'));
   assert.deepEqual((await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k),[...new Set(keys)].sort());
  }
  for(const amount of ['Rs.1,250','USD1,250','$1,250','1,250 USD','one thousand two hundred and fifty dollars']){
   const source='Invoice of '+amount+' to Harbor Rowan, due 31 Oct 2026',keys=privateOriginKeys(source);
   assert.ok(keys.includes('number:1250'),amount);assert.ok(keys.includes('party:harbor'),amount);assert.ok(keys.includes('party:rowan'),amount);
   assert.deepEqual((await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k),[...new Set(keys)].sort());
  }
  for(const source of ['I issued the invoice: the watermark is false','I billed Harbor Rowan']){
   const keys=privateOriginKeys(source);
   assert.deepEqual((await f.db.query('select distinct k from app.private_invoice_origin_aliases($1) k order by k',[source])).rows.map(x=>x.k),[...new Set(keys)].sort());
  }
  const symbols=(await f.db.query('select unnest(enum_range(null::public.invoice_status))::text value')).rows.map(x=>x.value);
  for(const value of symbols){
   await f.db.query('delete from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId]);
   await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{invoice:{status:value,followup_state:'draft',metadata:{followup_state:'draft'},total:43913}}]);
   let terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(x=>x.term);
   assert.ok(!terms.includes(value));assert.ok(!terms.includes('identifier:'+value));assert.ok(terms.includes('number:43913'));
   await f.db.query('select app.retain_private_invoice_terms($1,$2)',[f.scope.workspaceId,{invoice:{invoice_number:value,notes:value,custom_fields:{status:value}}}]);
   terms=(await f.db.query('select term from whatsapp_private_invoice_terms where workspace_id=$1',[f.scope.workspaceId])).rows.map(x=>x.term);
   assert.ok(terms.includes(value),'A free-text fact has a different role from the enum');
   assert.equal(createPrivateValueMatcher(terms)(value),true);
  }
  for(const role of ['anon','authenticated','service_role'])assert.equal((await f.db.query("select has_function_privilege($1,'app.private_invoice_record_facts(jsonb)','execute') value",[role])).rows[0].value,false);
  for(const value of ['draft','approved','active','scheduled','paused','cancelled']){
   const projected=(await f.db.query('select app.private_invoice_record_facts($1) value',[{invoice:{followup_state:value,metadata:{followup_state:value},notes:value}}])).rows[0].value;
   assert.equal(projected.invoice.followup_state,undefined);assert.equal(projected.invoice.metadata.followup_state,undefined);assert.equal(projected.invoice.notes,value);
  }
  const unknown=(await f.db.query('select app.private_invoice_record_facts($1) value',[{invoice:{status:'PrivateStateToken',metadata:{followup_state:'PrivateStateToken'},custom_fields:{status:'draft'}}}])).rows[0].value;
  assert.equal(unknown.invoice.status,'PrivateStateToken');assert.equal(unknown.invoice.metadata.followup_state,'PrivateStateToken');assert.equal(unknown.invoice.custom_fields.status,'draft');

 }finally{await f.close();}
});
