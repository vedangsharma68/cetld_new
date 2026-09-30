-- Favor fresh questions over older slow/retrying work so one poisoned event
-- cannot cause head-of-line blocking. Keep the existing lease and attempt cap.
create or replace function public.whatsapp_claim_inbound_events(p_limit integer)
returns setof public.whatsapp_inbound_events
language sql security definer set search_path = public, pg_temp
as $$
  update public.whatsapp_inbound_events e
  set status = 'processing',
      attempts = e.attempts + 1,
      claimed_at = now(),
      claim_token = gen_random_uuid()
  from (
    select id from public.whatsapp_inbound_events
    where ((status = 'pending' and next_attempt_at <= now())
      or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
      and attempts < 5
    order by id desc
    for update skip locked
    limit least(greatest(p_limit, 1), 25)
  ) pending
  where e.id = pending.id
  returning e.*;
$$;
revoke all on function public.whatsapp_claim_inbound_events(integer) from public, anon, authenticated;
grant execute on function public.whatsapp_claim_inbound_events(integer) to service_role;
