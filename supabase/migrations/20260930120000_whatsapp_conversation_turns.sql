create table public.whatsapp_conversation_turns (
  id bigserial primary key,
  workspace_id uuid not null,
  customer_id uuid,
  phone text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index whatsapp_conversation_turns_phone_workspace_created_idx
  on public.whatsapp_conversation_turns (phone, workspace_id, created_at desc);

alter table public.whatsapp_conversation_turns enable row level security;
alter table public.whatsapp_conversation_turns force row level security;
revoke all on public.whatsapp_conversation_turns from public, anon, authenticated;
grant select, insert, delete on public.whatsapp_conversation_turns to service_role;
revoke all on sequence public.whatsapp_conversation_turns_id_seq from public, anon, authenticated;
grant usage, select on sequence public.whatsapp_conversation_turns_id_seq to service_role;
