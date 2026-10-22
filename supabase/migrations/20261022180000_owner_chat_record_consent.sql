-- A dedicated owner-chat write; do not impersonate an authenticated dashboard
-- user or change reminder eligibility. Consent and its receipt commit together.
create function public.whatsapp_owner_record_consent(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_customer_id uuid,
 p_contact_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype; existing public.whatsapp_consents%rowtype;
 receipt public.whatsapp_direct_write_receipts%rowtype;
 request jsonb; result jsonb; lock_phone text; consent_id uuid;
 statement text:=lower(replace(coalesce(p_user_message,''),'’',''''));
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 -- Use the same phone-wide locks as STOP. A stable order also handles two
 -- verified owners recording consent for one another without a lock cycle.
 for lock_phone in select distinct v from unnest(array[p_phone,p_contact_phone]) v where v is not null order by v loop
   perform pg_advisory_xact_lock(hashtextextended(lock_phone,0));
 end loop;
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) b
     where b.workspace_id=p_workspace_id and b.owner_id=p_owner_id)<>1
 or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id
   and e.sender_phone=p_phone and e.message_type='text' and e.message_text=p_user_message)
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 select * into c from public.customers where workspace_id=p_workspace_id and id=p_customer_id for update;
 if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
 if c.phone is distinct from p_contact_phone then return jsonb_build_object('ok',false,'code','STALE'); end if;
 if c.phone is null or c.phone !~ '^\+[1-9][0-9]{7,14}$'
 then return jsonb_build_object('ok',false,'code','INVALID'); end if;
 if c.phone=p_phone or coalesce(c.metadata->>'whatsapp_owner','false')='true'
 or exists(select 1 from public.workspace_settings s where s.workspace_id=p_workspace_id and s.whatsapp_owner_phone=c.phone)
 then return jsonb_build_object('ok',false,'code','OWNER_PHONE'); end if;
 if exists(select 1 from public.whatsapp_global_suppressions where phone=c.phone)
 then return jsonb_build_object('ok',false,'code','globally_suppressed'); end if;
 if exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=c.phone)
 then return jsonb_build_object('ok',false,'code','suppressed'); end if;
 select * into existing from public.whatsapp_consents where workspace_id=p_workspace_id and phone=c.phone for update;
 if found and existing.customer_id is distinct from c.id
 then return jsonb_build_object('ok',false,'code','CONFLICT'); end if;
 if existing.revoked_at is not null then return jsonb_build_object('ok',false,'code','revoked'); end if;
 if exists(select 1 from regexp_matches(statement,'\+[0-9][0-9 -]*[0-9]|\m[6-9][0-9]{9}\M','g') m
   where regexp_replace(m[1],'[^0-9]','','g') not in
     (regexp_replace(c.phone,'[^0-9]','','g'),case when c.phone ~ '^\+91' then substring(c.phone from 4) else '' end))
 then return jsonb_build_object('ok',false,'code','STALE'); end if;
 -- Current owner evidence must be affirmative and identify this exact customer
 -- or phone. A model-supplied target, a question or a bare YES is not consent.
 if statement ~ '[?;\n]' or btrim(statement) ~ '^(has|have|had|did|does|do|is|are|was|were|why|how|what|which|who|where)\M'
 or statement ~ '\m(not|never|no|without|refused|declined|maybe|tomorrow|later|stop|stopped|withdraw|withdrawn|revoke|revoked|if|when|once|whether|can|could|would|will|should)\M'
 or statement ~ '\m(hasn''t|haven''t|didn''t|doesn''t|don''t|isn''t|wasn''t|won''t|can''t)\M'
 or statement !~ '\m(agreed|consented)[[:space:]]+(to|for)[[:space:]]+((receive|get)[[:space:]]+)?(whatsapp[[:space:]]+)?(invoice[[:space:]]+)?reminders?\M'
 or not (position(' '||lower(regexp_replace(c.name,'[^[:alnum:] ]',' ','g'))||' '
     in ' '||regexp_replace(statement,'[^[:alnum:] ]',' ','g')||' ')>0
   or exists(select 1 from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=c.id and i.deleted_at is null
     and position(' '||lower(regexp_replace(i.invoice_number,'[^[:alnum:] ]',' ','g'))||' '
       in ' '||regexp_replace(statement,'[^[:alnum:] ]',' ','g')||' ')>0)
   or exists(select 1 from regexp_matches(statement,'\+?[0-9][0-9 -]{6,}[0-9]','g') m
     where regexp_replace(m[1],'[^0-9]','','g') in
       (regexp_replace(c.phone,'[^0-9]','','g'),case when c.phone ~ '^\+91' then substring(c.phone from 4) end)))
 then return jsonb_build_object('ok',false,'code','INVALID'); end if;
 request:=jsonb_build_object('operation','consent.record','customerId',c.id,'phone',c.phone,'message',p_user_message);
 -- Serialize receipt reuse even if an SDK retry supplies a different target.
 perform pg_advisory_xact_lock(hashtextextended(p_message_id,7));
 select * into receipt from public.whatsapp_direct_write_receipts where provider_message_id=p_message_id;
 if found then
   if receipt.workspace_id<>p_workspace_id or receipt.owner_id<>p_owner_id or receipt.phone<>p_phone or receipt.request<>request
   then return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH'); end if;
   return receipt.result||jsonb_build_object('replayed',true);
 end if;
 insert into public.whatsapp_consents(workspace_id,customer_id,phone,categories,consent_text_version,source,consented_by)
 values(p_workspace_id,c.id,c.phone,array['invoice_updates'],'owner_confirmed_v1','verbal',p_owner_id)
 on conflict(workspace_id,phone) do update set
   categories=case when 'invoice_updates'=any(whatsapp_consents.categories) then whatsapp_consents.categories
     else array_append(whatsapp_consents.categories,'invoice_updates') end,
   consent_text_version='owner_confirmed_v1',source='verbal',consented_by=p_owner_id,consented_at=now()
 where whatsapp_consents.customer_id=c.id and whatsapp_consents.revoked_at is null
 returning id into consent_id;
 if consent_id is null then return jsonb_build_object('ok',false,'code','CONFLICT'); end if;
 result:=jsonb_build_object('ok',true,'completed',true,'action','consent.recorded','customerName',c.name,'phone',c.phone);
 insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
 values(p_message_id,p_workspace_id,p_owner_id,p_phone,'consent_'||md5(p_message_id),request,result);
 return result;
end $$;
revoke all on function public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text) to service_role;
