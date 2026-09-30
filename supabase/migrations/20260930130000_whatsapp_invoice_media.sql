alter table public.whatsapp_inbound_events
  add column media_id text,
  add column media_mime_type text,
  add column media_caption text,
  add column media_ref text,
  add column media_error text;

create table public.whatsapp_inbound_media (
  provider_message_id text primary key,
  media_id text not null,
  mime_type text not null,
  bytes bytea not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default now()
);

create table public.whatsapp_pending_actions (
  id bigserial primary key,
  workspace_id uuid not null,
  customer_id uuid not null,
  phone text not null,
  action jsonb not null,
  source text not null check (source = 'whatsapp'),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create unique index whatsapp_pending_actions_active_scope_idx
  on public.whatsapp_pending_actions (workspace_id, customer_id, phone)
  where consumed_at is null;

create index whatsapp_pending_actions_scope_created_idx
  on public.whatsapp_pending_actions (workspace_id, customer_id, phone, created_at desc);

alter table public.whatsapp_inbound_media enable row level security;
alter table public.whatsapp_inbound_media force row level security;
alter table public.whatsapp_pending_actions enable row level security;
alter table public.whatsapp_pending_actions force row level security;
revoke all on public.whatsapp_inbound_media, public.whatsapp_pending_actions from public, anon, authenticated;
grant select, insert, update on public.whatsapp_inbound_media, public.whatsapp_pending_actions to service_role;
revoke all on sequence public.whatsapp_pending_actions_id_seq from public, anon, authenticated;
grant usage, select on sequence public.whatsapp_pending_actions_id_seq to service_role;
