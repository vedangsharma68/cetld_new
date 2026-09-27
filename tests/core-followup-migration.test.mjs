import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), workspace = id(2), customer = id(3);
const migration = new URL('../supabase/migrations/20260927140000_core_followup_pipeline.sql', import.meta.url);

async function one(db, sql) { return (await db.query(sql)).rows[0]; }
async function claim(db, invoiceId) {
  return one(db, `select * from public.cetld_core_claim_due_followups('${owner}','${workspace}',now(),25,'${invoiceId}')`);
}
async function authorize(db, claimId) {
  return one(db, `select * from public.cetld_core_authorize_delivery('${claimId}','${owner}','${workspace}')`);
}

test('current-schema migration enforces invoice and owner preference gates in Postgres', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema app; create schema auth;
      create table auth.users(id uuid primary key);
      create table public.workspaces(id uuid primary key,owner_id uuid not null);
      create table public.workspace_settings(
        workspace_id uuid primary key references public.workspaces(id),
        default_timezone text not null default 'UTC',
        follow_up_preferences jsonb not null default '{}'::jsonb,
        updated_at timestamptz not null default now());
      create table public.customers(id uuid primary key,workspace_id uuid not null references public.workspaces(id),phone text);
      create table public.invoices(
        id uuid primary key,workspace_id uuid not null references public.workspaces(id),
        customer_id uuid not null references public.customers(id),
        invoice_number text not null,issue_date date not null,due_date date,
        total_amount numeric(18,2) not null,amount_paid numeric(18,2) not null default 0,
        status text not null default 'draft',metadata jsonb not null default '{}'::jsonb);
      insert into auth.users values ('${owner}');
      insert into public.workspaces values ('${workspace}','${owner}');
      insert into public.workspace_settings(workspace_id,follow_up_preferences)
        values ('${workspace}','{"firstReminderDays":0,"allowedWeekdays":[0,1,2,3,4,5,6],"contactStart":"00:00","contactEnd":"23:59","maxReminders":2}'::jsonb);
      insert into public.customers values ('${customer}','${workspace}','+919876543210');
    `);
    await db.exec(await readFile(migration, 'utf8'));

    // Approval written by the current UI through metadata must mirror into the
    // indexed server column and schedule using owner settings.
    await db.query(`insert into public.invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,metadata)
      values ('${id(10)}','${workspace}','${customer}','INV-R',current_date-10,current_date-5,100,
        '{"invoice_direction":"receivable","followup_state":"draft","approved_reminder_text":"Please pay INV-R."}'::jsonb)`);
    await db.query(`update public.invoices set metadata=jsonb_set(jsonb_set(metadata,'{followup_state}','"approved"'::jsonb),'{approved_preferences_updated_at}',to_jsonb((select updated_at from public.workspace_settings where workspace_id='${workspace}')))
      where id='${id(10)}'`);
    const approved = await one(db, `select followup_state,next_follow_up_at,metadata,automation_version from public.invoices where id='${id(10)}'`);
    assert.equal(approved.followup_state, 'approved');
    assert.ok(approved.next_follow_up_at);
    assert.equal(approved.metadata.followup_state, 'approved');
    assert.ok(approved.automation_version > 0);

    // A due, approved payable or old unknown invoice cannot acquire a claim.
    for (const [n, direction] of [[11, 'payable'], [12, null]]) {
      const directionJson = direction ? `,"invoice_direction":"${direction}"` : '';
      await db.query(`insert into public.invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,metadata)
        values ('${id(n)}','${workspace}','${customer}','INV-${n}',current_date-10,current_date-5,100,
          '{"followup_state":"approved","next_follow_up_at":"2026-01-01T09:00:00Z"${directionJson}}'::jsonb)`);
      assert.equal(await claim(db, id(n)), undefined);
    }

    await db.query(`update public.invoices set next_follow_up_at=now()-interval '1 minute' where id='${id(10)}'`);
    const dueRow = await one(db, `select followup_state,next_follow_up_at,metadata,automation_version from public.invoices where id='${id(10)}'`);
    assert.ok(new Date(dueRow.next_follow_up_at) <= new Date(), JSON.stringify(dueRow));
    const stale = await claim(db, id(10));
    assert.ok(stale?.claim_id, JSON.stringify({dueRow,dbNow:await one(db,'select now() as now'),eligible:(await db.query(`select i.id,i.status,i.due_date,i.amount_paid,i.total_amount,i.followup_state,i.next_follow_up_at from public.invoices i where i.id='${id(10)}' and i.next_follow_up_at<=now() and i.metadata->>'invoice_direction'='receivable'`)).rows,claims:(await db.query('select * from public.cetld_core_automation_delivery_claims')).rows}));
    await db.query(`update public.workspace_settings set follow_up_preferences=follow_up_preferences||'{"tone":"firm"}'::jsonb,
      updated_at=now()+interval '1 second' where workspace_id='${workspace}'`);
    const staleAuth = await authorize(db, stale.claim_id);
    assert.equal(staleAuth.authorized, false);
    assert.equal(staleAuth.reason, 'stale_claim');
    assert.equal((await one(db, `select * from public.cetld_core_mark_failed('${stale.claim_id}','${owner}','${workspace}',null,'preferences_changed',false)`)).ok, true);

    // Paid and paused changes after a claim invalidate final authorization.
    for (const [n, change] of [[13, 'amount_paid=total_amount'], [14, "metadata=jsonb_set(metadata,'{followup_state}','\"paused\"'::jsonb)"]]) {
      await db.query(`insert into public.invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,metadata)
        values ('${id(n)}','${workspace}','${customer}','INV-${n}',current_date-10,current_date-5,100,
          '{"invoice_direction":"receivable","followup_state":"approved","approved_reminder_text":"Please pay this invoice.","next_follow_up_at":"2026-01-01T09:00:00Z"}'::jsonb)`);
      await db.query(`update public.invoices set metadata=jsonb_set(metadata,'{approved_preferences_updated_at}',to_jsonb((select updated_at from public.workspace_settings where workspace_id='${workspace}'))) where id='${id(n)}'`);
      const pending = await claim(db, id(n));
      assert.ok(pending?.claim_id);
      await db.query(`update public.invoices set ${change} where id='${id(n)}'`);
      assert.equal((await authorize(db, pending.claim_id)).authorized, false);
    }

    // An eligible invoice with a matching approval snapshot is authorized in
    // the allowed owner window; recording the receipt never calls a provider.
    await db.query(`insert into public.invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,total_amount,metadata)
      values ('${id(15)}','${workspace}','${customer}','INV-15',current_date-10,current_date-5,100,
        '{"invoice_direction":"receivable","followup_state":"approved","approved_reminder_text":"Please pay INV-15.","next_follow_up_at":"2026-01-01T09:00:00Z"}'::jsonb)`);
    await db.query(`update public.invoices set metadata=jsonb_set(metadata,'{approved_preferences_updated_at}',to_jsonb((select updated_at from public.workspace_settings where workspace_id='${workspace}'))) where id='${id(15)}'`);
    const sendable = await claim(db, id(15));
    assert.ok(sendable?.claim_id);
    const allowed = await authorize(db, sendable.claim_id);
    assert.equal(allowed.authorized, true);
    assert.ok(allowed.token);
    assert.equal((await one(db,`select * from public.cetld_core_mark_sent('${sendable.claim_id}','${owner}','${workspace}','${allowed.token}','mock-receipt')`)).ok,true);

    // The database checks the live owner contact window immediately before send.
    await db.query(`update public.workspace_settings set follow_up_preferences=follow_up_preferences||'{"contactStart":"23:58","contactEnd":"23:59"}'::jsonb,
      updated_at=now()+interval '2 seconds' where workspace_id='${workspace}'`);
    assert.equal((await one(db,`select followup_state from public.invoices where id='${id(10)}'`)).followup_state,'draft');
    await db.query(`update public.invoices set metadata=jsonb_set(jsonb_set(jsonb_set(metadata,'{followup_state}','"approved"'::jsonb),'{approved_reminder_text}','"Please pay INV-R."'::jsonb),'{approved_preferences_updated_at}',to_jsonb((select updated_at from public.workspace_settings where workspace_id='${workspace}'))),
      next_follow_up_at=now()-interval '1 minute' where id='${id(10)}'`);
    const blocked = await claim(db, id(10));
    assert.ok(blocked?.claim_id, JSON.stringify({row:await one(db,`select followup_state,next_follow_up_at,metadata,automation_version from public.invoices where id='${id(10)}'`),prefs:await one(db,`select updated_at from public.workspace_settings where workspace_id='${workspace}'`),claims:(await db.query('select status,attempts,scheduled_for from public.cetld_core_automation_delivery_claims')).rows}));
    const windowAuth = await authorize(db, blocked.claim_id);
    assert.equal(windowAuth.authorized, false);
    assert.equal(windowAuth.reason, 'contact_hours');
  } finally { await db.close(); }
});
