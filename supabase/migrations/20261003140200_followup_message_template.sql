-- Keep editable customer reminder copy in the existing workspace preference
-- document. Template edits are owner-only, bounded, and revoke stale approvals.
create or replace function app.normalize_reminder_punctuation(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(coalesce(p_text, ''), '[[:space:],]*[—–][[:space:]]*', ', ', 'g'),
      '(,[[:space:]]*,[[:space:]]*)+', ', ', 'g'),
    '^[[:space:]]*,[[:space:]]*|[[:space:]]*,[[:space:]]*$', '', 'g'));
$$;
revoke all on function app.normalize_reminder_punctuation(text) from public, anon;
grant execute on function app.normalize_reminder_punctuation(text) to authenticated, service_role;

create or replace function app.guard_followup_reminder_template()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  template_text text;
  remaining_text text;
  placeholder text;
  template_changed boolean := false;
begin
  if jsonb_typeof(new.follow_up_preferences) is distinct from 'object' then
    raise exception 'Invalid follow-up preferences' using errcode = '22023';
  end if;

  if new.follow_up_preferences ? 'reminderTemplate' then
    if jsonb_typeof(new.follow_up_preferences->'reminderTemplate') is distinct from 'string' then
      raise exception 'Reminder template must be text' using errcode = '22023';
    end if;
    template_text := new.follow_up_preferences->>'reminderTemplate';
    template_text := replace(replace(template_text, E'\r\n', E'\n'), E'\r', E'\n');
    template_text := replace(template_text, E'\t', ' ');
    template_text := app.normalize_reminder_punctuation(template_text);
    if length(template_text) > 1000 then
      raise exception 'Reminder template must be 1,000 characters or fewer' using errcode = '22023';
    end if;
    if translate(template_text, E'\n', '') ~ '[[:cntrl:]]' then
      raise exception 'Reminder template contains an unsupported control character' using errcode = '22023';
    end if;
    remaining_text := template_text;
    foreach placeholder in array array['business_name','customer_name','invoice_number','balance','due_date'] loop
      remaining_text := replace(remaining_text, '{{' || placeholder || '}}', '');
    end loop;
    if remaining_text ~ '[{}]' then
      raise exception 'Reminder template contains an unsupported or incomplete placeholder' using errcode = '22023';
    end if;
    new.follow_up_preferences := jsonb_set(new.follow_up_preferences, '{reminderTemplate}', to_jsonb(template_text), true);
  end if;

  if tg_op = 'INSERT' then
    template_changed := new.follow_up_preferences ? 'reminderTemplate';
  else
    template_changed := (new.follow_up_preferences->'reminderTemplate')
      is distinct from (old.follow_up_preferences->'reminderTemplate');
  end if;
  if template_changed and auth.uid() is not null and not exists (
    select 1 from public.workspaces w
    where w.id = new.workspace_id and w.owner_id = auth.uid()
  ) then
    raise exception 'Only the workspace owner may update the reminder template' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger workspace_reminder_template_guard
  before insert or update on public.workspace_settings
  for each row execute function app.guard_followup_reminder_template();
revoke all on function app.guard_followup_reminder_template() from public, anon, authenticated;

create or replace function app.require_branded_reminder_approval()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  business text;
  normalized_business text;
  body text;
begin
  if new.metadata->>'followup_state' = 'approved' and (
    tg_op = 'INSERT'
    or new.metadata->>'followup_state' is distinct from old.metadata->>'followup_state'
    or new.metadata->>'approved_reminder_text' is distinct from old.metadata->>'approved_reminder_text'
  ) then
    select business_name into business from public.workspace_settings where workspace_id = new.workspace_id;
    normalized_business := app.normalize_reminder_punctuation(business);
    body := btrim(new.metadata->>'approved_reminder_text');
    if normalized_business is null or normalized_business = '' or body is null or body = ''
      or position(chr(8212) in body) > 0 or position(chr(8211) in body) > 0
      or not (
        body = normalized_business
        or right(body, length(normalized_business) + 2) = E'\n\n' || normalized_business
      ) then
      raise exception 'Approve a reminder containing the configured business name';
    end if;
  end if;
  return new;
end;
$$;

-- Invoice details appear in rendered template tokens. Any change to those
-- facts removes stale draft and approval text so the dashboard must rebuild
-- the preview from the refreshed row before another owner approval.
create or replace function app.invalidate_followup_invoice_fact_approvals()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  invoice_facts_changed boolean;
begin
  invoice_facts_changed :=
    new.total_amount is distinct from old.total_amount
    or new.amount_paid is distinct from old.amount_paid
    or new.status is distinct from old.status
    or new.due_date is distinct from old.due_date
    or new.currency is distinct from old.currency
    or new.invoice_number is distinct from old.invoice_number
    or new.customer_id is distinct from old.customer_id
    or new.customer_phone is distinct from old.customer_phone
    or new.metadata->>'invoice_direction' is distinct from old.metadata->>'invoice_direction'
    or new.metadata->>'client_name' is distinct from old.metadata->>'client_name'
    or new.metadata->>'debtor_phone' is distinct from old.metadata->>'debtor_phone';

  if not invoice_facts_changed then
    return new;
  end if;

  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    - 'reminder_text' - 'approved_reminder_text' - 'approved_preferences_updated_at';
  if new.status::text not in ('paid','void','cancelled')
     and new.total_amount > 0 and new.amount_paid < new.total_amount
     and new.followup_state in ('approved','active','scheduled') then
    new.followup_state := 'draft';
  end if;
  new.next_follow_up_at := null;
  new.metadata := jsonb_set(
    jsonb_set(new.metadata, '{followup_state}', to_jsonb(new.followup_state), true),
    '{next_follow_up_at}', 'null'::jsonb, true);
  return new;
end;
$$;
drop trigger if exists zz_invoices_invalidate_followup_fact_approvals on public.invoices;
create trigger zz_invoices_invalidate_followup_fact_approvals
  before update on public.invoices
  for each row execute function app.invalidate_followup_invoice_fact_approvals();
revoke all on function app.invalidate_followup_invoice_fact_approvals() from public, anon, authenticated;

create or replace function app.invalidate_followup_template_drafts()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if (new.follow_up_preferences->'reminderTemplate')
       is distinct from (old.follow_up_preferences->'reminderTemplate') then
    update public.invoices
      set metadata = metadata - 'reminder_text'
      where workspace_id = new.workspace_id
        and metadata ? 'reminder_text'
        and metadata->>'invoice_direction' = 'receivable'
        and amount_paid < total_amount
        and status not in ('paid','void','cancelled');
  end if;
  return new;
end;
$$;
create trigger workspace_settings_invalidate_followup_template_drafts
  after update of follow_up_preferences on public.workspace_settings
  for each row execute function app.invalidate_followup_template_drafts();
revoke all on function app.invalidate_followup_template_drafts() from public, anon, authenticated;
