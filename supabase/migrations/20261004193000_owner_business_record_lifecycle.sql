-- LOCAL PROPOSAL ONLY. Installation changes no existing record values.
alter table public.business_records add column deleted_at timestamptz;
alter table public.business_records add column deleted_by uuid references auth.users(id);
alter table public.business_records add constraint business_record_deletion_pair
  check ((deleted_at is null) = (deleted_by is null));

-- Preserve the reviewed create/update implementation; all callers get the active-row guard.
do $copy$
declare definition text;
begin
  definition:=replace(pg_get_functiondef('app.apply_business_record(uuid,text,uuid,timestamptz,jsonb)'::regprocedure),
    'CREATE OR REPLACE FUNCTION app.apply_business_record(',
    'CREATE OR REPLACE FUNCTION app.apply_active_business_record(');
  if strpos(definition,'CREATE OR REPLACE FUNCTION app.apply_active_business_record(')<>1 then raise exception 'business helper copy mismatch'; end if;
  execute definition;
end;
$copy$;
revoke all on function app.apply_active_business_record(uuid,text,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

create or replace function app.apply_business_record(ws uuid,op text,target uuid,expected timestamptz,value jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare r public.business_records%rowtype; actor uuid;
begin
  if op='create' then return app.apply_active_business_record(ws,op,target,expected,value); end if;
  if op not in ('update','delete','restore') then return jsonb_build_object('ok',false,'code','INVALID'); end if;
  select * into r from public.business_records b where b.workspace_id=ws and b.id=target for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
  if expected is null or r.updated_at is distinct from expected then return jsonb_build_object('ok',false,'code','STALE'); end if;
  if op='update' then
    if r.deleted_at is not null then return jsonb_build_object('ok',false,'code','ALREADY_DELETED'); end if;
    return app.apply_active_business_record(ws,op,target,expected,value);
  end if;
  if value is distinct from '{}'::jsonb then return jsonb_build_object('ok',false,'code','INVALID'); end if;
  select w.owner_id into actor from public.workspaces w where w.id=ws;
  if actor is null then return jsonb_build_object('ok',false,'code','DENIED'); end if;
  if op='delete' then
    if r.deleted_at is not null then return jsonb_build_object('ok',false,'code','ALREADY_DELETED'); end if;
    update public.business_records b set deleted_at=clock_timestamp(),deleted_by=actor
      where b.workspace_id=ws and b.id=target returning * into r;
  else
    if r.deleted_at is null or r.deleted_by is distinct from actor then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
    if r.deleted_at<clock_timestamp()-interval '30 days' then return jsonb_build_object('ok',false,'code','UNDO_EXPIRED'); end if;
    update public.business_records b set deleted_at=null,deleted_by=null
      where b.workspace_id=ws and b.id=target returning * into r;
  end if;
  return jsonb_build_object('ok',true,'record',to_jsonb(r));
end;
$$;
revoke all on function app.apply_business_record(uuid,text,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

do $upgrade$
declare definition text; before_definition text;
begin
  definition:=replace(pg_get_functiondef('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure),chr(13),'');
  before_definition:=definition;
  definition:=replace(definition,'''business_record.create'',''business_record.update''',
    '''business_record.create'',''business_record.update'',''business_record.delete'',''business_record.restore''');
  if definition=before_definition then raise exception 'business lifecycle allowlist marker missing'; end if;
  before_definition:=definition;
  definition:=replace(definition,
    'case when p_operation=''business_record.create'' then ''business_record.created'' else ''business_record.updated'' end',
    'case p_operation when ''business_record.create'' then ''business_record.created'' when ''business_record.delete'' then ''business_record.deleted'' when ''business_record.restore'' then ''business_record.restored'' else ''business_record.updated'' end');
  if definition=before_definition then raise exception 'business lifecycle action marker missing'; end if;
  execute definition;
end;
$upgrade$;
