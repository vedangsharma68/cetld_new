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

- `https://YOUR_HOST/api/accounting?provider=zoho_books`
- `https://YOUR_HOST/api/accounting?provider=quickbooks`

Zoho consent requires the organization ID and region (`in` for an India account).
QuickBooks stores the callback's `realmId` as the company identifier. Use an
Intuit sandbox app/company for the first test, with `QUICKBOOKS_SANDBOX=true`.

Sync stores normalized invoice/payment snapshots keyed by workspace, provider,
record type and external ID. It does not insert duplicate payments into the
core ledger. The integration returns pagination metadata when more rows remain;
`sync` accepts `invoicePage` and `paymentPage` for continuation. Review/merge these snapshots through the
core backend before treating a full import as complete. Every reminder queries
the specific remote invoice balance, independent of bulk-sync pagination.
A local/remote currency or invoice-total mismatch blocks the reminder.

Live verification still requires developer client IDs/secrets, callback
registration and user consent: connect each provider, sync a known invoice and
payment, expire an access token, verify one refresh with the rotated token saved,
and verify that a fully paid linked invoice never sends.

Official references used for implementation:
- https://www.zoho.com/books/api/v3/oauth/
- https://www.zoho.com/books/api/v3/invoices/
- https://www.zoho.com/books/api/v3/customer-payments/
- https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
- https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
