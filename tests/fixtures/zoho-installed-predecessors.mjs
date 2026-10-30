import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const legacyBlock=`    if not app.legacy_reminder_approval_matches(p_owner_id,i) then
      update public.invoices set followup_state='paused',next_follow_up_at=null,
        metadata=metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,'reminder_review_reason','delivery_form_review')
        where workspace_id=p_workspace_id and id=i.id;
      return '{"authorized":false,"reason":"needs_re_review"}';
    end if;
`;
export const safeCadence="and not (coalesce(i.metadata#>>'{approved_reminder_delivery,version}','')='2' and coalesce(i.metadata#>>'{approved_reminder_delivery,mode}','')='immediate')";
export const oldCadence="and not (i.metadata#>>'{approved_reminder_delivery,version}'='2' and i.metadata#>>'{approved_reminder_delivery,mode}'='immediate')";
export const installedShapes=[
 ['public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)','a9cb55e078ac3203d20bc375f6b5cc7859709fefc417cef06699d824fc37d84f',0],
 ['public.cetld_core_record_first_party_receipt(text,text,text,text,text,text)','add70c665905608618618b6156b7c849ec5b49ea59790b8f30da108c606cfb42',68],
 ['app.reminder_canonical_json(jsonb)','51b89ca99fca774daa6077454b735c3059636e4c23d77878115198ae574b5f66',5],
 ['public.cetld_core_check_local_reminder_payment(uuid,uuid,uuid)','5bfeccccb370e82543aba56fcd241ead4f8fbc29739569bdd32848acc92f9178',23],
 ['app.first_party_receipt_audit_guard()','ca43f160c886182e72350fcde7ced8551c59b2030cabf75147e5983f5bd01658',1],
 ['app.first_party_consent_phone_lock()','2a0b2fcd396d8e1ce63be7118af5dc60a94269f1a50ae89c5afaa4876e44c1d1',8],
 ['app.cancel_first_party_phone(text,uuid)','265269a0711b3a5dfc72636455f330a9da199823251d1d4075f308dcf48d4dff',17],
 ['app.first_party_suppression_hook()','fc1a836b55819bdc964c200cfd92eab098b364af633725dd5d2eaa8a166d03f9',4],
];
export async function definition(db,signature){return (await db.query('select oid,pg_get_functiondef(oid) d,prosrc,to_jsonb(p)-\'prosrc\' security from pg_proc p where oid=$1::regprocedure',[signature])).rows[0];}
export async function installObservedPredecessors(db){
 await db.exec('set search_path=pg_catalog,public');
 for(const [signature,hash,cr] of installedShapes){
  const p=await definition(db,signature);let body=p.prosrc;
  if(signature.includes('authorize_first_party')){assert.equal(body.split(legacyBlock).length,2);body=body.replace(legacyBlock,'');}
  if(signature.includes('record_first_party_receipt')){assert.equal(body.split(safeCadence).length,2);body=body.replace(safeCadence,oldCadence);}
  if(cr)body=body.replaceAll('\n','\r\n');
  // The review migration inserted exactly two LF lines into the existing
  // 68-CRLF receipt body. Reproduce those exact historical insertion points.
  if(signature.includes('record_first_party_receipt'))body=body.replace('\r\n      if i.metadata#>>', '\n      if i.metadata#>>').replace('\r\n        and not (i.metadata#>>', '\n        and not (i.metadata#>>');
  await db.exec(p.d.replace(p.prosrc,()=>body));
  const actual=await definition(db,signature);
  assert.equal(createHash('sha256').update(actual.d).digest('hex'),hash,signature+' exact independently observed source');
  assert.equal(actual.prosrc.split('\r\n').length-1,cr);
 }
 await db.exec('drop function app.legacy_reminder_approval_matches(uuid,public.invoices)');
 assert.equal((await db.query("select to_regprocedure('app.legacy_reminder_approval_matches(uuid,public.invoices)') value")).rows[0].value,null);
}
