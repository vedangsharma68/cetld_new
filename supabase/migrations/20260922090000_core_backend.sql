-- cetld core backend: tenants, billing records, profiles, and private invoice files
-- Apply after the project is otherwise empty. Google provider/client configuration is
-- managed by Supabase Auth and is intentionally outside this migration.

create extension if not exists pgcrypto;

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;

create type public.workspace_role as enum ('owner', 'admin', 'member');
create type public.invoice_status as enum ('draft', 'sent', 'overdue', 'paid', 'void', 'cancelled');

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id)
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  unique (workspace_id, user_id, role)
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or length(btrim(full_name)) between 1 and 160),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  business_name text check (business_name is null or length(btrim(business_name)) between 1 and 200),
  default_currency text not null default 'INR' check (default_currency ~ '^[A-Z]{3}$'),
  default_timezone text not null default 'Asia/Kolkata',
  follow_up_preferences jsonb not null default '{}'::jsonb check (jsonb_typeof(follow_up_preferences) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  company_name text,
  email text,
  phone text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index customers_workspace_email_unique
  on public.customers (workspace_id, lower(email)) where email is not null;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  customer_id uuid not null,
  invoice_number text not null check (length(btrim(invoice_number)) between 1 and 100),
  issue_date date not null default current_date,
  due_date date,
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  total_amount numeric(18,2) not null check (total_amount >= 0),
  amount_paid numeric(18,2) not null default 0 check (amount_paid >= 0 and amount_paid <= total_amount),
  status public.invoice_status not null default 'draft',
  notes text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, invoice_number),
  foreign key (workspace_id, customer_id) references public.customers(workspace_id, id) on delete restrict,
  check (due_date is null or due_date >= issue_date)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  paid_at timestamptz not null default now(),
  method text,
  reference text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, invoice_id) references public.invoices(workspace_id, id) on delete cascade
);

create table public.invoice_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null,
  storage_path text not null check (length(storage_path) between 10 and 1024),
  file_name text not null check (length(btrim(file_name)) between 1 and 255),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_path),
  unique (workspace_id, id),
  foreign key (workspace_id, invoice_id) references public.invoices(workspace_id, id) on delete cascade
);

create or replace function app.set_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function app.prevent_workspace_change()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.workspace_id is distinct from new.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function app.prevent_workspace_owner_change()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if old.owner_id is distinct from new.owner_id then
    raise exception 'owner_id is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function app.workspace_role_for(p_workspace_id uuid, p_user_id uuid default auth.uid())
returns public.workspace_role
language sql stable security definer set search_path = pg_catalog, public
as $$
  select wm.role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id
  limit 1
$$;

create or replace function app.is_workspace_member(p_workspace_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select p_user_id is not null and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id
  )
$$;

create or replace function app.can_manage_settings(p_workspace_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select app.workspace_role_for(p_workspace_id, p_user_id) in ('owner'::public.workspace_role, 'admin'::public.workspace_role)
$$;

create or replace function app.can_manage_member(p_workspace_id uuid, p_target_role public.workspace_role, p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = pg_catalog, public
as $$
  select case app.workspace_role_for(p_workspace_id, p_user_id)
    when 'owner'::public.workspace_role then true
    when 'admin'::public.workspace_role then p_target_role = 'member'::public.workspace_role
    else false
  end
$$;

create or replace function app.valid_invoice_file_path(p_name text)
returns boolean
language plpgsql stable security definer set search_path = pg_catalog, public
as $$
declare
  parts text[];
  ws uuid;
  inv uuid;
begin
  if p_name is null then return false; end if;
  parts := string_to_array(p_name, '/');
  if coalesce(array_length(parts, 1), 0) <> 3 or parts[3] = '' then return false; end if;
  if parts[1] !~ '^[0-9a-fA-F-]{36}$' or parts[2] !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  begin
    ws := parts[1]::uuid;
    inv := parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return app.is_workspace_member(ws) and exists (
    select 1 from public.invoices i where i.workspace_id = ws and i.id = inv
  );
end;
$$;

create or replace function app.handle_new_user()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles(user_id, full_name, avatar_url)
  values (
    new.id,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')), ''),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')), '')
  ) on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

create or replace function app.prevent_last_owner_change()
returns trigger language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
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

create trigger workspaces_updated_at before update on public.workspaces for each row execute function app.set_updated_at();
create trigger workspace_members_updated_at before update on public.workspace_members for each row execute function app.set_updated_at();
create trigger profiles_updated_at before update on public.profiles for each row execute function app.set_updated_at();
create trigger workspace_settings_updated_at before update on public.workspace_settings for each row execute function app.set_updated_at();
create trigger customers_updated_at before update on public.customers for each row execute function app.set_updated_at();
create trigger invoices_updated_at before update on public.invoices for each row execute function app.set_updated_at();
create trigger payments_updated_at before update on public.payments for each row execute function app.set_updated_at();
create trigger invoice_files_updated_at before update on public.invoice_files for each row execute function app.set_updated_at();
create trigger workspaces_owner_immutable before update on public.workspaces for each row execute function app.prevent_workspace_owner_change();
create trigger members_owner_guard before delete or update on public.workspace_members for each row execute function app.prevent_last_owner_change();
create trigger members_workspace_immutable before update on public.workspace_members for each row execute function app.prevent_workspace_change();
create trigger settings_workspace_immutable before update on public.workspace_settings for each row execute function app.prevent_workspace_change();
create trigger customers_workspace_immutable before update on public.customers for each row execute function app.prevent_workspace_change();
create trigger invoices_workspace_immutable before update on public.invoices for each row execute function app.prevent_workspace_change();
create trigger payments_workspace_immutable before update on public.payments for each row execute function app.prevent_workspace_change();
create trigger invoice_files_workspace_immutable before update on public.invoice_files for each row execute function app.prevent_workspace_change();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.profiles enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.customers enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.invoice_files enable row level security;

alter table public.workspaces force row level security;
alter table public.workspace_members force row level security;
alter table public.profiles force row level security;
alter table public.workspace_settings force row level security;
alter table public.customers force row level security;
alter table public.invoices force row level security;
alter table public.payments force row level security;
alter table public.invoice_files force row level security;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on public.workspaces, public.workspace_members, public.profiles, public.workspace_settings, public.customers, public.invoices, public.payments, public.invoice_files to authenticated;
grant execute on function app.workspace_role_for(uuid, uuid), app.is_workspace_member(uuid, uuid), app.can_manage_settings(uuid, uuid), app.can_manage_member(uuid, public.workspace_role, uuid), app.valid_invoice_file_path(text) to authenticated;

create policy workspaces_select on public.workspaces for select to authenticated using (app.is_workspace_member(id));
create policy workspaces_update on public.workspaces for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy workspaces_delete on public.workspaces for delete to authenticated using (owner_id = (select auth.uid()));

create policy members_select on public.workspace_members for select to authenticated using (app.is_workspace_member(workspace_id));
create policy members_insert on public.workspace_members for insert to authenticated with check (app.can_manage_member(workspace_id, role));
create policy members_update on public.workspace_members for update to authenticated using (app.can_manage_member(workspace_id, role) and user_id <> (select auth.uid())) with check (app.can_manage_member(workspace_id, role) and user_id <> (select auth.uid()));
create policy members_delete on public.workspace_members for delete to authenticated using (app.can_manage_member(workspace_id, role) and user_id <> (select auth.uid()));

create policy profiles_select on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy profiles_delete on public.profiles for delete to authenticated using (user_id = (select auth.uid()));

create policy settings_select on public.workspace_settings for select to authenticated using (app.is_workspace_member(workspace_id));
create policy settings_insert on public.workspace_settings for insert to authenticated with check (app.can_manage_settings(workspace_id));
create policy settings_update on public.workspace_settings for update to authenticated using (app.can_manage_settings(workspace_id)) with check (app.can_manage_settings(workspace_id));
create policy settings_delete on public.workspace_settings for delete to authenticated using (app.can_manage_settings(workspace_id));

create policy customers_select on public.customers for select to authenticated using (app.is_workspace_member(workspace_id));
create policy customers_insert on public.customers for insert to authenticated with check (app.is_workspace_member(workspace_id));
create policy customers_update on public.customers for update to authenticated using (app.is_workspace_member(workspace_id)) with check (app.is_workspace_member(workspace_id));
create policy customers_delete on public.customers for delete to authenticated using (app.is_workspace_member(workspace_id));

create policy invoices_select on public.invoices for select to authenticated using (app.is_workspace_member(workspace_id));
create policy invoices_insert on public.invoices for insert to authenticated with check (app.is_workspace_member(workspace_id));
create policy invoices_update on public.invoices for update to authenticated using (app.is_workspace_member(workspace_id)) with check (app.is_workspace_member(workspace_id));
create policy invoices_delete on public.invoices for delete to authenticated using (app.is_workspace_member(workspace_id));

create policy payments_select on public.payments for select to authenticated using (app.is_workspace_member(workspace_id));
create policy payments_insert on public.payments for insert to authenticated with check (app.is_workspace_member(workspace_id));
create policy payments_update on public.payments for update to authenticated using (app.is_workspace_member(workspace_id)) with check (app.is_workspace_member(workspace_id));
create policy payments_delete on public.payments for delete to authenticated using (app.is_workspace_member(workspace_id));

create policy invoice_files_select on public.invoice_files for select to authenticated using (app.is_workspace_member(workspace_id));
create policy invoice_files_insert on public.invoice_files for insert to authenticated with check (app.is_workspace_member(workspace_id));
create policy invoice_files_update on public.invoice_files for update to authenticated using (app.is_workspace_member(workspace_id)) with check (app.is_workspace_member(workspace_id));
create policy invoice_files_delete on public.invoice_files for delete to authenticated using (app.is_workspace_member(workspace_id));

create or replace function public.create_workspace(p_name text, p_slug text default null)
returns public.workspaces
language plpgsql security definer set search_path = pg_catalog, public, auth
as $$
declare
  caller uuid := auth.uid();
  clean_name text := btrim(p_name);
  clean_slug text := nullif(lower(btrim(p_slug)), '');
  created public.workspaces;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if clean_name is null or length(clean_name) = 0 then raise exception 'workspace name is required' using errcode = '22023'; end if;
  if clean_slug is null then
    clean_slug := lower(regexp_replace(clean_name, '[^a-zA-Z0-9]+', '-', 'g'));
    clean_slug := trim(both '-' from clean_slug);
    clean_slug := left(clean_slug, 55) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  end if;
  if clean_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' then
    raise exception 'invalid workspace slug' using errcode = '22023';
  end if;
  insert into public.workspaces(owner_id, name, slug) values (caller, clean_name, clean_slug) returning * into created;
  insert into public.workspace_members(workspace_id, user_id, role) values (created.id, caller, 'owner');
  insert into public.workspace_settings(workspace_id, business_name) values (created.id, clean_name);
  return created;
exception when unique_violation then
  raise exception 'workspace slug already exists' using errcode = '23505';
end;
$$;
revoke all on function public.create_workspace(text, text) from public;
grant execute on function public.create_workspace(text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-files', 'invoice-files', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists invoice_files_object_select on storage.objects;
drop policy if exists invoice_files_object_insert on storage.objects;
drop policy if exists invoice_files_object_update on storage.objects;
drop policy if exists invoice_files_object_delete on storage.objects;
create policy invoice_files_object_select on storage.objects for select to authenticated
  using (bucket_id = 'invoice-files' and app.valid_invoice_file_path(name));
create policy invoice_files_object_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-files' and app.valid_invoice_file_path(name));
create policy invoice_files_object_update on storage.objects for update to authenticated
  using (bucket_id = 'invoice-files' and app.valid_invoice_file_path(name))
  with check (bucket_id = 'invoice-files' and app.valid_invoice_file_path(name));
create policy invoice_files_object_delete on storage.objects for delete to authenticated
  using (bucket_id = 'invoice-files' and app.valid_invoice_file_path(name));

comment on table public.workspaces is 'Tenant boundary. All business records carry an immutable workspace_id.';
comment on table public.invoice_files is 'Metadata for private Storage objects at workspace UUID/invoice UUID/random filename.';
