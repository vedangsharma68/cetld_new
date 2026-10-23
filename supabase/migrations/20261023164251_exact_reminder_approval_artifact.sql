-- Text representation only: the artifact mirrors the immutable reviewed outgoing body.
-- Preserve every existing approval/eligibility check and all existing receipts.
begin;
create function app.reminder_artifact_text(delivery jsonb,body text,business text) returns text
language sql immutable set search_path='' as $$
 select case when delivery->>'artifactVersion'='1' then body else app.review_approval_text(body,business) end
$$;
revoke all on function app.reminder_artifact_text(jsonb,text,text) from public,anon,authenticated,service_role;

-- Patch only representation comparisons. Abort atomically if a predecessor
-- changed; never replace the consent, payment, snapshot or approval requirements.
do $patch$
declare definition text;old_text text;new_text text;
begin
 definition:=pg_get_functiondef('app.owner_assistant_reminder(uuid,uuid,uuid,boolean,text,text,jsonb,jsonb,boolean)'::regprocedure);
 old_text:='app.review_approval_text(p_preview,s.business_name)';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>2 then raise exception 'Reminder artifact approval patch points changed';end if;
 definition:=replace(definition,old_text,'app.reminder_artifact_text(d,p_preview,s.business_name)');
 execute definition;

 definition:=pg_get_functiondef('app.evaluate_reviewed_reminder(uuid,uuid,uuid,uuid,jsonb,text,boolean)'::regprocedure);
 old_text:='app.review_approval_text(r.approved_text,s.business_name)';
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'Reminder artifact receipt patch point changed';end if;
 definition:=replace(definition,old_text,'app.reminder_artifact_text(d,r.approved_text,s.business_name)');
 execute definition;

 -- Legacy approvals still require their original business signature. An exact-word
 -- artifact must instead be backed by the already-created private approval
 -- receipt, with exactly the same owner, business, invoice, delivery and words.
 -- This trigger retains invoker security: a direct client cannot read or forge
 -- the protected receipt. Only the existing approval routine creates one.
 definition:=pg_get_functiondef('app.require_branded_reminder_approval()'::regprocedure);
 old_text:=$old$    select business_name into business from public.workspace_settings where workspace_id = new.workspace_id;$old$;
 if (length(definition)-length(replace(definition,old_text,'')))/length(old_text)<>1 then raise exception 'Reminder artifact branding patch point changed';end if;
 new_text:=$new$    if new.metadata#>>'{approved_reminder_delivery,artifactVersion}'='1' then
      if exists(select 1 from app.reminder_approvals r join public.workspaces w on w.id=r.workspace_id and w.owner_id=r.owner_id
        where r.id::text=new.metadata#>>'{approved_reminder_delivery,approvalId}'
        and r.workspace_id=new.workspace_id and r.invoice_id=new.id
        and r.delivery=new.metadata->'approved_reminder_delivery'
        and r.approved_text=new.metadata->>'approved_reminder_text'
        and r.approved_text=r.delivery->>'body') then return new;end if;
      raise exception 'Approve the exact reviewed reminder words';
    end if;
$new$||old_text;
 definition:=replace(definition,old_text,new_text);
 execute definition;
end $patch$;
commit;
