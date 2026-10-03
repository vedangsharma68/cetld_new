
create table if not exists public.ai_provider_health (
  provider text not null check (provider in ('cloudflare', 'google', 'openrouter', 'opencode-zen')),
  model text not null check (char_length(model) between 1 and 200),
  account_fingerprint text not null check (account_fingerprint ~ '^[a-f0-9]{64}$'),
  credential_fingerprint text not null check (credential_fingerprint ~ '^[a-f0-9]{64}$'),
  disabled_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (provider, model, account_fingerprint, credential_fingerprint)
);

alter table public.ai_provider_health enable row level security;
revoke all on table public.ai_provider_health from public, anon, authenticated;
grant select, insert, update, delete on table public.ai_provider_health to service_role;

create index if not exists ai_provider_health_disabled_until_idx
  on public.ai_provider_health (disabled_until);
