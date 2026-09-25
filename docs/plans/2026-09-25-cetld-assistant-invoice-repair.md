# CETLD Assistant and invoice repair

## Objective

Make CETLD's invoice ledger and Assistant dependable enough for a real pilot: financial writes remain consistent under retries and partial failures, answers stay grounded in the current workspace, and the AI provider configuration has one tested contract.

## Global constraints

- Preserve workspace isolation and RLS.
- Accounting data remains authoritative for synced invoice/payment state.
- The model may select tools and draft proposals; deterministic code owns financial values and writes.
- Consequential writes require explicit confirmation.
- Do not broaden navigation or redesign unrelated surfaces.
- Keep multi-currency amounts separate and preserve exact decimal values.
- All financial write paths must be retry-safe.

## Task 1: Atomic invoice settlement and payments

- Add failing tests for partial-payment settlement, duplicate retry, overpayment, cross-workspace access, and paid follow-up cancellation.
- Add a workspace-scoped Postgres RPC that locks the invoice, records only the outstanding payment, updates the invoice balance/status, and cancels follow-up when settled in one transaction.
- Wire the dashboard payment and “already paid” paths through the RPC.
- Keep demo behavior equivalent.

## Task 2: Coherent Assistant provider and grounded response contract

- Resolve the current mismatch between provider implementation, saved settings, extraction, and tests.
- Keep the current production Gemini-primary direction from main, with OpenRouter free as the bounded fallback.
- Update tests to exercise both adapters through the shared provider contract without stale OpenRouter-only assumptions.
- Fix generic questions such as “Which invoice is overdue?” being misread as invoice identifiers.
- Use tool-specific empty states and never silently substitute local data when the user explicitly asks for unavailable Zoho data.
- Return answer freshness, completeness, and safe evidence metadata from the Assistant and render it without exposing internal tool structures.

## Task 3: End-to-end verification

- Add/extend deterministic integration tests for invoice creation, partial payment, settlement, retry, Assistant invoice lookup, overdue prioritization, and confirmed Zoho proposals.
- Reload ledger data after successful Zoho connection/organization selection/manual sync, and label retained rows as stale after refresh failure.
- Run typecheck, focused tests, and the full test suite.
- Run a browser smoke test for invoice and Assistant UI states using local fixtures or demo mode where authentication is unavailable.
- Record any live-authenticated flows that remain unverified.
