-- Older reviews can list dueDate as missing. A scoped owner reply that the
-- source shows no due date resolves that field to JSON null, never a guess.
-- Keep the versioned transition, fixed financial facts and evidence scope.
begin;
do $migration$
declare
  target regprocedure := 'public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure;
  definition text;
  old_null text := $old$or v_fact->'value' is null or v_fact->'value' = 'null'::jsonb$old$;
  new_null text := $new$or v_fact->'value' is null or (v_fact->'value' = 'null'::jsonb and v_field <> 'dueDate')$new$;
  old_evidence text := $old$and m.status in ('received','accepted') and m.created_at >= v_created_at$old$;
  new_evidence text := $new$and m.status in ('received','accepted') and m.created_at >= v_created_at
            and (v_field <> 'dueDate' or v_fact->'value' <> 'null'::jsonb or (
              m.body ~* '(\mno\s+due\s+date\M|\mdue\s+date\s+(is\s+)?(not\s+(shown|printed|specified)|unknown|absent)\M)'
              and m.body !~* '[?"“”`]|\m(maybe|perhaps|might|if|whether|invent|assume|guess)\M'
              and m.body !~* '\m(not|never)\s+(true\s+that\s+)?(there\s+is\s+)?no\s+due\s+date\M'
            ))$new$;
begin
  select pg_get_functiondef(target) into definition;
  if position(old_null in definition)=0 or position(old_evidence in definition)=0 then
    raise exception 'unexpected invoice review function: unknown due-date patch not applied';
  end if;
  execute replace(replace(definition,old_null,new_null),old_evidence,new_evidence);
end
$migration$;
commit;
