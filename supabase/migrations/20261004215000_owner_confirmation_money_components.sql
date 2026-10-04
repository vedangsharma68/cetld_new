-- LOCAL PROPOSAL. No stored invoice/payment data changes on installation.
begin;
create function app.owner_invoice_recorded_component(meta jsonb,component text) returns numeric
language plpgsql set search_path='' as $$
declare value numeric;raw jsonb;
begin
 if component not in ('tax','discount') then raise exception 'invalid component';end if;
 raw:=meta->component;
 if raw is not null and raw<>'null'::jsonb then
  if jsonb_typeof(raw) not in ('number','string') or meta->>component!~'^[0-9]+([.][0-9]+)?$' then raise exception 'Invalid recorded %',component;end if;
  value:=(meta->>component)::numeric;
  if value<>round(value,2) or value>=10000000000000000 then raise exception 'Invalid recorded % precision',component;end if;
  return round(value,2);
 end if;
 raw:=meta->(component||'_minor');
 if raw is null or raw='null'::jsonb then return 0;end if;
 if jsonb_typeof(raw) not in ('number','string') or meta->>(component||'_minor')!~'^[0-9]+([.][0-9]+)?$' then raise exception 'Invalid recorded % minor units',component;end if;
 value:=(meta->>(component||'_minor'))::numeric;
 if value<>trunc(value) or value>=1000000000000000000 then raise exception 'Invalid recorded % minor units',component;end if;
 return round(value/100,2);
end; $$;
revoke all on function app.owner_invoice_recorded_component(jsonb,text) from public,anon,authenticated,service_role;

-- The reviewed legacy function already performs total and metadata changes in
-- one UPDATE. Normalize its derived NUMERIC representation, preserve canonical
-- overrides and discount, and let the table guard verify existing itemization.
do $repair$
declare definition text;old_block text;new_block text;
begin
 definition:=replace(pg_get_functiondef('public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure),chr(13),'');
 if strpos(definition,'recorded_tax numeric;')=0 then raise exception 'owner confirmation declaration marker mismatch';end if;
 definition:=replace(definition,'recorded_tax numeric;','recorded_tax numeric;recorded_discount numeric;');
 old_block:=$old$    if coalesce(meta->>'tax_minor','') ~ '^[0-9]+$' then
     recorded_tax:=(meta->>'tax_minor')::numeric/100;
    elsif coalesce(meta->>'tax','') ~ '^[0-9]+(\.[0-9]{1,2})?$' then
     recorded_tax:=(meta->>'tax')::numeric;
    else recorded_tax:=0;
    end if;$old$;
 new_block:=$new$    recorded_tax:=app.owner_invoice_recorded_component(meta,'tax');
    recorded_discount:=app.owner_invoice_recorded_component(meta,'discount');$new$;
 if (length(definition)-length(replace(definition,old_block,'')))/length(old_block)<>1 then raise exception 'owner confirmation tax marker mismatch';end if;
 definition:=replace(definition,old_block,new_block);
 old_block:=$old$'subtotal',new_total-recorded_tax,'tax',recorded_tax)$old$;
 if strpos(definition,old_block)=0 then raise exception 'owner confirmation subtotal marker mismatch';end if;
 definition:=replace(definition,old_block,$new$'subtotal',new_total-recorded_tax+recorded_discount,'tax',recorded_tax,'discount',recorded_discount)$new$);
 execute definition;
end; $repair$;
commit;
