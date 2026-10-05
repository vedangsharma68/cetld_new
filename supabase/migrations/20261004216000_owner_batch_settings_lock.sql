-- FORWARD LOCAL REVIEW PROPOSAL: no production application authorized.
-- Patch only the installed public batch coordinator, retaining its ACL, engine,
-- validation, receipt/replay behavior and existing operation body.
begin;
do $batch_lock_order$
declare
  target regprocedure:='public.whatsapp_apply_owner_batch(uuid,uuid,text,text,text,jsonb)'::regprocedure;
  original text; patched text; old_acl aclitem[];
  phone_marker text:='  perform pg_advisory_xact_lock(hashtextextended(''owner_batch:''||p_provider_message_id,0));';
  child_marker text:='  for v_item in select value from jsonb_array_elements(p_operations) loop';
begin
  original:=replace(pg_get_functiondef(target),chr(13),'');
  select proacl into old_acl from pg_proc where oid=target;
  if strpos(original,'CREATE OR REPLACE FUNCTION public.whatsapp_apply_owner_batch(')<>1
    or (length(original)-length(replace(original,phone_marker,'')))/length(phone_marker)<>1
    or (length(original)-length(replace(original,child_marker,'')))/length(child_marker)<>1
    or strpos(original,'perform 1 from public.workspace_settings where workspace_id=p_workspace_id for update;')>0 then
    raise exception 'unexpected installed owner batch lock markers';
  end if;
  patched:=replace(original,phone_marker,
    '  -- Owner phone before settings, matching child operations and STOP.'||chr(10)||
    '  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));'||chr(10)||phone_marker);
  patched:=replace(patched,child_marker,
    '  -- Settings before any invoice/customer child, including mixed settings batches.'||chr(10)||
    '  perform 1 from public.workspace_settings where workspace_id=p_workspace_id for update;'||chr(10)||child_marker);
  execute patched;
  if (select proacl from pg_proc where oid=target) is distinct from old_acl then
    raise exception 'owner batch ACL unexpectedly changed';
  end if;
end;
$batch_lock_order$;
commit;
