import {createOwnerWorkspaceTools} from '../automation/whatsapp/owner-workspace-tools.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {createOwnerMessageHandler} from './fixtures/owner-engine.mjs';
import {createWhatsAppPendingActionStore} from '../automation/whatsapp/pending-actions.mjs';
import {ownerGroundingIssue} from '../automation/whatsapp/owner-grounding.mjs';
import {DEFAULT_EXTRACTION_MODEL,GEMINI_FALLBACK_MODEL,ZEN_PRIMARY_MODEL} from '../ai/provider.mjs';

const phone = '+12025550101';
const incorrect = "I couldn't log the invoice because I couldn't find it.";

async function fixture(t, {persistentIncorrectReply = false} = {}) {
  const f = await createOfflineSqlNetwork(), ownerId = randomUUID();
  await f.db.query('insert into auth.users(id) values($1)', [ownerId]);
  await f.db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${ownerId}';set role authenticated`);
  const workspaceId = (await f.db.query('select (public.create_workspace($1,$2)).id', ['Fixture studio',randomUUID()])).rows[0].id;
  const verification = (await f.db.query('select * from public.owner_start_whatsapp_verification($1,$2)', [workspaceId,phone])).rows[0];
  await f.db.exec("reset role;set request.jwt.claim.sub='';set request.jwt.claim.role='service_role'");
  assert.equal((await f.db.query('select public.whatsapp_verify_owner_code($1,$2) value', [phone,verification.code])).rows[0].value.ok, true);
  const binding = (await f.db.query('select * from public.whatsapp_resolve_verified_owner($1)', [phone])).rows[0];
  const scope = {workspaceId,ownerId,customerId:binding.customer_id,phone};
  const sourceId = 'failed-image-source', bytes = Buffer.from([255,216,255,0,0,0]);
  await f.db.query("insert into whatsapp_inbound_events(provider_message_id,phone_number_id,sender_phone,message_type,message_text,status,media_ref) values($1,'123456',$2,'image','log this invoice','processing',$1)", [sourceId,phone]);
  await f.db.query("insert into whatsapp_inbound_media(provider_message_id,media_id,mime_type,bytes,size_bytes) values($1,'fixture-media','image/jpeg',$2,$3)", [sourceId,bytes,bytes.length]);
  const providerRequests = [], results = [], logs = [];
  let finalReplies = 0;
  let localReads=0;
  const handler=createOwnerMessageHandler({supabase:f.supabase,env:{NODE_ENV:'test'},
    localExtraction:async()=>{localReads++;throw Object.assign(new Error('private local timeout detail'),{code:'TIMEOUT',status:504});},
    providerFactory:()=>{providerRequests.push('provider');throw Error('local failure cannot invoke a provider');},
    toolsFactory:options=>{const tools=createOwnerWorkspaceTools(options);return {...tools,async execute(...args){const result=await tools.execute(...args);results.push(result);return result;}};},
    logger:{info(label,data){logs.push({label,data});},warn(){},error(label,data){logs.push({label,data});}}});
  const turn = () => handler({...scope,message:'log this invoice',messageId:sourceId,
    media:{bytes,mimeType:'image/jpeg',fileName:'source.jpg'}});
  return {...f,scope,sourceId,bytes,turn,providerRequests,results,logs,get localReads(){return localReads;},
    async assertNoFinancialWrites() {
      for (const table of ['invoices','invoice_files','payments','invoice_correction_audits','whatsapp_direct_write_receipts','whatsapp_owner_action_receipts']) {
        assert.equal((await f.db.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
      }
      assert.equal(f.requests.some(request => request.url.includes('/storage/v1/object/')), false);
      assert.deepEqual(f.errors, []);
    }};
}

for (const persistentIncorrectReply of [false,true]) test(`local extraction timeout is truthful and durable without any provider calls (repeated bad final=${persistentIncorrectReply})`, async t => {
  const f = await fixture(t, {persistentIncorrectReply});
  try {
    const reply = await f.turn();
    assert.match(reply.answer, /Reading the invoice timed out.*Nothing was saved/i);
    assert.doesNotMatch(reply.answer, /couldn't find|not found|does not exist/);
    assert.doesNotMatch(JSON.stringify(reply), /isolated transport timeout|isolated provider unavailable/);
    // The outer handler exposes the grounded answer rather than internal
    // fallback metadata. Two native final drafts prove a repair was attempted;
    // a repeatedly incorrect model still yields the canonical existing fallback.
    assert.equal(f.results.length, 1);assert.equal(f.localReads,1);
    assert.deepEqual(f.providerRequests,[],'timeout and fallback paths cannot invoke a model');
    const result = f.results[0];
    assert.equal(result.code, 'UNAVAILABLE');
    assert.equal(result.outcome, 'not_saved');
    assert.match(result.message, /Reading the invoice timed out.*Nothing was saved/i);
    const pending = createWhatsAppPendingActionStore({supabase:f.supabase});
    const review = (await pending.loadInvoiceReview(f.scope)).action;
    assert.equal(review.stage, 'canceled');
    assert.equal(review.sourceMessageId, f.sourceId);
    assert.equal(review.failureCode, 'EXTRACTION_UNAVAILABLE');
    assert.equal(review.failureReason, 'TIMEOUT');
    assert.equal(review.failureStatus, 504);
    assert.equal(review.invoice.invoiceNumber, null);
    assert.equal(review.invoice.total, null);
    const retained = (await f.db.query('select bytes from whatsapp_inbound_media where provider_message_id=$1', [f.sourceId])).rows[0].bytes;
    assert.deepEqual(Buffer.from(retained), f.bytes);
    await f.assertNoFinancialWrites();
    const before = f.providerRequests.length;
    const replay = await f.turn();
    assert.equal(replay.replayed, true);
    assert.equal(replay.answer, reply.answer);
    assert.equal(f.providerRequests.length, before);
    assert.equal((await f.db.query("select count(*)::int n from whatsapp_messages where audience='owner' and direction='outbound' and idempotency_key=$1", [`reply:${f.sourceId}`])).rows[0].n, 1);
    assert.equal(f.logs.filter(item => item.label === 'WhatsApp invoice review failed').length, 1);
    const failure = f.logs.find(item => item.label === 'WhatsApp invoice review failed').data;
    assert.equal(failure.reason, 'TIMEOUT');
    assert.equal(failure.status, 504);
    assert.equal(Object.hasOwn(failure, 'message'), false);
    await f.assertNoFinancialWrites();
  } finally { await f.close(); }
});

test('contextual invoice absence requires a checked NOT_FOUND result while missing field wording stays valid', () => {
  const unavailable = {ok:false,code:'UNAVAILABLE',outcome:'not_saved',review:{stage:'canceled'},message:'Invoice Reading the invoice timed out. Nothing was saved.'};
  assert.equal(ownerGroundingIssue(incorrect,[unavailable],'log this invoice'), 'fresh_database_read_required');
  assert.equal(ownerGroundingIssue("I couldn't locate it.",[unavailable],'log this invoice'), 'fresh_database_read_required');
  const read = {ok:false,code:'NOT_FOUND',table:'invoices',operation:'read'};
  assert.equal(ownerGroundingIssue(incorrect,[read],'log this invoice'), null);
  assert.equal(ownerGroundingIssue("I couldn't find a due date on that invoice.",[{ok:true,table:'invoices',operation:'read',readOnly:true,rows:[{invoice_number:'INV-1'}]}],'show invoice INV-1'), null);
  assert.equal(ownerGroundingIssue("I couldn't find it.",[{ok:false,code:'UNAVAILABLE'}],'What is the customer phone number?'), null);
  assert.equal(ownerGroundingIssue("I couldn't find that customer for this invoice.",
    [{ok:false,code:'NOT_FOUND',table:'customers',operation:'read'}],'Find the customer for invoice INV-1'), null);
});
