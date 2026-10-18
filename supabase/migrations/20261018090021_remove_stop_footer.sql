-- Forward-only no-footer catalog swap. No sends, consent, schedules or flags change.
-- Meta approval is NOT yet confirmed: all four rows are deliberately pending.
-- After verifying each exact template is Meta APPROVED (Utility/en, same BODY,
-- same buttons, NO FOOTER), the operator may attest that row's approval with:
-- UPDATE app.first_party_reminder_templates
-- SET approved=true, approval_reference='<operator + Meta approval evidence>',
--     approved_at=clock_timestamp()
-- WHERE waba_id='1734116767674237' AND language='en'
--   AND revision='approved-20261018-nf' AND name='<verified template name>';
-- Never attest before Meta approval. The existing atomic sender gate requires approved=true.
begin;

insert into app.first_party_reminder_templates
  (waba_id,name,language,revision,body,approved,approval_reference,approved_at,category,parameter_count,button_variant,tone)
values
('1734116767674237','cetld_invoice_update_v3','en','approved-20261018-nf','Hi, this is {{1}}. Invoice {{2}} for {{3}} has an update.',false,null,null,'UTILITY',3,false,'professional'),
('1734116767674237','cetld_invoice_update_btn_v3','en','approved-20261018-nf','Hi, this is {{1}}. Invoice {{2}} for {{3}} has an update.',false,null,null,'UTILITY',3,true,'professional'),
('1734116767674237','cetld_invoice_gentle_v2','en','approved-20261018-nf','Hi, this is {{1}}. A quick note about invoice {{2}} for {{3}}. Questions? Just reply here.',false,null,null,'UTILITY',3,false,'gentle'),
('1734116767674237','cetld_invoice_gentle_btn_v2','en','approved-20261018-nf','Hi, this is {{1}}. A quick note about invoice {{2}} for {{3}}. Questions? Just reply here.',false,null,null,'UTILITY',3,true,'gentle');

-- Pending no-footer rows need one operator attestation. Content remains immutable,
-- historical revisions retain their guard, and revoked approvals cannot be rearmed.
-- Existing table privileges still restrict these writes to the database operator.
create or replace function app.first_party_template_revision_guard() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and not old.approved and new.approved
    and old.waba_id='1734116767674237' and old.language='en'
    and old.revision='approved-20261018-nf'
    and old.name in ('cetld_invoice_update_v3','cetld_invoice_update_btn_v3','cetld_invoice_gentle_v2','cetld_invoice_gentle_btn_v2')
    and old.approval_reference is null and old.approved_at is null
    and nullif(btrim(new.approval_reference),'') is not null and new.approved_at is not null
    and (to_jsonb(new)-array['approved','approval_reference','approved_at'])
      is not distinct from (to_jsonb(old)-array['approved','approval_reference','approved_at']) then
    return new;
  end if;
  if tg_op='DELETE' or (to_jsonb(new)-'approved') is distinct from (to_jsonb(old)-'approved')
    or (not old.approved and new.approved) then
    raise exception 'Template approval revisions are immutable; pending no-footer approval requires operator evidence and approved_at' using errcode='42501';
  end if;
  return new;
end $$;

do $upgrade$
declare def text;patch_point text;
begin
  -- Normalize FIRST: production prosrc may contain CRLF line endings.
  def:=pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure);
  def:=replace(def,chr(13),'');
  patch_point:=$old$then t.name is distinct from s.follow_up_preferences->>'templateName'$old$;
  if position(patch_point in def)=0 then raise exception 'No-footer template selection patch point missing';end if;
  -- Preserve exact old selections during rollout; accept the replacement too.
  def:=replace(def,patch_point,$new$then (t.name is distinct from s.follow_up_preferences->>'templateName'
        and t.name is distinct from case s.follow_up_preferences->>'templateName'
          when 'cetld_invoice_update_v2' then 'cetld_invoice_update_v3'
          when 'cetld_invoice_update_btn_v2' then 'cetld_invoice_update_btn_v3'
          when 'cetld_invoice_gentle_v1' then 'cetld_invoice_gentle_v2'
          when 'cetld_invoice_gentle_btn_v1' then 'cetld_invoice_gentle_btn_v2'
          else s.follow_up_preferences->>'templateName' end)$new$);
  execute def;

  def:=pg_get_functiondef('public.cetld_core_handle_reminder_button(text,text,text,text)'::regprocedure);
  def:=replace(def,chr(13),'');
  patch_point:=$old$('cetld_invoice_update_btn_v2','cetld_invoice_gentle_btn_v1')$old$;
  if position(patch_point in def)=0 then raise exception 'No-footer button reply patch point missing';end if;
  def:=replace(def,patch_point,$new$('cetld_invoice_update_btn_v2','cetld_invoice_gentle_btn_v1',
      'cetld_invoice_update_btn_v3','cetld_invoice_gentle_btn_v2')$new$);
  execute def;
end $upgrade$;
commit;
