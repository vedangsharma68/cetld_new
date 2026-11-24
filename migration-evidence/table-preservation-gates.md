# Full source-table preservation gate

Live information_schema inventory, November24. Counts and row values intentionally omitted. Every row below remains blocking for real import, including empty source tables. Core/settings planners do not implement an exporter, importer, reminder effects or integration behavior. No table is implicitly disposable. Auth users/identities require their separate sameUUID/provider checks.

| Source table | Current preservation scope | Real import |
|---|---|---|
| app.accounting_connection_epochs | Unmapped preservation and behavior required | BLOCKED |
| app.accounting_invoice_admissions | Unmapped preservation and behavior required | BLOCKED |
| app.accounting_refresh_permits | Unmapped preservation and behavior required | BLOCKED |
| app.first_party_reminder_button_events | Unmapped preservation and behavior required | BLOCKED |
| app.first_party_reminder_dispatches | Unmapped preservation and behavior required | BLOCKED |
| app.first_party_reminder_receipt_events | Unmapped preservation and behavior required | BLOCKED |
| app.first_party_reminder_templates | Unmapped preservation and behavior required | BLOCKED |
| app.invoice_lifecycle_write_context | Unmapped preservation and behavior required | BLOCKED |
| app.invoice_total_correction_context | Unmapped preservation and behavior required | BLOCKED |
| app.offline_invoice_businesses | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_alias_cache | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_customer_parties | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_global_keys | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_index_state | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_raw_edges | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_sources | Unmapped preservation and behavior required | BLOCKED |
| app.private_dispatch_witnesses | Unmapped preservation and behavior required | BLOCKED |
| app.private_invoice_canonical_inputs | Unmapped preservation and behavior required | BLOCKED |
| app.private_invoice_capture_epochs | Unmapped preservation and behavior required | BLOCKED |
| app.private_invoice_capture_state | Unmapped preservation and behavior required | BLOCKED |
| app.reminder_approvals | Unmapped preservation and behavior required | BLOCKED |
| app.reminder_delivery_evaluations | Unmapped preservation and behavior required | BLOCKED |
| app.signup_invites | Unmapped preservation and behavior required | BLOCKED |
| app.test_invoice_creations | Unmapped preservation and behavior required | BLOCKED |
| app.whatsapp_service_deliveries | Unmapped preservation and behavior required | BLOCKED |
| app.zoho_capture_completion | Unmapped preservation and behavior required | BLOCKED |
| app.zoho_capture_write_context | Unmapped preservation and behavior required | BLOCKED |
| app.zoho_customer_origins | Unmapped preservation and behavior required | BLOCKED |
| app.zoho_export_operations | Unmapped preservation and behavior required | BLOCKED |
| app.zoho_invoice_origins | Unmapped preservation and behavior required | BLOCKED |
| public.ai_provider_health | Unmapped preservation and behavior required | BLOCKED |
| public.business_records | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_accounting_connections | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_accounting_oauth_states | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_accounting_sync_records | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_core_automation_delivery_claims | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_core_automation_events | Unmapped preservation and behavior required | BLOCKED |
| public.cetld_core_automation_messages | Unmapped preservation and behavior required | BLOCKED |
| public.customers | Core pure planner only | BLOCKED |
| public.invoice_correction_audits | Unmapped preservation and behavior required | BLOCKED |
| public.invoice_files | Core pure planner only | BLOCKED |
| public.invoice_lifecycle_proposals | Unmapped preservation and behavior required | BLOCKED |
| public.invoice_number_sequences | Unmapped preservation and behavior required | BLOCKED |
| public.invoice_reopening_proposals | Unmapped preservation and behavior required | BLOCKED |
| public.invoices | Core pure planner only | BLOCKED |
| public.owner_assistant_proposals | Unmapped preservation and behavior required | BLOCKED |
| public.owner_assistant_token_receipts | Unmapped preservation and behavior required | BLOCKED |
| public.owner_assistant_turns | Unmapped preservation and behavior required | BLOCKED |
| public.payment_reversals | Unmapped preservation and behavior required | BLOCKED |
| public.payments | Core pure planner only | BLOCKED |
| public.profiles | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_consents | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_conversation_turns | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_direct_write_receipts | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_global_suppressions | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_inbound_events | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_inbound_media | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_invoice_update_claims | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_messages | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_owner_action_receipts | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_owner_contact_recovery | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_owner_verifications | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_pending_actions | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_private_invoice_backfill | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_private_invoice_terms | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_provider_memory | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_suppressions | Unmapped preservation and behavior required | BLOCKED |
| public.whatsapp_workspace_data_proposals | Unmapped preservation and behavior required | BLOCKED |
| public.workspace_ai_settings | Settings pure planner only | BLOCKED |
| public.workspace_members | Core pure planner only | BLOCKED |
| public.workspace_settings | Settings pure planner only | BLOCKED |
| public.workspaces | Core pure planner only | BLOCKED |
