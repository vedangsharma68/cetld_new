-- Keep five-parameter reminder facts in sync with the full trimmed JS greeting.
begin;
do $upgrade$
declare def text;patch_point text;
begin
  def:=pg_get_functiondef('public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text)'::regprocedure);
  patch_point:=$old$split_part(btrim(translate(x.name,U&'\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\202f\205f\3000\feff',repeat(' ',18))),' ',1)$old$;
  if position(patch_point in def)=0 then raise exception 'Reminder full customer name patch point missing';end if;
  def:=replace(def,patch_point,$new$btrim(translate(x.name,U&'\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\202f\205f\3000\feff',repeat(' ',18)))$new$);
  execute def;
end $upgrade$;
commit;
