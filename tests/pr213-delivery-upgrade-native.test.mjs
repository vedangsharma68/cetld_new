import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:net';import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';import {createNativePostgresFixture} from './fixtures/native-postgres.mjs';import {OFFLINE_SQL_BOOTSTRAP,offlineSqlMigrationSources} from './fixtures/offline-sql-network.mjs';import {migrationStatements} from './fixtures/migration-statements.mjs';
const fourth='20261121095622_durable_service_delivery_intents.sql';
test('native populated upgrade reconciles only known-unsent legacy acks, preserves existing queue state and ordinary answer recovery',async t=>{
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const pg=await createNativePostgresFixture({port});let db;
 try{await pg.initialise();await pg.start();db=pg.getPgClient();await db.connect();await db.query(OFFLINE_SQL_BOOTSTRAP);for(const [,sql]of await offlineSqlMigrationSources([fourth]))await db.query(sql);
  const owner=randomUUID(),otherOwner=randomUUID();await db.query('insert into auth.users(id) values($1),($2)',[owner,otherOwner]);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[owner]);const workspace=(await db.query("select (create_workspace('Legacy phase upgrade',$1)).id",[randomUUID()])).rows[0].id;
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[otherOwner]);const other=(await db.query("select (create_workspace('Other scope',$1)).id",[randomUUID()])).rows[0].id;await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  const phone='+12025550889',cases=['registered','not-claimed','receipt-fence','event-fence','orphan-nonce','historical','provider-id','ambiguous','expired','round6-populated'],events={};
  for(const kind of cases){const id='wamid.native-legacy-'+kind;events[kind]=(await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status,ack_reservation_nonce,owner_ack_claimed_at,ack_dispatch_started_at,ack_dispatch_nonce) values($1,'123456',$2,'text','Operation',now()-case when $3='expired' then interval '25 hours' else interval '2 hours' end,'done',$4,$5,$6,$7) returning *",[id,phone,kind,kind==='historical'||kind==='not-claimed'?null:randomUUID(),kind==='not-claimed'?null:new Date(),kind==='event-fence'?new Date():null,kind==='orphan-nonce'?randomUUID():null])).rows[0];
   await db.query("insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key,dispatch_started_at,provider_message_id) values($1,$2,'outbound','owner',$3,'normal','pending',$4,$5,$6)",[workspace,phone,'First stored ack '+kind,'ack:'+id,kind==='receipt-fence'?new Date():null,kind==='provider-id'?'wamid.already-handed-off':null]);
   if(kind==='ambiguous')await db.query("insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,'outbound','owner','Conflicting scope','normal','pending',$3)",[other,phone,'ack:'+id]);
  }
  const answer=(await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) values('wamid.legacy-answer','123456',$1,'text','Answer request',now(),'pending') returning *",[phone])).rows[0];
  await db.query("insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key) values($1,$2,'outbound','owner','Saved ordinary answer','normal','pending','reply:wamid.legacy-answer')",[workspace,phone]);
  await db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,provider_timestamp,status) select 'wamid.bulk-ack-'||n,'123456',$1,'text','Operation',now(),'done' from generate_series(1,1000)n",[phone]);
  await db.query("insert into whatsapp_messages(workspace_id,phone,direction,audience,body,kind,status,idempotency_key) select $1,$2,'outbound','owner','Bulk saved progress','normal','pending','ack:wamid.bulk-ack-'||n from generate_series(1,1000)n",[workspace,phone]);
  // Populated round-six replay is an independent upgrade path: its immutable
  // queue bytes, status and retry deadline must win over legacy reconstruction.
  await db.query(await readFile(new URL('./fixtures/pr213-round6-deliveries.source.sql',import.meta.url),'utf8'));
  const existing=events['round6-populated'];await db.query("update whatsapp_inbound_events set status='processing' where id=$1",[existing.id]);
  await db.query("select whatsapp_save_service_delivery($1,$2,'ack',$3)",[existing.provider_message_id,phone,{method:'reply',input:{workspaceId:workspace,to:phone,messageId:existing.provider_message_id,phase:'ack',kind:'normal',audience:'owner',body:'Existing sealed round-six intent',businessName:'Legacy phase upgrade'}}]);
  await db.query("update app.whatsapp_service_deliveries set status='accepted',next_attempt_at=now()+interval '3 hours' where event_id=$1",[existing.id]);await db.query("update whatsapp_inbound_events set status='done' where id=$1",[existing.id]);
  const before=(await db.query('select * from app.whatsapp_service_deliveries where event_id=$1',[existing.id])).rows[0];
  const sql=await readFile(new URL('../supabase/migrations/'+fourth,import.meta.url),'utf8'),stages=[];const begun=performance.now();
  for(const statement of migrationStatements(sql)){const start=performance.now();await db.query(statement);stages.push(performance.now()-start);if(/set local statement_timeout/i.test(statement))await db.query("set local statement_timeout='1s'");}
  t.diagnostic(JSON.stringify({legacyAcknowledgments:1010,migrationMs:performance.now()-begun,maxStatementMs:Math.max(...stages)}));
  await t.test('known-unsent phase content and original window are recovered; ambiguous handoffs never become retryable',async()=>{
   for(const kind of cases){const event=events[kind],row=(await db.query("select * from app.whatsapp_service_deliveries where event_id=$1 and phase='ack'",[event.id])).rows[0];assert.ok(row,kind);
    if(kind==='round6-populated'){assert.deepEqual(row,before);continue;}
    assert.equal(row.request.input.body,'First stored ack '+kind);assert.equal(row.request.input.workspaceId,workspace);assert.equal(Date.parse(row.request.input.lastInboundAt),new Date(event.provider_timestamp).getTime());
    assert.equal(row.status,['registered','not-claimed'].includes(kind)?'pending':kind==='expired'?'blocked':'quarantined',kind);
    const after=(await db.query('select ack_dispatch_started_at,ack_dispatch_nonce,ack_reservation_nonce from whatsapp_inbound_events where id=$1',[event.id])).rows[0];assert.deepEqual(after,{ack_dispatch_started_at:event.ack_dispatch_started_at,ack_dispatch_nonce:event.ack_dispatch_nonce,ack_reservation_nonce:event.ack_reservation_nonce});
   }
   assert.equal((await db.query("select count(*)::int n from app.whatsapp_service_deliveries where status='pending'")).rows[0].n,1002);
   assert.equal((await db.query("select count(*)::int n from app.whatsapp_service_deliveries where phase='answer'")).rows[0].n,0);
   const claimed=(await db.query('select * from whatsapp_claim_inbound_events(1)')).rows;assert.equal(String(claimed[0].id),String(answer.id));
  });
  await t.test('replay preserves populated queue outcomes and deadlines exactly',async()=>{const rows=(await db.query('select * from app.whatsapp_service_deliveries order by event_id,phase')).rows;await db.query(sql);await db.query(sql);assert.deepEqual((await db.query('select * from app.whatsapp_service_deliveries order by event_id,phase')).rows,rows);});
  await t.test('phase exclusions and own due times are enforced independently of a due parent',async()=>{
   await db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()+interval '1 hour' where status='pending'");const target=events.registered;await db.query("update whatsapp_inbound_events set status='pending',next_attempt_at=now()-interval '1 hour' where id=$1",[target.id]);assert.equal((await db.query('select whatsapp_claim_service_delivery() value')).rows[0].value,null);
   await db.query("update app.whatsapp_service_deliveries set next_attempt_at=now()-interval '1 second' where event_id=$1",[target.id]);assert.equal((await db.query('select whatsapp_claim_ready_service_delivery($1) value',[JSON.stringify([target.id+':ack'])])).rows[0].value,null);
   const lease=(await db.query('select whatsapp_claim_ready_service_delivery($1) value',['[]'])).rows[0].value;assert.equal(String(lease.event.id),String(target.id));
   await db.query("select whatsapp_release_service_delivery($1,'ack',$2)",[target.id,lease.delivery.lease_token]);
   for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'whatsapp_claim_ready_service_delivery(jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  });
 }finally{if(db){await db.query('rollback').catch(()=>{});await db.end().catch(()=>{});}await pg.stop();}
});
