# Source and audit metadata preservation proposal

Baseline: frozen `1439bb2433b717f678f8ed09435ece92f717c13d`, isolated
`cetld_owner_hardened`. Migration:
`20261004218000_source_invoice_metadata_guard.sql`. No production apply,
publication, credentials, Storage API calls, or real business changes occurred.

The existing authenticated Data API allowed an owner/member to overwrite or
erase source/audit metadata and to replace/delete an existing invoice file
pointer. Existing Storage write policies also allowed replacing/deleting the
linked object. The baseline regression reproduced missing rejection in four
of five cases; the benign audited correction case already passed.

The forward migration adds inline invoker triggers, without new grants or
columns. Raw authenticated invoice UPDATE preserves the `source_`, `original_`,
`extracted_`, `extraction`/`extraction_`, and `raw_text` namespaces, plus
`printed_invoice_number`, `invoice_number_override_audit`,
`assistant_idempotency_key`, and `whatsapp_corrections`. Missing, JSON null,
replacement, and whole-metadata erasure are distinct and guarded. The source
guard runs before `assign_consistent_invoice_number` so the trusted numbering
trigger can still generate its source label.

Initial browser `source_invoice_number` is a bounded self-reported label, not
verified extraction evidence. Initial `extraction_status` and Assistant
idempotency are also accepted for compatibility with actual dashboard saves;
existing values become immutable to raw edits. Other new protected provenance
or audit claims are refused. The authenticated paid Assistant definer RPC is
patched with exact checked markers to reject audit forgeries and validate the
same initial source label shape. Its ACL and receipt/atomic-payment/replay body
are retained. Typed owner corrections have a closed field allowlist; trusted
service import, attachment creation, and verified legacy numbering flows retain
their separate server authorization. No metadata role key changes caller scope.

Authenticated file INSERT remains supported after upload, with the path bound
to its actual row's `workspace_id/invoice_id/filename` and no extra/dot segments.
Existing file rows cannot be moved, replaced, or deleted by raw authenticated
UPDATE/DELETE; timestamp-only refresh remains allowed. File existence in Storage
is not asserted by SQL because upload is an external managed service operation.

Existing named Storage UPDATE/DELETE policies retain bucket/path scope and deny
linked objects. UPDATE's WITH CHECK also prevents moving an orphan onto a linked
name. INSERT/read and unlinked cleanup remain unchanged; backend service flows
retain RLS bypass. Installation fails closed on extra applicable permissive
write policies requiring review, rather than allowing an OR-policy bypass. No
Storage table, trigger, column, privilege, or provider configuration is added.
Archived invoice paths remain unavailable under the existing active-invoice path
validator, so hidden file metadata does not make an archived path writable.

Final source suite: 7/7 actual all-migration offline SQL cases pass. Coverage
includes owner/member/foreign scopes, null/removal/whole erase, new forged audit
claims, fake role/custom-field isolation, canonical AUTO numbering and initial
printed labels, typed notes/date/custom fields and exact audit replay, paid
Assistant receipts, actual SDK scoped file INSERT, invalid pointer prefixes,
linked Storage metadata/name/delete/move refusal, orphan cleanup, service
positives, private-trigger EXECUTE denial, and PUBLIC/inherited-role policy
preflight with a non-inherited-role control. Typecheck passed. Supporting
invoice/owner focused suite covered 63 cases; its sole benign fixture overwrite
correctly exposed source erasure. That benign fixture now merges metadata;
the exact final source/settlement rerun passes 24/24 (7 source + 17 settlement).
The parent runs the final frozen combined gate; this is not production evidence.

Logs in task root: `source-invoice-guard-red.log`,
`source-invoice-guard-final.log`, `source-invoice-guard-focused-final.log`,
`source-invoice-guard-final-refinement.log`, `source-invoice-guard-typecheck.log`.
Canonical LF migration SHA256:
`60bdb74f5425f0306d74322a9afd15755ccf4075fb623647c54c0c9405fc0a1b`.

Storage policy tests use isolated managed-schema stand-ins and explicitly
labelled platform table-grant/metadata-column fixtures. They establish SQL
authorization, not live HTTP/blob-byte preservation. A separate transaction
linking a previously orphaned object can race with an already-authorized
Storage mutation; these policies do not prove cross-service atomicity. Stronger
future guarantees would require an upload/finalization protocol and service
reconciliation. Existing trusted service privileges remain an intentional trust
boundary, not capabilities made available to the model.
