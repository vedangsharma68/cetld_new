-- Reviewable proposal: do not apply to production without explicit approval.
-- Reuse the installed validated engine privately, with one aggregate receipt.
do $batch_engine$
declare v_def text; v_start integer; v_end integer;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure),chr(13),'');
  if strpos(v_def,'CREATE OR REPLACE FUNCTION public.whatsapp_apply_direct_owner_write(')<>1 then raise exception 'unexpected direct engine definition'; end if;
  v_def:=replace(v_def,'CREATE OR REPLACE FUNCTION public.whatsapp_apply_direct_owner_write(','CREATE OR REPLACE FUNCTION app.whatsapp_apply_owner_batch_operation(');
  v_start:=strpos(v_def,'  select * into v_receipt from public.whatsapp_direct_write_receipts r');
  v_end:=strpos(substr(v_def,v_start),'  if p_authorization_kind=''instruction'' then');
  if v_start=0 or v_end=0 then raise exception 'batch receipt read marker missing'; end if;
  v_def:=overlay(v_def placing '' from v_start for v_end-1);
  v_start:=strpos(v_def,'  insert into public.whatsapp_direct_write_receipts(');
  v_end:=strpos(substr(v_def,v_start),'  return v_result;');
  if v_start=0 or v_end=0 then raise exception 'batch receipt write marker missing'; end if;
  v_def:=overlay(v_def placing '' from v_start for v_end-1);
  execute v_def;
end;
$batch_engine$;
revoke all on function app.whatsapp_apply_owner_batch_operation(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated,service_role;

create or replace function public.whatsapp_apply_owner_batch(
  p_workspace_id uuid,p_owner_id uuid,p_phone text,p_provider_message_id text,
  p_authorization_quote text,p_operations jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_receipt public.whatsapp_direct_write_receipts%rowtype;
  v_request jsonb; v_item jsonb; v_result jsonb; v_results jsonb:='[]'::jsonb;
  v_index integer:=0; v_code text; v_targets text[]:='{}'; v_target text; v_key text;
begin
  if auth.role() is distinct from 'service_role' then return jsonb_build_object('ok',false,'code','DENIED'); end if;
  if p_operations is null or jsonb_typeof(p_operations)<>'array' or jsonb_array_length(p_operations) not between 2 and 10
    or octet_length(p_operations::text)>32768 or p_authorization_quote is null or length(p_authorization_quote) not between 1 and 4000 then
    return jsonb_build_object('ok',false,'code','INVALID');
  end if;
  -- Owner/event authorization is still independently enforced by every child.
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r where r.workspace_id=p_workspace_id and r.owner_id=p_owner_id)<>1
    or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_provider_message_id and e.sender_phone=p_phone and e.message_text=p_authorization_quote) then
    return jsonb_build_object('ok',false,'code','DENIED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('owner_batch:'||p_provider_message_id,0));
  v_request:=jsonb_build_object('kind','batch','quote',p_authorization_quote,'operations',p_operations);
  select * into v_receipt from public.whatsapp_direct_write_receipts where provider_message_id=p_provider_message_id for update;
  if found then
    if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.owner_id is distinct from p_owner_id or v_receipt.phone is distinct from p_phone or v_receipt.request is distinct from v_request then
      return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');
    end if;
    return v_receipt.result||jsonb_build_object('replayed',true);
  end if;
  for v_item in select value from jsonb_array_elements(p_operations) loop
    v_index:=v_index+1;
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_object_keys(v_item) k where k not in ('operation','targetId','expectedUpdatedAt','payload'))
      or coalesce(v_item->>'operation','') not in ('invoice.create','invoice.update','customer.create','customer.update','business_record.create','business_record.update','settings.update','ai_settings.update')
      or jsonb_typeof(v_item->'payload') is distinct from 'object' or v_item->'payload' ? 'status' then
      v_code:='INVALID';raise exception using errcode='Z0003';
    end if;
    v_target:=v_item->>'operation'||':'||coalesce(v_item->>'targetId','create_'||v_index::text);
    if v_target=any(v_targets) then v_code:='INVALID';raise exception using errcode='Z0003';end if;
    v_targets:=array_append(v_targets,v_target);
    v_key:='ownerwrite_'||md5(p_provider_message_id||':'||v_index::text);
    v_result:=app.whatsapp_apply_owner_batch_operation(p_workspace_id,p_owner_id,p_phone,p_provider_message_id,null,v_key,
      v_item->>'operation',(v_item->>'targetId')::uuid,(v_item->>'expectedUpdatedAt')::timestamptz,'instruction',p_authorization_quote,null,null,null,v_item->'payload');
    if v_result->>'ok' is distinct from 'true' then v_code:=coalesce(v_result->>'code','UNAVAILABLE');raise exception using errcode='Z0003';end if;
    v_results:=v_results||jsonb_build_array(v_result||jsonb_build_object('completed',true));
  end loop;
  v_result:=jsonb_build_object('ok',true,'completed',true,'action','batch.completed','entityType','batch','entityId',p_workspace_id,'results',v_results);
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
    values(p_provider_message_id,p_workspace_id,p_owner_id,p_phone,'ownerbatch_'||md5(p_provider_message_id),v_request,v_result);
  return v_result;
exception
  when sqlstate 'Z0003' then return jsonb_build_object('ok',false,'completed',false,'code',v_code,'failedOperation',v_index,'rolledBack',true);
  when others then return jsonb_build_object('ok',false,'completed',false,'code','UNAVAILABLE','failedOperation',v_index,'rolledBack',true);
end;
$$;
revoke all on function public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb) to service_role;
