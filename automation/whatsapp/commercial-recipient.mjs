import {getSendEligibility} from './consent.mjs';

const E164 = /^\+[1-9][0-9]{7,14}$/;
const denied = reason => ({allowed: false, reason});

/** Commercial recipients require fresh consent; an optional test list only narrows. */
export async function getCommercialRecipientEligibility({env, supabase, workspaceId, phone}) {
  if (typeof phone !== 'string' || !E164.test(phone)) return denied('invalid_phone');
  const raw = env.WHATSAPP_TEST_ALLOWLIST;
  if (raw !== undefined) {
    if (typeof raw !== 'string') return denied('invalid_test_allowlist');
    const values = raw.split(',').map(value => value.trim());
    if (!values.length || values.some(value => !E164.test(value))) return denied('invalid_test_allowlist');
    if (!values.includes(phone)) return denied('test_allowlist');
  }
  try {
    return await getSendEligibility({supabase, workspaceId, phone, category: 'invoice_updates'});
  } catch {
    return denied('eligibility_unavailable');
  }
}
