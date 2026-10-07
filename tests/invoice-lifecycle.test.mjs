import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createInvoiceLifecycleService} from '../ai/invoice-lifecycle.mjs';

const WS1 = '10000000-0000-4000-8000-000000000001';
const WS2 = '10000000-0000-4000-8000-000000000002';
const OWNER1 = '20000000-0000-4000-8000-000000000001';
const OWNER2 = '20000000-0000-4000-8000-000000000002';
const INVOICE1 = '30000000-0000-4000-8000-000000000001';
const INVOICE2 = '30000000-0000-4000-8000-000000000002';
const INVOICE3 = '30000000-0000-4000-8000-000000000003';
const PHONE1 = '+919876543210';
const PHONE2 = '+919876543211';

function lifecycleFixture({now = '2026-10-02T12:00:00.000Z'} = {}) {
  let tick = Date.parse(now);
  const clock = () => new Date(tick);
  const advance = ms => { tick += ms; };
  const invoices = new Map([
    [INVOICE1, {id: INVOICE1, workspaceId: WS1, ownerId: OWNER1, invoiceNumber: 'INV-2026-0001',
      customerName: 'Northwind', totalAmount: '1250.50', currency: 'INR', status: 'sent', updatedAt: clock().toISOString(),
      deletedAt: null, paid: false, hadPayment: false, hadSentReminder: false, activeDispatch: false, followupState: 'approved'}],
    [INVOICE2, {id: INVOICE2, workspaceId: WS2, ownerId: OWNER2, invoiceNumber: 'INV-2026-0002',
      customerName: 'Contoso', totalAmount: '75.00', currency: 'USD', status: 'draft', updatedAt: clock().toISOString(),
      deletedAt: null, paid: false, hadPayment: false, hadSentReminder: false, activeDispatch: false, followupState: 'draft'}],
    [INVOICE3, {id: INVOICE3, workspaceId: WS1, ownerId: OWNER1, invoiceNumber: 'INV-2026-0003',
      customerName: 'Fabrikam', totalAmount: '200.00', currency: 'INR', status: 'sent', updatedAt: clock().toISOString(),
      deletedAt: null, paid: false, hadPayment: false, hadSentReminder: false, activeDispatch: false, followupState: 'approved'}],
  ]);
  const proposals = new Map();
  const idempotency = new Map();
  const events = new Map();
  const claimStates = new Map([[INVOICE1, ['claimed']]]);
  let idCounter = 0;
  const nextId = () => `40000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`;
  const snapshot = (action, invoice, proposal, extra = {}) => ({
    ok: true, action, proposalId: proposal?.id, invoiceId: invoice?.id,
    invoiceNumber: invoice?.invoiceNumber, customerName: invoice?.customerName,
    totalAmount: invoice?.totalAmount, currency: invoice?.currency, status: invoice?.status,
    expectedUpdatedAt: proposal?.expectedUpdatedAt, expiresAt: proposal?.expiresAt,
    requiresExactConfirmation: proposal?.requiresExact, ...extra,
  });
  const safeError = code => ({ok: false, code});

  function actorOwner(context, args) {
    if (context.kind === 'phone') return args.p_phone === context.phone ? OWNER1 : null;
    return args.p_phone == null ? context.userId : null;
  }
  function eventMatches(id, phone, text) {
    const event = events.get(id);
    return event && event.phone === phone && event.text === text && ['processing', 'done'].includes(event.status) ? event : null;
  }
  function hasStrongRisk(invoice) {
    return invoice.paid || invoice.hadPayment || invoice.status === 'paid' || invoice.hadSentReminder;
  }
  function rpcFor(context) {
    return async (name, args) => {
      assert.equal(name, 'invoice_lifecycle_action');
      assert.equal(Object.hasOwn(args, 'p_owner_id'), false, 'caller supplied owner ids are never authorization');
      const ownerId = actorOwner(context, args);
      if (!ownerId) return safeError('OWNER_REQUIRED');
      if (args.p_action === 'capabilities') return {ok: true, action: 'capabilities', available: true};
      const isPhone = context.kind === 'phone';
      if (isPhone && ['prepare', 'cancel', 'undo'].includes(args.p_action)) {
        const event = eventMatches(args.p_request_message_id, context.phone, args.p_user_message);
        if (!event) return safeError('INVALID_CONFIRMATION');
      }
      if (args.p_action === 'pending') {
        const proposal = [...proposals.values()].find(p => p.workspaceId === args.p_workspace_id && p.ownerId === ownerId
          && p.phone === (args.p_phone || null) && p.state === 'pending' && Date.parse(p.expiresAt) > tick);
        if (!proposal) return {ok: true, action: 'proposal_loaded', pending: false};
        return {...snapshot('proposal_loaded', invoices.get(proposal.invoiceId), proposal), pending: true};
      }
      if (args.p_action === 'prepare') {
        if (isPhone) {
          const event = events.get(args.p_request_message_id);
          if (event.status !== 'processing' || event.receivedAt < tick - 10 * 60_000) return safeError('INVALID_CONFIRMATION');
        }
        const existingId = idempotency.get(`${args.p_workspace_id}:${ownerId}:${args.p_idempotency_key}`);
        if (existingId) {
          const proposal = proposals.get(existingId);
          if (proposal.invoiceId !== args.p_invoice_id || proposal.requestMessageId !== (args.p_request_message_id || null)) return safeError('INVALID_REQUEST');
          if (proposal.state === 'pending' && Date.parse(proposal.expiresAt) > tick) return snapshot('proposal_created', invoices.get(proposal.invoiceId), proposal);
          return safeError(proposal.state === 'expired' ? 'ACTION_EXPIRED' : 'ACTION_STALE');
        }
        for (const proposal of proposals.values()) {
          if (proposal.workspaceId === args.p_workspace_id && proposal.ownerId === ownerId && proposal.state === 'pending') {
            if (Date.parse(proposal.expiresAt) <= tick) proposal.state = 'expired';
            else return safeError('ACTION_PENDING');
          }
        }
        const invoice = invoices.get(args.p_invoice_id);
        if (!invoice || invoice.workspaceId !== args.p_workspace_id || invoice.ownerId !== ownerId || invoice.deletedAt) return safeError('INVOICE_NOT_FOUND');
        const proposal = {id: nextId(), workspaceId: invoice.workspaceId, ownerId, phone: args.p_phone || null,
          invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, expectedUpdatedAt: invoice.updatedAt,
          requiresExact: hasStrongRisk(invoice), hadPayment: invoice.hadPayment || invoice.paid || invoice.status === 'paid',
          hadSentReminder: invoice.hadSentReminder, requestMessageId: args.p_request_message_id || null,
          expiresAt: new Date(tick + 10 * 60_000).toISOString(), state: 'pending'};
        proposals.set(proposal.id, proposal);
        idempotency.set(`${args.p_workspace_id}:${ownerId}:${args.p_idempotency_key}`, proposal.id);
        return snapshot('proposal_created', invoice, proposal);
      }
      if (args.p_action === 'confirm') {
        const proposal = proposals.get(args.p_proposal_id);
        if (!proposal || proposal.workspaceId !== args.p_workspace_id || proposal.ownerId !== ownerId || proposal.phone !== (args.p_phone || null)) return safeError('PROPOSAL_NOT_FOUND');
        if (isPhone) {
          const event = eventMatches(args.p_confirmation_message_id, context.phone, args.p_user_message);
          if (!event) return safeError('INVALID_CONFIRMATION');
          if (proposal.state === 'deleted' && proposal.confirmationMessageId === args.p_confirmation_message_id) return snapshot('deleted', invoices.get(proposal.invoiceId), proposal, {replayed: true});
          if (args.p_confirmation_message_id === proposal.requestMessageId || event.status !== 'processing' || event.receivedAt < Date.parse(proposal.expiresAt) - 10 * 60_000) return safeError('INVALID_CONFIRMATION');
        }
        if (proposal.state === 'deleted' && proposal.confirmationMessageId === args.p_confirmation_message_id) return snapshot('deleted', invoices.get(proposal.invoiceId), proposal, {replayed: true});
        if (proposal.state !== 'pending') return safeError(proposal.state === 'deleted' ? 'ALREADY_DELETED' : 'ACTION_STALE');
        if (Date.parse(proposal.expiresAt) <= tick) { proposal.state = 'expired'; return safeError('ACTION_EXPIRED'); }
        const invoice = invoices.get(proposal.invoiceId);
        if (!invoice || invoice.deletedAt) { proposal.state = 'stale'; return safeError('ALREADY_DELETED'); }
        if (invoice.updatedAt !== proposal.expectedUpdatedAt) { proposal.state = 'stale'; return safeError('ACTION_STALE'); }
        const currentPayment = invoice.paid || invoice.hadPayment || invoice.status === 'paid';
        if ((currentPayment && !proposal.hadPayment) || (invoice.hadSentReminder && !proposal.hadSentReminder)) { proposal.state = 'stale'; return safeError('ACTION_STALE'); }
        const exact = proposal.requiresExact || hasStrongRisk(invoice);
        if (exact ? args.p_user_message !== `DELETE ${invoice.invoiceNumber}` : args.p_user_message.trim().toLowerCase() !== 'yes') {
          return safeError(exact ? 'EXACT_CONFIRMATION_REQUIRED' : 'INVALID_CONFIRMATION');
        }
        if (invoice.activeDispatch || invoice.deliveryClaim?.status === 'sending') return safeError('ACTION_PENDING');
        invoice.deletedAt = clock().toISOString();
        invoice.deletedBy = ownerId;
        invoice.followupState = 'cancelled';
        invoice.updatedAt = clock().toISOString();
        claimStates.set(invoice.id, (claimStates.get(invoice.id) || []).map(s => ['claimed', 'failed'].includes(s) ? 'cancelled' : s));
        proposal.state = 'deleted';
        proposal.confirmationMessageId = args.p_confirmation_message_id || null;
        proposal.deletedAt = invoice.deletedAt;
        return snapshot('deleted', invoice, proposal);
      }
      if (args.p_action === 'cancel') {
        const proposal = proposals.get(args.p_proposal_id);
        if (!proposal || proposal.workspaceId !== args.p_workspace_id || proposal.ownerId !== ownerId || proposal.phone !== (args.p_phone || null)) return safeError('PROPOSAL_NOT_FOUND');
        const cancelId = args.p_request_message_id || args.p_confirmation_message_id;
        if (proposal.state === 'cancelled' && proposal.cancelMessageId === cancelId) return snapshot('cancelled', invoices.get(proposal.invoiceId), proposal, {replayed: true});
        if (proposal.state !== 'pending') return safeError('ACTION_STALE');
        if (isPhone) {
          const event = events.get(args.p_request_message_id);
          if (event.status !== 'processing' || event.receivedAt < Date.parse(proposal.expiresAt) - 10 * 60_000 || args.p_request_message_id === proposal.requestMessageId) return safeError('INVALID_CONFIRMATION');
        }
        proposal.state = 'cancelled'; proposal.cancelMessageId = cancelId || null;
        return snapshot('cancelled', invoices.get(proposal.invoiceId), proposal);
      }
      if (args.p_action === 'undo') {
        const idempotencyKey = `${args.p_workspace_id}:${ownerId}:${args.p_idempotency_key}`;
        const targetMatches = proposal => args.p_invoice_id
          ? proposal.invoiceId === args.p_invoice_id
          : proposal.invoiceNumber === args.p_invoice_number;
        const messageMatches = proposal => [
          `undo delete ${proposal.invoiceNumber}`,
          `undo ${proposal.invoiceNumber}`,
          `restore ${proposal.invoiceNumber}`,
        ].some(command => command.toLowerCase() === (args.p_user_message || '').trim().toLowerCase());
        if (isPhone) {
          const messageReplay = [...proposals.values()].find(p => p.workspaceId === args.p_workspace_id
            && p.ownerId === ownerId && p.undoActorPhone === args.p_phone && p.undoRequestMessageId === args.p_request_message_id);
          if (messageReplay) {
            if (!targetMatches(messageReplay) || messageReplay.undoKey !== idempotencyKey || !messageMatches(messageReplay)) return safeError('REPLAYED');
            if (messageReplay.state === 'restored') return {...messageReplay.undoResult, replayed: true};
            return safeError('ACTION_STALE');
          }
        }
        const existing = [...proposals.values()].find(p => p.undoKey === idempotencyKey);
        if (existing) {
          if (!targetMatches(existing) || existing.undoActorPhone !== (args.p_phone || null)
            || (isPhone && existing.undoRequestMessageId !== args.p_request_message_id)
            || (!isPhone && existing.undoRequestMessageId != null)
            || (isPhone && !messageMatches(existing))) return safeError('REPLAYED');
          if (existing.state === 'restored') return {...existing.undoResult, replayed: true};
          return safeError('ACTION_STALE');
        }
        const invoice = [...invoices.values()].find(i => i.workspaceId === args.p_workspace_id && i.ownerId === ownerId && i.deletedAt
          && (args.p_invoice_id ? i.id === args.p_invoice_id : i.invoiceNumber === args.p_invoice_number));
        if (!invoice) return safeError('INVOICE_NOT_FOUND');
        if (isPhone && !messageMatches({invoiceNumber: invoice.invoiceNumber})) return safeError('INVALID_CONFIRMATION');
        const proposal = [...proposals.values()].find(p => p.invoiceId === invoice.id && p.state === 'deleted' && p.deletedAt === invoice.deletedAt);
        if (!proposal) return safeError('INVOICE_NOT_FOUND');
        if (tick > Date.parse(invoice.deletedAt) + 30 * 24 * 60 * 60_000) return safeError('UNDO_EXPIRED');
        if (isPhone) {
          const event = events.get(args.p_request_message_id);
          if (event.status !== 'processing' || event.receivedAt < Date.parse(invoice.deletedAt)) return safeError('INVALID_CONFIRMATION');
        }
        invoice.deletedAt = null; invoice.deletedBy = null; invoice.followupState = 'paused'; invoice.updatedAt = clock().toISOString();
        proposal.state = 'restored'; proposal.undoKey = idempotencyKey;
        proposal.undoRequestMessageId = isPhone ? args.p_request_message_id : null;
        proposal.undoActorPhone = isPhone ? args.p_phone : null;
        proposal.undoResult = {ok: true, action: 'restored', proposalId: proposal.id, invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber, status: invoice.status};
        return proposal.undoResult;
      }
      return safeError('INVALID_REQUEST');
    };
  }
  return {clock, advance, invoices, proposals, events, claimStates, serviceForUser: id => createInvoiceLifecycleService({rpc: rpcFor({kind: 'user', userId: id})}),
    serviceForPhone: (phone = PHONE1) => createInvoiceLifecycleService({rpc: rpcFor({kind: 'phone', phone})})};
}

test('delete then restore is scoped, reversible for 30 days, and idempotent', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForUser(OWNER1);
  const prepared = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'prepare_invoice_0001'});
  assert.equal(prepared.ok, true);
  assert.equal(prepared.invoiceNumber, 'INV-2026-0001');
  assert.equal(prepared.totalAmount, '1250.50');
  assert.equal(prepared.requiresExactConfirmation, false);
  assert.equal((await service.loadPendingDelete({workspaceId: WS1, actor: {kind: 'authenticated_owner', userId: OWNER1}})).proposalId, prepared.proposalId);

  const deleted = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'yes', confirmationMessageId: 'dashboard-confirm-1'});
  assert.equal(deleted.action, 'deleted');
  assert.equal(fixture.invoices.get(INVOICE1).deletedBy, OWNER1);
  assert.deepEqual(fixture.claimStates.get(INVOICE1), ['cancelled']);

  fixture.advance(29 * 24 * 60 * 60_000);
  const restored = await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'restore_invoice_0001'});
  assert.equal(restored.action, 'restored', JSON.stringify(restored));
  assert.equal(fixture.invoices.get(INVOICE1).deletedAt, null);
  assert.equal(fixture.invoices.get(INVOICE1).followupState, 'paused');
  const replay = await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'restore_invoice_0001'});
  assert.equal(replay.replayed, true);
});

test('expired and stale proposals cannot delete an invoice', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForUser(OWNER1);
  const expired = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'prepare_expired_0001'});
  fixture.advance(10 * 60_000 + 1);
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: expired.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'yes', confirmationMessageId: 'dashboard-confirm-expired'})).code, 'ACTION_EXPIRED');
  assert.equal(fixture.invoices.get(INVOICE1).deletedAt, null);

  const stale = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'prepare_stale_00001'});
  fixture.invoices.get(INVOICE1).updatedAt = new Date(Date.parse(fixture.clock()) + 1000).toISOString();
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: stale.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'yes', confirmationMessageId: 'dashboard-confirm-stale'})).code, 'ACTION_STALE');
  assert.equal(fixture.invoices.get(INVOICE1).deletedAt, null);
});

test('paid, payment-bearing, or reminded invoices need the exact invoice phrase; newly increased risk invalidates a proposal', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForUser(OWNER1);
  const invoice = fixture.invoices.get(INVOICE1);
  invoice.hadPayment = true;
  const prepared = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'prepare_strong_0001'});
  assert.equal(prepared.requiresExactConfirmation, true);
  const weak = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'yes', confirmationMessageId: 'dashboard-weak-1'});
  assert.equal(weak.code, 'EXACT_CONFIRMATION_REQUIRED');
  const exact = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'DELETE INV-2026-0001', confirmationMessageId: 'dashboard-exact-1'});
  assert.equal(exact.action, 'deleted');

  const secondFixture = lifecycleFixture();
  const secondService = secondFixture.serviceForUser(OWNER1);
  const normal = await secondService.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: {kind: 'authenticated_owner', userId: OWNER1}, idempotencyKey: 'prepare_riskup_0001'});
  secondFixture.invoices.get(INVOICE1).hadSentReminder = true;
  assert.equal((await secondService.confirmDelete({workspaceId: WS1, proposalId: normal.proposalId, actor: {kind: 'authenticated_owner', userId: OWNER1}, userMessage: 'yes', confirmationMessageId: 'dashboard-risk-up'})).code, 'ACTION_STALE');
});

test('an unresolved sending claim blocks deletion after its lease expires', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForUser(OWNER1);
  const actor = {kind: 'authenticated_owner', userId: OWNER1};
  const prepared = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor, idempotencyKey: 'prepare_expired_sending_01'});
  const invoice = fixture.invoices.get(INVOICE1);
  invoice.deliveryClaim = {status: 'sending', leaseUntil: Date.parse(fixture.clock()) + 120_000};
  fixture.claimStates.set(INVOICE1, ['sending']);
  fixture.advance(121_000);
  const result = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'dashboard-expired-sending'});
  assert.equal(result.code, 'ACTION_PENDING');
  assert.equal(invoice.deletedAt, null);
  assert.deepEqual(fixture.claimStates.get(INVOICE1), ['sending']);
});

test('undo replay keys remain bound to invoice targets and request identities', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForUser(OWNER1);
  const actor = {kind: 'authenticated_owner', userId: OWNER1};
  const preparedOne = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor, idempotencyKey: 'prepare_replay_one_001'});
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: preparedOne.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'dashboard-replay-one'})).action, 'deleted');
  const firstRestore = await service.undoDelete({workspaceId: WS1, invoiceId: INVOICE1, actor, idempotencyKey: 'same_undo_request_001'});
  assert.equal(firstRestore.action, 'restored');

  const preparedThree = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE3, actor, idempotencyKey: 'prepare_replay_three_001'});
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: preparedThree.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'dashboard-replay-three'})).action, 'deleted');
  assert.equal((await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0003', actor,
    idempotencyKey: 'same_undo_request_001'})).code, 'REPLAYED');
  assert.ok(fixture.invoices.get(INVOICE3).deletedAt);
  assert.equal((await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0003', actor,
    idempotencyKey: 'different_undo_request_001'})).action, 'restored');

  const phoneFixture = lifecycleFixture();
  const phoneService = phoneFixture.serviceForPhone();
  const phoneActor = {kind: 'verified_owner_phone', phone: PHONE1};
  phoneFixture.events.set('phone-delete-request-1', {phone: PHONE1, text: 'Please delete invoice 1', status: 'processing', receivedAt: Date.parse(phoneFixture.clock())});
  const phoneProposal = await phoneService.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor: phoneActor,
    userMessage: 'Please delete invoice 1', requestMessageId: 'phone-delete-request-1', idempotencyKey: 'phone_prepare_replay_001'});
  phoneFixture.events.set('phone-delete-confirm-1', {phone: PHONE1, text: 'yes', status: 'processing', receivedAt: Date.parse(phoneFixture.clock()) + 1});
  assert.equal((await phoneService.confirmDelete({workspaceId: WS1, proposalId: phoneProposal.proposalId, actor: phoneActor,
    userMessage: 'yes', confirmationMessageId: 'phone-delete-confirm-1'})).action, 'deleted');
  phoneFixture.events.set('phone-undo-request-1', {phone: PHONE1, text: 'restore INV-2026-0001', status: 'processing', receivedAt: Date.parse(phoneFixture.clock()) + 2});
  const phoneUndo = await phoneService.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor: phoneActor,
    userMessage: 'restore INV-2026-0001', requestMessageId: 'phone-undo-request-1', idempotencyKey: 'phone_undo_replay_001'});
  assert.equal(phoneUndo.action, 'restored');
  assert.equal((await phoneService.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor: phoneActor,
    userMessage: 'restore INV-2026-0001', requestMessageId: 'phone-undo-request-1', idempotencyKey: 'phone_undo_replay_001'})).replayed, true);
  phoneFixture.events.set('phone-undo-request-2', {phone: PHONE1, text: 'restore INV-2026-0001', status: 'processing', receivedAt: Date.parse(phoneFixture.clock()) + 3});
  assert.equal((await phoneService.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor: phoneActor,
    userMessage: 'restore INV-2026-0001', requestMessageId: 'phone-undo-request-2', idempotencyKey: 'phone_undo_replay_001'})).code, 'REPLAYED');

  const otherPhoneService = phoneFixture.serviceForPhone(PHONE2);
  phoneFixture.events.set('phone-undo-request-3', {phone: PHONE2, text: 'restore INV-2026-0001', status: 'processing', receivedAt: Date.parse(phoneFixture.clock()) + 4});
  assert.equal((await otherPhoneService.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001',
    actor: {kind: 'verified_owner_phone', phone: PHONE2}, userMessage: 'restore INV-2026-0001',
    requestMessageId: 'phone-undo-request-3', idempotencyKey: 'phone_undo_replay_001'})).code, 'REPLAYED');
});

test('verified owner actions require matching inbound text, a distinct confirmation message, and workspace scope', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForPhone();
  const actor = {kind: 'verified_owner_phone', phone: PHONE1};
  fixture.events.set('provider-proposal-1', {phone: PHONE1, text: 'Please delete INV-2026-0001', status: 'processing', receivedAt: Date.parse(fixture.clock())});
  const prepared = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor,
    userMessage: 'Please delete INV-2026-0001', requestMessageId: 'provider-proposal-1', idempotencyKey: 'wa_prepare_0000001'});
  assert.equal(prepared.ok, true);
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor,
    userMessage: 'Please delete INV-2026-0001', confirmationMessageId: 'provider-proposal-1'})).code, 'INVALID_CONFIRMATION');
  fixture.events.set('provider-confirm-1', {phone: PHONE1, text: 'yes', status: 'processing', receivedAt: Date.parse(fixture.clock()) + 1});
  const deleted = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'provider-confirm-1'});
  assert.equal(deleted.action, 'deleted');
  const replay = await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'provider-confirm-1'});
  assert.equal(replay.replayed, true);
  assert.equal((await service.confirmDelete({workspaceId: WS2, proposalId: prepared.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'provider-confirm-1'})).code, 'PROPOSAL_NOT_FOUND');
});

test('verified owner undo must name the target invoice in the original inbound message', async () => {
  const fixture = lifecycleFixture();
  const service = fixture.serviceForPhone();
  const actor = {kind: 'verified_owner_phone', phone: PHONE1};
  fixture.events.set('undo-proposal-1', {phone: PHONE1, text: 'Please delete INV-2026-0001', status: 'processing', receivedAt: Date.parse(fixture.clock())});
  const prepared = await service.prepareDelete({workspaceId: WS1, invoiceId: INVOICE1, actor,
    userMessage: 'Please delete INV-2026-0001', requestMessageId: 'undo-proposal-1', idempotencyKey: 'undo_prepare_000001'});
  fixture.events.set('undo-confirm-1', {phone: PHONE1, text: 'yes', status: 'processing', receivedAt: Date.parse(fixture.clock()) + 1});
  assert.equal((await service.confirmDelete({workspaceId: WS1, proposalId: prepared.proposalId, actor,
    userMessage: 'yes', confirmationMessageId: 'undo-confirm-1'})).action, 'deleted');

  fixture.events.set('undo-wrong-1', {phone: PHONE1, text: 'undo delete INV-2026-0002', status: 'processing', receivedAt: Date.parse(fixture.clock()) + 2});
  assert.equal((await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor,
    userMessage: 'undo delete INV-2026-0002', requestMessageId: 'undo-wrong-1', idempotencyKey: 'undo_wrong_000001'})).code, 'INVALID_CONFIRMATION');
  assert.notEqual(fixture.invoices.get(INVOICE1).deletedAt, null);

  fixture.events.set('undo-right-1', {phone: PHONE1, text: 'undo delete INV-2026-0001', status: 'processing', receivedAt: Date.parse(fixture.clock()) + 3});
  const restored = await service.undoDelete({workspaceId: WS1, invoiceNumber: 'INV-2026-0001', actor,
    userMessage: 'undo delete INV-2026-0001', requestMessageId: 'undo-right-1', idempotencyKey: 'undo_right_000001'});
  assert.equal(restored.action, 'restored');
  assert.equal(fixture.invoices.get(INVOICE1).deletedAt, null);
});

test('undo replay identity follows the restoring actor across dashboard and WhatsApp', async () => {
  const phoneDeleteFixture=lifecycleFixture();
  const phoneService=phoneDeleteFixture.serviceForPhone();
  const phoneActor={kind:'verified_owner_phone',phone:PHONE1};
  phoneDeleteFixture.events.set('cross-delete-request',{phone:PHONE1,text:'Delete invoice 1',status:'processing',receivedAt:Date.parse(phoneDeleteFixture.clock())});
  const phoneProposal=await phoneService.prepareDelete({workspaceId:WS1,invoiceId:INVOICE1,actor:phoneActor,
    userMessage:'Delete invoice 1',requestMessageId:'cross-delete-request',idempotencyKey:'cross_delete_phone_001'});
  phoneDeleteFixture.events.set('cross-delete-confirm',{phone:PHONE1,text:'yes',status:'processing',receivedAt:Date.parse(phoneDeleteFixture.clock())+1});
  assert.equal((await phoneService.confirmDelete({workspaceId:WS1,proposalId:phoneProposal.proposalId,actor:phoneActor,
    userMessage:'yes',confirmationMessageId:'cross-delete-confirm'})).action,'deleted');
  const dashboard=phoneDeleteFixture.serviceForUser(OWNER1);
  const dashboardUndo=await dashboard.undoDelete({workspaceId:WS1,invoiceId:INVOICE1,
    actor:{kind:'authenticated_owner',userId:OWNER1},idempotencyKey:'cross_undo_dashboard_001'});
  assert.equal(dashboardUndo.action,'restored');
  assert.equal((await dashboard.undoDelete({workspaceId:WS1,invoiceId:INVOICE1,
    actor:{kind:'authenticated_owner',userId:OWNER1},idempotencyKey:'cross_undo_dashboard_001'})).replayed,true);

  const dashboardDeleteFixture=lifecycleFixture();
  const dashboardService=dashboardDeleteFixture.serviceForUser(OWNER1);
  const actor={kind:'authenticated_owner',userId:OWNER1};
  const proposal=await dashboardService.prepareDelete({workspaceId:WS1,invoiceId:INVOICE1,actor,
    idempotencyKey:'cross_delete_dashboard_001'});
  assert.equal((await dashboardService.confirmDelete({workspaceId:WS1,proposalId:proposal.proposalId,actor,
    userMessage:'yes',confirmationMessageId:'cross-dashboard-confirm'})).action,'deleted');
  const phone=dashboardDeleteFixture.serviceForPhone(PHONE1);
  const verifiedActor={kind:'verified_owner_phone',phone:PHONE1};
  dashboardDeleteFixture.events.set('cross-phone-undo',{phone:PHONE1,text:'restore INV-2026-0001',
    status:'processing',receivedAt:Date.parse(dashboardDeleteFixture.clock())+1});
  const undo=await phone.undoDelete({workspaceId:WS1,invoiceNumber:'INV-2026-0001',actor:verifiedActor,
    userMessage:'restore INV-2026-0001',requestMessageId:'cross-phone-undo',idempotencyKey:'cross_undo_phone_001'});
  assert.equal(undo.action,'restored');
  assert.equal((await phone.undoDelete({workspaceId:WS1,invoiceNumber:'INV-2026-0001',actor:verifiedActor,
    userMessage:'restore INV-2026-0001',requestMessageId:'cross-phone-undo',idempotencyKey:'cross_undo_phone_001'})).replayed,true);
});

test('REST lifecycle error handling never exposes raw provider or database text', async () => {
  const service = createInvoiceLifecycleService({rpc: async () => { throw {code: 'XX000', status: 500, message: 'secret SQL details'}; }});
  const result = await service.capabilities({workspaceId: WS1, actor: {kind: 'authenticated_owner', userId: OWNER1}});
  assert.deepEqual(result, {ok: false, code: 'DATABASE_UNAVAILABLE'});
});

test('lifecycle source conflict reports a safe duplicate code without exposing SQL detail',async()=>{
  const service=createInvoiceLifecycleService({rpc:async()=>({error:{code:'23505',message:'source invoice already exists for customer'}})});
  assert.deepEqual(await service.capabilities({workspaceId:WS1,actor:{kind:'authenticated_owner',userId:OWNER1}}),{ok:false,code:'DUPLICATE_INVOICE'});
});

test('migration contains scoped owner, consent, stale, confirmation, restore, read, payment, and reminder guards', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261002090000_invoice_soft_delete.sql', import.meta.url), 'utf8');
  assert.match(sql, /deleted_at timestamptz/);
  assert.match(sql, /using \(app\.is_workspace_member\(workspace_id\) and deleted_at is null\)/i);
  assert.match(sql, /join public\.workspace_members m[^;]*m\.role = 'owner'[^;]*w\.owner_id = auth\.uid\(\)/is);
  assert.match(sql, /whatsapp_resolve_verified_owner\(p_phone\)/i);
  assert.match(sql, /e\.message_text = p_user_message/);
  assert.match(sql, /p_confirmation_message_id = v_proposal\.request_message_id/);
  assert.match(sql, /interval '10 minutes'/i);
  assert.match(sql, /interval '30 days'/i);
  assert.match(sql, /undo delete '\s*\|\|\s*pg_catalog\.lower\(v_invoice\.invoice_number\)/i);
  assert.match(sql, /expected_updated_at/);
  assert.match(sql, /revoke delete on public\.invoices from authenticated/i);
  assert.match(sql, /cannot record payment for a deleted invoice/i);
  assert.match(sql, /i\.deleted_at is not null or s\.workspace_id is null/i);
  assert.match(sql, /i\.deleted_at is null/);
  assert.match(sql, /status = 'cancelled', delivery_token = null/i);
  assert.match(sql, /create table app\.invoice_lifecycle_write_context/i);
  assert.match(sql, /revoke all on app\.invoice_lifecycle_write_context from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /current_setting\('app\.invoice_lifecycle_rpc'/i);
  assert.match(sql, /invoice_number = p_invoice_number/i);
  assert.doesNotMatch(sql.match(/create or replace function public\.invoice_lifecycle_action\(([\s\S]*?)\) returns jsonb/i)?.[1] || '', /p_owner_id/);
  const outsideRoutineBodies = sql.replace(/create or replace function\b[\s\S]*?\$\$;/gi, '');
  assert.doesNotMatch(outsideRoutineBodies, /drop table|truncate|update public\.invoices\s+set\s+(total_amount|amount_paid|status)\s*=/i);
});

test('migration keeps unresolved dispatches, consent eligibility, and delivery lock order safe', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261002090000_invoice_soft_delete.sql', import.meta.url), 'utf8');
  const confirm = sql.slice(sql.indexOf("if p_action = 'confirm'"), sql.indexOf("if p_action = 'cancel'"));
  assert.match(confirm, /c\.status\s*=\s*'sending'/i);
  assert.doesNotMatch(confirm, /status\s*=\s*'sending'[^;]{0,160}lease_until/is);
  assert.match(confirm, /status in \('claimed','failed'\)/i);
  assert.doesNotMatch(confirm, /status in \('claimed','failed'\)[^;]{0,180}sending/is);

  const claim = sql.match(/create or replace function public\.cetld_core_claim_due_followups\([\s\S]*?\n\$\$;/i)?.[0] || '';
  const authorization = sql.match(/create or replace function public\.cetld_core_authorize_delivery\([\s\S]*?\n\$\$;/i)?.[0] || '';
  const sent = sql.match(/create or replace function public\.cetld_core_mark_sent\([\s\S]*?\n\$\$;/i)?.[0] || '';
  const invoiceClaimLock = authorization.indexOf('from public.invoices where id=c.invoice_id');
  const authorizationClaimLock = authorization.indexOf('from public.cetld_core_automation_delivery_claims', invoiceClaimLock);
  assert.ok(claim.indexOf('for update of i skip locked') < claim.indexOf('insert into public.cetld_core_automation_delivery_claims'));
  assert.ok(invoiceClaimLock >= 0 && invoiceClaimLock < authorizationClaimLock,
    'delivery authorization locks invoice before claim');
  assert.ok(sent.indexOf('from public.invoices i') < sent.indexOf('update public.cetld_core_automation_delivery_claims'),
    'sent receipt locks invoice before updating claim');
  assert.match(authorization, /lease_until=now\(\)\+interval '2 minutes'/i);

  const whatsappClaim = sql.match(/create or replace function public\.whatsapp_claim_invoice_update\([\s\S]*?\n\$\$;/i)?.[0] || '';
  assert.doesNotMatch(whatsappClaim, /whatsapp_owner_attested_at/i);
});

test('migration binds undo replay to its invoice, owner phone, key, and inbound message', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261002090000_invoice_soft_delete.sql', import.meta.url), 'utf8');
  const routine = sql.match(/create or replace function public\.invoice_lifecycle_action\([\s\S]*?\n\$\$;/i)?.[0] || '';
  const undo = routine.slice(routine.indexOf("if p_action = 'undo'"));
  assert.match(undo, /p\.undo_actor_phone = v_phone and p\.undo_request_message_id = p_request_message_id/i);
  assert.match(undo, /v_proposal\.undo_idempotency_key is distinct from p_idempotency_key/i);
  assert.match(undo, /v_proposal\.undo_actor_phone is distinct from v_phone/i);
  assert.match(undo, /v_proposal\.undo_request_message_id is distinct from p_request_message_id/i);
  assert.match(undo, /p_invoice_id is not null and p_invoice_id <> v_proposal\.invoice_id/i);
  assert.match(undo, /p_invoice_number is not null and p_invoice_number <> v_proposal\.invoice_number/i);
  assert.match(undo, /undo_actor_phone = case when v_is_service then v_phone else null end/i);
});
