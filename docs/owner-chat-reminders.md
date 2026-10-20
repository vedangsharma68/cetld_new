# Reminder approval from owner chat

A verified owner can say `send a reminder to Ravi`, `remind the customer on INV-123 now`, or `show the reminder preview for INV-123`. The `workspaceData` operations `sendReminderNow` and `previewReminder` also support other model-resolved wording. Both require exactly one invoice identifier or customer name; ambiguous matches ask for an invoice number.

The bot shows the exact rendered Meta catalog body, using the existing template selector and parameter builder. Both actions create an `owner_reminder_approval` in the existing pending-action store. A later explicit yes/approve or existing signed confirmation button is mandatory, including in direct owner mode. Cancellation, expiry, pending versions, source/decision inbound messages and owner scope are checked in SQL. Committed decisions use the existing receipt store for replay recovery.

Confirmation writes the dashboard approval fields: `metadata.followup_state = approved`, `metadata.reminder_text`, `metadata.approved_reminder_text`, and `metadata.approved_preferences_updated_at = workspace_settings.updated_at`. The stored text retains the legacy branded-review suffix required by the existing dashboard approval trigger. The displayed Meta body is kept separately in the pending action; the first-party scheduler renders its message through the unchanged template code and does not send that legacy suffix.

`sendReminderNow` additionally sets `next_follow_up_at` to the database clock. It queues work for the next scheduler tick; the chat path never calls a WhatsApp sender. Approval-only retains normal scheduling, including approval outside contact hours. Send-now refuses requests outside the saved contact window.

The new RPC checks current consent/suppression, invoice eligibility, reminder limits, exceptions, payment verification, current customer facts, settings version, and active/uncertain delivery claims before preparation and confirmation. The existing scheduler, final delivery authorization, consent/cadence gates, claims and idempotency remain authoritative and unchanged. Existing preference, business-name and invoice-fact triggers still revoke approval. Stale previews require a fresh request.

Deploy `20261020130000_owner_chat_reminder_approval.sql` after the existing reminder catalog and full-customer-name migrations. It creates only a service-role RPC, with no data backfill, flags, schedules, template edits or sends. Roll back by removing the chat capability and dropping this RPC; existing approvals and delivery gates retain their normal behavior.
