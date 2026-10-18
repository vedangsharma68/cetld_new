-- Forward-only schema change; reviewed and applied separately by the owner.
-- No consent, schedules, environment flags or outbound messages are changed.
begin;
alter table public.customers add column reminder_tone text
  constraint customers_reminder_tone_check
  check(reminder_tone is null or reminder_tone in ('gentle','relaxed','firm','professional'));
comment on column public.customers.reminder_tone is
  'Optional WhatsApp reminder tone. NULL inherits workspace follow-up tone, then professional.';
-- A wording change requires a fresh approval for every affected invoice.
create function app.invalidate_customer_reminder_tone() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  update public.invoices set metadata=metadata||jsonb_build_object('followup_state','paused',
    'next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null)
    where workspace_id=new.workspace_id and customer_id=new.id
      and followup_state in ('approved','active','scheduled');
  return new;
end $$;
create trigger customers_reminder_tone_invalidate after update of reminder_tone on public.customers
  for each row when(old.reminder_tone is distinct from new.reminder_tone)
  execute function app.invalidate_customer_reminder_tone();
revoke all on function app.invalidate_customer_reminder_tone() from public,anon,authenticated,service_role;
commit;
