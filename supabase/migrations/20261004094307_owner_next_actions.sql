-- Server-owned next-action choices are distinct from pending approval tokens.
-- This is a local forward migration; do not apply until this follow-on is released.
create or replace function app.owner_next_action_ref_valid(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare c jsonb; action text;
begin
  if jsonb_typeof(value) is distinct from 'object' or octet_length(value::text)>8192
    or (value-'v'-'key'-'expiresAt'-'choices')<>'{}'::jsonb or value->'v' is distinct from '1'::jsonb
    or jsonb_typeof(value->'key') is distinct from 'string'
    or value->>'key'!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(value->'expiresAt') is distinct from 'string'
    or jsonb_typeof(value->'choices') is distinct from 'array' then return false; end if;
  if not isfinite((value->>'expiresAt')::timestamptz) then return false; end if;
  if jsonb_array_length(value->'choices') not between 1 and 3 then return false; end if;
  for c in select * from jsonb_array_elements(value->'choices') loop
    action:=c->>'action';
    if jsonb_typeof(c) is distinct from 'object' or (c-'action'-'title'-'table'-'id'-'updatedAt')<>'{}'::jsonb
      or action is null or action not in ('select','view_file','edit_details','record_payment','unpaid_invoices','recent_invoices','find_invoice')
      or jsonb_typeof(c->'title') is distinct from 'string' or length(c->>'title') not between 1 and 20
      or c->>'title'~'[[:cntrl:]]' then return false; end if;
    if action in ('select','view_file','edit_details','record_payment') then
      if coalesce(c->>'table','') not in ('customers','invoices') or coalesce(c->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or jsonb_typeof(c->'updatedAt') is distinct from 'string'
        or action in ('view_file','record_payment') and c->>'table'<>'invoices' then return false; end if;
      if not isfinite((c->>'updatedAt')::timestamptz) then return false; end if;
    elsif c ? 'table' or c ? 'id' or c ? 'updatedAt' then return false; end if;
  end loop;
  return value ?& array['v','key','expiresAt','choices'];
exception when others then return false;
end;
$$;
revoke all on function app.owner_next_action_ref_valid(jsonb) from public,anon,authenticated;
grant execute on function app.owner_next_action_ref_valid(jsonb) to service_role;
alter table public.whatsapp_messages add column owner_next_action_ref jsonb;
alter table public.whatsapp_messages add constraint whatsapp_messages_owner_next_action_ref_check
  check(owner_next_action_ref is null or (direction='outbound' and audience='owner' and kind='normal'
    and owner_action_ref is null and app.owner_next_action_ref_valid(owner_next_action_ref)));
create unique index whatsapp_owner_next_action_key on public.whatsapp_messages(workspace_id,phone,(owner_next_action_ref->>'key'))
  where owner_next_action_ref is not null;
alter table public.whatsapp_messages add column owner_reply_media_ref jsonb;
alter table public.whatsapp_messages add constraint whatsapp_messages_owner_reply_media_ref_check
  check(owner_reply_media_ref is null or (direction='outbound' and audience='owner' and kind='normal'
    and owner_action_ref is null and owner_next_action_ref is null and jsonb_typeof(owner_reply_media_ref)='object'
    and owner_reply_media_ref ?& array['invoiceId','invoiceUpdatedAt','fileId']
    and (owner_reply_media_ref-'invoiceId'-'invoiceUpdatedAt'-'fileId')='{}'::jsonb
    and coalesce(owner_reply_media_ref->>'invoiceId','')~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and coalesce(owner_reply_media_ref->>'fileId','')~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and jsonb_typeof(owner_reply_media_ref->'invoiceUpdatedAt') is not distinct from 'string'));
