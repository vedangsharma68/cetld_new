import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWhatsAppDispatch} from '../automation/whatsapp/private-dispatch.mjs';
import {privateOccurrenceSyntax as privateLanguageSyntax,privateFieldLiteralOpen} from '../ai/private-occurrence-evidence.mjs';
const phone='+12025550991';
async function admit(term,body){const admission=await prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms:[term],identifiers:[],values:[],files:[]}})},phone});return ()=>admission({to:phone.slice(1),type:'text',text:{body}});}
const ordinary=[
 ['can','We can quietly answer now.'],['can','You can also read it.'],['must','They must carefully check it.'],
 ['review','Continue the document review.'],['request','Send a separate chat request.'],['report','Open the upload report.'],
 ['invoice','Answer the invoice questions.'],['questions','I can answer the invoice questions.'],['records','Read the document records.'],
 ['an','Send an invoice.'],['the','Send the invoice.'],['a','Send a statement.'],
 ['separately','Send it separately.'],['quietly','Read it quietly.'],['only','I can only answer now.'],
 ['records','I got it from verified records.'],['verified','I got it from verified records.'],
 ['check','Use the menu to check a balance.'],['read','Use the menu to read a statement.'],
 ['status','Check a balance or status.'],['correct','Use the review to correct or confirm it.'],
];
// These former bare-compound positives are explicitly undetermined, not
// certified as ordinary: invoice can be a recipient; questions can be a bare
// private object head; records can follow a recipient of read. The matched
// source copy and independent determiner-led forms above are the safe cases.
const ambiguousBare=[['invoice','Answer invoice questions.'],['questions','I can answer invoice questions.'],['records','Read document records.']];
const citations=[...ambiguousBare,
 ['can','I billed Can yesterday.'],['can','I billed can yesterday.'],['an','I billed An yesterday.'],['an','I billed an yesterday.'],
 ['the','Customer: the invoice'],['an','Customer: an invoice'],['can','Customer name is can'],
 ['separately','I billed separately yesterday.'],['separately','Send it to separately.'],['only','The customer is only'],
 ['records','Send it to Records.'],['records','Send it to records.'],['verified','Send it to Verified.'],
 ['invoice','I asked invoice questions.'],['bill','I asked bill questions.'],['review','I billed Review yesterday.'],
 ['check','I sent it to check yesterday.'],['check','Send it to Check.'],
 ['glorb','Answer glorb questions.'],['review','Continue the glorb review.'],['questions','Answer glorb questions.'],
];
test('R18 positive occurrence grammar, not a word certificate',async t=>{for(const [word,body] of ordinary)for(const kind of ['party:','identifier:'])await t.test(kind+word+' ordinary',async()=>assert.doesNotThrow(await admit(kind+word,body),body));});
test('R18 recipient, proper, field, incomplete and unknown controls remain private',async t=>{for(const [word,body] of citations)for(const kind of ['party:','identifier:'])await t.test(kind+word+' citation',async()=>assert.throws(await admit(kind+word,body),{code:'PRIVATE_PAYLOAD_BLOCKED'},body));});
test('R18 pinned-model evidence remains distinct from guessed POS',()=>{assert.equal(privateLanguageSyntax('glorb')[0].lexical,false);assert.equal(privateLanguageSyntax('invoice')[0].lexical,true);assert.equal(privateLanguageSyntax('invoice')[0].known,false);});

// An explicit field owns the whole nominal value, including articles and
// modifiers. This failure predates R4 but is mandatory for this repair.
test('R19 field declarations cannot be erased by a determiner-led value',async t=>{
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:'])for(const body of ['The customer is the review','The customer is a review','Customer name is the review','Customer: the review','The client was the review','Customer: the recent upload review'])await t.test(kind+body,async()=>assert.throws(await admit(kind+'review',body),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
});
test('R19 independent source-copy grammar paraphrases survive dense all-token indexes',async t=>{
 for(const body of ['You can only review the invoice details after the upload.','Please use the invoice menu to check a balance or status.','You can only correct the invoice details using the upload review.','Please send an unrelated chat request separately.','Use the review to correct or confirm the invoice details.'])for(const forms of [['party:'],['identifier:'],['party:','identifier:']])await t.test(forms.join('+')+body,async()=>{
  const words=[...new Set(body.toLowerCase().match(/[a-z]+/g))],terms=words.flatMap(w=>forms.map(kind=>kind+w));
  const admission=await prepareWhatsAppDispatch({supabase:{rpc:async()=>({data:{terms,identifiers:[],values:[],files:[]}})},phone});
  assert.doesNotThrow(()=>admission({to:phone.slice(1),type:'text',text:{body}}));
 });
});

test('R20 field scope covers joined and modified values but not a completed clause',async t=>{
 const fields=['Customer: the invoice, review','Customer: the invoice, the review','Customer: the invoice, and the review','Customer: the invoice and not the review','Customer: the invoice for the review','Customer name is the invoice or a review','Invoice number: the invoice, the upload review'];
 const ordinary=['Customer: a label. You can review the invoice.','Customer: a label; you can review the invoice.','Customer: a label\nYou can review the invoice.','Customer: a label! Please review the invoice.','Customer: a label. Review the invoice.','Send the invoice and review it.'];
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
  for(const body of fields)await t.test(kind+'field '+body,async()=>assert.throws(await admit(kind+'review',body),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
  for(const body of ordinary)await t.test(kind+'ordinary '+body,async()=>assert.doesNotThrow(await admit(kind+'review',body)));
 }
});

test('R21 declaration continuations require positive independent-clause evidence',async t=>{
 const continuations=[];
 for(const head of ['Customer:','Customer name is','The customer is','The client was','Invoice number is'])for(const separator of ['\n','\r\n','\n\n'])continuations.push(head+separator+'the review');
 continuations.push('Customer: the\nReview the invoice','Customer: a verified\nReview the invoice','Customer: your\nReview the invoice','Customer: the invoice\nand the review','Customer: the invoice and\nthe review','Customer: the invoice;\nthe review','Customer: the invoice Co.\nthe review','Customer: the invoice e.g. the review','Customer:\nReview the invoice','Customer: the review.\nYou can read the invoice.','Customer: "a label\nYou can review the invoice"','Customer: a label (\nYou can review the invoice)','Customer: a label.\nHe review the invoice.','Customer: a label.\nGlorb can review the invoice.','Customer: a label.\nYou can send it to review.','Customer: a label.\nYou can read the invoice and "review".');
 const independent=[];
 for(const separator of ['\n','\r\n','. ',';\n','! '])for(const clause of ['You can review the invoice.','You can quietly review the invoice.','Review the invoice.','Please review the invoice.'])independent.push('Customer: a label'+separator+clause);
 independent.push('Customer: "a label"\nYou can review the invoice.','Customer: a label (verified)\nYou can review the invoice.','Customer: a label\nWe quietly review the invoice.','Customer: a label\nYou can review it.');
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
  for(const body of continuations)await t.test(kind+'private '+body,async()=>assert.throws(await admit(kind+'review',body),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
  for(const body of independent)await t.test(kind+'ordinary '+body,async()=>assert.doesNotThrow(await admit(kind+'review',body)));
  await t.test(kind+'quoted article stays literal after a completed action clause',async()=>assert.throws(await admit(kind+'the','Customer: a label. You can read an invoice and "the" invoice.'),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 }
});

test('R22 Unicode quotation scope follows the entire delimiter class',async t=>{
 const pairs=[[0x22,0x22],[0x27,0x27],[0x60,0x60],[0xab,0xbb],[0xbb,0xab],[0x2018,0x2019],[0x2019,0x2018],[0x201a,0x2018],[0x201a,0x2019],[0x201b,0x2019],[0x201c,0x201d],[0x201d,0x201c],[0x201e,0x201c],[0x201e,0x201d],[0x201f,0x201d],[0x2039,0x203a],[0x203a,0x2039],[0x2e42,0x201c],[0x300c,0x300d],[0x300e,0x300f],[0x301d,0x301e],[0x301d,0x301f],[0xfe41,0xfe42],[0xfe43,0xfe44],[0xff02,0xff02],[0xff07,0xff07],[0xff62,0xff63],[0x300d,0x300c],[0x300f,0x300e],[0x301e,0x301d],[0x301f,0x301d],[0xfe42,0xfe41],[0xfe44,0xfe43],[0xff63,0xff62],[0xff02,0x22],[0x22,0xff02]].map(pair=>pair.map(cp=>String.fromCodePoint(cp)));
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
  for(const [open,close]of pairs){
   await t.test(kind+'open '+open+close,async()=>assert.throws(await admit(kind+'review','Customer: '+open+'a label\nYou can review the invoice'+close),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
   await t.test(kind+'closed '+open+close,async()=>assert.doesNotThrow(await admit(kind+'review','Customer: '+open+'Glorby'+close+'\nYou can review the invoice.')));
  }
  for(const body of ['Customer: '+String.fromCodePoint(0x201c)+"a 'label'\nYou can review the invoice"+String.fromCodePoint(0x201d),'Customer: '+String.fromCodePoint(0xab)+'a label"\nYou can review the invoice'+String.fromCodePoint(0xbb)])await t.test(kind+'nested/mismatched remains data',async()=>assert.throws(await admit(kind+'review',body),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
  for(const mark of ["'",String.fromCodePoint(0x2019)])await t.test(kind+'ordinary apostrophe in completed value',async()=>assert.doesNotThrow(await admit(kind+'review','Customer: the label'+mark+'s invoice\nYou can review the invoice.')));
 }
});

test('R22 inherited literals retain scope through embedded declarations',async t=>{
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:'])for(const [a,b]of [[0x22,0x22],[0x201c,0x201d],[0xab,0xbb],[0x300c,0x300d]]){
  const open=String.fromCodePoint(a),close=String.fromCodePoint(b);
  const body='Customer: '+open+'a label\nCustomer: a label\nYou can review the invoice'+close;
  await t.test(kind+'outer literal '+open+close,async()=>assert.throws(await admit(kind+'review',body),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
 }
});

test('R22 every Unicode quotation mark starts a private literal witness',()=>{
 let count=0;
 for(let cp=0;cp<=0x10ffff;cp++){
  const mark=String.fromCodePoint(cp);if(!/\p{Quotation_Mark}/u.test(mark))continue;count++;
  assert.equal(privateFieldLiteralOpen(mark+'a label\nYou can review the invoice'),true,'U+'+cp.toString(16));
 }
 assert.ok(count>0);
});
test('R22 repeated declarations stay local without weakening private or ordinary controls',async t=>{
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:'])for(const n of [20,80,150]){
  await t.test(kind+'private declarations '+n,async st=>{
   const run=await admit(kind+'review','Customer: review\n'.repeat(n));const start=performance.now();
   assert.throws(run,{code:'PRIVATE_PAYLOAD_BLOCKED'});st.diagnostic(JSON.stringify({declarations:n,elapsedMs:Math.round(performance.now()-start)}));
  });
  await t.test(kind+'ordinary after declarations '+n,async()=>assert.doesNotThrow(await admit(kind+'review','Customer: a label\n'.repeat(n)+'You can review the invoice.')));
 }
});
test('R22 escaped quotation closers do not erase the open-value witness',async t=>{
 const slash=String.fromCharCode(92),open=String.fromCodePoint(0x201c),close=String.fromCodePoint(0x201d);
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:']){
  await t.test(kind+'escaped closer remains open',async()=>assert.throws(await admit(kind+'review','Customer: '+open+'a label'+slash+close+'\nYou can review the invoice'+close),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
  await t.test(kind+'even escape count closes value',async()=>assert.doesNotThrow(await admit(kind+'review','Customer: '+open+'a label'+slash+slash+close+'\nYou can review the invoice.')));
 }
});

test('R22 word-internal quotation marks cannot end an enclosing quoted field',async t=>{
 for(const kind of ['party:','identifier:','party-ref:','party-inferred:'])for(const [a,b]of [[0x22,0x22],[0x27,0x27],[0x2018,0x2019],[0x2019,0x2018],[0xab,0xbb],[0x300c,0x300d]]){
  const open=String.fromCodePoint(a),close=String.fromCodePoint(b),name='O'+close+'Neill Glorby';
  await t.test(kind+'apostrophe/open '+open+close,async()=>assert.throws(await admit(kind+'review','Customer: '+open+name+'\nYou can review the invoice'+close),{code:'PRIVATE_PAYLOAD_BLOCKED'}));
  await t.test(kind+'apostrophe/closed '+open+close,async()=>assert.doesNotThrow(await admit(kind+'review','Customer: '+open+name+close+'\nYou can review the invoice.')));
 }
});
