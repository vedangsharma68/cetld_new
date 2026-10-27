# Remove unused Vercel OIDC without changing inbox scheduling

Base: deployed PR205/main `249b0aeebe6c2a5e45e9c3f294d5a8f1112b5310`.
PR204 is held separately; no migration, provider/account configuration, runtime
API, webhook, middleware, cron, Vercel config or CI gate changes are included.
This is offline code/build evidence, not deployment or live bot acceptance.

## Decision and supported scope

| Route | Benefit | Risk / decision |
|---|---|---|
| A: remove Functions, replace `waitUntil` / `next` | Removes the full dependency | Plain Node has no Next `after()`. The supported non-Next mechanism remains the Functions package. Copying its private request-context symbol creates an application-owned runtime contract. Not selected. |
| B: retain Functions3.9.9, exclude unused upstream OIDC | Preserves documented scheduling/middleware unchanged; removes actual vulnerable files | Selected. OIDC becomes deliberately unavailable, with a throwing local package and regression guards. Future OIDC use requires a separate dependency/security review. |
| C: document residual reachability only | No install/runtime change | Leaves all four audit highs and bundled vulnerable code installed. Not needed because B passes clean installation and offline behavior tests. |

Sources checked 2026-10-27:
- [Vercel Functions API](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package): documented `waitUntil` for non-Next Node functions; `after()` recommendation is for Next15.1+.
- [npm11 overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides): replacement package/file specifiers and references to direct dependencies (`$name`) are supported.

There are exactly two application imports: root `@vercel/functions` for
`api/whatsapp.js` and `@vercel/functions/middleware` for `middleware.js`. Neither
loads the separate `./oidc` subpath. No app source imports OIDC. This was an
observed boundary, not an exploitability clearance for the old artifact.

## Actual removal and installation

Before: Functions3.9.9 -> OIDC3.8.9 -> CLI-config0.3.0 -> Zod4.1.11.
CLI-config's root bundle embeds Zod4.1.11; merely overriding external Zod leaves
that code unchanged. Latest CLI-config0.3.4 also embeds the old validator.

After: Functions remains exactly3.9.9 with its original integrity. A root local
`@vercel/oidc` dependency points to `vendor/vercel-oidc-disabled`, and the override
`"@vercel/oidc": "$@vercel/oidc"` makes the transitive request use that same local
package. Its version is explicitly `0.0.0-cetld-disabled`, not an upstream
version. The package has no dependencies, install scripts, auth API, token
handling, network activity or success simulation. Evaluating its only entry
throws `CETLD_VERCEL_OIDC_DISABLED`. Both direct import and the Functions OIDC
subpath are tested to fail loudly.

The lockfile removes 23 upstream transitive entries, including CLI-config,
CLI-exec, Zod and jose. All retained package entries are byte-equivalent to the
base except the root dependency map and OIDC's replacement with a local link.
No registry package is renamed to hide its advisory, and no vulnerable package
is kept behind an audit exception. The stub is original application code
(marked private/UNLICENSED); it contains no copied upstream implementation.
Unchanged Functions retains its upstream Apache-2.0 package/license.

A nested relative override first produced a broken lock (`npm ci` refused it).
A stale lock was also rejected by `npm ls`. Neither candidate is included. The
final direct-file + `$` reference was regenerated from the original lock without
deleting it, then verified by successful `npm ci` and `npm ls`. No absolute
workspace paths occur in the committed manifest or lockfile.

Reproduction (Node24.19.0, npm11.9.0 locally; configured CI uses Node24):

```sh
npm ci --include=dev --no-audit --no-fund
npm ls @vercel/functions @vercel/oidc @vercel/cli-config zod --json
node --import tsx tests/vercel-dependency-boundary.test.mjs
npm audit --json
npm audit --omit=dev --json
```

A second clean installation in a different empty directory, containing only the
manifest, lock and local stub, also passed; it resolved the same root stub and
Functions version. No symlink relies on the source worktree path. npm ci did not
change either manifest/lock. Future deployment must preserve the tracked vendor
folder; no postinstall/prepare generation is needed.

Baseline all/production audits: **4 high / 4 total** each, one
GHSA-mrhx-c7xc-m3w5 propagated through four dependency nodes. Final all/production
audits: **0 findings** each. The upstream vulnerable OIDC/CLI-config/Zod code is
absent from the installed tree. This does not claim general application safety.

## Published bytes and trace

Original Functions3.9.9 registry tarball SRI:
`sha512-ocN/BNsIswReoyqfU1huilNyBM9tvY9kFXgYj0LlyPRATC1dt35gj2jN5hs9+Nag/CRyVQOX58L2FEhvL+0sSA==`.
The unpacked bytes match installed bytes exactly:

| File | SHA256 |
|---|---|
| index.js | `3f15b477f331868ca7dff124126ca9de0f44ae998a25eafdf1591077296e9a3d` |
| middleware.js | `445a1a1196e64341cd0969f599847ebfe9257cdf20624dfe78705297c6dd48e9` |
| wait-until.js | `dd593a912523ff6d7d3846bce6b5177eba5866a21149e25a4da8278992cebedd` |
| get-context.js | `4331b07d75d102e20b6faabae865fd9f52e53a56f59761224452f926b9c010e2` |

Root and middleware have zero direct OIDC requires; the offline tests pin these
four hashes so dependency updates require renewed review. Stub index.cjs SHA256:
`0b763cbcc16596183c97db07986d885c5f6e3a181ade97aa03ca4a796081f95d`.

Local `@vercel/nft@1.11.0` Node File Trace of `api/whatsapp.js` and
`middleware.js` returned **335 files**, containing neither the OIDC stub nor any
upstream OIDC/CLI-config/CLI-exec/Zod file. NFT was an isolated temporary review
tool, not an added application dependency. Reproduce in an isolated tool directory:

```sh
npm install --prefix /tmp/cetld-nft-tool --ignore-scripts --no-audit --no-fund @vercel/nft@1.11.0
node --input-type=module <<'JS'
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {nodeFileTrace}=require('/tmp/cetld-nft-tool/node_modules/@vercel/nft');
const r=await nodeFileTrace(['api/whatsapp.js','middleware.js'],{base:process.cwd(),processCwd:process.cwd()});
const forbidden=[...r.fileList].filter(p=>/node_modules\/(?:@vercel\/(?:oidc|cli-config|cli-exec)|zod)(?:\/|$)|vendor\/vercel-oidc-disabled/.test(p));
console.log({files:r.fileList.size,forbidden,warnings:[...r.warnings].map(w=>w.message)});
if(forbidden.length)process.exitCode=1;
JS
```

Trace limitations: NFT returned 89 warnings concerning PDF import.meta parsing,
optional ws/AWS/native platform modules and missing cross-platform binaries.
No warning was suppressed. This is local static file-trace evidence, not a
complete deployed-lambda trace or native-module acceptance proof. No Vercel
build/deploy/provider request was performed. Independent deployment inspection
remains required; absence from the installed artifact is separately asserted.

## Behavior proof, failure modes and maintenance

Seven new tests exercise installed absence and pinned source hashes, application
import guards, throwing OIDC paths, real Functions `waitUntil` validation and
context branches, a real signed webhook retaining an unresolved processing
promise while returning200, registration-failure503, and real middleware `next`
plus anonymous/invalid/outage/verified-auth redirect behavior. Fake global fetch
sentinels prohibit unexpected network calls. Synthetic HTTP/auth responses only.
No AI, Graph, accounting, DB, customer or business-data side effects.

The asynchronous scheduling path is unchanged, including function lifetime
limits. Removing `waitUntil` would risk replies waiting for existing00:00/04:00
UTC processor crons: gaps are4h/20h, with a worst-case wait approaching20h plus
processing/retries. That would be a blocking latency defect, not an acceptable
fallback. The positive test proves200 returns before processing completes;
registration failure still returns503 so durable inbox/provider retries remain
visible. Neither test claims real Vercel lifetime or live reply proof.

Targeted validation:
- `node --import tsx tests/vercel-dependency-boundary.test.mjs`: **7 passed**, no skips/cancellations.
- `node --import tsx --test --test-concurrency=2 tests/whatsapp-webhook.test.mjs tests/landing-routing.test.mjs`: **42 passed**, no skips/cancellations.
- `npm run typecheck`, `npm run build:frontend`, `git diff --check`: passed. Generated frontend stamps were restored; no product assets changed.
- Configured exact-head CI runs after publication; no local full-release duplication or manual CI rerun.

The dependency override is a deliberate capability restriction. Any future
Functions upgrade or OIDC import must revisit the byte/import/absence guards,
trace and behavior tests. Do not weaken them to enable OIDC. Replace this stub
only after an independently reviewed upstream artifact truly removes/patches
the bundled validator, with fresh clean-install/audit/trace proof. A future
upstream dependency can import OIDC from root; the fail-closed stub then breaks
initialization visibly rather than silently performing authentication. Review
and configured tests must catch that before rollout.
