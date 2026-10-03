-- Provider button references are persisted independently from their visible title.
-- The service-role inbox already owns access to the whole event row.
alter table public.whatsapp_inbound_events
  add column if not exists interaction_id text
  check (interaction_id is null or length(interaction_id) between 1 and 256);
