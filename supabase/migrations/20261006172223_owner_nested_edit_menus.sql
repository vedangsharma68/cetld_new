-- REVIEW ONLY. Requires separate production approval.
-- Expand only persisted nested invoice-menu action kinds; no row backfill, table
-- rewrite, constraint change, message send or grant change.
begin;

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
      or action is null or action not in ('select','view_file','edit_details','edit_amount','edit_due_date','edit_more','record_payment','unpaid_invoices','recent_invoices','find_invoice')
      or jsonb_typeof(c->'title') is distinct from 'string' or length(c->>'title') not between 1 and 20
      or c->>'title'~'[[:cntrl:]]' then return false; end if;
    if action in ('select','view_file','edit_details','edit_amount','edit_due_date','edit_more','record_payment') then
      if coalesce(c->>'table','') not in ('customers','invoices') or coalesce(c->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or jsonb_typeof(c->'updatedAt') is distinct from 'string'
        or action in ('view_file','edit_amount','edit_due_date','edit_more','record_payment') and c->>'table'<>'invoices' then return false; end if;
      if not isfinite((c->>'updatedAt')::timestamptz) then return false; end if;
    elsif c ? 'table' or c ? 'id' or c ? 'updatedAt' then return false; end if;
  end loop;
  return value ?& array['v','key','expiresAt','choices'];
exception when others then return false;
end;
$$;

commit;
