# Migration work in progress

Isolated local branch, base ff066b664d2750638e63adba8b64be1a8290c3b9. No live effect or cutover authority. Source inventory is regex-based and includes tests, not a definitive list of active browser calls.

Customers replaces students by explicit user confirmation. Legacy src/app retained under legacy for reference, not served by Next. Other legacy root handlers, scripts and tests remain temporarily for migration inventory. No claim that remaining modules are migrated.

Next16.4.6 is registry stable; requested Auth.js v5 is beta32, pinned explicitly. Next16 uses proxy.ts for its auth gate, replacing the brief's middleware.ts convention. Node22 local runtime meets Next's >=20.9 requirement.

Protocol assumptions: no-body204; Auth.js protocol endpoints retain native responses; application health uses success/data envelope; invoice PATCH required; browser signed storage fetch is the explicit upload exception. No anon-key rotation or hosted schema changes performed.

No hosted schema pull, DB migration, production user/hash export, bucket move or preview deploy has been run. Hosted database/dev project identity remains to be verified. Existing migrations include live business triggers and RLS semantics that require explicit parity tests before removal.

Latest checkpoint:55unit/contract/generated-SQL tests;6Chromium flows on a new native local PostgreSQL18.6 with synthetic fixture users and no hosted data. Credentials login, workspace selection, customer CRUD, foreign404, invite expiry/email/replay and concurrent one-winner covered. Native Google challenge/subject-binding invariants tested without a real OAuth handshake. New target customer writes corrected to all workspace members after reading live policy definitions. Target generated baseline still not a valid live migration.
