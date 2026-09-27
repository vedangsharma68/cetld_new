# Cetld automation and accounting integration

Server-only automation modules. The active pipeline uses `public.invoices`,
`public.workspace_settings.follow_up_preferences`, and `public.customers`.
Apply `supabase/migrations/20260927140000_core_followup_pipeline.sql` in a
reviewed migration process before enabling a worker. It adds columns and durable
claims without deleting existing invoice data. Existing invoices with no explicit
`metadata.invoice_direction = "receivable"` remain ineligible for outbound sends.

## Run tests

```sh
node --test tests/*.test.mjs
```

No runtime npm dependencies are required. SQL integration tests use PGlite when
its package path is supplied. To reproduce the full 48-test run:

```sh
npm install --prefix /tmp/cetld-sql-test --ignore-scripts @electric-sql/pglite@0.5.8
PGLITE_MODULE=/tmp/cetld-sql-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/*.test.mjs
```

Without `PGLITE_MODULE`, only the SQL suite is skipped. See
`automation/SCHEMA-CONTRACT.md` for the core-backend merge requirements.

## API entrypoints

`POST /api/automation` accepts a JSON body with `workspaceId`, `invoiceId` and
`action` (`configure`, `pause`, `resume`, or `mock-reply`). Pass the signed-in
user's Supabase access token as `Authorization: Bearer ...`. The server verifies
that token and independently verifies workspace ownership. `mock-reply` is
disabled in production.

`action: "tick"` instead requires `ownerId`, `workspaceId`, and the dedicated
`AUTOMATION_WORKER_SECRET`. It processes a bounded batch using durable DB claims.
Clients must never receive this secret or the Supabase service key.
The worker generates an idempotent daily summary event for the previous day in
the owner's timezone when that preference is enabled. `daily-summary` returns
the current day's counts to the signed-in owner. There is no notification sink
for daily summaries, so no summary message is sent.

`POST /api/accounting` with `action: "start"`, `provider: "zoho_books"` or
`"quickbooks"`, and `workspaceId` initiates accounting consent. Zoho also needs
`organizationId`. Send the Supabase bearer token and navigate to the returned
`authorizationUrl`. The browser retains a secure HttpOnly consent cookie.
The registered callback is `GET /api/accounting?provider=PROVIDER`.
`POST /api/accounting` with `action: "sync"` retrieves normalized accounting data.

## Dispatch safety

Before every outbound reminder, the engine refreshes the linked accounting
invoice, rereads the local invoice and obtains a fresh database authorization.
Payment and pause writes invalidate old claims. Provider or accounting errors
block sending. A response claiming payment pauses reminders for review; it does
not fabricate a payment.

An external payment or pause arriving *after* final authorization cannot recall
an HTTP request already handed to a provider. The WAPI adapter must document its
cancellation/idempotency capabilities. A crash after transmission but before
acknowledgement must be treated as uncertain and reviewed, never blindly resent.

## Scheduling

Run `node automation/worker.mjs` once per minute from a scheduler with:

- `AUTOMATION_APP_URL`: HTTPS application origin.
- `AUTOMATION_WORKER_SECRET`: at least 32 random characters, matching the server.
- `AUTOMATION_WORKSPACES`: JSON array of `{ "workspaceId": "...", "ownerId": "..." }`.
- `AUTOMATION_OUTBOUND_ENABLED`: defaults to `false`; only the exact value `true`
  allows `tick` to dispatch reminders, subject to every invoice and preference gate.

This is an executable scheduler driver, not a scheduler registered in your live
hosting account. Workspace registration belongs to backend onboarding. Overlapping
workers use database claims to prevent duplicate reminders.

## Setup and remaining live verification

1. Review and apply the additive core follow-up migration listed above. The old
   `supabase/install/automation_persistence.sql` targets legacy `cetld_*` tables
   and is not the active core invoice pipeline.
2. Configure server variables from `automation/.env.example`; keep token encryption
   keys durable and secret.
3. Register the exact HTTPS callback URI in Zoho and Intuit, complete consent,
   and verify a real invoice/payment plus refresh-token rotation.
4. Add a WAPI implementation of `automation/whatsapp/contract.mjs`, configure its
   account credentials and webhook signature validation, and verify send/receive
   with an authorized test contact. WAPI is deliberately unavailable until then.
5. Configure the scheduler to run the driver. Production mock sending is refused.

No Meta implementation is included in this branch. Any legacy outbound automation
in the old cetld product must be disabled before sharing its phone number with a
new WAPI adapter, to prevent duplicate handling.

See `automation/accounting/README.md` and `automation/whatsapp/README.md` for
provider contracts and token lifecycle details.
