import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {createWhatsAppOutbound} from '../automation/whatsapp/cloud-outbound.mjs';
import {createApprovedReminderProvider} from '../automation/whatsapp/approved-reminders.mjs';
import {createFirstPartyReminderProvider} from '../automation/whatsapp/cloud-reminders.mjs';
import {APPROVED_REMINDER_WABA,selectReminderTemplate,buildReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';
import {reminderDeliveryForm} from '../automation/whatsapp/reminder-approval.mjs';
import {brandedReminder} from '../automation/preferences.mjs';

const QA = '+919871367051';
const COMMERCIAL = '+12025550199';
const OTHER = '+12025550198';
const NOW = '2026-10-23T12:00:00.000Z';
const ownerId = '10000000-0000-4000-8000-000000000001';
const workspaceId = '20000000-0000-4000-8000-000000000001';
const foreignBusinessId = '20000000-0000-4000-8000-000000000002';
const customerId = '30000000-0000-4000-8000-000000000001';
const invoiceId = '40000000-0000-4000-8000-000000000001';
const claimId = '50000000-0000-4000-8000-000000000001';
const baseEnv = {
  WHATSAPP_OUTBOUND_ENABLED:'true', AUTOMATION_OUTBOUND_ENABLED:'true', WHATSAPP_REMINDERS_ENABLED:'true',
  WHATSAPP_ACCESS_TOKEN:'fake-token', WHATSAPP_PHONE_NUMBER_ID:'1234567890',
  WHATSAPP_WABA_ID:APPROVED_REMINDER_WABA, WHATSAPP_GRAPH_API_VERSION:'v24.0',
};
const template = {
  status:'APPROVED', category:'UTILITY', useCase:'first_party_invoice_reminder',
  name:'fixture_invoice_reminder', language:'en', revision:'fixture-v1',
  wabaId:APPROVED_REMINDER_WABA, phoneNumberId:baseEnv.WHATSAPP_PHONE_NUMBER_ID,
  body:'Hello {{2}}, invoice {{3}}: {{4}} {{5}}, date {{6}}.\n\n{{1}}',
};

// Every transport is injected. These traps fail the test if any path escapes it.
function forbidLiveNetwork(t) {
  let attempts = 0;
  const forbidden = () => { attempts++; throw Error('Live network is forbidden'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(http, 'request', forbidden);
  t.mock.method(https, 'request', forbidden);
  t.after(() => assert.equal(attempts, 0, 'no live network call occurred'));
}

function harness(t, kind, {phone=COMMERCIAL, env={}, mutate=()=>{}}={}) {
  forbidLiveNetwork(t);
  const configured = {...baseEnv, WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:'true', ...env};
  const entry = selectReminderTemplate({tone:'professional'});
  const settings = {workspace_id:workspaceId, business_name:'Fixture business', updated_at:NOW,
    follow_up_preferences:{templateName:entry.name}};
  const parameters = kind === 'cloud-reminders'
    ? [settings.business_name,'Fixture customer','INV-1','125.00','USD','2026-10-22']
    : [settings.business_name,'INV-1','Fixture customer'];
  const body = kind === 'cloud-reminders'
    ? template.body.replace(/\{\{([1-6])\}\}/g, (_, n) => parameters[Number(n)-1])
    : buildReminderTemplate(entry, parameters).body;
  const delivery = reminderDeliveryForm({entry:kind === 'cloud-reminders' ? template : entry, parameters, body});
  const approvedText = kind === 'cloud-reminders' ? body : brandedReminder(body, settings.business_name);
  const state = {
    whatsapp_global_suppressions:[], whatsapp_suppressions:[],
    whatsapp_consents:[{id:'consent-fixture', workspace_id:workspaceId, customer_id:customerId,
      phone, source:'verbal', categories:['invoice_updates'], revoked_at:null, created_at:NOW}],
    customers:[{id:customerId, workspace_id:workspaceId, name:'Fixture customer', phone}],
    workspace_settings:[settings],
    owner_assistant_proposals:[{workspace_id:workspaceId, owner_id:ownerId, state:'confirmed',
      action:{type:'owner_reminder', payload:{invoiceId, preview:body, approvalText:approvedText,
        template:{name:entry.name, language:entry.language, revision:entry.revision, parameters}}},
      result:{ok:true, action:'reminder.approved'}}],
    invoice:{id:invoiceId, workspace_id:workspaceId, workspaceId, customer_id:customerId, customerId,
      customerPhone:phone, invoice_number:'INV-1', invoiceNumber:'INV-1', status:'sent',
      total_amount:'125.00', amount_paid:'0.00', due_date:'2026-10-22', currency:'USD', followup_state:'approved',
      updated_at:NOW, updatedAt:NOW, automation_version:1,
      metadata:{invoice_direction:'receivable', approved_preferences_updated_at:NOW,
        approved_reminder_text:approvedText, approved_reminder_delivery:delivery}},
    readError:false, atomicAllowed:true, invoiceClaimed:true,
  };
  mutate(state);
  const reads = [], claims = [], calls = [];
  const supabase = {
    from(table) {
      const filters = {};
      const rows = () => {
        reads.push({table, filters:{...filters}});
        if (state.readError) throw Error('Fake database unavailable');
        assert.ok(Array.isArray(state[table]), `unexpected table ${table}`);
        return state[table].filter(row => Object.entries(filters).every(([key, value]) => {
          const actual = key.split('->').reduce((current, part) => current?.[part.replace(/^>/, '')], row);
          return actual === value;
        }));
      };
      const query = {
        select(){return query;}, eq(key,value){filters[key]=value;return query;}, order(){return query;},
        async maybeSingle(){const data=rows();assert.ok(data.length<=1);return {data:data[0]??null};},
        async limit(){return {data:rows()};},
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'cetld_core_authorize_first_party_reminder');
      claims.push(args);
      assert.equal(args.p_owner_id, ownerId);
      assert.equal(args.p_workspace_id, workspaceId);
      return {data:{authorized:state.atomicAllowed, snapshot_hash:args.p_snapshot_hash, callback_token:'a'.repeat(64)}};
    },
  };
  const store = {
    async getInvoice(scope){assert.equal(scope.ownerId,ownerId);assert.equal(scope.workspaceId,workspaceId);return state.invoice;},
    async getWorkspacePreferences(scope){assert.equal(scope.ownerId,ownerId);assert.equal(scope.workspaceId,workspaceId);return settings;},
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, `https://graph.facebook.com/v24.0/${baseEnv.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    assert.equal(options.method, 'POST');
    calls.push(JSON.parse(options.body));
    return Response.json({messages:[{id:'wamid.fake-commercial'}]});
  };
  const input = {workspaceId, invoiceId, customerId, to:phone, body,
    idempotencyKey:`reminder:${workspaceId}:${claimId}`, businessName:settings.business_name, expectedUpdatedAt:NOW};
  const options = {env:configured, supabase, store, ownerId, workspaceId, fetchImpl, clock:()=>new Date(NOW)};
  const provider = kind === 'cloud-outbound'
    ? createWhatsAppOutbound({...options, conversationStore:null, logger:{warn(){},error(){}},
      invoiceStore:{async getCurrentInvoice(){return state.invoice;}},
      claimInvoiceUpdate:async args=>{claims.push(args);return {claimed:state.invoiceClaimed};}})
    : kind === 'approved-reminders' ? createApprovedReminderProvider(options)
      : createFirstPartyReminderProvider({...options, templateSnapshot:template});
  const send = (patch={}) => kind === 'cloud-outbound'
    ? provider.sendInvoiceUpdateTemplate({...input,...patch}) : provider.sendReminder({...input,...patch});
  return {provider, send, input, state, reads, claims, calls};
}

for (const kind of ['cloud-outbound','approved-reminders','cloud-reminders']) {
  for (const flag of [undefined, 'false', 'TRUE', ' true ', true, '']) {
    test(`${kind}: flag ${JSON.stringify(flag)} keeps the QA gate unchanged`, async t => {
      const f = harness(t, kind, {phone:QA, env:{WHATSAPP_COMMERCIAL_OUTBOUND_ENABLED:flag,
        WHATSAPP_TEST_ALLOWLIST:`${QA},${COMMERCIAL}`}});
      assert.deepEqual(await f.send({to:COMMERCIAL}), {status:'blocked',reason:'test_allowlist'});
      assert.equal(f.reads.length,0, 'non-QA is rejected before database access');
      assert.equal(f.calls.length,0);
      assert.equal((await f.send()).status,'accepted', 'QA passes the recipient gate');
      assert.equal(f.calls.length,1);
    });
  }

  const negatives = [
    ['no consent', s=>{s.whatsapp_consents=[];}, 'missing_consent'],
    ['revoked consent', s=>{s.whatsapp_consents[0].revoked_at=NOW;}, 'revoked'],
    ['global suppression', s=>{s.whatsapp_global_suppressions=[{phone:COMMERCIAL,suppressed_at:NOW}];}, 'globally_suppressed'],
    ['business suppression', s=>{s.whatsapp_suppressions=[{workspace_id:workspaceId,phone:COMMERCIAL,suppressed_at:NOW}];}, 'suppressed'],
    ['missing invoice category', s=>{s.whatsapp_consents[0].categories=['other'];}, 'category_not_consented'],
    ['customer phone mismatch', s=>{s.customers[0].phone=OTHER;}, 'unbound'],
    ['consent in another business', s=>{s.whatsapp_consents[0].workspace_id=foreignBusinessId;}, 'missing_consent'],
    ['customer in another business', s=>{s.customers[0].workspace_id=foreignBusinessId;}, 'unbound'],
    ['non-recipient consent source', s=>{s.whatsapp_consents[0].source='owner_attestation';}, 'missing_recipient_opt_in'],
    ['database ambiguity', s=>{s.readError=true;}, 'eligibility_unavailable'],
  ];
  for (const [label,mutate,reason] of negatives) {
    test(`${kind}: commercial ${label} blocks without dispatch`, async t => {
      const f = harness(t,kind,{mutate});
      assert.deepEqual(await f.send(), {status:'blocked',reason});
      assert.equal(f.calls.length,0);
      assert.equal(f.claims.length,0);
      if (kind==='approved-reminders') await assert.rejects(f.provider.prepareReminder(f.input));
    });
  }

  for (const phone of ['12025550199','+0123456789','+1234567','invalid',null]) {
    test(`${kind}: commercial malformed phone ${JSON.stringify(phone)} blocks`, async t => {
      const f = harness(t,kind);
      assert.deepEqual(await f.send({to:phone}),{status:'blocked',reason:'invalid_phone'});
      assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);
    });
  }

  test(`${kind}: commercial verbal invoice consent permits a non-QA recipient using fakes only`, async t => {
    const f = harness(t,kind);
    if (kind==='approved-reminders') assert.equal((await f.provider.prepareReminder(f.input)).body,f.input.body);
    assert.equal((await f.send()).status,'accepted');
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].to,COMMERCIAL.slice(1));
    const consentReads = f.reads.filter(r=>r.table==='whatsapp_consents');
    assert.ok(consentReads.length>=2, 'existing fresh consent rechecks still execute');
    assert.ok(consentReads.every(r=>r.filters.workspace_id===workspaceId && r.filters.phone===COMMERCIAL));
  });

  for (const [list,reason] of [[QA,'test_allowlist'],['','invalid_test_allowlist'],['bad','invalid_test_allowlist'],
    [`${COMMERCIAL},bad`,'invalid_test_allowlist'],[`${COMMERCIAL},`,'invalid_test_allowlist'],[null,'invalid_test_allowlist']]) {
    test(`${kind}: commercial allowlist ${JSON.stringify(list)} fails closed`, async t => {
      const f = harness(t,kind,{env:{WHATSAPP_TEST_ALLOWLIST:list}});
      assert.deepEqual(await f.send(),{status:'blocked',reason});
      assert.equal(f.calls.length,0);assert.equal(f.claims.length,0);
    });
  }

  test(`${kind}: commercial allowlist can include a consented non-QA recipient`, async t => {
    const f = harness(t,kind,{env:{WHATSAPP_TEST_ALLOWLIST:` ${COMMERCIAL} , ${QA} `}});
    assert.equal((await f.send()).status,'accepted');assert.equal(f.calls.length,1);
  });

  test(`${kind}: commercial allowlist cannot substitute for consent`, async t => {
    const f = harness(t,kind,{env:{WHATSAPP_TEST_ALLOWLIST:COMMERCIAL},mutate:s=>{s.whatsapp_consents=[];}});
    assert.deepEqual(await f.send(),{status:'blocked',reason:'missing_consent'});assert.equal(f.calls.length,0);
  });

  const flags = kind==='cloud-outbound' ? ['WHATSAPP_OUTBOUND_ENABLED']
    : ['WHATSAPP_OUTBOUND_ENABLED','AUTOMATION_OUTBOUND_ENABLED','WHATSAPP_REMINDERS_ENABLED'];
  for (const flag of flags) {
    test(`${kind}: commercial mode still requires ${flag}`, async t => {
      const f = harness(t,kind,{env:{[flag]:'false'}});
      assert.deepEqual(await f.send(),{status:'blocked',reason:'disabled'});
      assert.equal(f.reads.length,0);assert.equal(f.calls.length,0);
    });
  }

  test(`${kind}: commercial mode retains recipient business scoping`, async t => {
    const f = harness(t,kind);
    const result = await f.send({workspaceId:foreignBusinessId});
    assert.equal(result.status,'blocked');
    assert.equal(result.reason,kind==='cloud-outbound'?'missing_consent':'scope');
    assert.equal(f.calls.length,0);
  });

  test(`${kind}: commercial mode retains the final dispatch claim`, async t => {
    const f = harness(t,kind,{mutate:s=>{s.atomicAllowed=false;s.invoiceClaimed=false;}});
    assert.equal((await f.send()).status,'blocked');assert.equal(f.claims.length,1);assert.equal(f.calls.length,0);
  });
}

for (const method of ['sendServiceReply','sendServiceMedia','sendOwnerTestTemplate']) {
  test(`cloud-outbound: ${method} applies commercial consent before any transport`, async t => {
    const f = harness(t,'cloud-outbound',{mutate:s=>{s.whatsapp_consents=[];}});
    const args = method==='sendOwnerTestTemplate' ? {review:{...f.input,recipient:COMMERCIAL}} : f.input;
    assert.deepEqual(await f.provider[method](args),{status:'blocked',reason:'missing_consent'});
    assert.equal(f.calls.length,0);
  });
}

test('cloud-outbound: commercial consent is freshly checked after the invoice claim', async t => {
  const f = harness(t,'cloud-outbound');
  let consentReads=0;
  Object.defineProperty(f.state.whatsapp_consents[0],'revoked_at',{get(){return ++consentReads>=4 ? NOW : null;}});
  assert.deepEqual(await f.send(),{status:'blocked',reason:'revoked'});
  assert.equal(f.claims.length,1);assert.equal(f.calls.length,0);
});
