# Invite-only registration and new businesses

The database is the enforcement boundary for password signup, first Google
sign-in, and **every new workspace**, including direct REST and nested RPCs.
Existing accounts keep their sessions, sign-in methods and existing workspaces.
Creating another business requires a new email-bound invitation. A single code
approves one account (or an existing account) and one new business, never an
unlimited tenant-creation entitlement. Deleting that business does not restore
the grant.

Hosted GoTrue must use `supabase_auth_admin`, never a database superuser. The
`auth.users` BEFORE INSERT trigger consumes a valid invite under a row lock;
the AFTER INSERT trigger creates the initial workspace in that same transaction,
after the normal profile trigger. Failure rolls the account, profile, workspace
and consumption back together. Concurrent uses have one winner. Trusted database
operator seeding remains a privileged operation, not a public signup path.

Password clients prepare an opaque ten-minute, email-bound, one-use ticket.
Only the ticket goes to Auth; the original invite code does not enter its user
metadata. Google preparation authorizes the invited email for ten minutes, capped
by invite expiry; the server-owned provider identity consumes it at creation.
Changing the selected Google email fails. The compatibility signup adapter accepts legacy email/code input, exchanges it
for a ticket before calling GoTrue, and removes credential fields recursively
from returned user/identity/session objects. Direct raw-code GoTrue signup is
rejected before account creation or invite consumption; cached clients use the
compatible invitation entry. Hosted GoTrue returns an in-memory identity copy, so
SQL trigger sanitization alone cannot secure that response. Both user metadata and `auth.identities.identity_data`
are stripped on insert/update; the migration also scrubs historical copies.
The database stores only code/ticket hashes. Missing, expired, revoked, replayed
and cross-email credentials fail closed. Existing Google/password sign-in does
not require an invite.

## Operator issuance

Set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY` through the
normal secret mechanism, then run:

```sh
node scripts/issue-signup-invite.mjs invitee@example.com 24
```

Expiry is in hours (default 24, maximum 168). Deliver the code privately together
with the site's `/invite.html` entry link. Issuance sends no email and creates no
account. API clients cannot issue codes or inspect the private invite table.
The service key must never enter browser configuration, logs or committed files.

Existing signed-in accounts use that same entry to redeem an email-matching code.
For an account without a workspace, redemption atomically provisions its first
business. Otherwise it grants exactly one further workspace creation.

## Required deploy order and mixed versions

1. Fence and drain the old inbound worker **before** the schema/code switch.
   Do not allow it to claim work during the migration or restart it afterward.
2. Apply `20261120125758_signup_invites.sql`, then
   `20261120132445_dispatch_privacy_performance.sql`, then
   `20261120181032_recoverable_reply_reservations.sql`, then
   `20261121095622_durable_service_delivery_intents.sql` through the normal operator
   migration process. Keep all four migrations: invitation enforcement, the populated
   canonical index, recoverable handoff fencing, and durable per-phase scheduling
   with legacy acknowledgment reconciliation respectively. Each is replay-safe; their count is not a deployment gate.
   Verify `signup_invite_status()` reports v2 capabilities,
   `privacyRepairRevision: 3`, and the claim/release dispatch protocol. Also verify
   `whatsapp_service_delivery_status()` reports `version: 1`, `queueRevision: 2`,
   `ready: true`, `legacyAcknowledgmentsReconciled: true` and
   `retirementProgress: true`. Publication and worker startup share the exact
   version/feature predicate; unknown versions are rejected before any claim. Migration four must
   commit its reconciliation before this capability is published. If an earlier
   candidate fourth migration is already installed, replay the revised fourth
   through the operator migration process while workers remain drained; its
   populated replay preserves queue requests, outcomes and retry deadlines.
   Table existence alone is not readiness.
3. Publish the frontend and worker code. The **production frontend build refuses
   publication** unless the database reports account/tenant enforcement, identity
   scrubbing, a current global privacy index, the recoverable dispatch protocol
   **and the ready migration-four phase queue**. Worker startup checks the queue
   capability before any claims. Three migrations are insufficient for this worker.
4. Resume dispatch only on the new worker code after the capabilities and build
   checks pass. Issue invitations using the compatible `/invite.html` entry, which is independent
   of cached main-app code. Newly invited accounts already have a workspace when
   old or new main-app bootstrap runs.
   Existing sign-in remains available.

An untouched pre-invite database is inherently open: no UI can close its direct
Auth API. Old/old deployment is therefore unsupported, not claimed secure. New
UI with old/incomplete schema fails before Auth account creation and shows an
upgrade message. Cached pre-invite UI with the new schema cannot create accounts
without admission; invitees use the dedicated entry. Legacy code-input clients use the compatibility adapter or invitation entry.
Unmodified clients posting raw codes directly to GoTrue must upgrade; their
requests fail before consumption, and their existing sign-in remains available. Landing and demo do not use
account creation. Local/preview builds do not query production.

The performance migration's populated build is staged within one transaction;
readiness is published only after every stage, and failure rolls it all back.
Do not interpret its total elapsed time as the duration of one SQL statement.
The round-4 native measurement with **100,000 rows present before installation**
was **1,337.764 ms total**, **443.968 ms slowest statement**. Each command was
enforced under a **1,000 ms test statement budget**. The production migration's
statement limit remains **5,000 ms**. Separately, the snapshot was enforced under
a **1,000 ms statement budget**, measuring **151.234 ms cold / 149.644 ms warm**
with all 100,000 keys checked. These are local measurements, not a production SLA;
the round-4 evidence records these measurements at the repaired head. No timeout
or migration budget is increased. See `whatsapp-dispatch-performance.md` for the
build stages, atomic readiness and canonical admission contract.

The v1 upgrade marks already consumed invitations with existing workspaces as
spent tenant grants; replay preserves genuinely unused v2 grants. Both original
PR migrations are replay-safe, as is the reservation migration.
Existing historical migrations are unchanged. Tests use disposable native
PostgreSQL with the real Auth role, not the business-test fixture's operator
approvals. `signup-invite-native`, `pr213-auth-replay`, `signup-invite` and
`pr213-signup-matrix` cover provider failures, replay, concurrency, rollback,
identity copies, no-invite tenant RPCs and the supported deployment matrix.
