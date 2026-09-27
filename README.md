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
the browser.

Keep `WHATSAPP_OUTBOUND_ENABLED=false` while Meta reviews the proposed use.
`WHATSAPP_TEST_ALLOWLIST` defaults to `+919871367051` and accepts only
comma-separated E.164 test numbers. Code additionally hard blocks every
number other than `+919871367051`, even if it appears in that variable. The
only business-initiated template name accepted by the code is
`cetld_invoice_update_test`; Meta must approve its neutral invoice-update text
with business name and invoice number parameters before testing. The outbound
flag may be enabled only for that neutral test to the allowlisted number;
automated debtor or payment reminders remain on hold. Saving a business owner's
attestation does not replace each client's own agreement to receive WhatsApp
invoice updates.
The invoice-detail view uses the shared WhatsApp disclosure text. This checkout
has no invoice PDF renderer or customer portal; those outputs need the same
disclosure added where they are generated.
Do not put Meta credentials in browser code or commit populated `.env` files.

