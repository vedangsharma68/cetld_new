alter table public.workspace_settings
  add column owner_bot_preferences jsonb not null default '{}'::jsonb,
  add constraint workspace_settings_owner_bot_preferences_object
    check (jsonb_typeof(owner_bot_preferences) = 'object' and octet_length(owner_bot_preferences::text) <= 8192);

create or replace function app.guard_owner_bot_preferences_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  previous_preferences jsonb;
  preference_value text;
begin
  if jsonb_typeof(new.owner_bot_preferences) is distinct from 'object'
     or octet_length(new.owner_bot_preferences::text) > 8192 then
    raise exception 'Owner bot preferences must be a small JSON object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(new.owner_bot_preferences) as preference_keys(key)
    where key not in (
      'assistantName','tone','language','replyLength','confirmationMode',
      'serviceReplySignature','customInstruction'
    )
  ) then
    raise exception 'Unknown owner bot preference field' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'assistantName' and (
       jsonb_typeof(new.owner_bot_preferences->'assistantName') is distinct from 'string'
       or length(btrim(new.owner_bot_preferences->>'assistantName')) not between 1 and 50
       or new.owner_bot_preferences->>'assistantName' ~ '[[:cntrl:]]'
     ) then
    raise exception 'Invalid owner bot assistant name' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'tone' and (
       jsonb_typeof(new.owner_bot_preferences->'tone') is distinct from 'string'
       or new.owner_bot_preferences->>'tone' not in ('concise','friendly','formal')
     ) then
    raise exception 'Invalid owner bot tone' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'language' and (
       jsonb_typeof(new.owner_bot_preferences->'language') is distinct from 'string'
       or new.owner_bot_preferences->>'language' not in (
         'auto','English','Hindi','Hinglish','Bengali','Gujarati','Kannada',
         'Malayalam','Marathi','Tamil','Telugu','Urdu'
       )
     ) then
    raise exception 'Invalid owner bot language' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'replyLength' and (
       jsonb_typeof(new.owner_bot_preferences->'replyLength') is distinct from 'string'
       or new.owner_bot_preferences->>'replyLength' not in ('short','balanced','detailed')
     ) then
    raise exception 'Invalid owner bot reply length' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'confirmationMode' and (
       jsonb_typeof(new.owner_bot_preferences->'confirmationMode') is distinct from 'string'
       or new.owner_bot_preferences->>'confirmationMode' not in ('direct','buttons')
     ) then
    raise exception 'Invalid owner bot confirmation mode' using errcode = '22023';
  end if;
  if new.owner_bot_preferences ? 'serviceReplySignature' then
    if jsonb_typeof(new.owner_bot_preferences->'serviceReplySignature') is distinct from 'string' then
      raise exception 'Invalid owner bot service reply signature' using errcode = '22023';
    end if;
    preference_value := new.owner_bot_preferences->>'serviceReplySignature';
    if preference_value ~ '[[:cntrl:]]' then
      raise exception 'Invalid owner bot service reply signature' using errcode = '22023';
    end if;
    preference_value := regexp_replace(preference_value, '[[:space:]]*[—–][[:space:]]*', ', ', 'g');
    preference_value := btrim(preference_value, ' ,');
    if length(preference_value) > 120 then
      raise exception 'Invalid owner bot service reply signature' using errcode = '22023';
    end if;
    new.owner_bot_preferences := jsonb_set(new.owner_bot_preferences, '{serviceReplySignature}', to_jsonb(preference_value), true);
  end if;
  if new.owner_bot_preferences ? 'customInstruction' and (
       jsonb_typeof(new.owner_bot_preferences->'customInstruction') is distinct from 'string'
       or length(new.owner_bot_preferences->>'customInstruction') > 500
       or new.owner_bot_preferences->>'customInstruction' ~ '[[:cntrl:]]'
     ) then
    raise exception 'Invalid owner bot custom instruction' using errcode = '22023';
  end if;

  previous_preferences := case when tg_op = 'INSERT' then '{}'::jsonb else old.owner_bot_preferences end;
  if new.owner_bot_preferences is distinct from previous_preferences
     and auth.uid() is not null
     and not exists (
       select 1 from public.workspaces w
       where w.id = new.workspace_id and w.owner_id = auth.uid()
     ) then
    raise exception 'Only the workspace owner may update owner bot preferences' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger workspace_settings_owner_bot_preferences_guard
  before insert or update of owner_bot_preferences on public.workspace_settings
  for each row execute function app.guard_owner_bot_preferences_update();
