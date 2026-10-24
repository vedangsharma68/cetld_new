-- Sent and overdue receivables share the same local reminder status gate,
-- regardless of external linkage. All other eligibility checks stay in place.
-- The fresh-external-read migration already routes owner approval, final
-- authorization and both signed-receipt continuation predicates through it.
begin;

create or replace function app.reminder_local_status_payable(i public.invoices) returns boolean
language sql immutable set search_path='' as $$
 select i.status in ('sent','overdue');
$$;
revoke all on function app.reminder_local_status_payable(public.invoices) from public,anon,authenticated,service_role;

-- Keep these security-invoker predicates inline: callers have no EXECUTE
-- privilege on the private reminder status helper. No approval backfill.
create or replace function public.business_name_reminder_pause_count(p_workspace_id uuid)
returns integer language sql stable security invoker set search_path='' as $$
  select count(*)::integer from public.invoices
    where workspace_id=p_workspace_id and deleted_at is null and status in ('sent','overdue')
      and nullif(btrim(metadata->>'approved_reminder_text'),'') is not null;
$$;
revoke all on function public.business_name_reminder_pause_count(uuid) from public,anon;
grant execute on function public.business_name_reminder_pause_count(uuid) to authenticated,service_role;

create or replace function app.invalidate_core_followup_approvals()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.business_name is distinct from old.business_name then
    -- Include previously paused/stale approvals, using the same predicate as
    -- the impact count. The existing paused state enables dashboard re-review.
    update public.invoices set metadata=metadata||jsonb_build_object(
      'followup_state','paused','next_follow_up_at',null,
      'approved_reminder_text',null,'approved_preferences_updated_at',null,
      'reminder_review_reason','business_name_changed')
      where workspace_id=new.workspace_id and deleted_at is null and status in ('sent','overdue')
        and nullif(btrim(metadata->>'approved_reminder_text'),'') is not null;
  end if;
  -- Preserve existing preference/timezone and active-approval invalidation.
  if new.follow_up_preferences is distinct from old.follow_up_preferences
    or new.default_timezone is distinct from old.default_timezone
    or new.business_name is distinct from old.business_name then
    update public.invoices set metadata=metadata||jsonb_build_object('followup_state','paused',
      'next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null)
      where workspace_id=new.workspace_id and followup_state in ('approved','active','scheduled');
  end if;
  return new;
end; $$;
revoke all on function app.invalidate_core_followup_approvals() from public,anon,authenticated;

-- cetld_core_claim_due_followups and cetld_core_authorize_delivery retain their
-- existing paid/void/cancelled status refusals. No other guard is replaced.
commit;
