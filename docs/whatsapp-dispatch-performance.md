# Dispatch snapshot performance repair

`20261120132445_dispatch_privacy_performance.sql` is a forward-only migration.
It changes computation, not admission policy. Apply it through the normal
migration process before expecting the delivery outage to recover. Repository
verification uses disposable databases; it does not apply production migrations
or send real WhatsApp messages.

The previous snapshot repeatedly expanded origin grammar even for already typed
canonical keys, repeatedly expanded raw aliases, and compared every alias against
an owned-value array. Its cost grew with both retained terms and owned values.
The same immutable expansions were repeated for every reply.

The replacement:

- Projects origin grammar only for actual source origins; typed canonical terms
  never enter that parser merely to have the result discarded.
- Deduplicates inputs, materializes their projections once, and uses set joins for
  ownership and forbidden membership instead of repeated array membership scans.
- Memoizes **pure alias outputs** by workspace, exact input hash/value, semantic
  role and canonicalizer revision. Lookup uses the complete indexed key. Numeric
  scalars and UUIDs take their existing unambiguous interpretations before calendar
  or word grammar construction. Tests compare these aliases with the old parser.
- Reuses computations during retention. Memo writes use a nonblocking advisory
  try-lock; competing transactions compute the same uncached result rather than
  waiting for a cache writer. Failed transactions roll memo writes back.
- Avoids independent-party witness traversal when there are no reviewed inferred
  parties to resolve. When reviews contain parties, the full independent witness
  check remains in force.

The memo is private, has RLS and no API-role table privileges, and cascades on
workspace deletion. It stores no authorization result. Current owner verification,
recipient binding, active private terms (including foreign workspaces), owned
schema facts, opaque identifiers, reviewed-content rules, readiness and file
ownership are read again for every snapshot. Updates/deletions immediately change
those live sets. A different field value or semantic revision selects a different
memo entry. Old pure entries cannot authorize anything. There is no TTL during
which an ownership or consent decision remains trusted.

Final transport still scans the exact assembled bytes. No admission check,
assertion, service window, retry claim, timeout or source limit is removed or
increased. Existing mutations of source data, verified binding checks and final
send authorization continue to run in their original order.

## Retry recovery

`prepareMessage` records/reuses the original outbound intent before admission.
A snapshot outage throws before the atomic reply claim, so the pending message
and deferred event remain retryable. After recovery, the original stored body is
screened again; recipient/audience/kind/customer/invoice mismatches fail closed.
The reply claim and callback token prevent concurrent or recovered workers from
resending an accepted/uncertain request. Commercial authority and the reply claim
both enforce the durable inbound timestamp's 24-hour window. A stale deferred
reply is blocked before transport. No retry semantics needed modification.

`tests/whatsapp-dispatch-retry.test.mjs` uses the real SQL inbox, conversation
store, worker and outbound adapter, injects one snapshot timeout, reconstructs the
worker, and observes one accepted send followed by a delivered callback. It also
forces lease recovery/concurrent processing and checks that there is no second
Graph request; a stale pending intent remains unsent.

`tests/dispatch-snapshot-performance.test.mjs` compares old/new complete snapshot
sets, exercises a cold memo in a thousand-invoice workspace under a one-second
SQL budget, checks live ownership/source changes, semantic revision separation,
API privileges and incomplete-readiness failure. Existing dispatch tests cover
foreign values, own-value controls, reconstruction, tools/media and final bytes.

## Local measurements (same disposable database before/after)

`node scripts/benchmark-dispatch-snapshot.mjs` retains a 100-invoice baseline,
installs only the new performance migration, compares complete snapshot sets,
and expands the same workspace to 1,000 invoices. Recorded on the author machine:

| Profile | Before | After cold memo | After warm memo |
| --- | ---: | ---: | ---: |
| 100 invoices for one recipient | 1,111.9 ms | 129.8 ms | 30.0 ms |
| 1,000 invoices for one recipient | — | 1,130.4 ms | 274.3 ms |

After retaining an additional 2,400-character declaration, snapshot time was
303.0 ms; capture itself took 400.6 ms. The separate regression's 1,001-invoice,
ten-customer workspace measured 745.2 ms cold and 139.9 ms warm under its tighter
one-second SQL limit. These are local measurements, not a production SLA. The
reported production timeout (>80 seconds) was not rerun against production.

Historical fixture loading omits this dependent extension when canonical capture
is intentionally absent. The archived parent/head numeric comparison likewise
omits this future migration only for its frozen parent schema. Every archived
assertion and both comparison phases still execute unchanged; the current phase
loads the performance extension. No test is skipped and no timeout is raised.
