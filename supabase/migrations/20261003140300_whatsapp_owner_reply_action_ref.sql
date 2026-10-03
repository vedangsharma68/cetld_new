-- Reply retries keep only a pointer to the pending row. Signed button tokens
-- are regenerated from the live workspace/phone-bound action when replayed.
alter table public.whatsapp_messages
  add column if not exists owner_action_ref jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='whatsapp_messages_owner_action_ref_check'
      and conrelid='public.whatsapp_messages'::regclass
  ) then
    alter table public.whatsapp_messages
      add constraint whatsapp_messages_owner_action_ref_check check (
        owner_action_ref is null or (
          direction='outbound'
          and audience='owner'
          and jsonb_typeof(owner_action_ref)='object'
          and owner_action_ref ? 'pendingId'
          and owner_action_ref ? 'pendingVersion'
          and (owner_action_ref - 'pendingId' - 'pendingVersion')='{}'::jsonb
          and jsonb_typeof(owner_action_ref->'pendingId')='number'
          and jsonb_typeof(owner_action_ref->'pendingVersion')='number'
          and owner_action_ref->>'pendingId' ~ '^[1-9][0-9]{0,15}$'
          and owner_action_ref->>'pendingVersion' ~ '^[1-9][0-9]{0,8}$'
        )
      );
  end if;
end;
$$;
