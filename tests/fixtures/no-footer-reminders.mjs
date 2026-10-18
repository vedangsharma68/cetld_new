import {readFile} from 'node:fs/promises';

export const noFooterMigration='20261018090021_remove_stop_footer.sql';
export async function applyNoFooterMigration(db,{approve=false,crlf=false}={}){
  if(crlf){
    for(const signature of ['public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)',
      'public.cetld_core_handle_reminder_button(text,text,text,text)']){
      const {rows}=await db.query('select pg_get_functiondef($1::regprocedure) as def',[signature]);
      await db.exec(rows[0].def.replaceAll('\r','').replaceAll('\n','\r\n'));
    }
  }
  await db.exec(await readFile(new URL(`../../supabase/migrations/${noFooterMigration}`,import.meta.url),'utf8'));
  // Offline fixture attestation only. Production rows remain unapproved.
  if(approve)await approveNoFooterFixtures(db);
}
export async function approveNoFooterFixtures(db){
  await db.exec(`update app.first_party_reminder_templates
    set approved=true,approval_reference='TEST ONLY: simulated operator Meta approval',approved_at=clock_timestamp()
    where waba_id='1734116767674237' and language='en' and revision='approved-20261018-nf' and not approved`);
}
