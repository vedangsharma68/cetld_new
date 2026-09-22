create or replace function app.prevent_last_owner_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  -- During an ON DELETE CASCADE the parent workspace is already invisible.
  if tg_op = 'DELETE' and not exists (
    select 1 from public.workspaces w where w.id = old.workspace_id
  ) then
    return old;
  end if;
  if old.role = 'owner'::public.workspace_role and (tg_op = 'DELETE' or new.role <> old.role) then
    if not exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = old.workspace_id and wm.user_id <> old.user_id and wm.role = 'owner'::public.workspace_role
    ) then
      raise exception 'a workspace must retain an owner' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    raise exception 'user_id is immutable' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
