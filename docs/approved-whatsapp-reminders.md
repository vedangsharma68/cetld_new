# Approved WhatsApp reminder delivery

This release is based on main 9836c4c and contains only reminder work. It does
not include the unpublished owner target-plan repair 5bc2e1d.

The immutable code catalog selects one of the four owner-verified Meta Utility
templates. Language is en. Parameters are exactly business name, current invoice
number and current customer name. Gentle selects the quick-note template;
Professional and Firm select the update template. Settings > Follow-up
preferences > Use the approved WhatsApp template with reply buttons selects the
button variant. Static buttons come from Meta's approved template; this release
does not invent button labels, URLs or counts. Custom reminder text is a dashboard
draft and cannot replace the Meta delivery template.

Run supabase/migrations/20261005070000_approved_whatsapp_reminders.sql as one
transaction in the project's SQL Editor. The migration installs a new
three-parameter catalog, scoped atomic reservation, local payment verification,
durable message/status receipts, STOP locking and button handling. It does not
install the old disabled proposal, enable sending, create consent or schedule an
invoice. The release process must not apply this SQL automatically.

Existing server credentials are reused. Scheduled delivery additionally requires
WHATSAPP_PROVIDER=first_party_meta, WHATSAPP_REMINDER_PAYMENT_MODE=local_verified,
and all of AUTOMATION_OUTBOUND_ENABLED, WHATSAPP_OUTBOUND_ENABLED,
WHATSAPP_REMINDERS_ENABLED, WHATSAPP_REMINDER_RECEIPTS_ENABLED and
WHATSAPP_REMINDER_SCHEDULER_ENABLED to equal true. AUTOMATION_WORKSPACES is the
reviewed server list of ownerId/workspaceId pairs; arbitrary request scopes are
not added. WHATSAPP_TEST_ALLOWLIST is mandatory and can only narrow the fixed
QA set +919871367051 and +919818685252. The proof below may use only the first
number. Keep scheduled delivery disabled while QA proof is pending.

WHATSAPP_WABA_ID must be 1734116767674237. WHATSAPP_PHONE_NUMBER_ID,
WHATSAPP_GRAPH_API_VERSION, WHATSAPP_ACCESS_TOKEN and WHATSAPP_APP_SECRET remain
the existing server configuration. No en_US fallback, new credential, billing
upgrade, or LLM call is used. Missing flags, migration, consent, suppression
checks, payment verification or account configuration fail closed.

The existing worker can run the scoped tick. /api/whatsapp-process also runs
the daily reminder cron at 04:00 UTC (09:30 Asia/Kolkata), selected by Vercel's
x-vercel-cron-schedule header and verified with existing CRON_SECRET. The midnight
processing job retains its existing behavior. Both jobs share a function to stay
within the existing Hobby function limit. Invoice scheduling, local contact windows, owner pause, payment,
reminder limits and preference versions remain authoritative. Daily cron is a
daily opportunity to send, not minute-level delivery. Faster scheduling requires
the existing external worker; no paid upgrade is introduced. Only local invoices
with coherent payment history are supported; linked external accounting remains
blocked until a separately verified balance adapter is available.

Accepted requests are not proof of delivery. Signed, account-filtered webhook
statuses update both durable reminder receipts and dashboard conversation
messages. Interrupted dispatches remain reserved/quarantined and cannot resend.
Button replies of type button must reference an actual button-template dispatch
to the same phone. Scope comes from the saved receipt. Stop revokes consent and
suppresses that workspace; other verified button replies pause follow-ups.
Unmatched buttons never invoke a model or select another tenant.

## One-message proof procedure

Parent coordinates the recipient UI and performs the single send after confirming
the migration is installed. The own-number contact currently has active consent
but no invoice. The proof therefore uses synthetic reference CETLD-TEST-20261005;
it creates only a message intent and does not create/change financial records.

Use the existing authenticated application request helper. Do not expose JWTs or
server secrets. GET /api/whatsapp-test-send with action=approved-template-test
and the current workspaceId previews the fixed own-number test. It verifies the
actual Meta template status, category, en language and exact three-parameter body
before any send. Only the configured owner/operator can invoke it, and the existing
outbound enable and QA allowlist remain required.

After parent coordination, POST the same endpoint with JSON
{"action":"approved-template-test","workspaceId":"9a83b58d-6b02-4b17-8de5-c67136f26434"}.
No recipient, template, custom text or invoice ID is accepted in this action.
The SQL gate independently rechecks owner scope, consent, suppression and DB
facts, then reserves approved-template-proof:20261005 exactly once. This POST
requires the migration. Repeated/uncertain calls cannot resend, including after
a process restart. Record the returned Graph message ID. Correlate its actual
signed delivered/read webhook status and timestamp through whatsapp_messages;
API accepted alone is insufficient. No customer campaign is authorized by proof.

The separate GET action=templates diagnostic reads the four exact English
template definitions from the existing account. It is protected by the same
owner/operator configuration, fixed QA recipient and server-only credentials.
This GET is metadata evidence only and cannot send or mutate records.

The release gate strips live credentials and runs the mocked offline battery.
The new integration tests execute the forward SQL, real runtime, SDK/store,
atomic claims and signed webhook path against isolated PostgreSQL fixtures.
They do not prove live Meta acceptance, actual delivery or production migration.
