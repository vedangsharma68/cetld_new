-- Preserve bounded assistant/provider diagnostics for terminal inbound failures.
-- Planner fallbacks remain successfully processed (`done`) and are not retried
-- by the durable inbox because the user already received the safe reply.
alter table public.whatsapp_inbound_events
  add column error_detail text check (error_detail is null or length(error_detail) <= 1000);
