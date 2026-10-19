-- Function-only forward change. No invoice is touched until a future rename.
begin;

create or replace function public.business_name_change_impact(p_workspace_id uuid,p_business_name text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.workspace_settings%rowtype; n integer:=0;
begin
  select * into s from public.workspace_settings where workspace_id=p_workspace_id;
  if not found then raise exception 'Workspace settings unavailable' using errcode='42501'; end if;
  if btrim(p_business_name) is distinct from s.business_name then
    select count(*) into n from public.invoices where workspace_id=p_workspace_id
      and deleted_at is null and status='sent' and nullif(btrim(metadata->>'approved_reminder_text'),'') is not null;
  end if;
  return jsonb_build_object('pausedReminderCount',n,'updatedAt',s.updated_at);
end $$;
revoke all on function public.business_name_change_impact(uuid,text) from public,anon;
grant execute on function public.business_name_change_impact(uuid,text) to authenticated,service_role;

create or replace function app.invalidate_core_followup_approvals()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.business_name is distinct from old.business_name then
    -- The same set counted in the owner warning, including already-stale approvals.
    -- Draft is the existing owner-review state; no approval or schedule is created.
    update public.invoices set metadata=metadata||jsonb_build_object('followup_state','draft','next_follow_up_at',null,
        'approved_reminder_text',null,'approved_preferences_updated_at',null,
        'followup_review_reason','business_name_change',
        'followup_review_notice','Needs re-approval after business name change',
        'followup_review_settings_updated_at',new.updated_at)
      where workspace_id=new.workspace_id and deleted_at is null and status='sent'
        and nullif(btrim(metadata->>'approved_reminder_text'),'') is not null;
  end if;
  -- Retain existing invalidation behavior for all other settings/active invoices.
  if new.follow_up_preferences is distinct from old.follow_up_preferences
    or new.default_timezone is distinct from old.default_timezone
    or new.business_name is distinct from old.business_name then
    update public.invoices set metadata=metadata||jsonb_build_object('followup_state','paused',
      'next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null)
      where workspace_id=new.workspace_id and deleted_at is null and followup_state in ('approved','active','scheduled');
  end if;
  return new;
end $$;

-- Dashboard rename: lock the settings version before counting and invalidating.
-- SECURITY INVOKER preserves the existing workspace RLS for reads and writes.
create or replace function public.save_business_name_change(
  p_workspace_id uuid,p_expected_updated_at timestamptz,p_business_name text,
  p_default_currency text,p_default_timezone text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare s public.workspace_settings%rowtype; impact jsonb;
begin
  select * into s from public.workspace_settings where workspace_id=p_workspace_id for update;
  if not found then raise exception 'Workspace settings unavailable' using errcode='42501'; end if;
  if s.updated_at is distinct from p_expected_updated_at then
    raise exception 'Settings changed. Refresh and confirm the business name again.' using errcode='40001';
  end if;
  impact:=public.business_name_change_impact(p_workspace_id,p_business_name);
  update public.workspace_settings set business_name=p_business_name,default_currency=p_default_currency,
    default_timezone=p_default_timezone where workspace_id=p_workspace_id returning * into s;
  if not found then raise exception 'Workspace settings unavailable' using errcode='42501'; end if;
  return jsonb_build_object('settings',to_jsonb(s),'pausedReminderCount',impact->'pausedReminderCount');
end $$;
revoke all on function public.save_business_name_change(uuid,timestamptz,text,text,text) from public,anon;
grant execute on function public.save_business_name_change(uuid,timestamptz,text,text,text) to authenticated;

-- Patch the installed confirmation coordinator without copying its unrelated
-- invoice creation/payment guards. CREATE OR REPLACE preserves its existing ACL.
do $migration$
declare signature regprocedure:='public.whatsapp_confirm_owner_create_settings(uuid,uuid,text,bigint,bigint,text)'::regprocedure;
  definition text; marker text; replacement text;
begin
  select pg_get_functiondef(signature) into definition;
  if position('v_business_name_paused_reminder_count' in definition)>0 then return; end if;
  marker:=E'  v_changed jsonb := ''[]''::jsonb;';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
    raise exception 'Unexpected installed settings declaration'; end if;
  definition:=replace(definition,marker,marker||E'\n  v_business_name_paused_reminder_count integer := 0;');
  marker:=E'    v_preferences := v_settings.follow_up_preferences || v_patch;';
  replacement:=E'    v_business_name_paused_reminder_count := case when v_business_name is null then 0 else\n      (public.business_name_change_impact(p_workspace_id,v_business_name)->>''pausedReminderCount'')::integer end;\n';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
    raise exception 'Unexpected installed settings update'; end if;
  definition:=replace(definition,marker,replacement||marker);
  marker:=E'''businessName'',v_settings.business_name,''changed'',v_changed);';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
    raise exception 'Unexpected installed settings receipt'; end if;
  definition:=replace(definition,marker,E'''businessName'',v_settings.business_name,''changed'',v_changed,\n      ''pausedReminderCount'',v_business_name_paused_reminder_count);');
  execute definition;
end $migration$;
commit;
