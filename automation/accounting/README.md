# Accounting adapters

Zoho Books and QuickBooks use separate OAuth adapters with a common integration
service. Tokens remain server-side and are stored as AES-256-GCM ciphertext,
bound to provider and workspace. Set a base64 32-byte
`ACCOUNTING_TOKEN_ENCRYPTION_KEY` and preserve it across deployments.

Consent state is random, hashed, expires after ten minutes and is consumed once.
It binds provider, user, workspace, registered redirect URI and a browser nonce.
The HTTP route uses a Secure, HttpOnly, SameSite=Lax cookie for that nonce.

A database lease plus revision comparison coordinates refresh-token rotation
across workers. Re-consent replaces credentials using revision comparison.
Refresh failures block payment checks and sending; no token or raw provider
error is returned to the browser. Unknown refresh outcomes may require consent
again if the provider has already rotated the previous token.

Environment variables are in `../.env.example`. Register these exact callbacks:

- `https://YOUR_HOST/api/integrations/zoho/callback`
- `https://YOUR_HOST/api/integrations/quickbooks/callback`

Register the QuickBooks URI exactly as shown, with HTTPS and no query string.
Keep sandbox and production Intuit apps/configuration separate: use sandbox keys
with `QUICKBOOKS_SANDBOX=true`; only set it to `false` alongside production keys.
The accounting values (`ACCOUNTING_TOKEN_ENCRYPTION_KEY`,
`QUICKBOOKS_SANDBOX_CLIENT_ID`, `QUICKBOOKS_SANDBOX_CLIENT_SECRET`,
`QUICKBOOKS_PRODUCTION_CLIENT_ID`, `QUICKBOOKS_PRODUCTION_CLIENT_SECRET`,
`QUICKBOOKS_SANDBOX`, and `QUICKBOOKS_REDIRECT_URI`) are server-only deployment
environment variables. The runtime selects only the sandbox or production key
pair indicated by `QUICKBOOKS_SANDBOX`, preventing accidental cross-environment
credential reuse.

Zoho consent requires the organization ID and region (`in` for an India account).
QuickBooks stores the callback's `realmId` as the company identifier. Use an
Intuit sandbox app/company for the first test, with `QUICKBOOKS_SANDBOX=true`.

QuickBooks requests only `com.intuit.quickbooks.accounting`. Its initial and
manual sync read customers, invoices, and payments with Intuit query pagination.
The adapter performs no QuickBooks create/update operations.

Sync stores normalized customer/invoice/payment snapshots keyed by workspace, provider,
record type and external ID. It does not insert duplicate payments into the
core ledger. Upserts make repeated syncs idempotent. **Snapshots are not active
Cetld invoices:** no customer-identity reconciliation, invoice-direction and
eligibility review, or owner-approved import exists yet. Consequently imported
rows are not shown as reminder-ready and never enable reminders. The integration returns pagination metadata when more rows remain;
`sync` accepts `invoicePage` and `paymentPage` for continuation. Review/merge these snapshots through the
core backend before treating a full import as complete. Every reminder queries
the specific remote invoice balance, independent of bulk-sync pagination.
A local/remote currency or invoice-total mismatch blocks the reminder.

Owner action for live verification: apply the existing accounting migrations;
set the server-only variables above; add the exact callback to the matching
Intuit sandbox app; then use **Connect** from Cetld and consent with a test
company. Do not create a paid company or use production consent for this check.
Live verification still requires developer client IDs/secrets, callback
registration and user consent: connect each provider, sync a known customer, invoice and
payment, expire an access token, verify one refresh with the rotated token saved,
and verify that a fully paid linked invoice never sends.

Production remains blocked until the owner separately supplies production keys,
registers the production callback, and completes an account-level read-only test.
Import into the active ledger remains blocked on an explicit, reviewed mapping
and reconciliation design.

Official references used for implementation:
- https://www.zoho.com/books/api/v3/oauth/
- https://www.zoho.com/books/api/v3/invoices/
- https://www.zoho.com/books/api/v3/customer-payments/
- https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/customer
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment
- https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries
