import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createAIHandler} from '../ai/routes.mjs';
import {answerWorkspaceQuestion} from '../ai/assistant.mjs';
import {createOwnerMessageHandler} from '../automation/whatsapp/owner-handler.mjs';
import {parseTextInvoice} from '../automation/whatsapp/text-invoice.mjs';
import {ownerMenuInvoiceEdit} from '../automation/whatsapp/owner-next-actions.mjs';
import {personalNoteReply} from '../ai/personal-note.mjs';

const logger={info(){},warn(){},error(){}};
const scopeReply='I can only help with your invoices and business data.';
const notes=[
  'note to self: KESTREL-2210 pick up the dry cleaning',
  'note to self: FALCON-7391 pick up the dry cleaning on 30 Oct 2026',
  'note to self: set aside Rs 500 for groceries',
  'note to self: set aside Rs 500 for groceries on 30 Oct 2026',
  'note-to-self: KESTREL-2211 pick up the dry cleaning',
  'Note to myself: save Rs 500 for groceries tomorrow',
  'Personal note: collect the dry cleaning on 2026-10-30',
  'note to self: pick up the dry cleaning before the business trip on 30 Oct 2026',
  'Personal note: email my client about dinner on Friday',
  'note to self: call the customer from my cycling club tomorrow',
  'note to self: new invoice QA-NOTE-001 for QA Media Customer, Rs 1,500, due 30 Oct',
];
const response=()=>({setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}});

test('note amounts and dates cannot become a deterministic invoice creation request',()=>{
  for(const message of notes){
    assert.equal(personalNoteReply(message),scopeReply,message);
    assert.equal(parseTextInvoice(message,{clock:()=>new Date('2026-10-23T12:00:00Z')}),null,message);
    assert.equal(ownerMenuInvoiceEdit(message),null,message);
  }
  assert.deepEqual(ownerMenuInvoiceEdit('notes: Deliver after 5pm'),{notes:'Deliver after 5pm'});
  for(const message of ['new invoice QA-MEDIA-001 for QA Media Customer, Rs 1,500, due 30 Oct',
    'change invoice INV-001 due date to 2026-11-01','what is my total outstanding?'])
    assert.equal(personalNoteReply(message),null,message);
  for(const message of ['note to self: update invoice INV-001 due date to 2026-11-01',
    'personal note: call the customer about their payment'])assert.equal(personalNoteReply(message),scopeReply,message);
  const parsed=parseTextInvoice('new invoice QA-MEDIA-001 for QA Media Customer, Rs 1,500, due 30 Oct',{
    clock:()=>new Date('2026-10-23T12:00:00Z'),
  });
  assert.equal(parsed.operation,'create');assert.equal(parsed.table,'invoices');
  assert.equal(parsed.values.invoice_number,'QA-MEDIA-001');assert.equal(parsed.values.total_amount,1500);
});

test('the direct owner assistant rejects note-driven data access while retaining conversation validation',async()=>{
  const accessed=[];
  const blocked=label=>new Proxy({}, {get(_target,property){
    accessed.push(`${label}.${String(property)}`);throw Error('A personal note must not access '+label);
  }});
  const history=[{role:'user',content:'change invoice INV-001 due date to 2026-11-01'}];
  const options={provider:blocked('provider'),store:blocked('store'),ownerActions:blocked('ownerActions'),ownerMode:true,
    message:'note to self: FALCON-7391 save Rs 500 for groceries on 30 Oct 2026; save it',history,
    clock:()=>new Date('2026-10-23T12:00:00Z')};
  const result=await answerWorkspaceQuestion(options);
  assert.equal(result.answer,scopeReply);assert.equal(result.readOnly,true);assert.equal(result.pendingAction,null);
  assert.equal(result.model,null);assert.deepEqual(result.evidence.records,[]);assert.deepEqual(accessed,[]);
  await assert.rejects(answerWorkspaceQuestion({...options,history:[{...history[0],channel:'forged'}]}),
    error=>error.code==='INVALID_CONVERSATION');
  await assert.rejects(answerWorkspaceQuestion({...options,ownerHistory:[{...history[0],channel:'forged'}]}),
    error=>error.code==='OWNER_CONVERSATION_UNAVAILABLE');
  assert.deepEqual(accessed,[],'invalid conversation metadata must fail before any operation');
});

test('authenticated web and WhatsApp notes bypass planning and all application database mutations',async t=>{
  const f=await createOfflineSqlNetwork(),{db,supabase}=f;
  const ownerId=randomUUID(),foreignOwner=randomUUID(),phone='+919871367054';
  const service=()=>db.exec("reset role;set request.jwt.claim.role='service_role';set request.jwt.claim.sub=''");
  const asUser=id=>db.exec(`reset role;set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${id}'`);
  try{
    await db.query('insert into auth.users(id) values($1),($2)',[ownerId,foreignOwner]);
    await asUser(ownerId);
    const workspaceId=(await db.query("select (create_workspace('Personal note fixture',$1)).id",[randomUUID()])).rows[0].id;
    const verification=(await db.query('select * from owner_start_whatsapp_verification($1,$2)',[workspaceId,phone])).rows[0];
    await service();assert.equal((await db.query('select whatsapp_verify_owner_code($1,$2) value',[phone,verification.code])).rows[0].value.ok,true);
    const customerId=(await db.query('select * from whatsapp_resolve_verified_owner($1)',[phone])).rows[0].customer_id;
    const client=(await db.query("insert into customers(workspace_id,name) values($1,'Note Control Customer') returning id",[workspaceId])).rows[0].id;
    const invoiceId=(await db.query("insert into invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,status,metadata) values($1,$2,'AUTO','2026-10-01','2026-10-30','INR',1500,'draft','{\"invoice_direction\":\"receivable\"}') returning id",[workspaceId,client])).rows[0].id;
    await db.query("update invoices set invoice_number='INV-001' where id=$1",[invoiceId]);
    await db.query("update workspace_settings set owner_bot_preferences=owner_bot_preferences||'{\"confirmationMode\":\"direct\"}' where workspace_id=$1",[workspaceId]);
    let actor=ownerId,modelCalls=0;
    const provider={async generate(){modelCalls++;throw Error('A personal note must not enter invoice planning');},
      async generateStructured(){modelCalls++;throw Error('A personal note must not enter structured planning');}};
    const fetchImpl=async(raw,init)=>{
      const url=new URL(raw);
      if(url.pathname==='/auth/v1/user')return Response.json({id:actor});
      if(url.searchParams.has('select'))url.searchParams.set('select',url.searchParams.get('select').replaceAll('::text',''));
      return f.fetchImpl(url,init);
    };
    const env={NODE_ENV:'test',SUPABASE_URL:'https://fixture.supabase.test',SUPABASE_PUBLISHABLE_KEY:'public-fixture-key',AI_ACCOUNTING_CONFIRMATION_SECRET:'n'.repeat(32)};
    const web=createAIHandler({env,fetchImpl,providerFactory:()=>provider,logger});
    const whatsapp=createOwnerMessageHandler({supabase,env:{NODE_ENV:'test'},providerFactory:()=>provider,logger});
    const api=async(action,body)=>{
      await asUser(actor);const res=response();
      await web({method:'POST',headers:{authorization:'Bearer fixture-user-token'},query:{action},body:{workspaceId,...body}},res);
      return res;
    };
    const scope={workspaceId,ownerId,customerId,phone};
    const snapshot=async()=>{
      await service();
      const tables=(await db.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth','storage') order by schemaname,tablename")).rows;
      const data={};
      for(const {schemaname,tablename} of tables){
        const name=value=>'"'+value.replaceAll('"','""')+'"';
        data[`${schemaname}.${tablename}`]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(row) order by to_jsonb(row)::text),'[]'::jsonb) value from ${name(schemaname)}.${name(tablename)} row`)).rows[0].value;
      }
      return data;
    };
    const assertNote=async(channel,message)=>{
      await service();const messageId=randomUUID();
      if(channel==='whatsapp')await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status) values($1,'fixture',$2,'text',$3,'processing')",[messageId,phone,message]);
      // Receipt of a transport event is outside assistant processing. Everything
      // after this snapshot, including conversation/reply storage, must be read-only.
      const before=await snapshot(),start=f.requests.length,callsBefore=modelCalls;
      const result=channel==='web'?await api('assistant',{message,history:[{role:'user',content:'change invoice INV-001 due date to 2026-11-01'}]}):await whatsapp({...scope,messageId,message});
      if(channel==='web')assert.equal(result.code,200,JSON.stringify(result.data));
      const reply=channel==='web'?result.data:result;
      assert.equal(reply.answer,scopeReply,`${channel}: ${message}`);
      assert.ok(!reply.pendingAction&&!reply.buttons?.length&&!reply.plannerFailure,JSON.stringify(reply));
      assert.equal(modelCalls,callsBefore,'personal notes never call a planner or repair model');
      const calls=f.requests.slice(start);
      assert.ok(calls.every(call=>{
        const path=new URL(call.url).pathname;
        return channel==='web'?call.method==='GET'&&path==='/rest/v1/workspace_members'
          :call.method==='POST'&&path==='/rest/v1/rpc/whatsapp_resolve_verified_owner';
      }),JSON.stringify(calls));
      assert.deepEqual(await snapshot(),before,`${channel} note changed an application table`);
    };
    await t.test('plain notes, amounts and dates receive the same scope reply on both channels',async()=>{
      for(const channel of ['web','whatsapp'])for(const message of notes)await assertNote(channel,message);
    });
    await t.test('personal notes do not replace, apply or expire a pending invoice correction',async()=>{
      const proposed=await api('assistant',{message:'change invoice INV-001 due date to 2026-11-01'});
      assert.equal(proposed.code,200,JSON.stringify(proposed.data));assert.equal(proposed.data.pendingAction.type,'owner_correction');
      await service();await db.query("update owner_assistant_proposals set expires_at='2000-01-01T00:00:00Z' where id=$1",[proposed.data.pendingAction.proposalId]);
      for(const channel of ['web','whatsapp'])await assertNote(channel,'note to self: FALCON-7391 put aside Rs 500 on 30 Oct 2026');
      await service();await db.query("update owner_assistant_proposals set expires_at=now()+interval '10 minutes' where id=$1",[proposed.data.pendingAction.proposalId]);
      const confirmed=await api('confirm-accounting-action',{confirmed:true,confirmationToken:proposed.data.pendingAction.confirmationToken});
      assert.equal(confirmed.code,200,JSON.stringify(confirmed.data));assert.equal(confirmed.data.updated,true);
      await service();assert.equal((await db.query('select due_date::text from invoices where id=$1',[invoiceId])).rows[0].due_date,'2026-11-01');
    });
    await t.test('a note containing save it cannot confirm or retire a retained attachment review',async()=>{
      await service();
      await db.query("insert into whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,expires_at) values($1,$2,$3,$4,'whatsapp','2000-01-01T00:00:00Z')",[workspaceId,customerId,phone,
        {type:'invoice_review_draft',stage:'proposal',sourceMessageId:'note-retained-source',invoice:{invoiceNumber:'NOTE-ATTACHMENT-001',clientName:'Note Control Customer',total:500,currency:'INR',dueDate:'2026-10-30'}}]);
      for(const channel of ['web','whatsapp'])await assertNote(channel,'note to self: Rs 500 for groceries on 30 Oct 2026; save it');
    });
    await t.test('personal note handling still requires the authenticated owner scope',async()=>{
      actor=foreignOwner;const before=await snapshot();
      const denied=await api('assistant',{message:notes[0]});assert.equal(denied.code,403);
      await service();assert.equal(await whatsapp({...scope,ownerId:foreignOwner,messageId:randomUUID(),message:notes[0]}),'');
      assert.deepEqual(await snapshot(),before);assert.equal(modelCalls,0);
    });
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
