# Auth contract

The browser application in `app.js` supports email/password sign-in, signup
confirmation, Forgot password, and Google OAuth. It has no magic-link request
button or `signInWithOtp` request flow. Supabase-issued magic links are accepted
by the shared email callback consumer.

All application-generated redirects are exactly `${location.origin}/app/`,
including the trailing slash. Signup confirmation and Google OAuth use the
persistent PKCE client. Forgot password calls `resetPasswordForEmail` through a
separate, nonpersistent **implicit** client with `redirectTo` set to that same
URL. Recovery therefore works in another browser or mail app without the
requesting browser's PKCE verifier.

`/app/` consumes email access/refresh-token fragments explicitly before restoring
an account. It signs out the browser's previous session with `scope: 'local'`,
installs the link's session, and verifies its identity with Supabase `getUser`.
Recovery displays the verified email address in the new-password form. Invalid,
partial, expired, or unverifiable callbacks show an error and block account
loading; they cannot silently display the previous account. The fragment is
removed after processing and the landing-session cookie is cleared before any
switch. Google PKCE code callbacks retain the SDK's code exchange; exchange
errors block account restoration.

The public `/`, `/privacy/`, and `/terms/` pages forward auth fragments and code
or error queries to `/app/`, preserving their values. Ordinary anchors such as
`#features` remain on the public page. The root session-cookie middleware also
preserves callback query parameters when redirecting a signed-in browser.

The separate TypeScript helpers in `src/auth.ts` implement exact allowlisted
Google callbacks, code exchange, and verified session restoration for library
callers; they are not the static application's entry point.

## Supabase URL configuration

Set **Site URL** to the canonical production origin, and add the exact
`https://<production-host>/app/` URL to **Redirect URLs**. Add exact `/app/` URLs
for every other supported origin (for example, a deliberate preview or local
test origin). Production redirects should use exact URLs rather than broad
wildcards. A missing allowed redirect can make Supabase fall back to Site URL;
the root forwarder handles that fallback, but it does not replace the allowlist.
Email templates must preserve `ConfirmationURL`/`RedirectTo` rather than
hard-code Site URL in place of the requested callback.

Enable Google and enter its client ID and secret. The Google console must allow
Supabase's provider callback URL shown by the Supabase dashboard; this is a
different URL from the application's `/app/` callback.

The repository has no `supabase/config.toml` or snapshot of hosted Auth URL
configuration. The required settings above were derived from the actual app
requests and current Supabase documentation. The production dashboard allowlist
and email templates have **not** been inspected or changed by this fix.

## Verification and remaining live checks

`tests/email-auth-link.test.mjs` uses the installed Supabase JS SDK 2.116.0 with
mocked Auth HTTP responses. It executes the real Forgot-password submit handler
and asserts `/auth/v1/recover?redirect_to=https://cetld.com/app/`, with no PKCE
challenge. It covers stored A sessions receiving B magic/recovery/signup tokens,
invalid tokens, identity mismatch, sign-out HTTP failure, partial/expired links,
and public-route forwarding. The middleware regression checks that a valid A
cookie does not discard a callback's `code` or `sb_flow_id` query.

The underlying mismatch was verified against installed SDK source: its PKCE
client rejects an implicit magic-link fragment and preserves an existing
session on callback failure. The old app manually consumed only recovery
fragments. A root URL with no valid landing cookie served public HTML without
any auth consumer. These findings distinguish the reported admin-link leads
from the app's actual Forgot-password redirect, which already requested `/app/`.

Before claiming live email delivery and hosted configuration are verified:

1. Inspect Auth URL Configuration and email templates against the settings above.
   From the real Forgot-password form, inspect the `/recover` request's
   `redirect_to` and open the delivered email in both the same browser and a
   separate browser. Confirm the correct email appears on the new-password form,
   update the password, sign out, and sign in using the new password.
2. While signed in as account A, open a fresh recovery link for B. Confirm only
   B's email is shown, the password change affects B, and B's business loads.
   Also open a B magic link: the previous session must be signed out and B's
   business must load. There is no app magic-link request UI, so record how this
   supplementary link was issued.
3. Try expired/reused and malformed links with A already signed in. Confirm an
   explicit error appears without displaying A's business. Test a root fallback
   and both legal routes with auth fragments; normal `/#features` stays public.
4. Complete Google OAuth, including a root `?code=...` fallback with an existing
   landing cookie, and confirm PKCE still establishes the intended account.

Offline fixtures do not verify SMTP delivery, real Supabase-issued tokens, the
hosted allowlist/templates, or a deployed Google provider round trip. Record
those results separately in the PR description when performed.
