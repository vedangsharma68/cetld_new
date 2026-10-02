# Settings release

This release combines `settings-model-picker` (`7b6e5c9`) and
`settings-ux-fixes` (`ea0c7ee`) on local `main`.
Conflict resolution preserves both picker bindings and settings navigation.
Provider policy now distinguishes chat from extraction explicitly, so selecting
Gemini Flash Lite for chat does not inherit extraction retry/fallback behavior.

## Verification

- `npm test` and `npm run typecheck` are release gates. Three optional tests
  require private PDF/image paths and are skipped when those inputs are absent.
  Final run: 586 passed, zero failed, three skipped (589 tests). Typecheck passed.
  One earlier run under concurrent checks hit an unchanged OCR test's 30 ms
  deadline; the final unmodified full-suite rerun passed without competing checks.
- The integrated browser harness passed with installed Google Chrome at
  390x844, 768x1024, and 1440x900 with reduced motion enabled. It checks model
  exclusivity in both directions, mocked save/reload persistence, scroll and
  click navigation, form focus and sizing, and mocked WhatsApp number controls.
- Browser API and database responses are intercepted fixtures. Edge was
  unavailable; Firefox and WebKit were not verified.

To repeat the browser checks, serve this worktree and run
`node scripts/verify-settings-ux.mjs`. Set `CETLD_SETTINGS_URL` to its `/app/`
URL, `CETLD_PLAYWRIGHT_PATH` to an available Playwright Node module, and
`CETLD_CHROMIUM_EXECUTABLE` when using an installed Chrome binary.

## Deployment sequence

1. Confirm the target database has the constraints from
   `supabase/migrations/20261002060000_workspace_ai_model_choices.sql`.
   The originating model-picker task reports that the SQL was applied
   successfully; this integration task has not inspected the live database.
   No owner-specific columns or additional UX migration are required.
2. Confirm server environment credentials exist for the providers offered by
   the models endpoint: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
   `GEMINI_API_KEY`, and `OPENCODE_ZEN_API_KEY` where Zen is used.
   Do not place credentials in browser code or commit them.
3. Publish the verified main commit and deploy it through the existing Vercel
   release process. Pushing main may trigger an automatic production build;
   treat publication as part of the production release decision.
4. In a signed-in workspace, select distinct primary and fallback models,
   save, and reload. Check that saved choices remain selected and unavailable
   choices are handled clearly.
5. With reduced motion enabled, check settings scroll highlights, click
   navigation, mobile spacing, keyboard focus, and WhatsApp number controls.
6. Send an authorized owner-chat request and verify saved model selection in
   server-side diagnostics. Local mocked tests do not establish live provider
   availability, production database persistence, or WhatsApp delivery.

No production deployment, database migration, credential change, or real
WhatsApp send is performed by this integration task.
