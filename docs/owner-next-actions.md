# Contextual WhatsApp next actions

This local follow-on is based on released commit b307280. It has not been
published, migrated or deployed. Apply 20261004094307_owner_next_actions.sql
before its matching application code, only after separate release approval.

The server selects up to three next actions from verified workspace tool results.
There is no additional model call to generate labels, and a tap uses no model.

| Verified context | Choices | What a tap does |
| --- | --- | --- |
| One active invoice | View file when stored, Edit details, Record payment | Retrieves the scoped stored file, asks for the field/new value, or asks for payment information |
| Settled invoice | View file when stored | Reads the stored file; no edit/payment shortcut |
| One customer | Edit details | Asks for the change; the linked owner contact is excluded |
| Several matching customers/invoices | Up to three numbered record labels | Reads the exact selected record; does not repeat or approve the earlier ambiguous write |
| Invoice collection/business settings overview | Unpaid invoices, Recent invoices, Find invoice | Reads a bounded page or asks for an invoice number/customer |
| Pending approval, failed/unsupported tool, missing signing secret, long reply or media reply | No suggestions | Existing approval choices or typed chat remain available |

Native Confirm/Cancel approvals retain the existing `oab1` capability scheme.
Suggestions use separate `ons1` HMAC IDs containing only a random receipt key
and index. The signature binds the exact normalized server-owned choices,
workspace and phone. Titles are unique, at most 20 Unicode characters. IDs are
below the existing 256-byte bound, and interactive bodies are limited to 1024
characters. Existing inbound authorization, service-window and outbound atomic
claim checks remain in force. A closed service window does not fall back to an
unauthorized template or send.

`owner_next_action_ref` is stored on the existing owner outbound receipt, separate
from `owner_action_ref`. JSON constraints bound its shape and supported actions;
a unique scoped random key identifies one receipt. It expires after 30 minutes.
Raw signed tokens and model-provided commands are not persisted. Replay remints
the first canonical receipt choices, rather than replacing them with a later
draft. Expired suggestions disappear while the factual text stays available.
Missing receipt persistence removes suggestions before returning a text reply.

Every record tap reloads by UUID plus verified workspace and rejects changed
updated_at, deleted/missing records, another tenant, revoked binding or an active
approval. Payment/edit taps only ask for missing details. The user's subsequent
typed instruction enters the existing protected write/confirmation flow; a tap
cannot approve a financial change or reuse values from an ambiguous write.
Typed chat continues to work, including records beyond the three displayed
choices. Read lists are bounded and never imply that a partial page is complete.

File taps use the existing scoped invoice-file download path. A separate bounded
`owner_reply_media_ref` retains only invoice ID/version and file ID, so interrupted
delivery can recover the identical file. A changed invoice/file blocks replay;
the sender rejects replacing its saved file receipt with a text-only claim.
Already accepted replies retain the existing no-second-send recovery behavior.
No raw storage path, bytes or signed download URL is stored in this reference.

Meta documentation check: current developers.facebook.com interactive and
service-window documentation requests returned HTTP 429 in this executor.
The accessible official Meta-hosted archived SDK pages confirm [up to three
reply buttons](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/interactive/),
[20-character titles and 256-character IDs](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/ButtonObject/),
and [1024-character interactive bodies](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/InteractiveObject/).
The established 24-hour service guard is retained and covered by mocked outbound
tests; these archived pages do not establish that current Meta policy is unchanged.
Current policy should be rechecked before publication if the live docs are accessible.

Offline coverage includes scoped/contextual selection, ambiguity, JSONB ordering,
signature tampering, expiry, unknown actions, title limits, protected owner contact,
stale/deleted/foreign records, revocation, pending-approval priority, duplicate
webhooks, first-receipt replay, long-text fallback, file recovery, migration
constraints and native outbound payload/session/claim guards. It does not prove
live model interpretation, Meta acceptance or WhatsApp phone rendering.
