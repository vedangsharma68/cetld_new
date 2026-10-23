-- Additive, reply-only authority. Existing consent, owner write, approval and
-- artifact routines are deliberately unchanged. Used only by commercial mode.
begin;

create or replace function public.whatsapp_resolve_service_owner(p_phone text)
returns table(workspace_id uuid,owner_id uuid,customer_id uuid,business_name text)
language sql stable security definer set search_path='' as $$
 select w.id,w.owner_id,c.id,coalesce(s.business_name,'')
 from public.workspaces w
 join public.workspace_settings s on s.workspace_id=w.id and s.whatsapp_owner_phone=p_phone
 join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner'
 join public.customers c on c.workspace_id=w.id and c.phone=p_phone and c.metadata->>'whatsapp_owner'='true'
 where exists(select 1 from public.whatsapp_owner_verifications v where v.workspace_id=w.id
   and v.phone=p_phone and v.requested_by=w.owner_id and v.verified_at is not null)
 and not exists(select 1 from public.whatsapp_global_suppressions g where g.phone=p_phone)
 and not exists(select 1 from public.whatsapp_suppressions x where x.workspace_id=w.id and x.phone=p_phone)
$$;
revoke all on function public.whatsapp_resolve_service_owner(text) from public,anon,authenticated;
grant execute on function public.whatsapp_resolve_service_owner(text) to service_role;

create or replace function public.whatsapp_claim_service_owner_reply(
 p_provider_message_id text,p_sender_phone text,p_workspace_id uuid,p_phone_number_id text,p_phase text default 'answer'
) returns boolean language plpgsql security definer set search_path='' as $$
declare b record;claimed_id bigint;
begin
 if p_phase is null or p_phase not in ('answer','ack') or p_workspace_id is null
   or nullif(p_phone_number_id,'') is null then return false;end if;
 -- Preserve serialization with STOP/unbind and recheck the actual owner inside
 -- the lock. A caller's audience, message kind or business ID is not authority.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sender_phone,0));
 if (select count(*) from public.whatsapp_resolve_service_owner(p_sender_phone))<>1 then return false;end if;
 select * into b from public.whatsapp_resolve_service_owner(p_sender_phone) o where o.workspace_id=p_workspace_id;
 if not found then return false;end if;
 perform 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_provider_message_id
   and e.sender_phone=p_sender_phone and e.phone_number_id=p_phone_number_id and e.status='processing'
   and e.stop_processed_at is null
   and coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()
   and coalesce(e.provider_timestamp,e.received_at)>clock_timestamp()-interval '24 hours'
   and (e.owner_job_workspace_id is null or e.owner_job_workspace_id=b.workspace_id)
   and (e.owner_job_owner_id is null or e.owner_job_owner_id=b.owner_id)
   for update;
 if not found then return false;end if;
 if p_phase='answer' then
   return public.whatsapp_claim_inbound_reply(p_provider_message_id,p_sender_phone,'normal',p_workspace_id);
 end if;
 update public.whatsapp_inbound_events set owner_ack_claimed_at=clock_timestamp(),
   owner_job_workspace_id=b.workspace_id,owner_job_owner_id=b.owner_id
 where provider_message_id=p_provider_message_id and sender_phone=p_sender_phone
   and status='processing' and owner_ack_claimed_at is null returning id into claimed_id;
 return claimed_id is not null;
end;
$$;
revoke all on function public.whatsapp_claim_service_owner_reply(text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_service_owner_reply(text,text,uuid,text,text) to service_role;
commit;
