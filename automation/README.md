# Cetld automation and accounting integration

Server-only Node 24 modules, added without frontend changes. This branch extends
`vedangsharma68/cetld_new` on `feat/automation-integrations`. No live deployment is performed.

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

This is an executable scheduler driver, not a scheduler registered in your live
hosting account. Workspace registration belongs to backend onboarding. Overlapping
workers use database claims to prevent duplicate reminders.

## Setup and remaining live verification

1. Apply the SQL installation files under `supabase/install/` to the cetld database
   after reviewing them alongside the core-backend branch. They build on existing
   `cetld_workspaces`, `cetld_invoices`, and auth tables.
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
