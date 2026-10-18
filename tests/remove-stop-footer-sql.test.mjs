import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {applyNoFooterMigration,approveNoFooterFixtures} from './fixtures/no-footer-reminders.mjs';
import {REMINDER_TEMPLATE_REPLACEMENTS,REMINDER_TEMPLATES,selectInvoiceReminderTemplate} from '../automation/whatsapp/reminder-templates.mjs';

async function setup(){
  const f=await createOfflineSqlNetwork();
  try{
    for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])
      await f.db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    return f;
  }catch(error){await f.close();throw error;}
}

test('CRLF upgrade seeds pending no-footer versions, preserves predecessors and requires one operator attestation',async()=>{
  const f=await setup();try{
    await applyNoFooterMigration(f.db,{crlf:true});
    for(const [oldName,name] of Object.entries(REMINDER_TEMPLATE_REPLACEMENTS)){
      const {rows}=await f.db.query('select * from app.first_party_reminder_templates where name in ($1,$2) order by revision',[oldName,name]);
      assert.equal(rows.length,2);
      const previous=rows.find(r=>r.name===oldName),current=rows.find(r=>r.name===name);
      const entry=REMINDER_TEMPLATES.find(t=>t.name===name);
      assert.equal(current.revision,'approved-20261018-nf');assert.equal(current.approved,false);
      assert.equal(current.approval_reference,null);assert.equal(current.approved_at,null);assert.equal(previous.approved,true);
      for(const field of ['body','category','parameter_count','tone','button_variant'])assert.equal(current[field],previous[field],field);
      assert.equal(current.body,entry.body);assert.doesNotMatch(current.body,/Reply STOP|opt.out/i);
      assert.equal(selectInvoiceReminderTemplate({templateName:oldName}),entry);
      assert.equal(selectInvoiceReminderTemplate({templateName:name}),entry);
    }
    const name=REMINDER_TEMPLATE_REPLACEMENTS.cetld_invoice_update_v2;
    for(const change of ["approved=true","approved=true,approval_reference='   ',approved_at=now()",
      "approved=true,approval_reference='TEST ONLY',approved_at=now(),body='changed'"])
      await assert.rejects(f.db.query(`update app.first_party_reminder_templates set ${change} where name=$1`,[name]),/immutable/);
    await approveNoFooterFixtures(f.db);
    assert.equal((await f.db.query("select count(*)::int n from app.first_party_reminder_templates where revision='approved-20261018-nf' and approved")).rows[0].n,4);
    await assert.rejects(f.db.query("update app.first_party_reminder_templates set body='' where name=$1",[name]),/immutable/);
    await f.db.query('update app.first_party_reminder_templates set approved=false where name=$1',[name]);
    await assert.rejects(f.db.query('update app.first_party_reminder_templates set approved=true where name=$1',[name]),/immutable/);
    await f.db.exec('set role service_role');
    await assert.rejects(f.db.query('select * from app.first_party_reminder_templates'),/permission denied/);
    await f.db.exec('reset role');
  }finally{await f.close();}
});

for(const [signature,point,expected] of [
  ['public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)',"then t.name is distinct from s.follow_up_preferences->>'templateName'",'template selection'],
  ['public.cetld_core_handle_reminder_button(text,text,text,text)',"('cetld_invoice_update_btn_v2','cetld_invoice_gentle_btn_v1')",'button reply'],
])test(`missing ${expected} patch point aborts and rolls back the entire migration`,async()=>{
  const f=await setup();try{
    const {rows}=await f.db.query('select pg_get_functiondef($1::regprocedure) as def',[signature]);
    assert.ok(rows[0].def.includes(point));
    await f.db.exec(rows[0].def.replace(point,point.includes('cetld_invoice_update_btn_v2')?point.replace('cetld_invoice_update_btn_v2','cetld_invoice_update_btn_v999'):point.replaceAll(' ', '  ')));
    await assert.rejects(applyNoFooterMigration(f.db),new RegExp(`No-footer ${expected} patch point missing`));
    await f.db.exec('rollback');
    assert.equal((await f.db.query("select count(*)::int n from app.first_party_reminder_templates where revision='approved-20261018-nf'")).rows[0].n,0);
    const guard=(await f.db.query("select pg_get_functiondef('app.first_party_template_revision_guard()'::regprocedure) def")).rows[0].def;
    assert.doesNotMatch(guard,/pending no-footer approval/);
  }finally{await f.close();}
});
