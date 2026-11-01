# Local invoice review

This is an opt-in WhatsApp owner intake route. Only the exact server environment value `EXTRACTION_ROUTE=offline` selects it. Unset, uppercase, whitespace-suffixed and other values retain the existing provider route, models and settings. This change does not set the variable, alter settings or enable the route in any deployment. The web extraction API retains its existing behavior.

The local intake and its review turns do not construct an extraction/chat provider or invoke model intent classification. Images use the existing bundled Tesseract English OCR and conservative parser (confidence remains capped at 0.69). PDFs use the existing local PDF text reader and deterministic PDF parser; text that does not fit that parser uses the conservative offline text parser. A PDF with no readable text gets exactly: “This PDF has no readable text. Send a photo of the invoice instead.” It cannot fall back to a provider.

Every candidate is presented together, including printed invoice/due dates, amounts, explicit currency and all parsed line items. Printed evidence, confidence, conflicting candidates, low-confidence confirmation fields, assumptions and owner corrections remain in the versioned action. Missing invoice dates are requested, never changed to today. Unresolved currencies are requested, never taken from workspace defaults. An absent balance defaults to the total; absent due dates remain unset and absent readable line items remain empty. Each default is named in the assumptions. A detected table with unreadable rows blocks confirmation instead of silently accepting an empty or partial list.

Direction remains uncertain until the verified owner states issuance. The existing issuance wording is supported, for example `We issued this invoice` or `Issued by us`; negated, quoted, conditional and question forms do not qualify. A clear issuance statement in the attachment caption counts. Printed seller names do not count.

When candidates are complete and valid, one signed Confirm tap accepts exactly the values in that review message; Cancel discards it. The existing confirmation replies (`yes`, `confirm`, `ok`, and the other established `CONFIRMATION_REPLY` forms) are equivalent. A bare confirmation cannot supply missing facts, resolve conflicts or establish direction. No field-by-field confirmation turns are required. Corrections always re-present the complete review and invalidate previous buttons.

Corrections use `parseInvoiceCorrection`, including `set invoice date to 2026-10-20`, `set due date to 2026-11-04`, `set customer to Kabir Textiles`, `set total to 20060 INR`, `currency is INR`, and notes. The only added fact grammar is `set/change invoice number [to] TOKEN` to supply or correct a source number; a standalone supported currency code also uses the existing currency reply pattern. Free-form model edits are unavailable. Payment evidence or invalid monetary/line-item breakdowns remain blocked; send corrected source evidence.

## Database correction allowance

The installed fact-continuation RPC forbids replacing extracted candidates and editing proposals. The added service-role-only `whatsapp_correct_offline_invoice_review` changes only offline review candidates in `incomplete`/`proposal`, with a scoped row lock, expected version and persisted inbound owner source. Printed evidence and source provenance stay immutable. It cannot save an invoice. Normal transition rules, proposal → saving → saved, signed-button binding, later-turn confirmation and strict invoice validation remain in force. The migration is included for review and has not been applied to a remote database.

## WhatsApp message limits

Existing outbound limits are unchanged. Reviews up to 1,024 characters use the existing Confirm/Cancel buttons when signing is available. Longer reviews up to 3,790 characters display every value together and use equivalent text confirmation. A review larger than that retains all evidence but blocks confirmation and asks for a smaller invoice or review in cetld. It never truncates a candidate and then permits confirmation. These are necessary transport exceptions to the one-message button design.
