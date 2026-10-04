# Unpaid and current-turn correction

Local corrective patch based on released b307280. Contextual next-action buttons
are paused on a separate branch and are not included. No new migration is needed.
This correction is not published or deployed.

Read-only evidence on 2026-10-04: the production alias and runtime logs identify
deployment dpl_A5LzhBwUPMWYo6t6cn7iuct28Jsr at b307280. Inbound events 133, 134
and 135 were separate completed jobs, one attempt each, without retained
checkpoints. Unpaid and explanation turns produced repeated workspaceData INVALID
results. The model question called getAIProviderConfiguration successfully, then
its final/repair rounds returned an answer about the earlier invoice request.
The repair round reported unverified_proposal. Exact tool arguments and rejected
draft text were not retained; the exact live invalid field cannot be established.

Confirmed code defects: the invoice update validator allowed only invoice_number
or id, preventing customer_name from reaching the new scoped resolver. Repair
instructions assumed an actual tool failure even when current tool evidence was
successful. Output checks allowed a safe-looking failure about an earlier turn.
These defects are reproduced offline; this is not proof of the unrecorded live
arguments. Read-only invoice/payment evidence confirms the active John Smith
invoice is paid with one recorded payment. It must not be reset to unpaid.

The correction allows one customer-name update target to resolve inside the
verified workspace, requires an unambiguous invoice, and converts it to a scoped
record ID for existing write flows. Unpaid checks remain read-only: zero payments
and an active unpaid state yield an already-unpaid no-op; existing payments or a
terminal state yield PAYMENT_GUARD. No ledger mutation or reversal is added.

Missing target and unsupported fields receive specific validation reasons and
the existing safe catalog. Logs retain only allowlisted reason codes, never raw
arguments or business values. An error-explanation question cannot retry a write.
Verified configuration results are formatted directly from the server catalog,
so an extra summary/repair call cannot return an unrelated old invoice failure.
Other final/repair prompts explicitly anchor the current owner request and stop
assuming a failure when no failed tool result supports it.

Regression fixtures exercise unpaid no-op, paid/payment guard, ambiguous JohnSmith
matching, missing target/unsupported fields and the three-turn screenshot flow.
Duplicate webhooks reuse their own durable reply. Existing invoice/payment fixtures
are compared before/after, and all reads must retain verified workspace scope.
Full release checks remain offline. Live model/WhatsApp correctness after deployment
is still unverified, and publication/deployment require separate approval.
