-- LOCAL PROPOSAL. Existing receipts remain unchanged and replayable.
begin;
create function app.guard_incoming_payment_direction() returns trigger
language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;p public.payments%rowtype;
begin
 select * into i from public.invoices x where x.workspace_id=new.workspace_id and x.id=new.invoice_id for update;
 if not found then raise exception 'payment requires an invoice in this workspace' using errcode='42501';end if;
 if i.metadata->>'invoice_direction'='receivable' then return new;end if;
 -- An old exact idempotent insert may subsequently do ON CONFLICT NOTHING.
 -- It cannot create a second row because the existing workspace/key is unique.
 if new.idempotency_key is not null then
  select * into p from public.payments x where x.workspace_id=new.workspace_id and x.idempotency_key=new.idempotency_key for update;
  if found and p.invoice_id is not distinct from new.invoice_id and p.amount is not distinct from new.amount
   and p.reference is not distinct from new.reference and p.settle_remaining is not distinct from new.settle_remaining then return new;end if;
 end if;
 raise exception 'incoming payment requires a receivable invoice; payable and unknown directions need a separate outgoing-payment workflow' using errcode='22023';
end; $$;
revoke all on function app.guard_incoming_payment_direction() from public,anon,authenticated,service_role;
create trigger payments_receivable_direction_guard before insert on public.payments
for each row execute function app.guard_incoming_payment_direction();

-- Preserve the deployed membership, deletion, exact-money and replay rules.
-- Apply after the historical replay branch and before any new financial write.
do $guard$
declare definition text;marker text:='  if invoice_row.status in (''void''::public.invoice_status,''cancelled''::public.invoice_status) then';
begin
 definition:=replace(pg_get_functiondef('public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean)'::regprocedure),chr(13),'');
 if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'payment direction insertion marker mismatch';end if;
 definition:=replace(definition,marker,
  '  if invoice_row.metadata->>''invoice_direction'' is distinct from ''receivable'' then
    raise exception ''incoming payment requires a receivable invoice; payable and unknown directions need a separate outgoing-payment workflow'' using errcode=''22023'';
  end if;
'||marker);
 execute definition;
end; $guard$;
revoke all on function public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean) from public,anon,service_role;
grant execute on function public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean) to authenticated;
commit;
