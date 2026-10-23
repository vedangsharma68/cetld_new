# Dashboard UI verification

Run the existing release gate and the browser suite:

```sh
npm ci --include=dev
npm run check:release
npx playwright install --with-deps chromium
npm run test:ui
```

For an installed system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its path. The browser suite serves the real HTML, JavaScript and CSS over loopback. Only its fixture server exposes the in-memory application state; the shipped app has no test globals. It seeds long names, unbroken invoice numbers, large references, payments and records, and makes no live customer sends or production data writes. Authentication network calls are stubbed; these checks do not certify live login, backend authorization or WhatsApp delivery.

The suite checks Overview, Assistant, Business records, Invoices, Conversations, Payments, Connections, Settings and the existing onboarding view at 320, 360, 520, 800, 1280, 1920 and 3840 CSS pixels. It navigates through the actual app buttons, checks page overflow and clipped controls, and hit-tests enabled content buttons. Onboarding is rendered through the test fixture because its old setup card is intentionally retired. Auth forms and invoice forms are checked at 360, 520, 800, 1280 and 1920 pixels.

Drawer checks exercise the eight ordinary account actions plus a synthetic owner-test action, while leaving the production owner-test eligibility gate intact. Every button is scrolled into view and hit-tested. Short 640×360 and 320×280 viewports cover the layout space of 200% browser zoom; a separate 200% text-size test checks wrapping. These are Chromium checks, not physical-device or native mobile-keyboard certification.

Screenshots for every page and drawer size are recorded under `test-results/`. The Dashboard UI GitHub workflow uploads screenshots and any failure traces for seven days. The tests also cover token insertion by pointer and keyboard, selection replacement, length limits, settings save, filters, themes, dialog keyboard focus, and refresh prompt behavior with unsaved input.

## Deployment updates

`npm run check:release` retains the existing owner-chat, TypeScript and complete unit/SQL gates. Its successful npm lifecycle hook runs `build:frontend`. The build hashes the browser import graph, CSS, entry HTML and Vercel commit SHA, stamps the entry assets, and emits `app-version.json`. Static frontend responses require cache revalidation. The client polls the version every minute and checks on focus, visibility and reconnect. A different version displays an explicit refresh prompt; refresh never happens automatically.

Already-open tabs running code from before this change cannot run a checker they never loaded. Refresh them once after the first deployment. Subsequent deployments are detected by the new checker.

## Reminder approval integration dependency

`reminder-review-ui.mjs` provides the frontend review form and an isolated, browser-tested controller. After rebasing onto #173, Conversations and invoice drawers display the exact `approved_reminder_delivery` receipt body/name, with a re-review notice for pending reminders without a complete receipt. Editable draft text is never substituted in this pending-delivery preview.

The editor’s production transport is **not connected yet**. Main at #173 exposes template-only reminder proposals through Assistant; its route schema does not accept custom text/tone overrides, and `reminderDeliveryForm` and the SQL approval gate require templates. The custom service-message/tone preview and approval contract still needs to be supplied before the existing draft/approval flow can be replaced safely.

The controller's normalized interface expects:

- Preview input: `{text, tone}` for the current invoice/business/account.
- Preview result: `{eligible, approvalToken, expiresAt, delivery}`.
- Service delivery: `{form: 'service', text, windowExpiresAt, windowClosedPolicy: 'hold'}`. The words must equal the edited message. Expiry and hold policy must be server-confirmed.
- Template delivery: `{form: 'template', text, templateName}`. The name must match the approved template for the selected tone. The actual expanded words are shown, with an explicit replacement acknowledgement when they differ from the edit.
- Approval must atomically bind the token to the actor, invoice version, text, tone, delivery form and hold policy, return `{approved: true}`, and persist the reviewed form and words for the queued view.

The selected policy is **hold for re-review if the service window closes**. There is no automatic template fallback. A draft edit, tone change, expired preview, unconfirmed delivery form or backend error disables approval. Existing consent, invoice eligibility, owner permissions and send authorization remain server responsibilities and must not be bypassed by an adapter. Production editor/approval wiring remains blocked on that backend contract; fixture tests of this component are not a claim of integrated delivery.
