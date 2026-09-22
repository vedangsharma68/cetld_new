# Core backend integration contract

The new repo's core-backend branch had no schema when this branch was built.
These additive SQL files intentionally do not invent a second core backend.
Before installing, merge the core schema and map these existing cetld names if
that branch uses a different naming convention:

| Table | Required columns |
| --- | --- |
| `auth.users` | `id uuid` (Supabase managed) |
| `cetld_workspaces` | `id uuid primary key`, `owner_id uuid` |
| `cetld_invoices` | `id uuid primary key`, `owner_id uuid`, `workspace_id uuid`, `amount_minor bigint`, `paid_minor bigint`, `followup_state text`, `next_follow_up_at timestamptz` |

Runtime invoice reads additionally consume `number`, `currency` (ISO 4217),
`due_date`, optional `debtor_timezone`, `customer_contact_id`,
`bookkeeping_provider` (`zoho_books`/`zoho`/`quickbooks`) and
`bookkeeping_record_id`. Invoice amounts use the currency's minor units.

Install `supabase/install/automation_persistence.sql` and
`supabase/install/accounting_integrations.sql` after core schema creation, or
adopt their contents into CLI-generated migrations in the backend branch.
The automation SQL adds its own settings, contact phone, reminder count,
last-reminder timestamp and version columns to invoices.

The current authorization bridge uses workspace ownership. If core supports
team membership, adapt `authorizeWorkspace` in `automation/http.mjs` and the
read policies together; never accept an arbitrary caller-supplied owner ID.
Worker endpoints remain server authenticated.

New activity records are in `cetld_automation_events` (`metadata` JSON).
New messages are in `cetld_automation_messages` (`payload` JSON, provider ID,
direction/status). Both are read-only to authorized workspace owners. These
are the frontend activity/conversation data sources for the new engine.
Accounting ciphertext and OAuth state are completely inaccessible to browser
roles; only the server service role can read or mutate them.
