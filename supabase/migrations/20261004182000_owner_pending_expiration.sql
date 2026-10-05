-- Proposal metadata housekeeping only; install does not touch business data.
create or replace function public.whatsapp_expire_owner_pending(
  p_workspace_id uuid,p_owner_id uuid,p_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o record;e public.whatsapp_inbound_events%rowtype;a public.whatsapp_pending_actions%rowtype;v_now timestamptz:=clock_timestamp();v_expiry timestamptz;v_count integer:=0;v_changed integer;
begin
  if auth.role() is distinct from 'service_role' then return jsonb_build_object('ok',false,'code','DENIED');end if;
  if p_workspace_id is null or p_owner_id is null or p_phone is null or p_message_id is null or length(p_message_id) not between 1 and 256
    or p_user_message is null or length(p_user_message)>4000 then return jsonb_build_object('ok',false,'code','INVALID');end if;
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id)<>1 then
    return jsonb_build_object('ok',false,'code','DENIED');end if;
  select * into o from public.whatsapp_resolve_verified_owner(p_phone) r where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id;
  select * into e from public.whatsapp_inbound_events x where x.provider_message_id=p_message_id and x.sender_phone=p_phone
    and x.message_text=p_user_message and x.status in ('processing','done');
  if not found then return jsonb_build_object('ok',false,'code','DENIED');end if;
  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id and r.customer_id=o.customer_id)<>1 then
    return jsonb_build_object('ok',false,'code','DENIED');end if;
  for a in select * from public.whatsapp_pending_actions x where x.workspace_id=p_workspace_id and x.customer_id=o.customer_id and x.phone=p_phone
    and x.consumed_at is null order by x.generation desc for update loop
    v_expiry:=null;
    if e.received_at<a.created_at or e.provider_timestamp is not null and e.provider_timestamp+interval '1 second'<a.created_at then continue;end if;
    if a.action->>'type'='owner_invoice_reopen' then
      update public.invoice_reopening_proposals q set state='expired' where q.id=(a.action->>'proposalId')::uuid and q.workspace_id=p_workspace_id
        and q.owner_id=p_owner_id and q.phone=p_phone and q.state='pending' and q.expires_at<=v_now;
      get diagnostics v_changed=row_count;
      if v_changed=0 then continue;end if;
    elsif a.action->>'type'='owner_workspace_data_change' then
      update public.whatsapp_workspace_data_proposals q set state='expired' where q.id=(a.action->>'proposalId')::uuid and q.workspace_id=p_workspace_id
        and q.owner_id=p_owner_id and q.phone=p_phone and q.state='pending' and q.expires_at<=v_now;
      get diagnostics v_changed=row_count;
      if v_changed=0 then continue;end if;
    elsif a.action->>'type'='owner_invoice_delete_proposal' then
      update public.invoice_lifecycle_proposals q set state='expired' where q.id=(a.action->>'proposalId')::uuid and q.workspace_id=p_workspace_id
        and q.owner_id=p_owner_id and q.actor_phone=p_phone and q.state='pending' and q.expires_at<=v_now;
      get diagnostics v_changed=row_count;
      if v_changed=0 then continue;end if;
    elsif a.action->>'type' in ('owner_invoice_update','owner_invoice_payment','owner_invoice_create','owner_settings_update') then
      v_expiry:=nullif(a.action->>'expiresAt','')::timestamptz;
      if v_expiry is null or v_expiry>v_now then continue;end if;
    else
      -- Reviews have their own stage/CAS expiration rules. Never consume a
      -- review in saving, an undo receipt, an unknown type, or a live proposal.
      continue;
    end if;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id and version=a.version and consumed_at is null;
    get diagnostics v_changed=row_count;v_count:=v_count+v_changed;
  end loop;
  return jsonb_build_object('ok',true,'expired',v_count>0,'expiredCount',v_count,'businessChangeApplied',false);
exception when others then return jsonb_build_object('ok',false,'code','UNAVAILABLE');
end;
$$;
revoke all on function public.whatsapp_expire_owner_pending(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_expire_owner_pending(uuid,uuid,text,text,text) to service_role;
