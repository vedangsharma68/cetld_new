# Invite-only registration

Apply the new `20261120125758_signup_invites.sql` migration before publishing the
signup UI. This migration is the enforcement boundary; deploying UI alone does
not close registration. No existing migration is changed.

Hosted Supabase's GoTrue account creation runs as `supabase_auth_admin`. A BEFORE
INSERT trigger on `auth.users` gates all non-database-operator roles, including
that role, before profile triggers or client workspace setup. Existing-user
sign-in, identity linking, refresh, password recovery and existing sessions do
not insert a new user and do not need an invitation. Trusted `postgres` and
`supabase_admin` database maintenance/seeding remain privileged operations, not
public signup APIs. Do not run a custom GoTrue instance as a database superuser.
No Auth-hook dashboard setting or paid service is required.

Email signup supplies `signup_invite_code` as an untrusted credential. The database
checks its hash and exact normalized email, consumes it under a row lock, and
removes the credential from user metadata before insertion. User metadata never
grants authority by itself. Google registration first calls
`prepare_signup_invite(email, code)`; this authorizes only that email for ten
minutes, capped by code expiry. GoTrue's server-owned Google provider identity
then consumes the invitation when it creates the account. Selecting a different
Google email fails. Preparation alone creates no account and does not consume a
code. Existing Google sign-in uses its normal flow, without preparation.

Consumption commits in the same transaction as the account insertion. Concurrent
uses have one winner; a failed downstream insertion rolls consumption back.
Expired, revoked, consumed, cross-email and absent credentials fail closed.
Reissuing an invitation revokes earlier unused codes for that email. Codes are
stored only as SHA-256 digests; the service-role RPC returns a code once.

## Operator issuance

From a trusted operator shell, configure `SUPABASE_URL` and the server-only
`SUPABASE_SERVICE_ROLE_KEY` using the normal secret mechanism, then run:

```sh
node scripts/issue-signup-invite.mjs invitee@example.com 24
```

The second argument is expiry in hours (default 24, maximum 168). Deliver the
returned code privately to that invitee. Do not put the service key in browser
configuration, command arguments, logs, or a committed environment file. This
script issues a code; it does not send email or create an account. Anonymous and
authenticated clients can neither issue codes nor read the invite table.

## Verification and rollout

`tests/signup-invite-native.test.mjs` exercises the actual migration with a
non-superuser GoTrue role and real core profile/workspace functions in disposable
PostgreSQL. It covers both providers, replay, wrong email/code, expiry, revocation,
missing preparation, editable-metadata spoofing, rollback, concurrent use, and
existing-account updates. Browser-controller tests preserve normal sign-in.
Apply through the normal migration process; confirm the trigger is enabled on
`auth.users` before issuing invitations. No production changes are made by the
repository tests. The public landing page and demo do not use this creation path.
