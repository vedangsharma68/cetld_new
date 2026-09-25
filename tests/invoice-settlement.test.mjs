import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const db = new PGlite();
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let workspaceA;
let workspaceB;
let invoiceIds;
let customerAId;

async function identity(userId) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

async function withOwner(callback) {
  await db.exec('reset role');
  try { return await callback(); }
  finally { await db.exec('set role authenticated'); }
}

async function recordPayment({workspaceId, invoiceId, amount, idempotencyKey, settleRemaining = false, reference = 'bank transfer'}) {
  return db.query(
    'select * from public.record_invoice_payment($1::uuid, $2::uuid, $3::numeric, $4::text, $5::text, $6::boolean)',
    [workspaceId, invoiceId, amount, idempotencyKey, reference, settleRemaining],
  );
}

before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,storage to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;`);
  const deferredIntegrityMigrations = [];
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    if (name === '20260925140000_secure_invoice_settlement_and_currency_guards.sql' || name === '20260925150000_exact_invoice_money_and_delete_guards.sql') { deferredIntegrityMigrations.push(migration); continue; }
    await db.exec(migration.replace('create extension if not exists pgcrypto;', ''));
  }
  await db.exec(`insert into auth.users(id) values ('${userA}'),('${userB}'); set role authenticated;`);
  await identity(userA);
  workspaceA = (await db.query("select (public.create_workspace('Alpha','alpha-space')).id")).rows[0].id;
  await identity(userB);
  workspaceB = (await db.query("select (public.create_workspace('Beta','beta-space')).id")).rows[0].id;
  invoiceIds = {};
  await identity(userA);
  customerAId = (await db.query(
    "insert into public.customers(workspace_id,name) values ($1,'Alpha customer') returning id",
    [workspaceA],
  )).rows[0].id;
  for (const [label, status, paid, total, metadata, currency = 'INR'] of [
    ['partial', 'sent', '30.00', '100.00', {followup_state: 'approved', next_follow_up_at: '2026-10-01T09:00:00Z'}],
    ['retry', 'sent', '0.00', '45.00', {}],
    ['overpay', 'sent', '0.00', '10.00', {}],
    ['direct', 'sent', '0.00', '50.00', {}],
    ['forgery', 'sent', '0.00', '50.00', {}],
    ['mismatch', 'sent', '0.00', '77.00', {}],
    ['void', 'void', '0.00', '50.00', {followup_state: 'draft'}],
    ['cancelled', 'cancelled', '0.00', '50.00', {followup_state: 'approved'}],
    ['legacy-yen', 'sent', '0.00', '118.25', {}, 'JPY'],
    ['legacy-dinar', 'sent', '0.00', '10.125', {}, 'KWD'],
  ]) {
    invoiceIds[label] = (await withOwner(() => db.query(
      `insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,amount_paid,status,metadata,currency)
       values ($1,$2,$3,'2026-09-01','2026-10-01',$4,$5,$6,$7::jsonb,$8) returning id`,
      [workspaceA, customerAId, `INV-${label}`, total, paid, status, JSON.stringify(metadata), currency],
    ))).rows[0].id;
  }
  await identity(userB);
  const customerB = (await db.query(
    "insert into public.customers(workspace_id,name) values ($1,'Beta customer') returning id",
    [workspaceB],
  )).rows[0].id;
  invoiceIds.foreign = (await db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount)
     values ($1,$2,'INV-foreign','2026-09-01','2026-10-01',50) returning id`,
    [workspaceB, customerB],
  )).rows[0].id;
  await withOwner(() => db.exec(deferredIntegrityMigrations[0]));
  invoiceIds.mismatchPayment = (await withOwner(() => db.query(
    `insert into public.payments(workspace_id,invoice_id,amount,reference,idempotency_key,settle_remaining)
     values ($1,$2,5,'legacy payment history','legacy_mismatch_payment',false) returning id`,
    [workspaceA, invoiceIds.mismatch],
  ))).rows[0].id;
  await withOwner(() => db.exec(deferredIntegrityMigrations[1]));
});

after(async () => db.close());

test('a partial payment changes the core invoice balance by only the received amount', async () => {
  await identity(userA);
  const result = await recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.partial, amount: 20, idempotencyKey: key(1)});
  assert.equal(Number(result.rows[0].amount), 20);
  const invoice = (await db.query('select total_amount, amount_paid, status, metadata from public.invoices where id=$1', [invoiceIds.partial])).rows[0];
  assert.equal(Number(invoice.total_amount), 100);
  assert.equal(Number(invoice.amount_paid), 50);
  assert.equal(invoice.status, 'sent');
  assert.equal(invoice.metadata.followup_state, 'approved');
  assert.equal(invoice.metadata.next_follow_up_at, '2026-10-01T09:00:00Z');
});

test('marking a partially paid invoice already paid records only its remaining balance and stops follow-up', async () => {
  await identity(userA);
  const result = await recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.partial, amount: null, idempotencyKey: key(2), settleRemaining: true});
  assert.equal(Number(result.rows[0].amount), 50);
  const invoice = (await db.query('select total_amount, amount_paid, status, metadata from public.invoices where id=$1', [invoiceIds.partial])).rows[0];
  assert.equal(Number(invoice.total_amount), 100);
  assert.equal(Number(invoice.amount_paid), 100);
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.metadata.followup_state, 'cancelled');
  assert.equal(invoice.metadata.next_follow_up_at, null);
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.partial])).rows[0].count, 2);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.partial, amount: 1, idempotencyKey: key(2), settleRemaining: true}), /idempotency key.*different.*request/i);
});

test('a duplicate retry with the same idempotency key returns the original payment once', async () => {
  await identity(userA);
  const first = await recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: 15, idempotencyKey: key(3)});
  const retry = await recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: 15, idempotencyKey: key(3)});
  assert.equal(retry.rows[0].id, first.rows[0].id);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: 16, idempotencyKey: key(3)}), /idempotency key.*different.*request/i);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: 15, idempotencyKey: key(3), reference: 'different reference'}), /idempotency key.*different.*request/i);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: null, idempotencyKey: key(3), settleRemaining: true}), /idempotency key.*different.*request/i);
  assert.equal((await db.query('select amount_paid from public.invoices where id=$1', [invoiceIds.retry])).rows[0].amount_paid, '15.00');
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.retry])).rows[0].count, 1);
});

test('an overpayment is rejected without changing either side of the ledger', async () => {
  await identity(userA);
  await assert.rejects(
    recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.overpay, amount: 10.01, idempotencyKey: key(4)}),
    /cannot exceed/i,
  );
  assert.equal((await db.query('select amount_paid from public.invoices where id=$1', [invoiceIds.overpay])).rows[0].amount_paid, '0.00');
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.overpay])).rows[0].count, 0);
});

test('a different workspace member cannot settle another workspace invoice', async () => {
  await identity(userB);
  const before = (await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.partial])).rows[0].count;
  await assert.rejects(
    recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.partial, amount: 1, idempotencyKey: key(5)}),
    /workspace|permission|authorized/i,
  );
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.partial])).rows[0].count, before);
});

test('void and cancelled invoices reject payment attempts', async () => {
  await identity(userA);
  for (const label of ['void', 'cancelled']) {
    await assert.rejects(
      recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds[label], amount: 1, idempotencyKey: key(label === 'void' ? 6 : 7)}),
      /void|cancelled|terminal/i,
    );
    assert.equal((await db.query('select amount_paid from public.invoices where id=$1', [invoiceIds[label]])).rows[0].amount_paid, '0.00');
  }
});

test('authenticated members can read payment history but can only mutate it through the RPC', async () => {
  await identity(userA);
  const payment = (await recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.direct, amount: 3, idempotencyKey: key(8)})).rows[0];
  assert.equal((await db.query('select id from public.payments where id=$1', [payment.id])).rows.length, 1);
  await assert.rejects(
    db.query('insert into public.payments(workspace_id,invoice_id,amount) values ($1,$2,1)', [workspaceA, invoiceIds.direct]),
    /permission denied/i,
  );
  await assert.rejects(db.query('update public.payments set amount=4 where id=$1', [payment.id]), /permission denied/i);
  await assert.rejects(db.query('delete from public.payments where id=$1', [payment.id]), /permission denied/i);
  assert.equal((await db.query('select amount_paid from public.invoices where id=$1', [invoiceIds.direct])).rows[0].amount_paid, '3.00');
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.direct])).rows[0].count, 1);
});

test('authenticated members can create and edit ordinary invoice fields without settlement access', async () => {
  await identity(userA);
  const created = (await db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata)
     values ($1,$2,'INV-manual','2026-09-01','2026-10-01','USD',25.50,'first note','{"followup_state":"draft"}')
     returning id,amount_paid,status`,
    [workspaceA, customerAId],
  )).rows[0];
  assert.equal(Number(created.amount_paid), 0);
  assert.equal(created.status, 'draft');
  const updated = (await db.query(
    `update public.invoices set due_date='2026-10-15',notes='edited note',metadata='{"followup_state":"approved"}'::jsonb
     where id=$1 returning due_date,notes,metadata,amount_paid,status`,
    [created.id],
  )).rows[0];
  assert.equal(updated.due_date.toISOString().slice(0,10), '2026-10-15');
  assert.equal(updated.notes, 'edited note');
  assert.equal(updated.metadata.followup_state, 'approved');
  assert.equal(Number(updated.amount_paid), 0);
  assert.equal(updated.status, 'draft');
});

test('authenticated members cannot forge settlement fields on invoice inserts or updates', async () => {
  await identity(userA);
  await assert.rejects(db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,currency,total_amount,amount_paid)
     values ($1,$2,'INV-forged-paid','INR',50,50)`,
    [workspaceA, customerAId],
  ), /permission denied/i);
  await assert.rejects(db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,currency,total_amount,status)
     values ($1,$2,'INV-forged-status','INR',50,'paid')`,
    [workspaceA, customerAId],
  ), /permission denied/i);
  await assert.rejects(db.query('update public.invoices set amount_paid=50 where id=$1', [invoiceIds.forgery]), /permission denied/i);
  await assert.rejects(db.query("update public.invoices set status='paid' where id=$1", [invoiceIds.forgery]), /permission denied/i);
  const invoice = (await db.query('select amount_paid,status from public.invoices where id=$1', [invoiceIds.forgery])).rows[0];
  assert.equal(invoice.amount_paid, '0.00');
  assert.equal(invoice.status, 'sent');
});

test('exact numeric storage rejects excess precision before invoice or payment values can be rounded', async () => {
  await identity(userA);
  const assertRejectedInRolledBackTransaction = async (statement, params) => {
    await db.exec('begin');
    try { await db.query(statement, params); }
    finally { await db.exec('rollback'); }
  };
  await assert.rejects(assertRejectedInRolledBackTransaction(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,currency,total_amount)
     values ($1,$2,'INV-excess-precision','INR',10.001)`,
    [workspaceA, customerAId],
  ), /two_decimal|two decimal|precision|scale/i);
  await assert.rejects(db.query('update public.invoices set total_amount=44.001 where id=$1', [invoiceIds.forgery]), /two_decimal|two decimal|precision|scale/i);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds.retry, amount: 0.001, idempotencyKey: key(30)}), /two decimal|precision/i);
  await assert.rejects(withOwner(() => assertRejectedInRolledBackTransaction(
    'insert into public.payments(workspace_id,invoice_id,amount) values ($1,$2,0.001)',
    [workspaceA, invoiceIds.retry],
  )), /two_decimal|two decimal|precision|scale/i);
});

test('members cannot reprice or change currency after payment or terminal settlement state', async () => {
  await identity(userA);
  for (const label of ['partial','void','cancelled']) {
    await assert.rejects(db.query('update public.invoices set total_amount=101 where id=$1', [invoiceIds[label]]), /cannot change.*amount|payment.*recorded|terminal/i);
    await assert.rejects(db.query("update public.invoices set currency='USD' where id=$1", [invoiceIds[label]]), /cannot change.*amount|payment.*recorded|terminal/i);
  }
  await assert.rejects(db.query('update public.invoices set total_amount=90 where id=$1', [invoiceIds.mismatch]), /payment history|payment.*recorded|cannot change/i);
  await assert.rejects(db.query("update public.invoices set currency='USD' where id=$1", [invoiceIds.mismatch]), /payment history|payment.*recorded|cannot change/i);
});

test('authenticated invoice deletion is denied and customer deletion cannot cascade away payment history', async () => {
  await identity(userA);
  const settledHistoryBefore = (await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.retry])).rows[0].count;
  assert.ok(settledHistoryBefore > 0);
  await assert.rejects(db.query('delete from public.invoices where id=$1', [invoiceIds.retry]), /permission denied/i);
  assert.equal((await db.query('select count(*)::int as count from public.invoices where id=$1', [invoiceIds.retry])).rows[0].count, 1);
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.retry])).rows[0].count, settledHistoryBefore);
  const before = (await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.mismatch])).rows[0].count;
  assert.equal(before, 1);
  await assert.rejects(db.query('delete from public.customers where id=$1', [customerAId]), /foreign key.*invoices|violates foreign key constraint/i);
  assert.equal((await db.query('select count(*)::int as count from public.payments where invoice_id=$1', [invoiceIds.mismatch])).rows[0].count, before);
});

test('database rejects unsupported currencies on new invoices and settlement while preserving legacy rows', async () => {
  await identity(userA);
  for (const currency of ['JPY', 'KWD', 'BHD', 'ZZZ']) {
    await assert.rejects(db.query(
      `insert into public.invoices(workspace_id,customer_id,invoice_number,currency,total_amount)
       values ($1,$2,$3,$4,10)`,
      [workspaceA, customerAId, `INV-unsupported-${currency}`, currency],
    ), /two-decimal|two decimal|unsupported currency/i);
  }
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds['legacy-yen'], amount: 1, idempotencyKey: key(19)}), /unsupported currency|two-decimal|two decimal|supports only/i);
  await assert.rejects(recordPayment({workspaceId: workspaceA, invoiceId: invoiceIds['legacy-dinar'], amount: 1, idempotencyKey: key(20)}), /unsupported currency|two-decimal|two decimal|supports only/i);
  await assert.rejects(db.query("update public.workspace_settings set default_currency='JPY' where workspace_id=$1", [workspaceA]), /two-decimal|two decimal|unsupported currency/i);
  const legacy = (await db.query('select currency,total_amount from public.invoices where id=$1', [invoiceIds['legacy-yen']])).rows[0];
  assert.equal(legacy.currency, 'JPY');
  assert.equal(legacy.total_amount, '118.25');
  await db.query("update public.invoices set notes='legacy value retained' where id=$1", [invoiceIds['legacy-yen']]);
  await assert.rejects(db.query('update public.invoices set total_amount=119 where id=$1', [invoiceIds['legacy-yen']]), /legacy invoice uses unsupported currency precision/i);
});

test('the paid Assistant invoice RPC creates invoice and payment atomically and idempotently', async () => {
  await identity(userA);
  const metadata = {assistant_idempotency_key: 'assistant_paid_invoice_1048', followup_state: 'draft', next_follow_up_at: null, bookkeeping_sync_status: 'pending'};
  const args = [workspaceA, customerAId, 'INV-assistant-paid', '2026-09-01', '2026-10-01', 'INR', 118, 'Paid at entry', JSON.stringify(metadata), 'assistant_paid_invoice_1048', 'Marked as already paid'];
  const call = () => db.query(`select * from public.create_paid_assistant_invoice($1::uuid,$2::uuid,$3::text,$4::date,$5::date,$6::text,$7::numeric,$8::text,$9::jsonb,$10::text,$11::text)`, args);
  const created = (await call()).rows[0];
  assert.equal(created.invoice_number, 'INV-assistant-paid');
  assert.equal(created.status, 'paid');
  assert.equal(Number(created.amount_paid), 118);
  assert.equal(created.metadata.followup_state, 'cancelled');
  const retry = (await call()).rows[0];
  assert.equal(retry.id, created.id);
  const payment = (await db.query('select amount, idempotency_key, settle_remaining from public.payments where invoice_id=$1', [created.id])).rows;
  assert.equal(payment.length, 1);
  assert.equal(Number(payment[0].amount), 118);
  assert.equal(payment[0].idempotency_key, 'assistant_paid_invoice_1048');
  assert.equal(payment[0].settle_remaining, true);
});

test('paid Assistant invoice RPC rejects excess precision before inserting or settling', async () => {
  await identity(userA);
  const args = [workspaceA, customerAId, 'INV-assistant-excess-precision', '2026-09-01', '2026-10-01', 'INR', 118.257, 'Too precise', JSON.stringify({assistant_idempotency_key: 'assistant_invoice_excess_precision'}), 'assistant_invoice_excess_precision', 'Marked as already paid'];
  await assert.rejects(db.query(
    `select * from public.create_paid_assistant_invoice($1::uuid,$2::uuid,$3::text,$4::date,$5::date,$6::text,$7::numeric,$8::text,$9::jsonb,$10::text,$11::text)`,
    args,
  ), /two decimal|precision/i);
  assert.equal((await db.query("select count(*)::int as count from public.invoices where workspace_id=$1 and invoice_number='INV-assistant-excess-precision'", [workspaceA])).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::int as count from public.payments where workspace_id=$1 and idempotency_key='assistant_invoice_excess_precision'", [workspaceA])).rows[0].count, 0);
});

test('a failed paid Assistant invoice RPC rolls back the inserted invoice', async () => {
  await identity(userA);
  await assert.rejects(db.query(
    `select * from public.create_paid_assistant_invoice($1::uuid,$2::uuid,$3::text,$4::date,$5::date,$6::text,$7::numeric,$8::text,$9::jsonb,$10::text,$11::text)`,
    [workspaceA, customerAId, 'INV-assistant-zero', '2026-09-01', '2026-10-01', 'INR', 0, null, JSON.stringify({assistant_idempotency_key: 'assistant_paid_invoice_zero'}), 'assistant_paid_invoice_zero', 'Marked as already paid'],
  ), /already paid|balance/i);
  assert.equal((await db.query("select count(*)::int as count from public.invoices where workspace_id=$1 and invoice_number='INV-assistant-zero'", [workspaceA])).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::int as count from public.payments where workspace_id=$1 and idempotency_key='assistant_paid_invoice_zero'", [workspaceA])).rows[0].count, 0);
});

test('the paid Assistant invoice RPC repairs the legacy paid-without-history state on retry', async () => {
  await identity(userA);
  const metadata = {assistant_idempotency_key: 'assistant_legacy_repair_1', followup_state: 'draft'};
  const legacy = (await withOwner(() => db.query(
    `insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,amount_paid,status,notes,metadata)
     values ($1,$2,'INV-legacy-paid','2026-09-01','2026-10-01','INR',118,118,'paid','Legacy paid', $3::jsonb) returning id`,
    [workspaceA, customerAId, JSON.stringify(metadata)],
  ))).rows[0];
  const args = [workspaceA, customerAId, 'INV-legacy-paid', '2026-09-01', '2026-10-01', 'INR', 118, 'Legacy paid', JSON.stringify(metadata), 'assistant_legacy_repair_1', 'Marked as already paid'];
  const call = () => db.query(`select * from public.create_paid_assistant_invoice($1::uuid,$2::uuid,$3::text,$4::date,$5::date,$6::text,$7::numeric,$8::text,$9::jsonb,$10::text,$11::text)`, args);
  assert.equal((await call()).rows[0].id, legacy.id);
  assert.equal((await call()).rows[0].id, legacy.id);
  const history = (await db.query('select amount, idempotency_key from public.payments where invoice_id=$1', [legacy.id])).rows;
  assert.equal(history.length, 1);
  assert.equal(Number(history[0].amount), 118);
  assert.equal(history[0].idempotency_key, 'assistant_legacy_repair_1');
});
