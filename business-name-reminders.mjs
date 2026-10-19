// Shared owner-facing copy and scoped impact lookup; never changes approvals.
export function businessNameReminderNotice(count, {saved = false} = {}) {
  if (!Number.isSafeInteger(count) || count <= 0) return '';
  const subject = `${count} approved reminder${count === 1 ? '' : 's'}`;
  return `${subject} ${saved ? (count === 1 ? 'is' : 'are') : 'will be'} paused after this business name change until you re-approve ${count === 1 ? 'it' : 'them'} in the Conversations tab.`;
}

export async function businessNameReminderPauseCount(client, workspaceId, currentName, nextName) {
  if (nextName == null || nextName === currentName) return 0;
  const result = await client.rpc('business_name_reminder_pause_count', {p_workspace_id: workspaceId});
  if (result.error) throw result.error;
  const count = result.data == null ? NaN : Number(result.data);
  if (!Number.isSafeInteger(count) || count < 0) throw Error('Could not verify affected reminders.');
  return count;
}

export function businessNameReviewNotice(invoice) {
  const reason = invoice?.reminder_review_reason ?? invoice?.metadata?.reminder_review_reason;
  return invoice?.followup_state === 'paused' && reason === 'business_name_changed'
    ? 'Needs re-approval after business name change. Review the new reminder and approve it in the Conversations tab.' : '';
}
