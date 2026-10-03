-- Checkpoints and acknowledgement claims are internal service data. Existing
-- inbox RLS and service-only grants continue to protect the entire row.
alter table public.whatsapp_inbound_events
  add column if not exists owner_job_checkpoint jsonb,
  add column if not exists owner_job_workspace_id uuid,
  add column if not exists owner_job_owner_id uuid,
  add column if not exists owner_ack_claimed_at timestamptz;

create or replace function public.whatsapp_claim_owner_ack(
  p_provider_message_id text,p_sender_phone text,p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_claimed bigint;v_count bigint;v_workspace uuid;v_owner uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sender_phone,0));
  select count(*),min(workspace_id::text)::uuid,min(owner_id::text)::uuid
    into v_count,v_workspace,v_owner from public.whatsapp_resolve_verified_owner(p_sender_phone);
  if v_count<>1 or v_workspace is distinct from p_workspace_id then return false;end if;
  update public.whatsapp_inbound_events set owner_ack_claimed_at=now(),owner_job_workspace_id=v_workspace,owner_job_owner_id=v_owner
    where provider_message_id=p_provider_message_id and sender_phone=p_sender_phone
      and status='processing' and owner_ack_claimed_at is null
      and (owner_job_workspace_id is null or owner_job_workspace_id=p_workspace_id)
      and (owner_job_owner_id is null or owner_job_owner_id=v_owner);
  get diagnostics v_claimed=row_count;
  return v_claimed=1;
end; $$;
revoke all on function public.whatsapp_claim_owner_ack(text,text,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_owner_ack(text,text,uuid) to service_role;
