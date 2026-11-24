# Open signup focused checks

Run `node --test tests/open-signup/client.test.mjs` and `POSTGRES_BIN=/path/to/postgres/bin python3 tests/open-signup/native.py`.

The native runner uses a fresh loopback PostgreSQL database, synthetic UUIDs and the read-only-captured production create_workspace function. It verifies owner binding, verified-email requirement, foreign-owner denial, business creation cap, and anon/service_role rejection. It never connects to hosted data. PostgreSQL tools and psql must be installed.

The browser UI remains backed by Supabase Auth. Production currently has email confirmation enabled, no custom SMTP and no Send Email hook. External email/password signup therefore cannot complete with the default sender. Google authorize redirects successfully, but a new external-account OAuth handshake is not proven. Do not claim full signup readiness. No email settings are weakened by this patch.

Rollout must apply and verify the SQL before a production frontend build. Both signup and separate dispatch capabilities are checked by scripts/build-frontend.mjs under VERCEL_ENV=production. Preserve firewall bot-endpoint denials and do not release queued sends. Crons are removed from this candidate; that does not prove existing production crons were inactive.
