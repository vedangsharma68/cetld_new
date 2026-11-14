# Private chat cutover (operator procedure; no production changes run by tests)

A schema migration cannot stop deployed JavaScript from calling Cloudflare. Main
77cf1bd does not read readiness, and settings-read errors fall back to defaults.
Neither a revoked API credential nor a failed database query is a privacy fence:
the former can still transmit the request body, and the latter can be ignored.
Do not apply-first/deploy-first on live traffic and assume the new cursor helps.

This cutover requires a brief, externally enforced maintenance window. The fence
must exist **outside both old and new application versions**. On this Vercel
project, use an operator-controlled Vercel Firewall blocking rule over all `/api/`
entrypoints and every deployment/alias capable of processing the workspace, plus
pause scheduled/manual processing invocations and any external worker. This is
an existing platform facility, not a new product service. Preserve rule IDs and
its enforced configuration as rollout evidence. If such a fence is unavailable,
STOP: do not migrate or cut over. No application/SQL switch can substitute for it.

1. Inventory production and preview URLs, webhook entrypoints, `/api/whatsapp`,
   `/api/whatsapp-process`, `/api/ai`, `/api/automation`, and direct/custom-domain
   aliases. Enable the fence; verify requests through each route/alias receive a
   non-2xx response **without invocation**. Do not acknowledge dropped webhook
   bodies with HTTP 200. Meta will retry non-2xx deliveries; already queued inbox
   events remain durable. Do not delete/consume queue rows, STOP events or receipts.
2. Pause scheduled and external/manual callers, then drain existing function and
   waitUntil/queue processing to **zero** using platform invocation/worker logs.
   Wait at least the configured maximum lifetime, including background work;
   a request timeout alone is not proof of drain. Verify zero provider activity
   and no active old-version invocations. Leave the fence in force throughout.
3. Install the additive DDL under its short timeouts. No old columns/functions
   are renamed or removed. OLD/NEW capture is active immediately, but the correct
   numeric/UUID watermark backfill must still scan all untouched historical rows.
4. Run `node scripts/backfill-private-invoice-terms.mjs` as the database operator
   until all four sources report `allComplete:true`. The CLI commits each batch;
   never wrap the whole run in a transaction. Retain per-source numeric/UUID
   upper/cursor values and scanned counts; reconcile against read-only source
   counts at the captured watermarks. A soft 500ms yield is not a latency promise.
   On timeout, resume; never manufacture completion or clear private aliases.
5. While fenced, stage/switch to the new application and verify all serving
   aliases point to it. Confirm no old workers/invocations survive. Through an
   operator-only controlled validation path, verify readiness, deterministic
   menus/balances and ordinary chat using synthetic non-confidential inputs.
   New code fails closed if the schema/readiness/retention store is unavailable.
6. Remove the fence only after the new code, truthful completion and drain checks
   pass. Resume processing and retries using existing idempotency keys. Monitor
   native write latency and queue recovery. No reminder/commercial-send policy
   changes are part of this PR. All production actions require the operator.

If rollback is necessary, reapply/keep the external fence and drain first. Do not
resume old provider chat: it lacks containment even with a complete new schema.
Leave the additive data intact. Old ledger writes and SQL queries remain schema
compatible, but compatibility is not permission to reopen old provider paths.

The release tests demonstrate the old handler's readiness ignorance, additive
schema compatibility, new handler fail-closed behavior, and a closed external
request boundary preventing handler/provider invocation. They do **not** claim
the production firewall has been configured or the production workers drained.
Those are mandatory operator checks; this task makes no deployment or DB changes.
