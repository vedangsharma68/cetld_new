import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('neutral invoice claim is atomic and refuses stale, suppressed, or unconsented sends', async () => {
  const db = new PGlite();
  const ws = '11111111-1111-4111-8111-111111111111';
  const customer = '22222222-2222-4222-8222-222222222222';
  const invoice = '33333333-3333-4333-8333-333333333333';
  const phone = '+919871367051';
  const at = '2026-09-27T12:00:00Z';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.workspaces(id uuid primary key);
      create table public.customers(workspace_id uuid not null, id uuid not null, phone text, unique(workspace_id,id));
      create table public.invoices(workspace_id uuid not null, id uuid not null, customer_id uuid not null,
        invoice_number text, status text, updated_at timestamptz, unique(workspace_id,id));
      create table public.workspace_settings(workspace_id uuid, whatsapp_owner_attested_at timestamptz);
      create table public.whatsapp_consents(workspace_id uuid, customer_id uuid, phone text,
        revoked_at timestamptz, source text, categories text[]);
      create table public.whatsapp_suppressions(workspace_id uuid, phone text);
      create table public.whatsapp_global_suppressions(phone text);
    `);
    const sql = await readFile(new URL('../supabase/migrations/20260927120000_whatsapp_invoice_update_claims.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.query('insert into public.workspaces(id) values ($1)', [ws]);
    await db.query('insert into public.customers(workspace_id,id,phone) values ($1,$2,$3)', [ws,customer,phone]);
    await db.query('insert into public.invoices(workspace_id,id,customer_id,invoice_number,status,updated_at) values ($1,$2,$3,$4,$5,$6)', [ws,invoice,customer,'INV-1','sent',at]);
    await db.query('insert into public.workspace_settings(workspace_id,whatsapp_owner_attested_at) values ($1,$2)', [ws,at]);
    await db.query("insert into public.whatsapp_consents(workspace_id,customer_id,phone,source,categories) values ($1,$2,$3,'verbal',array['invoice_updates'])", [ws,customer,phone]);
    await db.exec('set role service_role');
    const claim = async key => (await db.query('select public.whatsapp_claim_invoice_update($1,$2,$3,$4,$5,$6) as claimed',
      [ws,invoice,customer,phone,key,at])).rows[0].claimed;
    assert.equal(await claim('invoice-update-1'), true);
    assert.equal(await claim('invoice-update-1'), false);
    await db.exec('reset role');
    await db.query('insert into public.whatsapp_suppressions(workspace_id,phone) values ($1,$2)', [ws,phone]);
    await db.exec('set role service_role');
    assert.equal(await claim('invoice-update-2'), false);
    await db.exec('reset role');
    await db.query('delete from public.whatsapp_suppressions where workspace_id=$1 and phone=$2', [ws,phone]);
    await db.query("update public.invoices set updated_at='2026-09-27T12:01:00Z' where id=$1", [invoice]);
    await db.exec('set role service_role');
    assert.equal(await claim('invoice-update-3'), false);
  } finally { await db.close(); }
});
