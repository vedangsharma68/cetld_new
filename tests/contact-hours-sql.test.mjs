import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createOfflineSqlNetwork} from './fixtures/offline-sql-network.mjs';
import {normalizeFollowUpPreferences} from '../automation/preferences.mjs';
import {isWithinContactHours,nextContactTime} from '../automation/cadence.mjs';
import {mergeFollowUpPreferences,readFollowUpPreferences} from '../followup-preferences-ui.mjs';

const migration='20261018085949_owner_controlled_contact_hours.sql';
const sqlFile=name=>readFile(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const zone='Asia/Kolkata';
const at=(time,date='2026-10-18')=>new Date(`${date}T${time}:00+05:30`);
const signatures=['app.core_next_contact(timestamp with time zone,jsonb,text)','app.sync_core_followup_invoice()',
  'app.guard_messaging_settings()','public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamp with time zone)'];
const definition=async(db,sig)=>(await db.query('select pg_get_functiondef($1::regprocedure) as def',[sig])).rows[0].def;

function uiSavedPreferences(){
  const Original=globalThis.FormData;
  const data={tone:'professional',firstReminderDays:'3',cadenceDays:'3',maxReminders:'3',contactStart:'10:15',contactEnd:'16:45',escalation:'manual_review',weekday:['0','3']};
  globalThis.FormData=class {get(key){return data[key]??null;}getAll(key){return data[key]??[];}has(key){return key in data;}};
  try{return mergeFollowUpPreferences({weekdays:[1],start_local:'09:00',end_local:'18:00'},readFollowUpPreferences({}));}
  finally{globalThis.FormData=Original;}
}

for(const modern of [false,true])test(`SQL contact migration: ${modern?'current first-party gate with CRLF':'legacy inline gate with LF'}`,async t=>{
  // This test intentionally constructs pre-contact-hours LF/CRLF predecessors;
  // the later exact-source containment migration is tested on current sources.
  const f=await createOfflineSqlNetwork({excludeMigrations:[migration,'20261026090000_contain_unproven_external_reminders.sql']});
  try{
    const {db}=f;
    if(modern)for(const file of ['20261018060000_customer_reminder_tone.sql','20261005070000_approved_whatsapp_reminders.sql','20261018060100_invoice_details_templates.sql'])await db.exec(await sqlFile(file));
    const owner=randomUUID();await db.query('insert into auth.users(id) values($1)',[owner]);
    await db.exec(`set request.jwt.claim.role='authenticated';set request.jwt.claim.sub='${owner}';set role authenticated`);
    const workspace=(await db.query('select (public.create_workspace($1,$2)).id',['Fixture studio',randomUUID()])).rows[0].id;
    await db.exec('reset role');
    const explicit={weekdays:[1],hoursStart:'09:17',hoursEnd:'18:42'};
    await db.query('update workspace_settings set follow_up_preferences=$2 where workspace_id=$1',[workspace,JSON.stringify(explicit)]);
    const migrationSql=await sqlFile(migration);
    const original=await definition(db,signatures[0]);
    await db.exec(original.replace("'09:00'","'09:01'"));
    await assert.rejects(db.exec(migrationSql),/Contact window patch point missing/);
    await db.exec('rollback');
    assert.equal((await db.query("select to_regprocedure('app.core_contact_preferences(jsonb)') as fn")).rows[0].fn,null,'failed migration rolls back its helper');
    await db.exec(original);
    if(modern)for(const sig of signatures)await db.exec((await definition(db,sig)).replace(/\n/g,'\r\n'));
    const approvedSig='public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)';
    const approvedBefore=modern?await definition(db,approvedSig):null;
    await db.exec(migrationSql);
    if(modern)assert.equal(await definition(db,approvedSig),approvedBefore,'first-party approval/ART gate is unchanged');
    assert.deepEqual((await db.query('select follow_up_preferences as p from workspace_settings where workspace_id=$1',[workspace])).rows[0].p,explicit,'existing explicit JSON is unchanged');
    assert.match(await definition(db,signatures[3]),/app.core_next_contact\(/);

    async function parity(raw,times,date='2026-10-18'){
      const p=normalizeFollowUpPreferences(raw,zone);
      for(const time of times){
        const now=at(time,date),expected=nextContactTime(now,p,zone);
        const row=(await db.query('select app.core_next_contact($1::timestamptz,$2::jsonb,$3) as next_at',[now.toISOString(),raw===undefined?null:JSON.stringify(raw),zone])).rows[0];
        assert.equal(row.next_at.toISOString(),expected.toISOString(),`${JSON.stringify(raw)} ${date} ${time}: JS/SQL next instant`);
        assert.equal(row.next_at.getTime()===now.getTime(),isWithinContactHours(now,p,zone));
      }
    }
    await t.test('proof: Sunday 12:00 default passes SQL; explicit weekdays [1] blocks',async()=>{
      for(const raw of [undefined,{},null])await parity(raw,['07:59','08:00','12:00','20:59','21:00']);
      await parity({weekdays:[1]},['12:00']);
      assert.equal((await db.query("select app.core_next_contact($1,'{}',null)=$1::timestamptz as passes",[at('12:00').toISOString()])).rows[0].passes,true);
    });
    await t.test('UI save and JS normalized shape gate SQL identically at all boundaries and on excluded days',async()=>{
      const saved=uiSavedPreferences();
      assert.deepEqual(saved.allowedWeekdays,[0,3]);assert.equal('weekdays' in saved,false);
      for(const raw of [saved,normalizeFollowUpPreferences(saved)]){
        await parity(raw,['10:14','10:15','16:44','16:45']);
        await parity(raw,['12:00'],'2026-10-19');
      }
    });
    await t.test('all legacy aliases and canonical precedence agree in both readers',async()=>{
      for(const dayKey of ['allowedWeekdays','weekdays'])for(const [start,end] of [['contactStart','contactEnd'],['hoursStart','hoursEnd'],['start_local','end_local']])
        await parity({[dayKey]:[0,3],[start]:'10:15',[end]:'16:45'},['10:14','10:15','16:44','16:45']);
      await parity({allowedWeekdays:[1],weekdays:[0],contactStart:'09:00',hoursStart:'10:00',start_local:'11:00',contactEnd:'18:00',hoursEnd:'19:00',end_local:'20:00'},['12:00']);
      await parity({allowedWeekdays:null,weekdays:[0],contactStart:null,hoursStart:'10:15',contactEnd:null,hoursEnd:'16:45'},['10:14','10:15','16:44','16:45']);
      await parity({allowedWeekdays:[0,1,2,3,4,5,6],contactStart:'00:00',contactEnd:'23:59'},['00:00','23:58','23:59']);
    });
    await t.test('existing explicit days and hours remain unchanged; settings validator accepts aliases and rejects overnight',async()=>{
      await parity(explicit,['09:16','09:17','18:41','18:42'],'2026-10-19');
      await parity({allowedWeekdays:[1,2,3,4,5],contactStart:'09:00',contactEnd:'18:00'},['08:59','09:00','17:59','18:00'],'2026-10-19');
      for(const raw of [explicit,{weekdays:[0],start_local:'00:00',end_local:'23:59'}])
        await db.query('update workspace_settings set follow_up_preferences=$2 where workspace_id=$1',[workspace,JSON.stringify(raw)]);
      for(const raw of [{weekdays:[]},{weekdays:[7]},{hoursStart:'20:00',hoursEnd:'02:00'},{start_local:'24:00',end_local:'23:59'}])
        await assert.rejects(db.query('update workspace_settings set follow_up_preferences=$2 where workspace_id=$1',[workspace,JSON.stringify(raw)]),/Invalid allowed weekdays|Overnight windows/);
    });
  }finally{await f.close();}
});
