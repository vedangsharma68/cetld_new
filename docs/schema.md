# Schema and tenant boundary

- `workspaces` is the tenant boundary; `workspace_members` assigns owner,
  admin, or member access.
- `profiles` belongs to one authenticated user. `workspace_settings` stores
  business name, currency, timezone, and follow-up preferences.
- `customers`, `invoices`, `payments`, and `invoice_files` carry an immutable
  `workspace_id`. Composite foreign keys prevent records from referencing a
  customer or invoice in another workspace.
- RLS is enabled and forced on every public table. Authorization uses
  membership stored in the database, never user-editable OAuth metadata.
- `create_workspace` atomically creates the workspace, owner membership, and
  default settings. Its privileged implementation lives in the private `app`
  schema behind an invoker-rights public wrapper.
- `invoice-files` is private. Storage policies validate both workspace
  membership and the invoice encoded in the object path.

The live verification used two authenticated identities and confirmed settings
persistence, invoice/customer/payment operations, storage-object access, and
that the second identity could neither read nor write the first workspace.
