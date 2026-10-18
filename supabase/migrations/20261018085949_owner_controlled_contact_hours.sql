-- Forward-only: retain saved preferences and unify all contact-hours readers.
begin;

-- Canonical precedence matches normalizeFollowUpPreferences in JS. JSON null,
-- like an absent key, falls through to the next alias or the default.
create function app.core_contact_preferences(p jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare days jsonb; start_local text; end_local text;
begin
  days:=coalesce(nullif(p->'allowedWeekdays','null'::jsonb),nullif(p->'weekdays','null'::jsonb),'[0,1,2,3,4,5,6]'::jsonb);
  start_local:=coalesce(p->>'contactStart',p->>'hoursStart',p->>'start_local','08:00');
  end_local:=coalesce(p->>'contactEnd',p->>'hoursEnd',p->>'end_local','21:00');
  if jsonb_typeof(days)<>'array' then raise exception 'Invalid allowed weekdays'; end if;
  if jsonb_array_length(days)<1 or exists(
    select 1 from jsonb_array_elements(days) day
    where jsonb_typeof(day)<>'number' or day::text !~ '^[0-6]$'
  ) then raise exception 'Invalid allowed weekdays'; end if;
  if start_local !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or end_local !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or start_local>=end_local then
    raise exception 'Contact end must be after contact start on the same day. Overnight windows are not supported.';
  end if;
  return jsonb_build_object('allowedWeekdays',days,'contactStart',start_local,'contactEnd',end_local);
end $$;
revoke all on function app.core_contact_preferences(jsonb) from public,anon;
grant execute on function app.core_contact_preferences(jsonb) to authenticated,service_role;

do $upgrade$
declare definition text; before_patch text;
begin
  definition:=replace(pg_get_functiondef('app.core_next_contact(timestamp with time zone,jsonb,text)'::regprocedure),chr(13),'');
  before_patch:=definition;
  definition:=replace(definition,$old$  contact_start := coalesce(p_preferences->>'contactStart','09:00')::time;
  contact_end := coalesce(p_preferences->>'contactEnd','18:00')::time;
  allowed := coalesce(p_preferences->'allowedWeekdays','[1,2,3,4,5]'::jsonb);$old$,$new$  p_preferences := app.core_contact_preferences(p_preferences);
  contact_start := (p_preferences->>'contactStart')::time;
  contact_end := (p_preferences->>'contactEnd')::time;
  allowed := p_preferences->'allowedWeekdays';$new$);
  if definition=before_patch then raise exception 'Contact window patch point missing'; end if;
  before_patch:=definition;
  definition:=replace(definition,'p_after at time zone p_timezone','p_after at time zone coalesce(nullif(p_timezone,''''),''Asia/Kolkata'')');
  definition:=replace(definition,'local_at at time zone p_timezone','local_at at time zone coalesce(nullif(p_timezone,''''),''Asia/Kolkata'')');
  if definition=before_patch then raise exception 'Contact timezone patch point missing'; end if;
  execute definition;

  definition:=replace(pg_get_functiondef('app.sync_core_followup_invoice()'::regprocedure),chr(13),'');
  before_patch:=definition;
  definition:=replace(definition,$old$coalesce(settings.follow_up_preferences->>'contactStart','09:00')::time$old$,
    $new$(app.core_contact_preferences(settings.follow_up_preferences)->>'contactStart')::time$new$);
  if definition=before_patch then raise exception 'Initial contact schedule patch point missing'; end if;
  execute definition;

  definition:=replace(pg_get_functiondef('app.guard_messaging_settings()'::regprocedure),chr(13),'');
  before_patch:=definition;
  definition:=replace(definition,$old$  if jsonb_typeof(p)<>'object' then raise exception 'Invalid follow-up preferences'; end if;$old$,
    $new$  if jsonb_typeof(p)<>'object' then raise exception 'Invalid follow-up preferences'; end if;
  p:=p||app.core_contact_preferences(p);$new$);
  if definition=before_patch then raise exception 'Contact validation patch point missing'; end if;
  -- The local canonical object always contains both times; no stored row changes.
  definition:=replace(definition,$old$coalesce(p->>'contactStart','09:00')>=coalesce(p->>'contactEnd','18:00')$old$,
    $new$(p->>'contactStart')>=(p->>'contactEnd')$new$);
  execute definition;

  -- Older core adapters used an inline copy of the contact guard. Current
  -- first-party adapters already delegate to core_next_contact. Support either
  -- installed body without changing any approval, token, lease or ART checks.
  definition:=replace(pg_get_functiondef('public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamp with time zone)'::regprocedure),chr(13),'');
  if position('weekday:=extract(dow from local_now)' in definition)>0 then
    before_patch:=definition;
    definition:=replace(definition,$old$  local_now:=now() at time zone coalesce(nullif(s.default_timezone,''),'UTC');
  weekday:=extract(dow from local_now)::integer;
  if not exists(select 1 from jsonb_array_elements_text(coalesce(p->'allowedWeekdays','[1,2,3,4,5]'::jsonb)) day where day.value::integer=weekday) then reason:='weekday';return next;return; end if;
  minute_now:=extract(hour from local_now)::integer*60+extract(minute from local_now)::integer;
  start_minute:=split_part(coalesce(p->>'contactStart','09:00'),':',1)::integer*60+split_part(coalesce(p->>'contactStart','09:00'),':',2)::integer;
  end_minute:=split_part(coalesce(p->>'contactEnd','18:00'),':',1)::integer*60+split_part(coalesce(p->>'contactEnd','18:00'),':',2)::integer;
  if minute_now<start_minute or minute_now>=end_minute then reason:='contact_hours';return next;return; end if;$old$,
      $new$  if app.core_next_contact(now(),p,s.default_timezone)>now() then reason:='contact_hours';return next;return; end if;$new$);
    if definition=before_patch then raise exception 'Legacy contact guard patch point missing'; end if;
    execute definition;
  elsif position('app.core_next_contact(' in definition)=0 then
    raise exception 'Delivery contact guard patch point missing';
  end if;
end $upgrade$;
commit;
