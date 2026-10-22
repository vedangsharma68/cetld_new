-- Keep the default payment draft in the JS snapshot and deployed gate in sync.
-- The Meta-approved catalog, authorization guards and function ACL stay intact.
begin;
do $upgrade$
declare def text;patch_point text;
begin
  def:=replace(pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure),chr(13),'');
  patch_point:=$old$  if body is distinct from p_snapshot->>'body'$old$;
  if position(patch_point in def)=0 or position('p_snapshot->>''defaultDraft''' in def)>0 then
    raise exception 'Default payment reminder draft patch point missing';
  end if;
  def:=replace(def,patch_point,$new$  if t.parameter_count=5 and (p_snapshot->>'defaultDraft') is distinct from
    ('Hi '||(facts->>0)||', this is '||(facts->>1)||'. Invoice '||(facts->>2)||
     ' has an outstanding balance of '||(facts->>3)||', due on '||(facts->>4)||
     '. Please arrange payment, or reply here if you have any questions.') then return '{"authorized":false}';end if;
  if body is distinct from p_snapshot->>'body'$new$);
  execute def;
end $upgrade$;
commit;
