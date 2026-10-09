import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {invoiceReviewUnpaidResolution} from '../automation/whatsapp/invoice-review-payment-resolution.mjs';
import {originalRetainedUnpaidInstruction as instruction,retainedUnpaidWordingCases,retainedUnpaidWordingNegatives} from './fixtures/retained-unpaid-wording.mjs';

const migrationName='20261009040005_invoice_review_general_inferred_currency_correction.sql';
const earlierMigration='20261009031935_invoice_review_nonzero_inferred_currency_correction.sql',earlierHash='b0efe01d27fc8a04489e9c62e182245b';
const predecessorHash='2ad9a819d7d03135ced3cc977986c75d',forwardHash='fd9dbe74cc189b9f64d39c59406bec79';
// Reported production event253/review31 facts. Only source IDs are synthetic.
const original={type:'invoice_review_draft',stage:'incomplete',missingFields:['direction'],validationIssues:['PAYMENT_STATUS_CONFLICT'],
 currencySource:'photo',currencyEvidence:'Melbourne, VIC 3000',sourceMessageId:'image-provider-source',
 invoice:{tax:8.5,total:93.5,dueDate:'2016-01-31',currency:'AUD',subtotal:85,direction:'uncertain',clientName:'Test Business',
  alreadyPaid:false,clientEmail:'test@test.com',clientPhone:null,invoiceDate:'2016-01-25',outstanding:93.5,invoiceNumber:'INV-3337'},
 paymentEvidence:{status:'paid',text:'Paid',confidence:.99}};
const audit=action=>Object.fromEntries(['invoice','paymentEvidence','sourceMessageId','currencySource','currencyEvidence']
 .filter(key=>Object.hasOwn(action,key)).map(key=>[key,action[key]]));
const candidate=(id,text=instruction,action=original,currency='USD')=>({...action,stage:'proposal',missingFields:[],validationIssues:[],currencySource:'user',
 invoice:{...action.invoice,currency,direction:'receivable'},ownerProvidedFacts:{...action.ownerProvidedFacts,
  currency:{value:currency,sourceMessageId:id},direction:{value:'receivable',sourceMessageId:id}},
 paymentStatusResolution:{status:'unpaid',outstanding:action.invoice.total,currency,sourceMessageId:id,ownerInstruction:text,extractedFacts:audit(action)}});
const resolve=(text=instruction,action=original,messageId='owner-correction')=>invoiceReviewUnpaidResolution({action,message:text,messageId});
const negativeEvidence=['printed currency code AUD','AUD','USD','Invoice currency: AUD','Melbourne, VIC 3000; printed AUD',
 'Australian details; USD printed','inferred AUD based on Australian address; currency AUD printed',null,{},'unknown address','printed AUD based on Australian address'];
const negatives=[...retainedUnpaidWordingNegatives,
 instruction+' We received USD 10.',instruction+' We got a payment yesterday.',instruction+' Change the total to USD 100.',
 instruction+' Send the customer a message.',instruction+' Set reminders on.',instruction.replace('currency is USD','currency is AUD'),
 instruction.replace('93.50','92.50'),instruction.replace('no payment has been received','payment has been received'),
 instruction.replace('incorrect','correct'),instruction.replace('My business issued','Maybe my business issued'),`"${instruction}"`,instruction+'?'];
const inferenceCases=['Melbourne, VIC 3000','  MELBOURNE,\tVIC 3000\r\n','Melbourne Victoria 3000','Australian details','INFERRED AUD BASED ON AUSTRALIAN ADDRESS'];
const canonicalInference=[
 ['INR','Indian details','Indian'],['USD','US address or phone details','United States'],['GBP','UK details','UK'],
 ['AED','UAE details','UAE'],['SGD','Singapore details','Singaporean'],['AUD','Australian details','Australian'],
 ['CAD','Canadian details','Canadian'],['CHF','Swiss details','Swiss'],['EUR','European details','European'],
];
const correctedCurrency=currency=>currency==='USD'?'EUR':'USD';
const retained=(currency,currencyEvidence)=>({...original,invoice:{...original.invoice,currency},currencyEvidence});
const ownerInstruction=currency=>instruction.replaceAll('USD',correctedCurrency(currency));
const genericInferenceCases=canonicalInference.flatMap(([currency,source,region])=>[
 {currency,currencyEvidence:source}, {currency,currencyEvidence:' \t'+source.toUpperCase()+'\r\n'},
 {currency,currencyEvidence:`inferred ${currency} based on ${region} address`},
 ...['address','country','phone','tax'].map(kind=>({currency,currencyEvidence:`inferred ${currency} based on ${kind} evidence`})),
]);
const generalNegativeEvidence=canonicalInference.flatMap(([currency,source,region])=>{
 const other=currency==='GBP'?'INR':'GBP',otherRegion=currency==='GBP'?'Indian':'British';
 return [source+'; printed '+currency,source+' '+other,source+'; uncertain',`printed currency code ${currency}`,currency,`${currency} symbol`,
  `ambiguous $ symbol; assumed ${currency}`,`currency not shown; assumed workspace default ${currency}`,
  `inferred ${other} based on address`, `inferred ${currency} based on ${otherRegion} address`,
  `inferred ${currency} based on unknown address`, `inferred ${currency} based on ${region} address and ${other} phone`,
  `inferred ${currency} based on ${region} address; printed ${currency}`,`inferred ${currency} based on address; unknown label`,
  `inferred ${currency} based on arbitrary evidence`,`perhaps inferred ${currency} based on address`,
  `inferred ${currency} based on address?`,`"inferred ${currency} based on address"`,
  'unknown geographic label', 'photo', '$ symbol',null,{},
  ...canonicalInference.filter(([code])=>code!==currency).map(([,label])=>label),
 ].map(currencyEvidence=>({currency,currencyEvidence}));
});

async function fixture({includeEarlierCandidate=false}={}){
 const f=await createOfflineSqlNetwork({excludeMigrations:[migrationName,...includeEarlierCandidate?[]:[earlierMigration]]}),{db}=f;
 const ownerId=randomUUID(),phone='+15555550154';
 await db.query('insert into auth.users(id) values($1)',[ownerId]);
 await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
 const workspaceId=(await db.query("select (public.create_workspace('Event254 correction fixture',$1)).id",[randomUUID()])).rows[0].id;
 const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
 await db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
 assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
 const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
 await db.query("insert into whatsapp_pending_actions(id,workspace_id,customer_id,phone,action,source,version,generation,created_at,expires_at) values(31,$1,$2,$3,$4,'whatsapp',2,1,now()-interval '1 minute',now()+interval '15 minutes')",[workspaceId,customerId,phone,original]);
 const persist=async(id,text=instruction,{transcriptCustomer=customerId}={})=>{
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'isolated',$2,'text',$3,'processing')",[id,phone,text]);
  await db.query("insert into whatsapp_messages(workspace_id,customer_id,phone,direction,audience,body,kind,status,provider_message_id,idempotency_key) values($1,$2,$3,'inbound','owner',$4,'text','received',$5,$5)",[workspaceId,transcriptCustomer,phone,text,id]);
 };
 const transition=(next,{id=31,version=2,workspace=workspaceId,customer=customerId,targetPhone=phone,stage='incomplete'}={})=>
  db.query('select * from public.whatsapp_transition_invoice_review($1,$2,$3,$4,$5,$6,$7)',[id,version,workspace,customer,targetPhone,stage,next]);
 const review=async()=>(await db.query('select id,version,generation,action,created_at,expires_at,consumed_at from whatsapp_pending_actions where id=31')).rows[0];
 const setAction=action=>db.query('update whatsapp_pending_actions set action=$1 where id=31',[action]);
 const routine=async()=>(await db.query("select oid,prosrc,md5(replace(prosrc,chr(13),'')) normalized_md5,proowner,proacl,prosecdef,proconfig,pg_get_functiondef(oid) definition from pg_proc where oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure")).rows[0];
 return {...f,phone,workspaceId,customerId,persist,transition,review,setAction,routine};
}

const migration=()=>readFile(new URL('../supabase/migrations/'+migrationName,import.meta.url),'utf8');
const unchangedFields=invoice=>Object.fromEntries(Object.entries(invoice).filter(([key])=>!['currency','direction'].includes(key)));
const security=({proowner,proacl,prosecdef,proconfig})=>({proowner,proacl,prosecdef,proconfig});

test('all supported retained currencies need consistent bounded inference provenance before factual correction',()=>{
 assert.deepEqual(resolve(),{status:'unpaid',outstanding:93.5,currency:'USD',sourceMessageId:'owner-correction',ownerInstruction:instruction,extractedFacts:audit(original)});
 for(const wording of retainedUnpaidWordingCases){
  const action=wording.total===93.5?original:{...original,invoice:{...original.invoice,total:wording.total,outstanding:wording.total,subtotal:wording.total,tax:0}};
  assert.deepEqual(resolve(wording.message,action),{status:'unpaid',outstanding:wording.total,currency:wording.currency,sourceMessageId:'owner-correction',ownerInstruction:wording.message,extractedFacts:audit(action)},wording.name);
 }
 for(const currencyEvidence of inferenceCases)assert.ok(resolve(instruction,{...original,currencyEvidence}),currencyEvidence);
 for(const {currency,currencyEvidence} of genericInferenceCases){
  const action=retained(currency,currencyEvidence),message=ownerInstruction(currency),result=resolve(message,action);
  assert.equal(result?.currency,correctedCurrency(currency),`${currency}: ${currencyEvidence}`);assert.deepEqual(result.extractedFacts,audit(action));
 }
 for(const {currency,currencyEvidence} of generalNegativeEvidence)assert.equal(resolve(ownerInstruction(currency),retained(currency,currencyEvidence)),null,`${currency}: ${String(currencyEvidence)}`);
 for(const currency of ['JPY','KWD','BHD','XYZ','toString','constructor'])assert.equal(resolve(instruction,retained(currency,`inferred ${currency} based on address`)),null,currency);
 for(const currencyEvidence of negativeEvidence)assert.equal(resolve(instruction,{...original,currencyEvidence}),null,String(currencyEvidence));
 for(const text of negatives)assert.equal(resolve(text),null,text);
 for(const action of [{...original,currencySource:'user'}, {...original,ownerProvidedFacts:{currency:{value:'AUD',sourceMessageId:'older'}}},
  {...original,missingFields:['direction','currency']}, {...original,invoice:{...original.invoice,direction:'payable'}},
  {...original,invoice:{...original.invoice,total:100}}, {...original,invoice:{...original.invoice,tax:9}},
  {...original,invoice:{...original.invoice,outstanding:0}}, {...original,invoice:{...original.invoice,alreadyPaid:true}},
  {...original,validationIssues:['PAYMENT_STATUS_CONFLICT','UNCERTAIN_TOTAL']}, {...original,sourceMessageId:null},
  {...original,paymentStatusResolution:{status:'unpaid'}}, {...original,paymentEvidence:{status:'paid',text:'nothing'}}])assert.equal(resolve(instruction,action),null);
 assert.equal(resolve(instruction,original,original.sourceMessageId),null);
});

for(const lineEndings of ['LF','CRLF'])test(`real SQL ${lineEndings} predecessor rejection, exact correction, protected facts, scope and CAS`,async()=>{
 const f=await fixture(),{db,persist,transition,review,routine,setAction}=f;
 try{
  const baseline=await review(),predecessor=await routine();assert.equal(predecessor.normalized_md5,predecessorHash);
  if(lineEndings==='CRLF')await db.exec(predecessor.definition.replaceAll('\n','\r\n'));
  await persist('valid-owner',instruction,{transcriptCustomer:null});const valid=candidate('valid-owner');
  await assert.rejects(transition(valid),/invoice review unpaid resolution lacks explicit evidence/,'PR108 cannot record the actual nonzero conflict currency correction');
  assert.deepEqual(await review(),baseline);
  const otherRoutines=async()=>(await db.query("select oid,prosrc,proowner,proacl,prosecdef,proconfig from pg_proc where pronamespace in ('public'::regnamespace,'app'::regnamespace) and oid<>'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure order by oid")).rows;
  const otherBefore=await otherRoutines(),sql=await migration();await db.exec(lineEndings==='CRLF'?sql.replaceAll('\n','\r\n'):sql);
  const installed=await routine();assert.equal(installed.normalized_md5,forwardHash);assert.deepEqual(security(installed),security(predecessor));
  assert.deepEqual(await otherRoutines(),otherBefore);assert.deepEqual(await review(),baseline,'migration itself mutates no retained review');
  await db.exec(sql);assert.deepEqual(await routine(),installed,'exact forward migration is idempotent');
  for(const role of ['anon','authenticated']){
   await db.exec('set role '+role);await assert.rejects(transition(valid),/permission denied for function whatsapp_transition_invoice_review/);await db.exec('reset role');
  }
  for(const [index,wording] of retainedUnpaidWordingCases.entries()){
   const action=wording.total===93.5?original:{...original,invoice:{...original.invoice,total:wording.total,outstanding:wording.total,subtotal:wording.total,tax:0}};
   const id='wording-'+index;await persist(id,wording.message);
   await db.exec('begin');try{await setAction(action);const accepted=(await transition(candidate(id,wording.message,action,wording.currency))).rows[0];
    assert.equal(accepted.id,31);assert.equal(accepted.version,3);assert.equal(accepted.action.stage,'proposal');assert.equal(accepted.action.invoice.currency,wording.currency);
    assert.deepEqual(unchangedFields(accepted.action.invoice),unchangedFields(action.invoice));assert.deepEqual(accepted.action.paymentStatusResolution.extractedFacts,audit(action));
   }finally{await db.exec('rollback');}
  }
  for(const [index,currencyEvidence] of inferenceCases.entries()){
   const action={...original,currencyEvidence};const id='inference-'+index;await persist(id);
   await db.exec('begin');try{await setAction(action);assert.equal((await transition(candidate(id,instruction,action))).rows[0].action.stage,'proposal');}finally{await db.exec('rollback');}
  }
  for(const [index,{currency,currencyEvidence}] of genericInferenceCases.entries()){
   const action=retained(currency,currencyEvidence),text=ownerInstruction(currency),id='general-'+index;await persist(id,text);
   await db.exec('begin');try{await setAction(action);const accepted=(await transition(candidate(id,text,action,correctedCurrency(currency)))).rows[0];
    assert.equal(accepted.action.invoice.currency,correctedCurrency(currency));assert.deepEqual(accepted.action.paymentStatusResolution.extractedFacts,audit(action));
    assert.deepEqual(unchangedFields(accepted.action.invoice),unchangedFields(action.invoice));
   }finally{await db.exec('rollback');}
  }
  for(const [index,{currency,currencyEvidence}] of generalNegativeEvidence.entries()){
   const action=retained(currency,currencyEvidence),text=ownerInstruction(currency),id='general-negative-'+index;await persist(id,text);
   await setAction(action);await assert.rejects(transition(candidate(id,text,action,correctedCurrency(currency))),/invoice review/);
  }
  await setAction(original);
  for(const currencySource of [null,undefined]){
   const action={...original,currencySource};if(currencySource===undefined)delete action.currencySource;
   await db.exec('begin');try{await setAction(action);assert.equal((await transition(candidate('valid-owner',instruction,action))).rows[0].action.stage,'proposal');}finally{await db.exec('rollback');}
  }
  for(const [index,text] of negatives.entries()){const id='negative-'+index;await persist(id,text);await assert.rejects(transition(candidate(id,text)),/invoice review/);}
  for(const currencyEvidence of negativeEvidence){const action={...original,currencyEvidence};await setAction(action);await assert.rejects(transition(candidate('valid-owner',instruction,action)),/invoice review/);}
  for(const action of [{...original,currencySource:'user'}, {...original,ownerProvidedFacts:{currency:{value:'AUD',sourceMessageId:'older'}}},
   {...original,missingFields:['direction','currency']}, {...original,invoice:{...original.invoice,direction:'payable'}},
   {...original,invoice:{...original.invoice,tax:9}}, {...original,invoice:{...original.invoice,outstanding:0}},
   {...original,validationIssues:['PAYMENT_STATUS_CONFLICT','UNCERTAIN_TOTAL']}, {...original,sourceMessageId:null}]){
   await setAction(action);await assert.rejects(transition(candidate('valid-owner',instruction,action)),/invoice review/);
  }
  await setAction(original);
  const tampered=[...['total','subtotal','tax','invoiceNumber','clientName','clientEmail','invoiceDate','dueDate','alreadyPaid','outstanding'].map(key=>({...valid,invoice:{...valid.invoice,[key]:key==='alreadyPaid'?true:typeof valid.invoice[key]==='number'?100:'changed'}})),
   {...valid,paymentEvidence:{...valid.paymentEvidence,text:'tampered'}}, {...valid,sourceMessageId:'tampered'}, {...valid,currencyEvidence:'printed USD'},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{currency:'AUD',outstanding:93.5}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{...audit(original),invoice:{...original.invoice,total:100}}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{...audit(original),paymentEvidence:{status:'unpaid'}}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{...audit(original),sourceMessageId:'tampered'}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{...audit(original),currencySource:'user'}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extractedFacts:{...audit(original),currencyEvidence:'printed AUD'}}},
   {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,outstanding:0}}, {...valid,paymentStatusResolution:{...valid.paymentStatusResolution,extra:true}},
   {...valid,ownerProvidedFacts:{...valid.ownerProvidedFacts,currency:{value:'USD',sourceMessageId:'other'}}},
   {...valid,currencySource:'photo'}, {...valid,stage:'incomplete'}, {...valid,validationIssues:['PAYMENT_STATUS_CONFLICT']}];
  for(const next of tampered)await assert.rejects(transition(next),/invoice review|owner-provided currency/);
  for(const scope of [{id:99},{version:3},{workspace:randomUUID()},{customer:randomUUID()},{targetPhone:'+15555559999'}])assert.equal((await transition(valid,scope)).rows.length,0);
  // A current provider wake-up and exact scoped owner transcript are both required.
  for(const [table,column,bad,good] of [['whatsapp_inbound_events','status','done','processing'],['whatsapp_inbound_events','sender_phone','+15555559999',f.phone],
   ['whatsapp_inbound_events','message_text',instruction+' extra',instruction],['whatsapp_messages','phone','+15555559999',f.phone],
   ['whatsapp_messages','audience','customer','owner'],['whatsapp_messages','direction','outbound','inbound'],['whatsapp_messages','body',instruction+' extra',instruction]]){
   await db.query(`update ${table} set ${column}=$1 where provider_message_id='valid-owner'`,[bad]);await assert.rejects(transition(valid),/source is outside current owner scope/);
   await db.query(`update ${table} set ${column}=$1 where provider_message_id='valid-owner'`,[good]);
  }
  for(const [table,column] of [['whatsapp_messages','created_at'],['whatsapp_inbound_events','received_at']]){
   await db.query(`update ${table} set ${column}=now()-interval '2 minutes' where provider_message_id='valid-owner'`);await assert.rejects(transition(valid),/source is outside current owner scope/);
   await db.query(`update ${table} set ${column}=now() where provider_message_id='valid-owner'`);
  }
  await db.query("update whatsapp_pending_actions set expires_at=now()-interval '1 second' where id=31");assert.equal((await transition(valid)).rows.length,0);
  await db.query("update whatsapp_pending_actions set expires_at=$1,consumed_at=now() where id=31",[baseline.expires_at]);assert.equal((await transition(valid)).rows.length,0);
  await db.query('update whatsapp_pending_actions set consumed_at=null where id=31');assert.deepEqual(await review(),baseline);
  const result=(await transition(valid)).rows[0];assert.equal(result.id,31);assert.equal(result.version,3);assert.equal(result.generation,1);
  assert.deepEqual(result.action,valid);assert.equal((await transition(valid)).rows.length,0,'CAS permits exactly one correction');
  for(const table of ['invoices','invoice_files','payments','payment_reversals','whatsapp_owner_action_receipts','whatsapp_direct_write_receipts'])assert.equal((await db.query(`select count(*)::int n from ${table}`)).rows[0].n,0,table);
  assert.equal((await db.query("select count(*)::int n from whatsapp_messages where audience='customer'")).rows[0].n,0);
 }finally{await f.close();}
});

test('exact-file migration source, line endings, security and posthash guards are atomic',async()=>{
 const f=await fixture(),{db,routine,review}=f;
 try{
  const sql=await migration(),predecessor=await routine(),baseline=await review();
  assert.equal(createHash('md5').update(sql.split('AS $function$')[1].split('$function$')[0].replaceAll('\r','')).digest('hex'),forwardHash);
  for(const definition of [predecessor.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\n  -- drift'),
   predecessor.definition.replace('  v_unpaid_resolution boolean := false;','  v_unpaid_resolution boolean := false;\r')]){
   await db.exec(definition);const drift=await routine();await assert.rejects(db.exec(sql),/Unexpected retained invoice review (?:source|line endings); no changes applied/);
   await db.exec('rollback');assert.deepEqual(await routine(),drift);assert.deepEqual(await review(),baseline);
  }
  await db.exec(predecessor.definition);
  for(const mutated of [sql.replace('  v_inferred_currency_correction boolean := false;','  v_inferred_currency_correction boolean := false;\n  -- posthash mismatch'),
   sql.replace("SET search_path TO 'pg_catalog', 'public'","SET search_path TO 'public', 'pg_catalog'"),sql.replace(' SECURITY DEFINER',' SECURITY INVOKER')]){
   await assert.rejects(db.exec(mutated),/Retained invoice review routine security or source changed/);await db.exec('rollback');
   assert.deepEqual(await routine(),predecessor);assert.deepEqual(await review(),baseline);
  }
  await db.exec(sql);const fixed=await routine();await db.exec(sql.replaceAll('\n','\r\n'));assert.deepEqual(await routine(),fixed);
  await db.exec(fixed.definition.replaceAll('\n','\r\n'));const crlf=await routine();await db.exec(sql);assert.deepEqual(await routine(),crlf);
  const old=await readFile(new URL('../supabase/migrations/20261008193550_invoice_review_inferred_currency_unpaid_correction.sql',import.meta.url),'utf8');
  await assert.rejects(db.exec(old),/Unexpected retained invoice review source/);await db.exec('rollback');assert.deepEqual(await routine(),crlf);
 }finally{await f.close();}
});

for(const lineEndings of ['LF','CRLF'])test(`superseding migration accepts frozen earlier candidate ${lineEndings} while preserving scope and security`,async()=>{
 const f=await fixture({includeEarlierCandidate:true}),{db,routine,review}=f;
 try{
  const before=await routine(),baseline=await review();assert.equal(before.normalized_md5,earlierHash);
  if(lineEndings==='CRLF')await db.exec(before.definition.replaceAll('\n','\r\n'));
  await db.exec(await migration());const after=await routine();assert.equal(after.normalized_md5,forwardHash);assert.deepEqual(security(after),security(before));assert.deepEqual(await review(),baseline);
  const earlierSql=await readFile(new URL('../supabase/migrations/'+earlierMigration,import.meta.url),'utf8');
  await assert.rejects(db.exec(earlierSql),/Unexpected retained invoice review source/);await db.exec('rollback');assert.deepEqual(await routine(),after);
 }finally{await f.close();}
});
