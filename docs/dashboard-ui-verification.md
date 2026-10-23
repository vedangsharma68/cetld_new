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

## Integrated reminder approval

The invoice drawer and Conversations open the production review form. The owner edits per-message text and tone, chooses scheduled follow-up or a one-off send, previews the actual outgoing words/form, and explicitly acknowledges that artifact before approval. Changing text, tone, timing or fallback choice invalidates the preview. Tone changes generate the actual proposed draft; replacing edited text requires confirmation.

Scheduled reminders use approved templates under **cetld product policy**, including inside the customer service window. A one-off reminder can send the exact edited text within WhatsApp’s 24-hour customer service window. Outside that window the preview offers the tone-matched approved template and explains that custom wording cannot send as-is. Custom wording remains in the dashboard draft.

For a service message, the default expiry policy is hold for re-review. An optional named fallback must be selected before preview; the screen then shows both exact bodies and requires acknowledgement of both. Conversations and invoice drawers show the immutable approved receipt, fallback choice and visible expiry reason. They never substitute a later editable draft in the pending-delivery preview.

The browser suite also sends real HTTP requests through `ai/routes.mjs`, the real Supabase SDK and isolated PostgreSQL. It approves through the normal dashboard buttons at 320, 360, 520, 800, 1280, 1920 and 3840px, reads back the stored receipt, and checks the captured Graph request. Separate checks exercise scheduled-template replacement and the visible window-expired hold. Auth is supplied by the fixture; no live login or production customer send is certified.

See [the API, preservation mapping, dispatch checks and rollout instructions](per-message-reminders.md).
