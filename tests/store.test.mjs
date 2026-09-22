import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../automation/store.mjs";

const scope = { ownerId: "owner-a", workspaceId: "workspace-a" };
const other = { ownerId: "owner-b", workspaceId: "workspace-b" };
function invoice(overrides = {}) {
  return { id: "inv-1", ...scope, amountMinor: 1000, paidMinor: 0, followupState: "approved", nextFollowUpAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

test("only one worker can claim a due invoice", async () => {
  const store = createMemoryStore({ now: () => new Date("2026-01-01T00:00:01Z") });
  store.seedInvoice(invoice());
  const claims = (await Promise.all(Array.from({ length: 12 }, () => store.claimDueFollowups({ ...scope, now: "2026-01-01T00:00:01Z" })))).flat();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "claimed");
});

test("payment after claim invalidates authorization before outbound", () => {
  const store = createMemoryStore({ now: () => new Date("2026-01-01T00:00:02Z") });
  store.seedInvoice(invoice());
  const claim = store.claimDueFollowups({ ...scope, now: "2026-01-01T00:00:01Z" })[0];
  store.markInvoicePaid({ ...scope, invoiceId: "inv-1" });
  const authorized = store.authorizeDelivery({ ...scope, claimId: claim.claimId });
  assert.equal(authorized.authorized, false);
  assert.equal(authorized.reason, "stale_claim");
  assert.equal(store.claims.get(`${scope.workspaceId}:inv-1:2026-01-01T00:00:00.000Z`).status, "cancelled");
});

test("pause after claim invalidates authorization", () => {
  const store = createMemoryStore();
  store.seedInvoice(invoice());
  const claim = store.claimDueFollowups({ ...scope, now: "2026-01-01T00:00:01Z" })[0];
  store.pauseInvoice({ ...scope, invoiceId: "inv-1" });
  const authorized = store.authorizeDelivery({ ...scope, claimId: claim.claimId });
  assert.equal(authorized.authorized, false);
  assert.equal(authorized.reason, "stale_claim");
});

test("unknown provider delivery is quarantined and cannot become a retry", () => {
  const store = createMemoryStore();
  const result = store.recordDelivery({ ...scope, providerMessageId: "provider-unknown", payload: { status: "failed" } });
  assert.equal(result.quarantined, true);
  assert.equal(result.retry, false);
  const message = [...store.messages.values()][0];
  assert.equal(message.status, "quarantined");
  assert.equal(store.events.size, 1);
});

test("scope prevents claims and delivery authorization across workspaces", () => {
  const store = createMemoryStore();
  store.seedInvoice(invoice());
  const claim = store.claimDueFollowups({ ...scope, now: "2026-01-01T00:00:01Z" })[0];
  assert.equal(store.authorizeDelivery({ ...other, claimId: claim.claimId }).authorized, false);
  assert.equal(store.getInvoice({ ...other, invoiceId: "inv-1" }), null);
});

test("messages, events and replies are idempotent within a workspace", () => {
  const store = createMemoryStore();
  const message1 = store.recordMessage({ ...scope, idempotencyKey: "m-1", payload: { a: 1 } });
  const message2 = store.recordMessage({ ...scope, idempotencyKey: "m-1", payload: { a: 2 } });
  assert.equal(message1.inserted, true); assert.equal(message2.inserted, false);
  assert.equal(store.recordEvent({ ...scope, type: "x", idempotencyKey: "e-1" }).inserted, true);
  assert.equal(store.recordEvent({ ...scope, type: "x", idempotencyKey: "e-1" }).inserted, false);
  assert.equal(store.saveReply({ ...scope, idempotencyKey: "r-1", body: "ok" }).inserted, true);
  assert.equal(store.saveReply({ ...scope, idempotencyKey: "r-1", body: "changed" }).inserted, false);
});

test('a stale worker cannot invalidate an in-flight authorized send',()=>{
  const now=new Date('2026-01-01T00:00:02Z');const store=createMemoryStore({now:()=>now});store.seedInvoice(invoice());
  const claim=store.claimDueFollowups({...scope,now})[0];
  const authorization=store.authorizeDelivery({...scope,claimId:claim.id});assert.equal(authorization.authorized,true);
  assert.equal(store.authorizeDelivery({...scope,claimId:claim.id}).authorized,false);
  assert.equal(store.markDeliveryFailed({...scope,claimId:claim.id,unknown:false}).ok,false);
  assert.equal(store.markDeliverySent({...scope,claimId:claim.id,token:authorization.token,providerMessageId:'sent'}).ok,true);
});
