# cetld core backend

Supabase foundation for cetld: Google OAuth client helpers, persistent browser
sessions, tenant workspaces, profiles and business settings, customers,
invoices, payments, and private invoice files.

## Commands

```bash
npm ci
npm test
npm run typecheck
```

Apply migrations in `supabase/migrations` in filename order. Configure the app
with the variables in `.env.example`; never put a service-role key in browser
code. Google must be enabled in Supabase Auth and its callback URL must exactly
match the application's allowlist.

The application should create workspaces through `create_workspace`. Every
business row is bound to an immutable `workspace_id`, and RLS derives access
from `workspace_members`. Invoice files are private and use paths shaped as
`workspace UUID/invoice UUID/random filename`.

## WhatsApp Cloud API setup

Set these **server-only** Vercel environment variables from the Meta developer
console: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_WABA_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_VERIFY_TOKEN`.
Set `WHATSAPP_GRAPH_API_VERSION` to the currently supported Meta Graph API
version before any test send; there is no version
fallback.
The webhook callback path is `/api/whatsapp` (GET verification and signed POST
events). Set `SUPABASE_SERVICE_ROLE_KEY` for the server-only webhook's
workspace-scoped consent and event queries, and `CRON_SECRET` for its protected
inbound-event processor at `/api/whatsapp-process`. Never expose either key to
the browser. Inbound events older than one hour that fail delivery are logged
and marked terminal with `status=failed` and `error_code=INBOUND_DEAD_LETTER`; the
worker will not reprocess them. No migration is needed. Do not requeue stale
confirmed actions; ask the owner to send a fresh WhatsApp message.

Keep `WHATSAPP_OUTBOUND_ENABLED=false` while Meta reviews the proposed use.
`WHATSAPP_TEST_ALLOWLIST` is required and accepts only comma-separated E.164
test numbers. For the authorized QA demo, configure the Vercel environment as
`WHATSAPP_TEST_ALLOWLIST=+919871367051,+919818685252`. Code additionally hard
blocks every number outside that fixed approved QA set, even if it appears in
the environment variable. The
only business-initiated template name accepted by the code is
`cetld_invoice_update_test`; Meta must approve its neutral invoice-update text
with business name and invoice number parameters before testing. The outbound
flag may be enabled only for that neutral test to the allowlisted number;
automated debtor or payment reminders remain on hold. Saving a business owner's
attestation does not replace each client's own agreement to receive WhatsApp
invoice updates.
To run that test, set `WHATSAPP_TEST_OPERATOR_USER_ID` to the signed-in
workspace owner's Supabase user UUID. An authenticated `POST` to
`/api/whatsapp-test-send` accepts only `workspaceId` and `invoiceId` in JSON.
The server reads the current invoice, customer phone, and business name; it
accepts only the fixed test number and derives a stable key per invoice
revision. The sender checks active consent and suppression again immediately
before the Graph API request. A blocked or uncertain result must not be retried
with a new invoice revision solely to force a send.
The invoice-detail view uses the shared WhatsApp disclosure text. This checkout
has no invoice PDF renderer or customer portal; those outputs need the same
disclosure added where they are generated.
Do not put Meta credentials in browser code or commit populated `.env` files.

## Owner chat regression battery

Run the complete local release check before pushing:

```bash
npm ci --include=dev
npm run check:release
```

Owner messages are durably queued before webhook acknowledgement. Verified
owners see typing for quick replies. A progress message is sent only when work
is still running after one minute, using a separate, atomic claim bound to the
original WhatsApp message. The final answer retains its own
delivery claim. Background workers have a 240 second work slice under a 300
second Vercel limit, execute in Mumbai beside Supabase, and persist the agent
transcript and completed tool results between operations. Expiring a slice
retains the job for the next worker invocation, without sending a timeout reply.
The production Supabase minute scheduler resumes queued work; the Vercel daily
cron is an additional recovery path. An interrupted write is never automatically
repeated or reported as successful. Database confirmation receipts still enforce
ownership, expiry and idempotency. Checkpoints are internal service data and are
cleared when the event finishes. This preserves work across invocation limits;
provider and delivery outages can still delay an answer.

Quota exhaustion is recorded in the service-only `ai_provider_health` table,
keyed by hashed account and credential identity. Cloudflare's shared daily
Neuron quota disables all Cloudflare models for that account until reset.
Subsequent instances consult that record before contacting a provider. Logs
include model/tool durations and request-local context query counts, with no
message text or credentials.

For an opt-in deployed timing check, call `/api/whatsapp-process?diagnostic=meta`
or `?diagnostic=john-invoices&quotaDead=1` with the normal
`Authorization: Bearer <CRON_SECRET>` header. The latter deliberately skips
Cloudflare for that probe only. This runs the real owner agent against a verified
number in the configured test allowlist, permits structured reads only, and
returns timing/count metadata without invoice facts. It sends no WhatsApp
message and consumes live provider quota, so it is never part of the build gate.

For a quick conversation check, run `npm run test:owner-chat`. It uses a
scripted model and fictional workspaces, but exercises the actual owner
handler, agent loop, scoped data tools, confirmations and saved replies.
It does not connect to WhatsApp, Supabase or Vercel and cannot message a customer.
The existing isolation tests also run in the full test suite.

Run `npm run test:owner-chat:live` manually when you want to spend quota on
real provider calls. The battery passes only when each reply came from the
saved Cloudflare primary; a Gemini fallback response does not count as live
proof. Supply server-only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in
your process environment. Live mode uses fictional workspace data and never
sends WhatsApp messages. A provider HTTP 429 prints `SKIP` and stops the live
run without failing it; other provider and scenario failures still return a
failing exit code. Do not paste provider credentials into this repository or a
chat.

GitHub Actions runs the fast battery, TypeScript checks and full test suite
on every push and pull request. Vercel runs that same fast release gate as its
build command; it never runs the live battery during a deployment. Any failing
fast check stops that build before publication, so a failed GitHub check cannot
race an automatic production deployment. The generated `owner-chat-build.json`
identifies the checked commit and source hashes, contains no customer data or
secrets, and is generated only after the gate passes.

Add scenarios in `scripts/owner-chat-battery.mjs`; seeded records and the
strict workspace query fixture live in `tests/fixtures/owner-chat-battery.mjs`.
Each scenario should exercise the handler or loop, assert a nonempty reply
within the deadline, verify the expected records or confirmation, and check
that no foreign workspace was read or changed. Add normal conversation cases
to both modes. Keep induced transport failures explicitly labeled as simulated.
`tests/owner-chat-battery.test.mjs` runs the fast scenarios in the normal test
suite. Use live mode selectively when a real provider check is needed; it spends
provider quota.


### Owner assistant behavior and recovery

The owner assistant uses the dashboard's verified workspace and the same database
rows. `workspaceData` is its scoped business-data interface; live model identity
comes from `getAIProviderConfiguration`. Model text cannot supply a workspace ID,
service credential, permission, or confirmation receipt.

Clear owner write instructions use a server-only transaction in direct mode.
The database verifies the current owner/phone binding, stored inbound message,
allowed operation and fields, target workspace, and current row version. Invoice
deletes are soft deletes, with a 30-day restore window. Receipt replay prevents a
restarted worker from repeating a completed mutation. The adapter re-reads the
persisted row before returning a completed result; failures cannot become success
claims. Conversation history supplies references, not proof of current balances
or completed changes. Repeating a question under a new WhatsApp message ID reads
fresh state; only redelivery of the exact message reuses the original reply.

Owners can choose reply buttons instead of direct changes in Settings > WhatsApp
& assistant. Buttons are signed, bound to the owner workspace/phone and exact
pending action version, and expire with that action. A stale or forged button
cannot approve a different change. Clear direct instructions do not need another
confirmation. Ambiguous targets still require a choice rather than a guessed
mutation. Preferences also control assistant name, tone, language, reply length,
signature, and style guidance. These never grant additional database privileges.

The release gate stays entirely offline. `tests/direct-owner-write-sql.test.mjs`
executes the migration chain and mutation safeguards in PGlite;
`tests/owner-database-grounding.test.mjs` exercises invented-success rejection.
Button transport, stale references, replay, and preference isolation are covered
by the WhatsApp and owner preference tests in `npm run check:release`.

Customer reminder templates live in **Settings > Follow-up**. Supported tokens
are `{{business_name}}`, `{{customer_name}}`, `{{invoice_number}}`,
`{{balance}}`, and `{{due_date}}`; the dashboard resolves them into the editable
owner-review draft and adds the configured business name as its plain signature.
Changing a template or invoice facts clears saved draft and approval text, so the
current values must be previewed and approved again. Saving a template does not
enable customer messaging, provision or approve a Meta template, or change
consent and delivery controls. Meta's approved-template rules still apply.

Automatic recovery covers worker resumption, provider failover/quota cooldown,
and idempotent delivery. It does not rewrite production code, override customer
consent, approve Meta templates, or replace expired external credentials. Live
provider quality and phone delivery require separate checks and are not claimed
by the offline suite.
