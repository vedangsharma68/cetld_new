# Core settings and invoice storage contract

`src/settings.ts` accepts an authenticated Supabase client and persists rows in
`profiles` (keyed by `user_id = auth.uid()`) and `workspace_settings` (keyed by
`workspace_id`). The client must use the user's session; these helpers never
accept or create a service-role client. Workspace membership and row ownership
are enforced by database RLS.

`src/storage.ts` uses the private `invoice-files` bucket. Files are placed at
`{workspace UUID}/{invoice UUID}/{random UUID}.{pdf|jpg|png|webp}`. Uploads are
limited to PDF, JPEG, PNG, or WebP and 10 MiB. Uploads set `upsert: false`.
Original filenames, when supplied, are stored as object metadata. Downloads
use short-lived signed URLs and deletes use the same authenticated client, so
the storage policies remain the enforcement point.

The helpers intentionally do not invent an invoice-file database table. If the
schema records object metadata, persist the returned `path` and MIME/name in
that table from the caller.
