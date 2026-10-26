# Release build performance

Scope: release/test infrastructure only. Base is current GitHub main at investigation start,
`2cd078446fa6e373d5877d3c387becd7dcb5b19a` (confirmed through connected GitHub;
the local `origin/main` ref was stale and shell fetch could not reach its proxy).

The supplied production baseline is deployment `dpl_GbMvdUcP97GensUWdGBQxgouYxmP`:
29m42s total, 28m44s full tests (`1724411.410032ms`), 7s npm install, with build
cache already restored. Enabling cache alone does not explain or solve that time.

## Changes and boundaries

- Bound the existing complete Node test command to two file workers. Both original
  TS and MJS globs remain. The owner battery, typecheck, full suite, manifest,
  and npm frontend lifecycle hook remain mandatory and in their existing order.
- Extract and harden the existing private per-release empty-schema cache. No
  persisted cross-deployment cache is delivered or claimed.
- No runtime modules, migrations, manifest content list, Vercel configuration,
  OCR/PDF assets, function bundles, account settings or live services change.

Exact changed files:

- `package.json`
- `tests/fixtures/offline-sql-network.mjs` (cache plumbing only)
- `tests/fixtures/empty-schema-cache.mjs` (new)
- `tests/empty-schema-cache.test.mjs` (new)
- `docs/build-cache-performance.md` (this report)

The consent task may also modify `tests/fixtures/offline-sql-network.mjs`.
Preserve its migration-exclusion handling when rebasing; this change leaves
migration selection and historical exclusions intact. The gate and its shared
manifest list are untouched. The published consent branch was inspected at
`f02c134012931c254b9ba63f8d8e8050e30f270a`. Its fixture patch adds exclusions for
`20261026045045_quoted_owner_consent_source.sql` at the start of
`createOfflineSqlNetwork`, separate from this cache plumbing. A scratch
three-way merge against `2cd0784` completed cleanly and retained both changes.
No consent code or migration is copied into this PR. Check again before merging;
a future rebase must retain that new exclusion handling.

## Cache correctness and exposure

The unchanged gate creates a private `mkdtemp` directory under the operating
system temp directory, supplies it only to verification children, and recursively
removes it in `finally`. No cache files are added under the repository's public output
(`outputDirectory: "."`), `.vercel/output`, dependencies, or runtime imports.
Only test fixtures import the helper; production modules do not.
There is no private cached archive to publish or bundle. After validation, verify
no archive was left in the repository and the release temp directory was removed.

Keys include all selected migration names and contents; the fixture source
(including bootstrap SQL and migration selection); helper source; dependency
lockfile (including PGlite version); full Node version and component versions
(including V8/WASM runtime); operating system and CPU architecture; and envelope
format version. An excluded migration cannot affect that historical schema;
changing the selected set changes its key. No customer data, credentials or
mutable test database is a cache input.

Only the newly migrated database is dumped, before returning control to a test.
Every hit creates a **new** PGlite instance. The archive is wrapped in a single
file containing its key and SHA-256 integrity digest. This catches truncation,
corruption and mismatches before restore. SHA-256 is an integrity check, not
protection against an attacker who can write to the private build directory.
Missing, unreadable, oversized, invalid or incompatible archives fall back to
fresh migrations. Schema/migration failures still propagate and fail the gate.

A UUID temporary file (mode 0600, exclusive create) is atomically renamed.
A nonblocking publication lock serializes count checks and writes: contenders
may build cold but never read partial output. A crashed lock disables further
writes until release cleanup; it cannot block checks. Limit: 32 entries, each
at most 16 MiB plus a small header (about 512 MiB total plus one in-flight file).
There is no eviction race or indefinite storage growth across releases.

## Vercel custom-framework findings

Official [Build Output API configuration](https://vercel.com/docs/build-output-api/configuration)
defines `cache` globs in **generated `.vercel/output/config.json`**. It is not a
new top-level `vercel.json` property. `framework: null` and `outputDirectory: "."`
do not by themselves declare arbitrary fixture directories as build-cache paths.

The inspected public [static builder prepareCache](https://github.com/vercel/vercel/blob/main/packages/static-build/src/index.ts)
first honors Build Output API v3 cache globs, then legacy filesystem configuration,
then defaults plus framework cache patterns. The [default paths](https://github.com/vercel/vercel/blob/main/packages/build-utils/src/default-cache-path-glob.ts)
are `**/{node_modules,.yarn/cache}/**` (source inspected 2026-10-26).
These sources describe current behavior, not proof of the exact builder revision
used by the supplied production deployment.

The [v3 output detector](https://github.com/vercel/vercel/blob/main/packages/static-build/src/utils/build-output-v3.ts)
checks for the existence of `.vercel/output/config.json`. The static builder
then returns that directory as final v3 output instead of continuing its normal
output handling. A cache-only generated config therefore changes output mode
and requires a complete, verified routes/functions/static output implementation. Putting
private archives under the repository root could expose them in this project's
static output. Neither is warranted here. Dependency caching already worked in
the measured deployment. Cross-deployment fixture reuse requires a separately
reviewed, proven private cache mechanism and deployment-output inspection.

## Measurements

Environment: same managed Linux x64 environment for all rows; Intel Xeon
Platinum 8573C; cgroup CPU quota `200000/100000` (2 CPU), memory limit
`8589934592` bytes (8 GiB). Node v24.19.0, npm 11.9.0, PGlite 0.5.8,
tsx 4.23.15, TypeScript 7.0.2. Host-reported RAM/CPU count is not the quota.
Dependencies were already installed; install time is excluded.

Focused sample (unchanged baseline cache implementation):
`accounting-invoice-integrity-sql`, `business-name-reminders-sql`,
`contact-hours-sql`, `invoice-total-correction-sql` test files. Each worker count
used a new private temp cache; warm immediately reused that same directory.
All six runs passed. Wall times include Node startup, migrations/restores and cases.

| File workers | Cold cache | Warm cache |
| --- | ---: | ---: |
| 1 | 17.60s | 10.13s |
| 2 | 15.37s | 9.41s |
| 4 | 17.23s | 10.12s |

These single samples select a candidate; they are not full-release speedups.
Full gates ran serially, baseline first, using separate worktrees and the same
installed dependency tree. Both started with a new private release cache.
The candidate includes the added regression file; nothing was skipped.

| Measurement | Baseline `2cd0784` | Candidate | Difference |
| --- | ---: | ---: | ---: |
| Complete `npm run check:release`, including frontend hook | 907.13s (15m07s) | 743.98s (12m24s) | -163.15s / **18.0%** |
| Full-suite phase | 899.43s (14m59s) | 736.31s (12m16s) | -163.12s / 18.1% |
| Reported test files passed | 247 | 248 | One new regression file |
| Failures / skips | 0 / 0 | 0 / 0 | No gates dropped |
| Aggregate child CPU time (user + system) | 1272.82s | 1438.62s | +13.0% |
| Largest child-process RSS (not concurrent total) | 1406.6 MiB | 1441.2 MiB | +34.6 MiB |

This is an observed wall-time improvement for the combined patch in one local
pair, with increased aggregate CPU work. It does not establish a reduction in
CPU consumption, statistical repeatability or production deployment time.
The existing baseline had one file worker in this Node environment; the
candidate explicitly has two. Each process can itself use native/WASM threads.

Limits: one trial per full gate, fixed ordering, shared OS page/dependency cache,
light inspection during runs, no attempt to reproduce Vercel's physical CPU,
builder revision or storage. Matching 2-CPU/8-GiB quotas is not matching Vercel
hardware. The supplied 29m42s deployment remains the production baseline.

Final validation:

- Both full gates exited successfully after owner battery, typecheck, complete
  suite, manifest creation and frontend lifecycle hook.
- Eight new focused regressions passed directly, including a real PGlite
  corrupted-archive cold rebuild with no retained test rows. These also ran
  within the candidate full suite.
- Existing real fixture isolation and owner-release-gate tests passed in the
  full suite. Tests cover key dimensions, independent restores, historical
  schema selection, corrupt/missing/mismatched/oversized/unloadable caches,
  unavailable storage, atomic concurrent publication, entry limit and failure
  at each required gate stage.
- All 112 manifest fingerprints and the checks list match baseline. Generated
  frontend versions also match. The expected generated HTML build stamp was
  restored before publication; it is not part of the diff.
- No `cetld-release-sql-*` directories remain under `/tmp`; no `.tgz` cache
  archive exists in the candidate repository. Only test fixtures import the
  cache helper. Runtime assets/configuration are unchanged by the diff.
- `git diff --check` passed.

Final candidate two-worker sample, same four files and commands: **14.31s cold**,
**10.60s warm**, both passed. Compared with the earlier baseline two-worker
sample (15.37s / 9.41s), the cold sample was lower and the warm sample higher.
These single samples do not demonstrate that cache hardening itself is faster;
its purpose is correctness and bounded storage. "Cold" here means an empty
fixture directory, not a cold machine/OS cache. The full-gate result is the
release-level evidence for this patch, and cannot isolate the effects of the
worker bound, cache changes and extra tests.

## Verification after review

1. Reconcile current main and the consent branch, preserving both fixture edits;
   rerun the mandatory gate if schema/fixture inputs change.
2. In an explicitly authorized later Vercel review deployment, record commit,
   builder/Node versions, Basic machine class, install/owner/typecheck/full-suite/
   frontend/total times, cache restore source and verification results.
3. Compare equivalent before/after deployments on the same machine class; repeat
   to estimate variance. Do not attribute local sample speed to production.
4. Inspect generated static output and function bundles for fixture archives,
   test databases and secrets. Confirm OCR/PDF/WhatsApp/accounting assets remain.
5. A subsequent deployment must explicitly demonstrate any proposed persisted
   fixture-cache hit and invalidation before cross-deployment reuse is claimed.
   This PR does not provide that feature.

## Reproduction

Use separate worktrees for base and candidate with the same installed dependency
versions. Run them serially on the same host; each `check:release` creates and
cleans its own cold fixture directory. Include npm's lifecycle hook when timing:

```sh
time npm run check:release
```

For the focused sample, use a new `mktemp -d` directory for each concurrency,
then run the command twice with that same directory (cold then warm). Remove the
directory after the pair. Substitute `1`, `2`, `4` for `WORKERS`:

```sh
CETLD_SQL_FIXTURE_CACHE_DIR="$FIXTURE_DIR" NODE_ENV=test \
node --import tsx --test --test-concurrency=WORKERS \
  tests/accounting-invoice-integrity-sql.test.mjs \
  tests/business-name-reminders-sql.test.mjs \
  tests/contact-hours-sql.test.mjs \
  tests/invoice-total-correction-sql.test.mjs
```

New regression coverage is in `tests/empty-schema-cache.test.mjs`; existing
`tests/offline-sql-fixture-isolation.test.mjs` exercises actual independent
restores, schema/session isolation and historical migration selection.
`tests/owner-release-gate.test.mjs` continues to check the mandatory release
sequence, manifest fingerprints and deployment build command.
